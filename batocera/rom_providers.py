"""
Kente's Korner — ROM source providers.

Each provider exposes a single entry point:
    search(system_id, title) -> [Candidate, ...]

A Candidate is a dict shaped like:
    {
        'provider':  'archive' | 'myrient' | 'romsfun' | ...,
        'url':       direct download URL (or upstream page; resolve_url() finalizes),
        'filename':  basename written to disk (with extension),
        'size':      int bytes (None if unknown),
        'region':    'usa' | 'eu' | 'jp' | 'world' | 'unknown',
        'score':     float; higher = better. score_candidate() fills this in.
        'extras':    provider-specific dict (archive id, redump set, etc.)
    }

Stdlib only. Reuses HTTP / cache helpers from theater_providers so the two
modules share a single TTL cache namespace.
"""
import re
import urllib.parse
import urllib.request
import urllib.error
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeoutError

from theater_providers import (
    _cache_get, _cache_put, _http_text, _http_text_resilient, UA,
)

# ── Region detection (mirrors kente.js RGN_*) ───────────────────────────────
RGN_USA = re.compile(r'\((USA|US|United States|World|U,)\)|\bUSA\b', re.I)
RGN_EU  = re.compile(r'\((Europe|EU|UK|Germany|France|Italy|Spain|E)\)|\bEUR\b', re.I)
RGN_JP  = re.compile(r'\((Japan|JP|Asia|Korea|J,)\)|\bJPN\b', re.I)


def _detect_region(name):
    if RGN_USA.search(name): return 'usa'
    if RGN_EU.search(name):  return 'eu'
    if RGN_JP.search(name):  return 'jp'
    return 'unknown'


# ── Per-system valid ROM extensions (mirrors ROM_EXT in kente.js) ───────────
ROM_EXT = {
    'nes':        ['.nes', '.zip'],
    'snes':       ['.sfc', '.smc', '.zip'],
    'gameboy':    ['.gb',  '.zip'],
    'gbc':        ['.gbc', '.zip'],
    'gba':        ['.gba', '.zip'],
    'genesis':    ['.md', '.bin', '.gen', '.smd', '.zip'],
    'mastersys':  ['.sms', '.zip'],
    'gamegear':   ['.gg', '.zip'],
    'sega32x':    ['.32x', '.zip'],
    'segacd':     ['.cue', '.bin', '.iso', '.chd', '.zip'],
    'turbografx': ['.pce', '.zip'],
    'neogeo':     ['.zip', '.neo'],
    'atari2600':  ['.a26', '.bin', '.zip'],
    'atari7800':  ['.a78', '.bin', '.zip'],
    'n64':        ['.n64', '.z64', '.v64', '.zip'],
    'ps1':        ['.cue', '.bin', '.chd', '.iso', '.pbp', '.zip', '.7z'],
    'ps2':        ['.iso', '.chd', '.bin', '.cue', '.zip', '.7z'],
    'psp':        ['.iso', '.cso', '.zip'],
    'saturn':     ['.cue', '.bin', '.chd', '.iso', '.zip'],
    'dreamcast':  ['.cdi', '.gdi', '.chd', '.iso', '.zip', '.7z'],
    'gamecube':   ['.iso', '.gcm', '.rvz', '.nkit.iso', '.zip'],
    'wii':        ['.iso', '.wbfs', '.rvz', '.nkit.iso', '.zip'],
    'wiiu':       ['.wud', '.wux', '.iso', '.rpx', '.zip'],
    'xbox':       ['.iso', '.xbe', '.zip'],
    'xbox360':    ['.iso', '.zip'],
    'nds':        ['.nds', '.zip'],
    '3ds':        ['.3ds', '.cia', '.zip'],
    'switch':     ['.nsp', '.xci', '.zip'],
    'ps3':        ['.iso', '.pkg', '.zip'],
}


def _ext_match(filename, system_id):
    valid = ROM_EXT.get(system_id, [])
    if not valid: return True   # unknown system → accept everything
    name_low = filename.lower()
    return any(name_low.endswith(e) for e in valid)


# ── Title normalization for fuzzy matching ──────────────────────────────────
_NORM_RE = re.compile(r'[^a-z0-9]+')

def _norm_words(s):
    return [w for w in _NORM_RE.sub(' ', (s or '').lower()).split() if len(w) > 2]


