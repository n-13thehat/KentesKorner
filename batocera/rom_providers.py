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
import base64
import urllib.parse
import urllib.request
import urllib.error
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeoutError

from theater_providers import (
    _cache_get, _cache_put, _http_text, _http_text_resilient, UA,
)

# ── Region detection (mirrors js/cloud_launch.js RGN_*) ─────────────────────
RGN_USA = re.compile(r'\((USA|US|United States|World|U,)\)|\bUSA\b', re.I)
RGN_EU  = re.compile(r'\((Europe|EU|UK|Germany|France|Italy|Spain|E)\)|\bEUR\b', re.I)
RGN_JP  = re.compile(r'\((Japan|JP|Asia|Korea|J,)\)|\bJPN\b', re.I)


def _detect_region(name):
    if RGN_USA.search(name): return 'usa'
    if RGN_EU.search(name):  return 'eu'
    if RGN_JP.search(name):  return 'jp'
    return 'unknown'


# ── Per-system valid ROM extensions (mirrors ROM_EXT in js/config.js) ───────
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


# Disc-based systems where multi-track .cue/.bin dumps are common.  For these,
# a bare .zip/.7z (single archive holding the full dump) and single-file
# formats (.chd/.pbp/.cso) are strongly preferred over a solo .cue, because
# the .cue is just a 1-2 KB index that's useless without its .bin tracks.
DISC_SYSTEMS = frozenset((
    'ps1', 'ps2', 'psp', 'saturn', 'segacd', 'dreamcast',
    'gamecube', 'wii', 'wiiu', 'xbox', 'xbox360', 'ps3',
))

# Extension preference per system, best-first.  Mirrors kente-server.py _PREFS
# but covers archive-container formats too.  Lower index → higher preference.
_EXT_RANK = {
    'ps1':       ('.chd', '.pbp', '.zip', '.7z', '.rar', '.iso', '.cue', '.bin', '.img'),
    'ps2':       ('.chd', '.zip', '.7z', '.iso', '.cue', '.bin'),
    'psp':       ('.chd', '.cso', '.zip', '.7z', '.iso', '.pbp'),
    'saturn':    ('.chd', '.zip', '.7z', '.iso', '.cue', '.bin'),
    'segacd':    ('.chd', '.zip', '.7z', '.iso', '.cue', '.bin'),
    'dreamcast': ('.chd', '.gdi', '.zip', '.7z', '.cdi', '.iso'),
    'gamecube':  ('.rvz', '.nkit.iso', '.zip', '.7z', '.iso', '.gcm', '.wbfs'),
    'wii':       ('.rvz', '.nkit.iso', '.zip', '.7z', '.wbfs', '.iso', '.gcm'),
    'wiiu':      ('.wud', '.wux', '.zip', '.7z', '.iso'),
    'xbox':      ('.iso', '.xiso', '.zip', '.7z'),
    'xbox360':   ('.iso', '.zip', '.7z'),
    'ps3':       ('.iso', '.pkg', '.zip', '.7z'),
    'n64':       ('.z64', '.v64', '.n64', '.zip'),
    'nds':       ('.nds', '.zip'),
    'snes':      ('.sfc', '.smc', '.zip'),
    'nes':       ('.nes', '.zip'),
    'gameboy':   ('.gb', '.zip'),
    'gbc':       ('.gbc', '.zip'),
    'gba':       ('.gba', '.zip'),
    'genesis':   ('.md', '.gen', '.smd', '.bin', '.zip'),
    'mastersys': ('.sms', '.zip'),
    'gamegear':  ('.gg', '.zip'),
    'sega32x':   ('.32x', '.zip'),
    'turbografx':('.pce', '.zip'),
    'neogeo':    ('.neo', '.zip'),
    'atari2600': ('.a26', '.bin', '.zip'),
    'atari7800': ('.a78', '.bin', '.zip'),
}