def _title_overlap(filename, title):
    """Return [0..1] fraction of title words that appear in filename."""
    fwords = set(_norm_words(filename))
    twords = set(_norm_words(title))
    if not twords: return 0.0
    return len(fwords & twords) / len(twords)


# ── Candidate scoring ───────────────────────────────────────────────────────
# Higher is better. Combines: title-word overlap, region preference, extension
# confidence (zip is valid but raw ROM is preferred), and a small provider
# tiebreaker so a tied USA-region ROM from Myrient beats Archive (curated > raw).
PROVIDER_BIAS = {
    'archive_redump': 0.12,   # curated disc dumps (3000+ verified items)
    'archive_packs':  0.08,   # hand-picked per-system packs
    'archive_tosec':  0.04,   # historical / preservation set
    'archive':        0.0,    # broad fallback
}
REGION_BIAS   = {'usa': 0.15, 'world': 0.12, 'eu': 0.05, 'jp': 0.0, 'unknown': 0.02}

def score_candidate(c, query):
    title = query or ''
    overlap = _title_overlap(c.get('filename') or '', title)
    base = overlap * 1.0
    base += REGION_BIAS.get((c.get('region') or 'unknown').lower(), 0.0)
    base += PROVIDER_BIAS.get((c.get('provider') or '').lower(), 0.0)
    fname_low = (c.get('filename') or '').lower()
    if fname_low.endswith('.zip') or fname_low.endswith('.7z'):
        base -= 0.03  # slightly prefer extracted ROMs when both exist
    if c.get('size'):
        base += 0.02   # size known (download progress can render)
    return round(base, 4)


# ── Archive.org provider ────────────────────────────────────────────────────
# Mirrors the multi-phase searchArchive() in kente.js, then resolves each item
# to a single best-region ROM file via the metadata API.

ARCHIVE_SYS_QUERY = {
    'nes':        'subject:"Nintendo Entertainment System"',
    'gameboy':    'subject:"Game Boy"',
    'mastersys':  'subject:"Master System"',
    'atari2600':  'subject:"Atari 2600"',
    'atari7800':  'subject:"Atari 7800"',
    'gamegear':   'subject:"Game Gear"',
    'snes':       'subject:"Super Nintendo"',
    'genesis':    '(subject:"Mega Drive" OR subject:"Sega Genesis")',
    'gbc':        'subject:"Game Boy Color"',
    'gba':        'subject:"Game Boy Advance"',
    'turbografx': '(subject:"PC Engine" OR subject:"TurboGrafx")',
    'neogeo':     '(subject:"Neo-Geo" OR subject:NeoGeo)',
    'segacd':     '(subject:"Sega CD" OR subject:"Mega CD")',
    'sega32x':    '(subject:"Sega 32X" OR subject:"32X")',
    'n64':        '(subject:"Nintendo 64" OR subject:N64)',
    'ps1':        '(subject:PSX OR subject:"PlayStation 1")',
    'saturn':     'subject:Saturn',
    'nds':        'subject:"Nintendo DS"',
    'dreamcast':  '(subject:Dreamcast OR subject:"Sega Dreamcast")',
    'psp':        'subject:PSP',
    'ps2':        '(subject:"PlayStation 2" OR subject:"Sony PlayStation 2")',
    'gamecube':   '(subject:GameCube OR subject:"Nintendo GameCube")',
    'wii':        'subject:Wii',
    'xbox':       'subject:Xbox',
    'xbox360':    '(subject:Xbox360 OR subject:"Xbox 360")',
    'ps3':        'subject:PS3',
    'wiiu':       'subject:"Wii U"',
    'switch':     '(subject:NSP OR subject:nsp OR subject:XCI OR subject:xci OR subject:NSZ OR subject:nsz)',
}

# Disc-based and large systems that frequently use mediatype:data uploads.
ARCHIVE_MEDIATYPE = {
    s: '(mediatype:software OR mediatype:data)' for s in (
        'psp', 'ps2', 'saturn', 'gamecube', 'segacd', 'sega32x', 'dreamcast',
        'wii', 'xbox', 'xbox360', 'ps3', 'wiiu', 'switch',
    )
}

_ARCHIVE_CLEAN_RE = re.compile(r'[\'"():\[\]{}.!?]')