def _ext_rank_score(filename, system_id):
    """Return [0..1] preference score for filename's extension on system_id.
    Higher = more preferred. Returns 0 if no per-system table defined."""
    order = _EXT_RANK.get(system_id)
    if not order: return 0.0
    name_low = filename.lower()
    # nkit.iso must match before .iso since both end in .iso
    for idx, ext in enumerate(order):
        if name_low.endswith(ext):
            return 1.0 - (idx / max(1, len(order)))
    return 0.0


def _has_companion_bin(filename, all_names):
    """True iff the basename of `filename` has a sibling .bin/.img track.
    Used to reject orphaned .cue files (1-2 KB text index with no audio data)."""
    name_low = filename.lower()
    if not (name_low.endswith('.cue') or name_low.endswith('.ccd')):
        return True
    stem = name_low.rsplit('.', 1)[0]
    # Match either exact-stem siblings or numbered tracks ("game (track 02).bin")
    for n in all_names:
        nl = n.lower()
        if nl == name_low: continue
        if nl.endswith(('.bin', '.img', '.sub')):
            if nl.startswith(stem) or stem in nl.rsplit('.', 1)[0]:
                return True
    return False


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
    'vimm':           0.10,   # preservation gold-standard, single best dump per title
    'archive_packs':  0.08,   # hand-picked per-system packs
    'archive_tosec':  0.04,   # historical / preservation set
    'archive':        0.0,    # broad fallback
    'coolrom':       -0.05,   # browse-page links only, JS-rendered listings
    'cdromance':     -0.05,   # external file-host downloads (page-link only)
    'hshop':         -0.05,   # 3DS-only, authenticated 3hs client downloads
    'myrient':       -0.10,   # site shut down 2026-03-31; reserved slot
    'emuparadise':   -0.10,   # downloads disabled since 2018; reserved slot
}
REGION_BIAS   = {'usa': 0.15, 'world': 0.12, 'eu': 0.05, 'jp': 0.0, 'unknown': 0.02}

def score_candidate(c, query):
    title = query or ''
    sid = (c.get('systemId') or '').lower()
    fname_low = (c.get('filename') or '').lower()
    overlap = _title_overlap(c.get('filename') or '', title)
    base = overlap * 1.0
    base += REGION_BIAS.get((c.get('region') or 'unknown').lower(), 0.0)
    base += PROVIDER_BIAS.get((c.get('provider') or '').lower(), 0.0)
    # Container preference flips per system: cartridge systems prefer raw ROMs
    # (extracted), disc systems prefer single-archive .zip (carries cue+bin set).
    is_container = fname_low.endswith('.zip') or fname_low.endswith('.7z') \
        or fname_low.endswith('.rar')
    if is_container:
        if sid in DISC_SYSTEMS:
            base += 0.04   # boost: a .zip on a disc system likely holds cue+bin
        else:
            base -= 0.03   # cartridge: a raw .nes/.sfc beats a .zip wrapper
    # Extension-rank bonus (0..0.15) so .chd/.pbp beat .cue on PS1, .gdi beats
    # .cdi on Dreamcast, etc.  Caps at 0.15 to avoid swamping title overlap.
    if sid:
        base += _ext_rank_score(fname_low, sid) * 0.15
    # Solo .cue / .ccd is unusable without companion data tracks — hard penalty
    # so any sibling format wins.  The picker still emits the candidate so a
    # bundling layer (server-side cue+bin → zip) can rescue it later.
    if fname_low.endswith('.cue') or fname_low.endswith('.ccd'):
        if not c.get('hasCompanionBin'):
            base -= 0.50
    if c.get('size'):
        base += 0.02   # size known (download progress can render)
    return round(base, 4)