def _archive_query(parts):
    q = urllib.parse.quote(' AND '.join(parts))
    url = ('https://archive.org/advancedsearch.php?q=' + q +
           '&fl[]=identifier&fl[]=title&fl[]=year&rows=40&output=json')
    cached = _cache_get(url)
    if cached is not None: return cached
    try:
        data = json.loads(_http_text(url, timeout=12))
    except Exception as e:
        print(f'[rom_providers/archive] query failed: {e}')
        return []
    docs = ((data or {}).get('response') or {}).get('docs') or []
    _cache_put(url, docs, ttl=900)
    return docs


def _archive_item_files(identifier):
    """Return list of {name, size} for an Archive.org item."""
    url = f'https://archive.org/metadata/{urllib.parse.quote(identifier)}'
    cached = _cache_get(url)
    if cached is not None: return cached
    try:
        data = json.loads(_http_text(url, timeout=12))
    except Exception as e:
        print(f'[rom_providers/archive] metadata failed for {identifier}: {e}')
        return []
    files = []
    for f in (data.get('files') or []):
        n = f.get('name')
        if not n: continue
        size = None
        try: size = int(f.get('size')) if f.get('size') else None
        except Exception: size = None
        files.append({'name': n, 'size': size})
    _cache_put(url, files, ttl=900)
    return files


def _archive_pick_file(files, system_id, title):
    """Pick the best file in an item: extension match → title-overlap → region."""
    valid = [f for f in files if _ext_match(f['name'], system_id)]
    if not valid: return None
    twords = set(_norm_words(title))
    if twords:
        scored = sorted(valid, key=lambda f: (
            len(set(_norm_words(f['name'])) & twords),
            1 if RGN_USA.search(f['name']) else
            0 if not (RGN_EU.search(f['name']) or RGN_JP.search(f['name'])) else -1,
        ), reverse=True)
    else:
        scored = valid
    return scored[0] if scored else None


def archive_search(system_id, title, max_items=8):
    """Multi-phase Archive.org search → list of Candidate dicts."""
    if not title: return []
    clean = _ARCHIVE_CLEAN_RE.sub(' ', title)
    clean = re.sub(r'\s+', ' ', clean).strip()
    sys_q = ARCHIVE_SYS_QUERY.get(system_id, '')
    mtype = ARCHIVE_MEDIATYPE.get(system_id, 'mediatype:software')
    phases = []
    if clean:
        phases.append([mtype, f'title:({clean})'] + ([sys_q] if sys_q else []))
        phases.append([mtype, f'title:({clean})'])
        phases.append(['(mediatype:software OR mediatype:data)', f'title:({clean})'])
        words = clean.split()
        if len(words) > 2:
            short = ' '.join(words[:3])
            phases.append(['(mediatype:software OR mediatype:data)', f'title:({short})'])
    docs = []
    for parts in phases:
        docs = _archive_query(parts)
        if docs: break
    docs = docs[:max_items]
    out = []
    def _resolve(doc):
        ident = doc.get('identifier')
        if not ident: return None
        files = _archive_item_files(ident)
        pick = _archive_pick_file(files, system_id, title)
        if not pick: return None
        url = (f'https://archive.org/download/{urllib.parse.quote(ident)}/'
               f'{urllib.parse.quote(pick["name"])}')
        return {
            'provider': 'archive',
            'url':      url,
            'filename': pick['name'],
            'size':     pick.get('size'),
            'region':   _detect_region(pick['name']),
            'extras':   {'archive_id': ident, 'item_title': doc.get('title')},
        }
    if docs:
        with ThreadPoolExecutor(max_workers=min(4, len(docs))) as ex:
            for cand in ex.map(_resolve, docs):
                if cand: out.append(cand)
    return out


# ── Archive.org curated-pack provider ───────────────────────────────────────
# Some systems have a single Archive.org item that holds hundreds of individual
# ROM files (e.g. pack-roms-nintendo-entertainment-system).  These are usually
# higher quality than the broad subject search because they're curated by hand.

ARCHIVE_PACKS = {
    'nes':  'pack-roms-nintendo-entertainment-system',
    'snes': 'chrono-trigger-2-crimson-echoes-usa',
}