# ── Archive.org provider ────────────────────────────────────────────────────
# Mirrors the multi-phase searchArchive() in js/cloud.js, then resolves each item
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
    """Pick the best file in an item.

    Ranking (higher is better):
      1. Title-word overlap with the requested game.
      2. Extension preference per system (_EXT_RANK) — favours single-file
         formats (.chd/.pbp/.rvz) and full archives (.zip/.7z) over multi-track
         dumps; rejects solo .cue/.ccd files with no companion .bin.
      3. USA region > untagged > EU > JP.

    Returns a dict mirroring the original `files[i]` plus a `hasCompanionBin`
    flag the scorer downstream uses to apply the orphan-cue penalty.
    """
    valid = [f for f in files if _ext_match(f['name'], system_id)]
    if not valid: return None
    all_names = [f['name'] for f in files]
    twords = set(_norm_words(title))

    def _rank_key(f):
        nm = f['name']
        nm_low = nm.lower()
        overlap = len(set(_norm_words(nm)) & twords) if twords else 0
        ext_score = _ext_rank_score(nm_low, system_id)
        rgn = (1 if RGN_USA.search(nm)
               else 0 if not (RGN_EU.search(nm) or RGN_JP.search(nm)) else -1)
        # Orphan .cue/.ccd is unusable — push to bottom but don't drop entirely;
        # the bundling layer can still recover it if no better candidate exists.
        orphan_penalty = 0
        if nm_low.endswith('.cue') or nm_low.endswith('.ccd'):
            if not _has_companion_bin(nm, all_names):
                orphan_penalty = -10
        return (orphan_penalty, overlap, ext_score, rgn, -(f.get('size') or 0))

    scored = sorted(valid, key=_rank_key, reverse=True)
    pick = scored[0] if scored else None
    if pick:
        pick = dict(pick)
        pick['hasCompanionBin'] = _has_companion_bin(pick['name'], all_names)
    return pick


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
            'systemId': system_id,
            'hasCompanionBin': pick.get('hasCompanionBin', True),
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
    all_names = [f['name'] for f in files]
    ranked = []
    for f in files:
        if not _ext_match(f['name'], system_id): continue
        fwords = set(_norm_words(f['name']))
        overlap = len(fwords & twords) / len(twords)
        if overlap < 0.6: continue
        ranked.append((overlap, f))
    ranked.sort(key=lambda r: (
        r[0],
        _ext_rank_score(r[1]['name'], system_id),
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
            'systemId': system_id,
            'hasCompanionBin': _has_companion_bin(f['name'], all_names),
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
            'systemId': system_id,
            'hasCompanionBin': pick.get('hasCompanionBin', True),
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


# ── CoolROM / Myrient / Emuparadise providers ───────────────────────────────
# These three are registered so the fan-out search visibly covers them and
# their cards show up in the SOURCE dropdown.  Upstream status as of today:
#
#   • Myrient     — shut down 2026-03-31. Hard zero; reserved for revival.
#   • Emuparadise — downloads disabled since 2018 (referrer-locked workaround
#                   only works inside a real Chrome session, not stdlib).
#   • CoolROM     — alive, but text search returns 0 results and listing pages
#                   are JS-rendered (yall lazyload), so static scraping yields
#                   little.  Direct downloads are Cloudflare/referrer-locked.
#
# Each search() returns []  on the common path so fan_out_search degrades
# silently.  A one-shot warning is logged the first time the function is
# called so the operator can see why the slot is empty.

_WARNED = set()
def _warn_once(key, msg):
    if key in _WARNED: return
    _WARNED.add(key)
    print(f'[rom_providers] {msg}')


# CoolROM Kente-systemId → URL slug.  Only systems CoolROM still hosts.
_COOLROM_SLUG = {
    'psx': 'psx', 'ps1': 'psx', 'ps2': 'ps2', 'psp': 'psp',
    'snes': 'snes', 'nes': 'nes', 'n64': 'n64', 'gba': 'gba',
    'gbc': 'gbc', 'gameboy': 'gb', 'nds': 'nds', 'gamecube': 'gamecube',
    'wii': 'wii', 'genesis': 'genesis', 'mastersys': 'sms',
    'gamegear': 'gg', 'segacd': 'segacd', 'saturn': 'saturn',
    'dreamcast': 'dreamcast', 'neogeo': 'neogeo', 'turbografx': 'turbografx',
}
_COOLROM_HREF_RE = re.compile(
    r'href="(/roms/(?P<slug>[a-z0-9]+)/(?P<id>\d+)/(?P<name>[^"]+)\.html)"',
    re.I,
)


def coolrom_search(system_id, title, max_items=6):
    """Best-effort scrape of CoolROM browse-by-letter listings.

    Returns page-link candidates only (no direct download URL) because
    CoolROM's actual .zip endpoints sit behind Cloudflare + Referer checks
    that block backend `urllib.request` calls.  The candidate's `url` points
    at the game's HTML page; the frontend's SAVE button will hit /api/rom-proxy
    which will reject the host today (good — surfaces the limitation), or
    succeed in the future if a referrer-relay is added.
    """
    slug = _COOLROM_SLUG.get(system_id)
    if not slug or not title: return []
    first = (title.strip()[:1] or '').upper()
    if not first.isalpha():
        first = '#'
    page_url = f'https://coolrom.com.au/roms/{slug}/?letter={urllib.parse.quote(first)}'
    cached = _cache_get(page_url)
    if cached is None:
        try:
            html = _http_text_resilient(page_url, timeout=8, retries=1)
        except Exception as e:
            _warn_once('coolrom_fetch', f'coolrom listing fetch failed: {e}')
            _cache_put(page_url, [], ttl=300)
            return []
        cached = _COOLROM_HREF_RE.findall(html)
        _cache_put(page_url, cached, ttl=1800)
    if not cached:
        _warn_once('coolrom_empty',
                   'coolrom returned no static listings (JS-rendered) — '
                   'provider registered but yields page-link results only')
        return []
    twords = set(_norm_words(title))
    if not twords: return []
    ranked = []
    for href, _slug, _gid, name in cached:
        display = urllib.parse.unquote(name).replace('-', ' ')
        overlap = _title_overlap(display, title)
        if overlap < 0.5: continue
        ranked.append((overlap, href, display))
    ranked.sort(key=lambda r: r[0], reverse=True)
    out = []
    for _ov, href, display in ranked[:max_items]:
        out.append({
            'provider': 'coolrom',
            'url':      f'https://coolrom.com.au{href}',
            'filename': display + '.zip',
            'size':     None,
            'region':   _detect_region(display),
            'extras':   {'page_only': True, 'note': 'CoolROM page link — Cloudflare-gated download'},
        })
    return out


def myrient_search(system_id, title):
    """Reserved provider slot — Myrient was shut down on 2026-03-31."""
    _warn_once('myrient_dead',
               'myrient.erista.me was shut down on 2026-03-31 — provider '
               'registered but returns no results until a mirror appears')
    return []


def emuparadise_search(system_id, title):
    """Reserved provider slot — Emuparadise downloads disabled since 2018."""
    _warn_once('emuparadise_dead',
               'emuparadise.me has had downloads disabled site-wide since '
               '2018 — provider registered but returns no results')
    return []


# ── Vimm's Lair provider ────────────────────────────────────────────────────
# vimm.net is the gold-standard preservation site for cartridge-era systems
# (NES through 3DS) plus PS1/PS2.  Two-phase scrape:
#   1. /vault/?p=list&q=<title>[&system=CODE]  →  rows of <a href= "/vault/N">
#   2. /vault/<id>  →  let media=[{ID, GoodTitle(b64), Zipped, ...}];
#                      and  <form action="//dlN.vimm.net/" ...>
# Downloads from dl*.vimm.net require Referer: https://vimm.net/ — the
# /api/rom-proxy in kente-server.py adds that header for dl*.vimm.net hosts.

_VIMM_SYS = {
    'nes': 'NES', 'snes': 'SNES', 'gameboy': 'GB', 'gbc': 'GBC', 'gba': 'GBA',
    'mastersys': 'SMS', 'gamegear': 'GG', 'genesis': 'Genesis', 'sega32x': '32X',
    'segacd': 'SegaCD', 'saturn': 'Saturn', 'dreamcast': 'Dreamcast',
    'turbografx': 'TG16', 'n64': 'N64', 'gamecube': 'GameCube', 'wii': 'Wii',
    'wiiware': 'WiiWare', 'nds': 'DS', '3ds': '3DS',
    'ps1': 'PS1', 'psx': 'PS1', 'ps2': 'PS2', 'ps3': 'PS3', 'psp': 'PSP',
    'xbox': 'Xbox', 'xbox360': 'Xbox360',
    'atari2600': 'Atari2600', 'atari5200': 'Atari5200', 'atari7800': 'Atari7800',
    'jaguar': 'Jaguar', 'lynx': 'Lynx', 'virtualboy': 'VB',
}
# When the search URL filters by system, Vimm drops the system column from
# its result rows, so we match the title anchor directly (cheaper + survives
# either layout).  The literal space inside  `href= "..."`  is exactly how
# Vimm renders the markup — keep `\s*` after `href=` to tolerate either.
_VIMM_ANCHOR_RE = re.compile(
    r'<a\s+href=\s*"/vault/(\d+)"[^>]*>\s*([^<]+?)\s*</a>', re.S,
)
_VIMM_MEDIA_RE = re.compile(r'let\s+media\s*=\s*(\[[^;]*\]);', re.S)
_VIMM_DLHOST_RE = re.compile(r'action="//(dl\d+\.vimm\.net)/"', re.I)


def _vimm_resolve(game_id, system_id, title):
    """Fetch /vault/<id>, return Candidate or None on failure / unavailable."""
    url = f'https://vimm.net/vault/{game_id}'
    cached = _cache_get(url)
    if cached is not None:
        return cached or None  # cache stores [] for known-bad to avoid retries
    try:
        html = _http_text_resilient(url, timeout=10, retries=1)
    except Exception as e:
        print(f'[rom_providers/vimm] detail fetch failed for {game_id}: {e}')
        _cache_put(url, [], ttl=300)
        return None
    m = _VIMM_MEDIA_RE.search(html)
    h = _VIMM_DLHOST_RE.search(html)
    if not m or not h:
        _cache_put(url, [], ttl=3600)
        return None
    try:
        media = json.loads(m.group(1))
        if not media: raise ValueError('empty media')
        m0   = media[0]
        mid  = m0.get('ID')
        b64  = m0.get('GoodTitle') or ''
        fname = base64.b64decode(b64).decode('utf-8', 'ignore') if b64 else ''
        # Vimm wraps every download as a .7z archive (verified via Content-
        # Disposition: 'Tekken 3 (USA).7z') — the scraped GoodTitle is the
        # bare title, so append the extension so find_and_launch_rom's
        # extractor pipeline picks it up.
        if fname and '.' not in fname.rsplit('/', 1)[-1]:
            fname += '.7z'
        # Vimm's `Zipped` field is in KB (matches the page's "439 MB" badge for
        # vault/50787 where Zipped=449130).  All other providers report bytes,
        # so convert here for a consistent Candidate.size unit.
        size = (int(m0.get('Zipped') or 0) * 1024) or None
    except Exception as e:
        print(f'[rom_providers/vimm] media parse failed for {game_id}: {e}')
        _cache_put(url, [], ttl=3600)
        return None
    if not mid or not fname:
        _cache_put(url, [], ttl=3600)
        return None
    # The "Download unavailable" tooltip is in a permanently-hidden <tr>;
    # presence of the dl_form + parsed media JSON is the reliable signal
    # that an actual download exists.  No additional check needed here.
    cand = {
        'provider': 'vimm',
        'url':      f'https://{h.group(1)}/?mediaId={mid}',
        'filename': fname,
        'size':     size,
        'region':   _detect_region(fname),
        'extras':   {'vault_id': game_id, 'media_id': mid,
                     'referer': 'https://vimm.net/'},
    }
    _cache_put(url, cand, ttl=3600)
    return cand


def vimm_search(system_id, title, max_items=6):
    """Search vimm.net Vault and resolve top results to direct dl URLs.

    Vimm doesn't index arcade/NeoGeo/etc; if `system_id` isn't in _VIMM_SYS
    we return [] immediately rather than spamming queries that always miss.
    """
    if not title: return []
    sys_code = _VIMM_SYS.get(system_id)
    if not sys_code: return []
    qs = {'p': 'list', 'q': title, 'system': sys_code}
    list_url = 'https://vimm.net/vault/?' + urllib.parse.urlencode(qs)
    cached = _cache_get(list_url)
    if cached is None:
        try:
            html = _http_text_resilient(list_url, timeout=10, retries=1)
        except Exception as e:
            _warn_once('vimm_fetch', f'vimm search fetch failed: {e}')
            _cache_put(list_url, [], ttl=300)
            return []
        # Pre-trim to the results table so the regex can't snag stray anchors
        # in the page header / footer (e.g. the system-picker dropdown).
        body = html
        i = body.find('<table')
        if i >= 0: body = body[i:]
        anchors = _VIMM_ANCHOR_RE.findall(body)
        twords  = set(_norm_words(title))
        ranked  = []
        seen    = set()
        for gid, t in anchors:
            if gid in seen: continue
            seen.add(gid)
            overlap = (len(set(_norm_words(t)) & twords) / len(twords)) if twords else 0
            if overlap < 0.5: continue
            ranked.append((overlap, gid, t))
        ranked.sort(key=lambda r: r[0], reverse=True)
        cached = ranked[:max_items]
        _cache_put(list_url, cached, ttl=900)
    if not cached:
        return []
    out = []
    with ThreadPoolExecutor(max_workers=min(4, len(cached))) as ex:
        for cand in ex.map(lambda r: _vimm_resolve(r[1], system_id, title), cached):
            if cand: out.append(cand)
    return out


# ── CDRomance / hShop (registered, page-link upstreams) ────────────────────
# Both sites are alive but auto-download from a Python backend is impractical:
#   • cdromance.org  — download buttons jump to external file-hosts (mediafire,
#     1fichier, GoFile) that require browser interaction / captchas.
#   • hshop.erista.me — actual ROM bytes are gated by the 3hs client's
#     authenticated API; static HTML never reveals direct .cia URLs.
# They're registered so users can see them in the SOURCE catalog; future work
# can swap these for full integrations if a backend-friendly path appears.

def cdromance_search(system_id, title):
    _warn_once('cdromance_pageonly',
               'cdromance.org downloads go through external file hosts '
               '(mediafire / 1fichier) — provider registered but returns no '
               'direct-download candidates')
    return []


def hshop_search(system_id, title):
    if system_id != '3ds':
        return []
    _warn_once('hshop_pageonly',
               'hshop.erista.me serves .cia files through its 3hs client '
               'API, not static URLs — provider registered for 3DS but '
               'returns no direct-download candidates')
    return []


# ── Provider registry ───────────────────────────────────────────────────────
# All sources are direct-download (no browser / CAPTCHA).  Order here matters
# only for the manual dropdown ordering; ranking still goes through score.
PROVIDERS = {
    'archive':        {'search': archive_search,        'label': 'ARCHIVE.ORG'},
    'archive_packs':  {'search': archive_packs_search,  'label': 'ARCHIVE · PACKS'},
    'archive_redump': {'search': archive_redump_search, 'label': 'ARCHIVE · REDUMP'},
    'archive_tosec':  {'search': archive_tosec_search,  'label': 'ARCHIVE · TOSEC'},
    'vimm':           {'search': vimm_search,           'label': "VIMM'S LAIR"},
    'cdromance':      {'search': cdromance_search,      'label': 'CDROMANCE'},
    'hshop':          {'search': hshop_search,          'label': 'HSHOP'},
    'coolrom':        {'search': coolrom_search,        'label': 'COOLROM'},
    'myrient':        {'search': myrient_search,        'label': 'MYRIENT'},
    'emuparadise':    {'search': emuparadise_search,    'label': 'EMUPARADISE'},
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
        # Stamp the system id so score_candidate() can apply per-system
        # extension-rank and container preferences without each provider
        # having to do it itself.
        c.setdefault('systemId', system_id)
        # Default hasCompanionBin to True when unknown so we only penalise
        # candidates the picker has positively flagged as orphans.
        c.setdefault('hasCompanionBin', True)
        c['score'] = score_candidate(c, title)
    out.sort(key=lambda c: c.get('score', 0), reverse=True)
    return out