def archive_packs_search(system_id, title, max_items=8):
    """List the curated pack item, filter files by title-word overlap."""
    ident = ARCHIVE_PACKS.get(system_id)
    if not ident or not title: return []
    twords = set(_norm_words(title))
    if not twords: return []
    files = _archive_item_files(ident)
    ranked = []
    for f in files:
        if not _ext_match(f['name'], system_id): continue
        fwords = set(_norm_words(f['name']))
        overlap = len(fwords & twords) / len(twords)
        if overlap < 0.6: continue
        ranked.append((overlap, f))
    ranked.sort(key=lambda r: (
        r[0],
        1 if RGN_USA.search(r[1]['name']) else
        0 if not (RGN_EU.search(r[1]['name']) or RGN_JP.search(r[1]['name'])) else -1,
    ), reverse=True)
    out = []
    for _ov, f in ranked[:max_items]:
        url = (f'https://archive.org/download/{urllib.parse.quote(ident)}/'
               f'{urllib.parse.quote(f["name"])}')
        out.append({
            'provider': 'archive_packs',
            'url':      url,
            'filename': f['name'],
            'size':     f.get('size'),
            'region':   _detect_region(f['name']),
            'extras':   {'archive_id': ident},
        })
    return out


# ── Archive.org collection-filtered providers ──────────────────────────────
# Each curated Archive.org collection becomes its own "source" so the user can
# pick a specific dump set in the UI dropdown.  Same scrape path as
# archive_search but with a `collection:<id>` filter prepended to the query.

def _archive_collection_search(collection_id, provider_name, system_id, title, max_items=6):
    if not title: return []
    clean = _ARCHIVE_CLEAN_RE.sub(' ', title)
    clean = re.sub(r'\s+', ' ', clean).strip()
    if not clean: return []
    sys_q = ARCHIVE_SYS_QUERY.get(system_id, '')
    parts = [f'collection:{collection_id}', f'title:({clean})']
    if sys_q: parts.append(sys_q)
    docs = _archive_query(parts) or _archive_query(parts[:2])
    docs = docs[:max_items]
    out = []
    def _resolve(doc):
        ident = doc.get('identifier')
        if not ident: return None
        files = _archive_item_files(ident)
        pick = _archive_pick_file(files, system_id, title)
        if not pick: return None
        url = (f'https://archive.org/download/{urllib.parse.quote(ident)}/'
               f'{urllib.parse.quote(pick["name"])}')
        return {
            'provider': provider_name,
            'url':      url,
            'filename': pick['name'],
            'size':     pick.get('size'),
            'region':   _detect_region(pick['name']),
            'extras':   {'archive_id': ident, 'collection': collection_id},
        }
    if docs:
        with ThreadPoolExecutor(max_workers=min(4, len(docs))) as ex:
            for cand in ex.map(_resolve, docs):
                if cand: out.append(cand)
    return out


def archive_redump_search(system_id, title):
    return _archive_collection_search('redump', 'archive_redump', system_id, title)


def archive_tosec_search(system_id, title):
    return _archive_collection_search('tosec', 'archive_tosec', system_id, title)


# ── Provider registry ───────────────────────────────────────────────────────
# All sources are direct-download (no browser / CAPTCHA).  Order here matters
# only for the manual dropdown ordering; ranking still goes through score.
PROVIDERS = {
    'archive':        {'search': archive_search,        'label': 'ARCHIVE.ORG'},
    'archive_packs':  {'search': archive_packs_search,  'label': 'ARCHIVE · PACKS'},
    'archive_redump': {'search': archive_redump_search, 'label': 'ARCHIVE · REDUMP'},
    'archive_tosec':  {'search': archive_tosec_search,  'label': 'ARCHIVE · TOSEC'},
}


def fan_out_search(system_id, title, providers=None, timeout=12):
    """Run search() across registered providers in parallel; merge + rank."""
    targets = providers or list(PROVIDERS.keys())
    out = []
    def _run(name):
        fn = PROVIDERS.get(name, {}).get('search')
        if not fn: return []
        try: return list(fn(system_id, title) or [])
        except Exception as e:
            print(f'[rom_providers/{name}] search failed: {e}')
            return []
    with ThreadPoolExecutor(max_workers=max(1, len(targets))) as ex:
        futs = {ex.submit(_run, n): n for n in targets}
        try:
            for f in as_completed(futs, timeout=timeout):
                out.extend(f.result())
        except FuturesTimeoutError:
            # Some providers stalled past the deadline; return whatever the
            # rest already produced rather than dropping the whole fan-out.
            for f, name in futs.items():
                if f.done():
                    try: out.extend(f.result())
                    except Exception: pass
                else:
                    print(f'[rom_providers/{name}] timed out (>{timeout}s) — partial results returned')
                    f.cancel()
    for c in out:
        c['score'] = score_candidate(c, title)
    out.sort(key=lambda c: c.get('score', 0), reverse=True)
    return out
