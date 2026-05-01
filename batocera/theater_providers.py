"""
Kente's Korner — Theater stream providers.

Each provider exposes:
    browse(kind, page, genre=None, sort=None) -> { items, page, hasMore }
    details(kind, slug)                       -> { id, title, year, poster, backdrop, synopsis, type, seasons? }
    stream(kind, slug, episode_id=None)       -> { streams: {q: m3u8}, subtitles, headers? }

Stdlib only — kente-server.py is intentionally pip-free.
"""
import urllib.request, urllib.parse, urllib.error
import json, re, time, threading, html as html_mod
from html.parser import HTMLParser

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

# ── tiny TTL cache for listing pages ────────────────────────────────────────
_CACHE_LOCK = threading.Lock()
_CACHE = {}                       # key -> (expires_epoch, value)

def _cache_get(key):
    with _CACHE_LOCK:
        ent = _CACHE.get(key)
        if ent and ent[0] > time.time():
            return ent[1]
        if ent:
            _CACHE.pop(key, None)
    return None

def _cache_put(key, value, ttl=900):
    with _CACHE_LOCK:
        _CACHE[key] = (time.time() + ttl, value)

def _http_get(url, headers=None, timeout=10):
    h = {'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9'}
    if headers: h.update(headers)
    req = urllib.request.Request(url, headers=h)
    return urllib.request.urlopen(req, timeout=timeout)

def _http_text(url, headers=None, timeout=10):
    return _http_get(url, headers, timeout).read().decode('utf-8', 'ignore')


def _http_text_resilient(url, headers=None, timeout=10, retries=1, backoff=0.6):
    """_http_text with one retry on transient 5xx / network errors."""
    last_err = None
    for attempt in range(retries + 1):
        try:
            return _http_text(url, headers, timeout)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (500, 502, 503, 504) and attempt < retries:
                time.sleep(backoff); continue
            raise
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(backoff); continue
            raise
    if last_err: raise last_err   # pragma: no cover


# ── AI synopsis fallback (AniList → Wikipedia) ─────────────────────────────
# Both endpoints are free, no key required. Used to enrich detail envelopes
# when the upstream provider returns no synopsis (or just an SEO meta tag),
# and to populate offline-fallback envelopes when an upstream is down.
_AI_HTML_BR = re.compile(r'<br\s*/?>', re.I)
_AI_HTML_TAG = re.compile(r'<[^>]+>')
_AI_NEG_HINT = re.compile(r'^Watch .* All Episodes', re.I)

_ANILIST_NORM_RE = re.compile(r'[^a-z0-9]+')

def _anilist_norm(s):
    """Normalize a title for fuzzy comparison: lowercase, strip non-alnum."""
    return _ANILIST_NORM_RE.sub('', (s or '').lower())


def _ai_anilist(title):
    body = json.dumps({
        'query': ('query ($s: String) { Media (search: $s, sort: SEARCH_MATCH) { '
                  'id idMal format episodes '
                  'title { romaji english native } synonyms '
                  'description(asHtml: false) coverImage { extraLarge large } '
                  'bannerImage startDate { year } } }'),
        'variables': {'s': title},
    }).encode('utf-8')
    req = urllib.request.Request(
        'https://graphql.anilist.co', data=body, method='POST',
        headers={'User-Agent': UA, 'Content-Type': 'application/json',
                 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=8) as r:
        data = json.loads(r.read().decode('utf-8', 'ignore'))
    m = (data.get('data') or {}).get('Media') or {}
    desc = (m.get('description') or '').strip()
    if desc:
        desc = _AI_HTML_BR.sub('\n', desc)
        desc = _AI_HTML_TAG.sub('', desc).strip()
    img = (m.get('coverImage') or {}).get('extraLarge') \
        or (m.get('coverImage') or {}).get('large') \
        or m.get('bannerImage')
    yr = (m.get('startDate') or {}).get('year')
    # Side-channel: cache the AniList numeric id so anime-only embed
    # providers (vidplus, etc) can resolve it without a second round trip.
    # Strict title verification \u2014 AniList's SEARCH_MATCH returns something
    # for almost any query, so we confirm the requested title actually
    # appears in romaji/english/native/synonyms before trusting the id.
    aid = m.get('id')
    if title and aid:
        cand = []
        t = m.get('title') or {}
        for k in ('romaji', 'english', 'native'):
            if t.get(k): cand.append(t[k])
        for syn in (m.get('synonyms') or []):
            if syn: cand.append(syn)
        want = _anilist_norm(title)
        ok = False
        for c in cand:
            n = _anilist_norm(c)
            if not n: continue
            if n == want or want in n or n in want:
                ok = True; break
        if ok:
            _cache_put('anilist-id:' + title.strip().lower(), int(aid), ttl=86400 * 7)
    return (desc or None, img or None, yr or None)


def _anilist_id_for(title):
    """Title -> AniList numeric id (or None). Cached 7 days; failures cached
    24 h so repeated lookups for live-action titles don't hammer AniList.
    Only returns an id when the AniList result's title (romaji/english/
    native/synonym) matches the request \u2014 protects against fuzzy hits on
    live-action titles like 'Breaking Bad'."""
    t = (title or '').strip()
    if not t:
        return None
    key = 'anilist-id:' + t.lower()
    cached = _cache_get(key)
    if cached is not None:
        return cached or None
    try:
        # _ai_anilist primes the cache as a side-effect; re-read it.
        _ai_anilist(t)
    except Exception as e:
        print(f'[anilist/id] {t!r}: {e}')
    cached = _cache_get(key)
    if cached:
        return cached
    _cache_put(key, 0, ttl=86400)   # negative cache
    return None


def _ai_wikipedia(title):
    url = ('https://en.wikipedia.org/api/rest_v1/page/summary/'
           + urllib.parse.quote(title, safe=''))
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=8) as r:
        data = json.loads(r.read().decode('utf-8', 'ignore'))
    if (data.get('type') or '') == 'disambiguation':
        return (None, None, None)
    extract = (data.get('extract') or '').strip()
    img = (data.get('thumbnail') or {}).get('source')
    return (extract or None, img or None, None)


def _ai_synopsis(title, kind='show', prefer='auto'):
    """Return (synopsis, poster, year) for `title` from AniList → Wikipedia.
    Cached 24 h per title. Failures cache as the empty triple so we don't
    re-hammer the upstreams on the same title.

    `prefer` controls source order:
      'auto' (default) — Wikipedia first when kind == 'movie', else AniList first.
      'wiki'           — Wikipedia first regardless. Use for IMDB-based
                         embed providers, which are overwhelmingly live-action.
      'anilist'        — AniList first regardless. Use for anime-only providers.
    """
    t = (title or '').strip()
    if not t:
        return (None, None, None)
    key = f'ai-syn:{t.lower()}:{kind}:{prefer}'
    cached = _cache_get(key)
    if cached is not None:
        return cached
    out = (None, None, None)
    if prefer == 'wiki':
        prefer_wiki = True
    elif prefer == 'anilist':
        prefer_wiki = False
    else:
        prefer_wiki = (kind == 'movie')
    if prefer_wiki:
        try: out = _ai_wikipedia(t)
        except Exception as e:
            print(f'[ai/wiki] {t!r}: {e}')
        if not out[0]:
            try: out = _ai_anilist(t)
            except Exception as e:
                print(f'[ai/anilist] {t!r}: {e}')
    else:
        try: out = _ai_anilist(t)
        except Exception as e:
            print(f'[ai/anilist] {t!r}: {e}')
        if not out[0]:
            try: out = _ai_wikipedia(t)
            except Exception as e:
                print(f'[ai/wiki] {t!r}: {e}')
    _cache_put(key, out, ttl=86400)
    return out


def _is_seo_synopsis(s):
    """True if a synopsis is just the upstream SEO meta-tag template."""
    if not s: return True
    return bool(_AI_NEG_HINT.match(s.strip()))


# ════════════════════════════════════════════════════════════════════════════
# LOOKMOVIE2 PROVIDER
# ════════════════════════════════════════════════════════════════════════════
LM_BASE = 'https://www.lookmovie2.to'

# Kente category id → lookmovie listing URL builder.
# Listing pages all return the same .movie-item-style cards we parse below.
def _lm_listing_url(kind, page=1, genre=None, sort=None):
    # kind: 'movies' | 'shows'
    if genre:
        # /movies/genre/animation/page/2  (singular, lowercase)
        slug = urllib.parse.quote(genre.lower().replace(' ', '-'))
        return f'{LM_BASE}/{kind}/genre/{slug}/page/{page}'
    return f'{LM_BASE}/{kind}/page/{page}'


_CARD_SPLIT = re.compile(r'<div\s+class="movie-item-style-2[^"]*"', re.I)
_HREF_RE    = re.compile(r'href="/(movies|shows)/view/(\d+)-([a-z0-9-]+)(?:\?[^"]*)?"', re.I)
_DATA_SRC_RE = re.compile(r'data-src="([^"]+\.(?:webp|jpg|jpeg|png))"', re.I)
_ALT_RE      = re.compile(r'<img[^>]+alt="([^"]+)"', re.I)
_H6_TITLE_RE = re.compile(r'<h6[^>]*>\s*(?:<a[^>]*>)?\s*([^<]+?)\s*(?:</a>)?\s*</h6>', re.I)
_YEAR_P_RE   = re.compile(r'<p\s+class="year"[^>]*>\s*(\d{4})\s*</p>', re.I)
_RATING_RE   = re.compile(r'<p\s+class="rate"[^>]*>[\s\S]*?<span[^>]*>\s*(\d+(?:\.\d+)?)\s*</span>\s*/\s*10', re.I)
_QUALITY_RE  = re.compile(r'<div\s+class="(?:fhd|hd|sd|cam)-quality[^"]*"[^>]*>\s*([A-Za-z0-9]+)\s*</div>', re.I)
_TXT         = re.compile(r'<[^>]+>')


def _strip_tags(s):
    return html_mod.unescape(_TXT.sub('', s or '')).strip()


def _abs_image(src):
    if not src: return None
    if src.startswith('data:'): return None
    if src.startswith('//'): return 'https:' + src
    if src.startswith('/'):  return LM_BASE + src
    return src


def _lm_parse_listing(html_text, kind):
    """Yield {id, slug, title, year, poster, rating, quality, kind} per card.

    Cards are split on the `movie-item-style-2` div opener.  Each chunk is
    parsed independently so values don't bleed across cards.  For the
    shows landing page, hrefs include `?season=&episode=&id_episode=` and
    refer to recent episodes — we dedupe back to the parent show.
    """
    items = []
    seen = set()
    chunks = _CARD_SPLIT.split(html_text)[1:]   # discard prelude
    for chunk in chunks:
        # Limit chunk to ~3 KB (one card) so trailing markup can't pollute fields.
        chunk = chunk[:3000]
        href_m = _HREF_RE.search(chunk)
        if not href_m: continue
        k, idnum, slug = href_m.groups()
        full = f'{idnum}-{slug}'
        if full in seen: continue
        seen.add(full)
        # Title: prefer the `<h6>` link text; fall back to image alt; fall back to slug.
        title = None
        h6_m = _H6_TITLE_RE.search(chunk)
        if h6_m: title = _strip_tags(h6_m.group(1))
        if not title:
            alt_m = _ALT_RE.search(chunk)
            if alt_m: title = _strip_tags(alt_m.group(1))
        if not title:
            title = slug.replace('-', ' ').title()
        year_m    = _YEAR_P_RE.search(chunk)
        rating_m  = _RATING_RE.search(chunk)
        quality_m = _QUALITY_RE.search(chunk)
        img_m     = _DATA_SRC_RE.search(chunk)
        items.append({
            'id':       full,
            'slug':     slug,
            'idNum':    int(idnum),
            'title':    title,
            'year':     year_m.group(1) if year_m else None,
            'rating':   float(rating_m.group(1)) if rating_m else None,
            'quality':  quality_m.group(1).upper() if quality_m else None,
            'poster':   _abs_image(img_m.group(1)) if img_m else None,
            'kind':     'movie' if k == 'movies' else 'show',
            'provider': 'lookmovie',
        })
    return items


def lm_browse(kind='movies', page=1, genre=None, sort=None):
    """Return paginated listing of movies or shows. Cached 15 min per URL."""
    if kind not in ('movies', 'shows'):
        raise ValueError('kind must be movies|shows')
    url = _lm_listing_url(kind, page, genre, sort)
    cached = _cache_get(url)
    if cached: return cached
    page_html = _http_text(url)
    items = _lm_parse_listing(page_html, kind)
    has_more = 'rel="next"' in page_html or '?page=' in page_html
    result = {'items': items, 'page': page, 'hasMore': bool(items) and has_more,
              'source': url}
    _cache_put(url, result, ttl=900)
    return result


def lm_search(query, kind='movies'):
    """Search lookmovie. /<kind>/search?q=  returns standard card markup."""
    if kind not in ('movies', 'shows'):
        kind = 'movies'
    url = f'{LM_BASE}/{kind}/search?q={urllib.parse.quote(query)}'
    cached = _cache_get(url)
    if cached: return cached
    page_html = _http_text(url)
    items = _lm_parse_listing(page_html, kind)
    result = {'items': items, 'query': query, 'source': url}
    _cache_put(url, result, ttl=600)
    return result


# ── Curated slates ──────────────────────────────────────────────────────────
# Hand-picked title rows that resolve to lookmovie listings via search.
# Each entry is (title, kind) so anime films vs series resolve correctly.
CURATED_SLATES = {
    'top-anime': [
        ('One Piece', 'shows'), ('Demon Slayer', 'shows'),
        ('Attack on Titan', 'shows'), ('Jujutsu Kaisen', 'shows'),
        ('My Hero Academia', 'shows'), ('Naruto', 'shows'),
        ('Bleach', 'shows'), ('Hunter x Hunter', 'shows'),
        ('Fullmetal Alchemist Brotherhood', 'shows'), ('Death Note', 'shows'),
        ('Cowboy Bebop', 'shows'), ('One Punch Man', 'shows'),
        ('Spy x Family', 'shows'), ('Chainsaw Man', 'shows'),
        ('Tokyo Ghoul', 'shows'), ('Mob Psycho 100', 'shows'),
        ('Vinland Saga', 'shows'), ('Black Clover', 'shows'),
        ('Sword Art Online', 'shows'), ('Re:Zero', 'shows'),
    ],
    'classics': [
        ('Inuyasha', 'shows'), ('Ghost in the Shell', 'movies'),
        ('Akira', 'movies'), ('Cowboy Bebop', 'shows'),
        ('Trigun', 'shows'), ('Outlaw Star', 'shows'),
        ('Yu Yu Hakusho', 'shows'), ('Rurouni Kenshin', 'shows'),
        ('Samurai Champloo', 'shows'),
        ('Neon Genesis Evangelion', 'shows'),
        ('Princess Mononoke', 'movies'), ('Spirited Away', 'movies'),
        ('Avatar The Last Airbender', 'shows'),
        ('Castlevania', 'shows'), ('Gundam Wing', 'shows'),
        ('Sailor Moon', 'shows'), ('Dragon Ball', 'shows'),
        ('Tenchi Muyo', 'shows'),
    ],
    'action-franchises': [
        ('Naruto', 'shows'), ('Naruto Shippuden', 'shows'),
        ('Boruto', 'shows'), ('Dragon Ball Z', 'shows'),
        ('Dragon Ball Super', 'shows'), ('Dragon Ball GT', 'shows'),
        ('Pokemon', 'shows'), ('Pokemon Journeys', 'shows'),
        ('Beyblade', 'shows'), ('Beyblade Burst', 'shows'),
        ('Xiaolin Showdown', 'shows'),
        ('American Dragon Jake Long', 'shows'),
        ('Yu-Gi-Oh', 'shows'), ('Bakugan Battle Brawlers', 'shows'),
        ('Digimon', 'shows'), ('Avatar The Last Airbender', 'shows'),
        ('The Legend of Korra', 'shows'),
    ],
    'game-adaptations': [
        ('The Matrix', 'movies'), ('Tekken', 'movies'),
        ('Mortal Kombat', 'movies'), ('Resident Evil', 'movies'),
        ('Street Fighter', 'movies'), ('Sonic the Hedgehog', 'movies'),
        ('Detective Pikachu', 'movies'),
        ('The Super Mario Bros Movie', 'movies'),
        ('Uncharted', 'movies'), ('Tomb Raider', 'movies'),
        ("Assassin's Creed", 'movies'), ('Warcraft', 'movies'),
        ('Prince of Persia', 'movies'), ('Silent Hill', 'movies'),
        ('Need for Speed', 'movies'), ('Hitman', 'movies'),
        ('Doom', 'movies'),
        ('Arcane', 'shows'), ('The Last of Us', 'shows'),
        ('Castlevania', 'shows'), ('Cyberpunk Edgerunners', 'shows'),
    ],
}


def lm_curated(slate):
    """Resolve a curated slate of titles to lookmovie listings.
    Cached 24 h per slate; underlying lm_search() also caches each query.
    """
    titles = CURATED_SLATES.get(slate)
    if not titles:
        raise ValueError(f'unknown slate: {slate}')
    cache_key = f'curated:{slate}'
    cached = _cache_get(cache_key)
    if cached: return cached

    from concurrent.futures import ThreadPoolExecutor

    def lookup(entry):
        q, kind = entry
        try:
            data = lm_search(q, kind)
            items = data.get('items') or []
            if not items: return None
            ql = q.lower()
            # Prefer exact-prefix matches; fall back to first hit.
            best = next(
                (i for i in items if (i.get('title','') or '').lower().startswith(ql)),
                items[0])
            return best
        except Exception as e:
            print(f'[lm_curated/{slate}] {q!r}: {e}')
            return None

    with ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(lookup, titles))

    seen = set()
    items = []
    for r in results:
        if not r: continue
        uid = r.get('id') or r.get('slug')
        if uid in seen: continue
        seen.add(uid)
        items.append(r)

    out = {'items': items, 'slate': slate, 'count': len(items),
           'source': 'curated:' + slate}
    _cache_put(cache_key, out, ttl=86400)   # 24 h
    return out


# ── Detail / play page parsers ──────────────────────────────────────────────
# JS variables on play pages appear in two forms:
#   movie page :  id_movie: 12345,  hash: "abc",   expires: 1700000000
#   show page  :  window.id_show='49795'; ... hash: 'abc', expires: 1700...
# So all patterns tolerate:  : or =  separator,  optional " or ' around
# either the key (object literal) or the value (string-coerced numbers).
def _jsnum(name):
    return re.compile(r'(?:["\']' + name + r'["\']|' + name + r')\s*[:=]\s*["\']?(\d+)["\']?')
def _jsstr(name):
    return re.compile(r'(?:["\']' + name + r'["\']|' + name + r')\s*[:=]\s*["\']([^"\']+)["\']')

_RE_ID_MOVIE   = _jsnum('id_movie')
_RE_ID_SHOW    = _jsnum('id_show')
_RE_HASH       = _jsstr('hash')
_RE_EXPIRES    = _jsnum('expires')
_RE_TITLE_JS   = _jsstr('title')
_RE_YEAR_JS    = _jsnum('year')
_RE_POSTER_JS  = re.compile(r'(?:movie_poster|poster_medium)\s*[:=]\s*["\']([^"\']+)["\']')
_RE_BACKDROP   = re.compile(r'backdrop_(?:huge|medium|small)\s*[:=]\s*["\']([^"\']+)["\']')
_RE_SLUG_SHOW  = _jsstr('slug')
# Episode dicts may use either single or double quotes (escaped \" in show JSON).
_RE_EP_FIELDS  = re.compile(
    r'\{[^{}]*?["\']?title["\']?\s*:\s*["\']([^"\']*?)["\'][^{}]*?'
    r'["\']?episode(?:_number)?["\']?\s*:\s*["\']?(\d+)["\']?[^{}]*?'
    r'["\']?id_episode["\']?\s*:\s*["\']?(\d+)["\']?[^{}]*?'
    r'["\']?(?:season|season_number)["\']?\s*:\s*["\']?(\d+)["\']?[^{}]*?\}'
)
_RE_DESC_META  = re.compile(r'<meta\s+name="description"\s+content="([^"]+)"', re.I)
_RE_OG_IMG     = re.compile(r'<meta\s+property="og:image"\s+content="([^"]+)"', re.I)


_RE_SEASONS_JSON = re.compile(r'window\.seasons\s*=\s*([\'"])((?:\\.|(?!\1).)*)\1', re.S)


def _lm_parse_seasons(page_html):
    """Extract `window.seasons='<json>'` and normalise to a list-of-seasons.

    The site embeds a JSON object keyed by season number, where each value
    has an `episodes` map keyed by episode number.  We unescape the
    JS-string-quoted JSON and walk it.
    """
    m = _RE_SEASONS_JSON.search(page_html)
    if not m: return None
    raw = m.group(2)
    # JS string escapes -> JSON-safe.  Order matters: unescape \\ last.
    decoded = (raw.replace('\\"', '"').replace("\\'", "'")
                  .replace('\\/', '/').replace('\\\\', '\\'))
    try:
        obj = json.loads(decoded)
    except Exception:
        return None
    out = []
    for season_key in sorted(obj.keys(), key=lambda x: int(x) if str(x).isdigit() else 0):
        season_obj = obj[season_key] or {}
        eps_map = season_obj.get('episodes') or {}
        eps = []
        for ep_key in sorted(eps_map.keys(), key=lambda x: int(x) if str(x).isdigit() else 0):
            ep = eps_map[ep_key] or {}
            try:
                ep_id = int(ep.get('id_episode'))
            except (TypeError, ValueError):
                continue
            eps.append({
                'title':     ep.get('title') or f'Episode {ep_key}',
                'episode':   int(ep.get('episode_number') or ep_key),
                'season':    int(season_key),
                'idEpisode': ep_id,
                'airDate':   ep.get('air_date') or None,
                'still':     _abs_image(ep.get('still_path')) if ep.get('still_path') else None,
            })
        if eps:
            out.append({'season': int(season_key), 'episodes': eps})
    return out or None


def _lm_parse_play_page(page_html, kind):
    """Pull common fields from a /movies/play or /shows/play page."""
    out = {
        'id_movie':  None, 'id_show': None, 'hash': None, 'expires': None,
        'title':     None, 'year':   None, 'poster':  None, 'backdrop': None,
        'synopsis':  None, 'seasons': None, 'slug': None,
    }
    if kind == 'movie':
        m = _RE_ID_MOVIE.search(page_html);   out['id_movie'] = int(m.group(1)) if m else None
    else:
        m = _RE_ID_SHOW.search(page_html);    out['id_show']  = int(m.group(1)) if m else None
    m = _RE_HASH.search(page_html);     out['hash']     = m.group(1) if m else None
    m = _RE_EXPIRES.search(page_html);  out['expires']  = int(m.group(1)) if m else None
    m = _RE_TITLE_JS.search(page_html); out['title']    = m.group(1) if m else None
    m = _RE_YEAR_JS.search(page_html);  out['year']     = m.group(1) if m else None
    m = _RE_POSTER_JS.search(page_html);out['poster']   = _abs_image(m.group(1)) if m else None
    m = _RE_BACKDROP.search(page_html); out['backdrop'] = _abs_image(m.group(1)) if m else None
    m = _RE_SLUG_SHOW.search(page_html);out['slug']     = m.group(1) if m else None
    m = _RE_DESC_META.search(page_html);out['synopsis'] = html_mod.unescape(m.group(1)) if m else None
    if kind == 'show':
        out['seasons'] = _lm_parse_seasons(page_html)
    if not out['poster']:
        m = _RE_OG_IMG.search(page_html)
        if m: out['poster'] = m.group(1)
    return out


def _lm_deslug_title(slug):
    """'12345-the-show-title' → 'The Show Title'."""
    return re.sub(r'^\d+-', '', slug or '').replace('-', ' ').strip().title()


def _lm_offline_fallback(kind, slug, url, reason):
    """Best-effort detail envelope when lookmovie upstream is unreachable.
    First tries to resolve the deslugged title to an IMDB tt id and redirect
    through the embed chain (vidsrc/2embed/etc) so the title remains playable.
    Only when that also fails do we surface the 'streaming unavailable' stub.
    """
    title = _lm_deslug_title(slug)
    # Redirect path: IMDB suggest -> embed details. Lazy-imports to avoid
    # circular load order with theater_embed (which imports from this module).
    try:
        from theater_embed import imdb_lookup, _embed_details
        match = imdb_lookup(title, year=None, kind=kind)
        if match:
            tt_id, _norm_title, _yr, resolved_kind, _poster = match
            envelope = _embed_details(resolved_kind or kind, tt_id, 'vidsrc')
            envelope = dict(envelope)   # copy so we don't poison the embed cache
            envelope['redirectedFrom'] = 'lookmovie'
            envelope['redirectedReason'] = (str(reason) or '')[:200]
            print(f'[lm_details] redirected {slug!r} -> vidsrc {tt_id}')
            return envelope
    except Exception as e:
        print(f'[lm_details] embed redirect failed for {slug!r}: {e}')
    # Hard fallback: AI-only summary stub.
    syn, poster, year = _ai_synopsis(title, kind=kind)
    return {
        'id':        slug,
        'kind':      kind,
        'title':     title,
        'year':      year,
        'poster':    poster,
        'backdrop':  poster,
        'synopsis':  syn or 'Streaming source is temporarily unavailable for this title.',
        'seasons':   None,
        'provider':  'lookmovie',
        'sourceUrl': url,
        'unavailable':       True,
        'unavailableReason': (str(reason) or '')[:200],
    }


def lm_details(kind, slug):
    """slug is '<id>-<slug-text>'. Returns full title metadata.
    Resilient: retries once on transient 5xx, falls back to a stub envelope
    seeded by AI lookup when the upstream is hard-down so the UI keeps rendering.
    """
    if kind not in ('movie', 'show'):
        raise ValueError('kind must be movie|show')
    pluralized = 'movies' if kind == 'movie' else 'shows'
    url = f'{LM_BASE}/{pluralized}/play/{slug}'
    cached = _cache_get('details:' + url)
    if cached: return cached
    try:
        page_html = _http_text_resilient(url)
    except Exception as e:
        print(f'[lm_details] upstream unreachable for {slug!r}: {e}')
        result = _lm_offline_fallback(kind, slug, url, e)
        _cache_put('details:' + url, result, ttl=120)
        return result
    info = _lm_parse_play_page(page_html, kind)
    # Enrich missing/SEO-y synopsis from AI. Skip if upstream gave us real text.
    if (not info.get('synopsis')) and info.get('title'):
        syn, alt_poster, alt_year = _ai_synopsis(info['title'], kind=kind)
        if syn:        info['synopsis'] = syn
        if not info.get('poster') and alt_poster: info['poster'] = alt_poster
        if not info.get('year')   and alt_year:   info['year']   = alt_year
    # Resolve runtime via IMDB id (TVMaze for shows / OMDb for movies). Lazy
    # import to avoid circular load order; failures are tolerated silently
    # since runtime is purely a UI nicety.
    runtime = None
    try:
        from theater_embed import imdb_lookup, imdb_runtime
        match = imdb_lookup(info.get('title') or '', year=info.get('year'), kind=kind)
        if match:
            runtime = imdb_runtime(match[0], kind=kind)
    except Exception as e:
        print(f'[lm_details/runtime] {slug!r}: {e}')
    result = {
        'id':        slug,
        'kind':      kind,
        'title':     info['title'],
        'year':      info['year'],
        'poster':    info['poster'],
        'backdrop':  info['backdrop'],
        'synopsis':  info['synopsis'],
        'seasons':   info['seasons'],
        'runtime':   runtime,
        'provider':  'lookmovie',
        'sourceUrl': url,
    }
    _cache_put('details:' + url, result, ttl=600)
    return result


def _lm_play_url(kind, slug, episode_id=None):
    pluralized = 'movies' if kind == 'movie' else 'shows'
    url = f'{LM_BASE}/{pluralized}/play/{slug}'
    if episode_id and kind == 'show':
        url += f'?id_episode={episode_id}'
    return url


def lm_stream(kind, slug, episode_id=None):
    """
    Resolve a playable HLS stream for a movie or show episode.
    Two-step handshake:
      1. GET /<kind>s/play/<slug>[?id_episode=...]   → id, hash, expires
      2. GET /api/v1/security/{movie|episode}-access?id_=&token=&expires=
    """
    if kind not in ('movie', 'show'):
        raise ValueError('kind must be movie|show')
    play_url = _lm_play_url(kind, slug, episode_id)
    page_html = _http_text(play_url)
    info = _lm_parse_play_page(page_html, kind)
    hash_ = info['hash']; expires = info['expires']
    if not hash_ or not expires:
        raise RuntimeError('Could not extract playback token from play page')

    if kind == 'movie':
        item_id = info['id_movie']
        if not item_id:
            raise RuntimeError('Could not extract id_movie')
        api_path = f'/api/v1/security/movie-access?id_movie={item_id}&token={hash_}&expires={expires}'
    else:
        if not episode_id:
            # Default to first episode of first season for show landing
            seasons = info['seasons'] or []
            if not seasons or not seasons[0]['episodes']:
                raise RuntimeError('Show has no episodes listed')
            episode_id = seasons[0]['episodes'][0]['idEpisode']
            # Re-fetch with that episode to get matching hash/expires
            return lm_stream(kind, slug, episode_id)
        api_path = f'/api/v1/security/episode-access?id_episode={episode_id}&token={hash_}&expires={expires}'

    api_url = LM_BASE + api_path
    raw = _http_text(api_url, headers={
        'X-Requested-With': 'XMLHttpRequest',
        'Accept':           'application/json, text/plain, */*',
        'Referer':          play_url,
    })
    data = json.loads(raw)
    if not data.get('success'):
        raise RuntimeError(f"lookmovie access denied: {data.get('reason') or 'unknown'}")
    streams = {q: u for q, u in (data.get('streams') or {}).items() if u}
    if not streams:
        raise RuntimeError('No usable streams returned')
    subtitles = []
    for s in (data.get('subtitles') or []):
        # subtitle shape is { language, file, kind } in older builds; pass through.
        src = s.get('file') or s.get('url')
        if not src: continue
        if src.startswith('/'): src = LM_BASE + src
        subtitles.append({
            'lang':  s.get('language') or s.get('lang') or 'en',
            'label': s.get('language') or s.get('label') or 'Subtitle',
            'url':   src,
        })
    return {
        'streams':   streams,
        'subtitles': subtitles,
        'sourceUrl': play_url,
        'provider':  'lookmovie',
    }


# ════════════════════════════════════════════════════════════════════════════
# MIRURO PROVIDER (anime — HTML scrape of miruro.ro)
# ════════════════════════════════════════════════════════════════════════════
# Search:   GET /search/<query>/        → <article class="bs"> cards
# Detail:   GET /series/<slug>/         → first 10 ep links + synopsis
# Episode:  GET /<series-stem>-episode-<n>/  → iframe src= /wp-content/.../player/?source=blogger&url=<b64>
# Resolve:  GET that iframe             → direct googlevideo.com MP4 (signed, ~24h TTL)
#
# Two practical limits:
#   (a) Full episode lists live behind a WP nonce-locked AJAX route that 403s
#       for non-browser clients.  We work around it by parsing the highest
#       episode number rendered on the detail page and extrapolating
#       <stem>-episode-1..N URLs.
#   (b) Some legacy episode pages currently throw a PHP fatal error upstream
#       (encrypt_decrypt undefined). mr_stream surfaces a clear RuntimeError
#       so the UI can show "stream unavailable" instead of hanging.
MR_BASE = 'https://miruro.ro'

_MR_CARD_RE = re.compile(r'<article class="bs"[^>]*>(.*?)</article>', re.S | re.I)
_MR_HREF_RE = re.compile(r'href="(https://miruro\.ro/series/([^"/]+)/?)"', re.I)
_MR_TITLE_RE = re.compile(r'<h2[^>]*itemprop="headline"[^>]*>([^<]+)</h2>', re.I)
_MR_TYPE_RE = re.compile(r'<div\s+class="typez[^"]*"[^>]*>([^<]+)</div>', re.I)
_MR_STATUS_RE = re.compile(r'<span\s+class="epx"[^>]*>([^<]+)</span>', re.I)
_MR_IMG_RE = re.compile(r'<img[^>]+(?:src|data-src)="([^"]+\.(?:jpg|jpeg|png|webp))[^"]*"', re.I)
_MR_EP_LINK_RE = re.compile(r'href="(https://miruro\.ro/([a-z0-9-]+)-episode-(\d+)/?)"', re.I)
_MR_OG_DESC_RE = re.compile(r'<meta\s+property="og:description"\s+content="([^"]*)"', re.I)
_MR_OG_IMG_RE = re.compile(r'<meta\s+property="og:image"\s+content="([^"]+)"', re.I)
_MR_IFRAME_RE = re.compile(r'<iframe[^>]+src="(https://miruro\.ro/wp-content/[^"]+/player/[^"]+)"', re.I)
_MR_GVIDEO_RE = re.compile(r'(https?://[^"\']*googlevideo\.com/videoplayback[^"\']+)', re.I)


def _mr_kind_from_type(t):
    """Map miruro 'typez' label to lookmovie-style 'movie' | 'show'."""
    return 'movie' if (t or '').strip().lower() == 'movie' else 'show'


_MR_SERIES_HREF_RE = re.compile(r'^https?://miruro\.ro/series/([^/"]+)/?$', re.I)
_MR_POSTER_EXT_RE  = re.compile(r'\.(?:jpg|jpeg|png|webp)(?:[?#]|$)', re.I)


class _MrSearchParser(HTMLParser):
    """Walks miruro search HTML and emits one dict per <article class="bs">.

    Replaces the brittle stack of regexes that previously slurped each card.
    Only depends on the stdlib html.parser; tolerates malformed markup the
    same way the regex path did (best-effort extraction, never raises).
    """
    _CAPTURE_TAGS = ('h2', 'div', 'span')

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.cards = []
        self._article_depth = 0
        self._capture = None
        self._buf = []
        self._cur = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'article':
            cls = (a.get('class') or '').split()
            if self._article_depth == 0 and 'bs' in cls:
                self._cur = {}
            if self._cur is not None:
                self._article_depth += 1
            return
        if self._cur is None:
            return
        if tag == 'a' and not self._cur.get('series_url'):
            m = _MR_SERIES_HREF_RE.match(a.get('href') or '')
            if m:
                self._cur['series_url'] = a['href']
                self._cur['slug'] = m.group(1)
        elif tag == 'h2' and a.get('itemprop') == 'headline':
            self._capture = 'title'; self._buf = []
        elif tag == 'div' and any(c == 'typez' or c.startswith('typez') for c in (a.get('class') or '').split()):
            self._capture = 'type'; self._buf = []
        elif tag == 'span' and 'epx' in (a.get('class') or '').split():
            self._capture = 'status'; self._buf = []
        elif tag == 'img' and not self._cur.get('poster'):
            src = a.get('data-src') or a.get('src') or ''
            if _MR_POSTER_EXT_RE.search(src):
                self._cur['poster'] = src

    def handle_startendtag(self, tag, attrs):
        # html.parser distinguishes self-closing tags; route them through
        # handle_starttag so void elements like <img/> are still picked up.
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if self._cur is None:
            return
        if self._capture and tag in self._CAPTURE_TAGS:
            self._cur[self._capture] = ''.join(self._buf).strip()
            self._capture = None
            self._buf = []
        if tag == 'article':
            self._article_depth -= 1
            if self._article_depth <= 0:
                if self._cur.get('slug'):
                    self.cards.append(self._cur)
                self._cur = None
                self._article_depth = 0

    def handle_data(self, data):
        if self._capture:
            self._buf.append(data)


def _mr_card_from_parsed(p):
    """Convert a parser-emitted dict into the standard provider card shape."""
    slug = p.get('slug')
    if not slug:
        return None
    title = p.get('title') or slug.replace('-', ' ').title()
    typ = p.get('type') or 'Anime'
    return {
        'id':       slug,
        'slug':     slug,
        'title':    title,
        'year':     None,
        'rating':   None,
        'quality':  p.get('status'),
        'poster':   p.get('poster'),
        'kind':     _mr_kind_from_type(typ),
        'provider': 'miruro',
        'sourceUrl': p.get('series_url'),
    }


def _mr_parse_cards(page_html):
    """Primary parser path with a regex fallback for hostile/broken markup."""
    try:
        p = _MrSearchParser()
        p.feed(page_html)
        items = [c for c in (_mr_card_from_parsed(d) for d in p.cards) if c]
        if items:
            return items
    except Exception:
        pass
    # Regex fallback — only triggered if the structured parser yields nothing.
    items = []
    for chunk in _MR_CARD_RE.findall(page_html):
        href_m = _MR_HREF_RE.search(chunk)
        if not href_m: continue
        series_url, slug = href_m.group(1), href_m.group(2)
        title_m = _MR_TITLE_RE.search(chunk)
        type_m = _MR_TYPE_RE.search(chunk)
        status_m = _MR_STATUS_RE.search(chunk)
        img_m = _MR_IMG_RE.search(chunk)
        items.append({
            'id': slug, 'slug': slug,
            'title': _strip_tags(title_m.group(1)) if title_m else slug.replace('-', ' ').title(),
            'year': None, 'rating': None,
            'quality': _strip_tags(status_m.group(1)) if status_m else None,
            'poster': img_m.group(1) if img_m else None,
            'kind': _mr_kind_from_type(_strip_tags(type_m.group(1)) if type_m else 'Anime'),
            'provider': 'miruro',
            'sourceUrl': series_url,
        })
    return items


def mr_search(query, kind='movies'):
    """Search miruro. Returns standard {items, query, source} envelope."""
    q = (query or '').strip()
    if not q:
        return {'items': [], 'query': '', 'source': MR_BASE}
    url = f'{MR_BASE}/search/{urllib.parse.quote(q)}/'
    cached = _cache_get(url)
    if cached: return cached
    page = _http_text(url)
    items = _mr_parse_cards(page)
    # Honour 'kind' as a soft filter, but keep everything if it leaves us empty.
    if kind == 'movies':
        movies = [i for i in items if i['kind'] == 'movie']
        if movies: items = movies
    elif kind == 'shows':
        shows = [i for i in items if i['kind'] == 'show']
        if shows: items = shows
    result = {'items': items, 'query': q, 'source': url}
    _cache_put(url, result, ttl=600)
    return result


def _mr_episode_links(detail_html):
    """Return list of (full_url, stem, episode_num) found on the detail page,
    sorted by episode number ascending. Dedupes on stem+number.
    """
    seen = set(); out = []
    for full, stem, num in _MR_EP_LINK_RE.findall(detail_html):
        try: n = int(num)
        except ValueError: continue
        key = (stem, n)
        if key in seen: continue
        seen.add(key)
        out.append((full, stem, n))
    out.sort(key=lambda r: r[2])
    return out


def mr_details(kind, slug):
    """Fetch series page; derive episode list from highest visible ep number.

    Returns the lookmovie-shaped envelope: { id, kind, title, year, poster,
    backdrop, synopsis, seasons:[{season:1, episodes:[...]}] | None, provider }.
    """
    url = f'{MR_BASE}/series/{urllib.parse.quote(slug)}/'
    cache_key = 'mr-details:' + url
    cached = _cache_get(cache_key)
    if cached: return cached
    page = _http_text_resilient(url)
    title_m = re.search(r'<h1[^>]*entry-title[^"]*"[^>]*>([^<]+)</h1>', page) \
              or re.search(r'<title>([^<]+?)\s*-\s*Miruro</title>', page)
    title = _strip_tags(title_m.group(1)) if title_m else slug.replace('-', ' ').title()
    syn_m = _MR_OG_DESC_RE.search(page)
    synopsis = html_mod.unescape(syn_m.group(1)) if syn_m else None
    img_m = _MR_OG_IMG_RE.search(page)
    poster = img_m.group(1) if img_m else None
    # Miruro fills og:description with a "Watch X All Episodes on Miruro TV …"
    # SEO blurb. Replace those with a real synopsis from AniList/Wikipedia.
    if _is_seo_synopsis(synopsis):
        syn_alt, poster_alt, _yr = _ai_synopsis(title, kind=(kind or 'show'))
        if syn_alt: synopsis = syn_alt
        if poster_alt and not poster: poster = poster_alt

    eps_raw = _mr_episode_links(page)
    seasons = None
    if eps_raw:
        # Stem is the slug-without-suffix used in episode URLs.  Pick the
        # most common stem in case stray cross-links sneak in.
        from collections import Counter
        stem = Counter(s for _u, s, _n in eps_raw).most_common(1)[0][0]
        max_n = max(n for _u, s, n in eps_raw if s == stem)
        episodes = [{
            'title':     f'Episode {n}',
            'episode':   n,
            'season':    1,
            'idEpisode': n,                       # episode_id == episode number
            'airDate':   None,
            'still':     None,
        } for n in range(1, max_n + 1)]
        seasons = [{'season': 1, 'episodes': episodes}]

    inferred_kind = 'show' if (seasons and len(seasons[0]['episodes']) > 1) else 'movie'
    result = {
        'id':        slug,
        'kind':      kind or inferred_kind,
        'title':     title,
        'year':      None,
        'poster':    poster,
        'backdrop':  poster,
        'synopsis':  synopsis,
        'seasons':   seasons,
        'provider':  'miruro',
        'sourceUrl': url,
    }
    _cache_put(cache_key, result, ttl=1800)   # 30 min
    return result


def _mr_resolve_iframe(iframe_url, referer):
    """Fetch the player iframe page and pull a googlevideo MP4 from it."""
    page = _http_text(iframe_url, headers={'Referer': referer})
    m = _MR_GVIDEO_RE.search(page)
    if not m:
        # Some sources embed via a nested iframe — try the outer iframe src
        nested = re.search(r'<iframe[^>]+src="([^"]+)"', page)
        if nested:
            inner = _http_text(nested.group(1), headers={'Referer': iframe_url})
            m = _MR_GVIDEO_RE.search(inner)
    if not m:
        raise RuntimeError('Could not extract stream URL from miruro player iframe')
    return m.group(1)


def mr_stream(kind, slug, episode_id=None):
    """Resolve a playable MP4 for a miruro series episode (or single-episode).

    For shows: episode_id is the integer episode number (1..N).
    For movies / specials: episode_id may be None or 1.
    """
    info = mr_details(kind or 'show', slug)
    eps = (info.get('seasons') or [{}])[0].get('episodes') or []
    n = int(episode_id) if episode_id else (eps[0]['episode'] if eps else 1)
    # Use the same stem heuristic mr_details did, by re-fetching the detail.
    page = _http_text(info['sourceUrl'])
    eps_raw = _mr_episode_links(page)
    if not eps_raw:
        raise RuntimeError('miruro detail page exposes no episode URLs')
    from collections import Counter
    stem = Counter(s for _u, s, _n in eps_raw).most_common(1)[0][0]
    ep_url = f'{MR_BASE}/{stem}-episode-{n}/'
    try:
        ep_page = _http_text(ep_url, headers={'Referer': info['sourceUrl']})
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'miruro episode page error {e.code} — try a different episode')
    if 'encrypt_decrypt' in ep_page or 'WordPress &rsaquo; Error' in ep_page:
        raise RuntimeError('miruro episode page is broken upstream — try a different episode')
    iframe_m = _MR_IFRAME_RE.search(ep_page)
    if not iframe_m:
        raise RuntimeError('No player iframe on miruro episode page')
    direct = _mr_resolve_iframe(iframe_m.group(1), ep_url)
    return {
        'streams':   {'auto': direct},
        'subtitles': [],
        'sourceUrl': ep_url,
        'provider':  'miruro',
    }


def mr_curated(slate):
    """One slate: 'trending' = miruro homepage 'Latest Release' + 'Popular All'."""
    if slate != 'trending':
        # Re-use the lookmovie slate titles by piping through mr_search.
        titles = CURATED_SLATES.get(slate)
        if not titles:
            raise ValueError(f'unknown miruro slate: {slate}')
        cache_key = f'mr-curated:{slate}'
        cached = _cache_get(cache_key)
        if cached: return cached
        from concurrent.futures import ThreadPoolExecutor
        def lookup(entry):
            try:
                items = (mr_search(entry[0], 'shows').get('items') or [])
                return items[0] if items else None
            except Exception: return None
        with ThreadPoolExecutor(max_workers=4) as ex:
            results = list(ex.map(lookup, titles))
        seen = set(); items = []
        for r in results:
            if not r or r['slug'] in seen: continue
            seen.add(r['slug']); items.append(r)
        out = {'items': items, 'slate': slate, 'count': len(items),
               'source': f'mr-curated:{slate}'}
        _cache_put(cache_key, out, ttl=86400)
        return out

    cache_key = 'mr-curated:trending'
    cached = _cache_get(cache_key)
    if cached: return cached
    home = _http_text(MR_BASE + '/')
    # Pair each series link with the nearest preceding card title (if any) so
    # we can show real names instead of slug-derived guesses.
    cards = _MR_CARD_RE.findall(home)
    items = []; seen = set()
    for chunk in cards:
        card = _mr_parse_card(chunk)
        if not card or card['slug'] in seen: continue
        seen.add(card['slug'])
        items.append(card)
        if len(items) >= 24: break
    # Backfill from raw series links if the homepage was light on cards.
    if len(items) < 12:
        link_re = re.compile(r'href="https://miruro\.ro/series/([a-z0-9][a-z0-9-]+)/"', re.I)
        for slug in link_re.findall(home):
            if slug in seen: continue
            seen.add(slug)
            # Strip a trailing 3–5 char random suffix when present.
            stem = re.sub(r'-[a-z0-9]{3,5}$', '', slug)
            items.append({
                'id':       slug, 'slug': slug,
                'title':    stem.replace('-', ' ').title(),
                'year':     None, 'rating': None, 'quality': None,
                'poster':   None, 'kind': 'show', 'provider': 'miruro',
                'sourceUrl': f'{MR_BASE}/series/{slug}/',
            })
            if len(items) >= 24: break
    out = {'items': items, 'slate': 'trending', 'count': len(items),
           'source': MR_BASE}
    _cache_put(cache_key, out, ttl=1800)   # 30 min
    return out


# ════════════════════════════════════════════════════════════════════════════
# ARCHIVE.ORG FALLBACK PROVIDER (public-domain anime / films)
# ════════════════════════════════════════════════════════════════════════════
# Lightweight curated list of public-domain anime + game-related films on
# Archive.org.  Each entry maps to an Archive.org item identifier; the actual
# stream URL is constructed at request time (no scraping required).
#
# Archive.org items expose direct mp4 / m3u8 via /download/<id>/<file>.
ARCHIVE_CATALOG = [
    # Public-domain / classic anime films (illustrative — extend freely)
    {'id': 'astro-boy-1963',     'title': 'Astro Boy (1963)',          'kind': 'movie',
     'archive_id': 'astroboy_201608', 'file': 'Astroboy.mp4',
     'year': '1963', 'genre': 'Animation'},
    {'id': 'gigantor-1964',      'title': 'Gigantor (1964)',           'kind': 'movie',
     'archive_id': 'Gigantor_1964', 'file': 'Gigantor1964.mp4',
     'year': '1964', 'genre': 'Animation'},
]


def arch_browse(kind='movies', page=1, genre=None, sort=None):
    items = [x for x in ARCHIVE_CATALOG if (kind == 'movies') == (x['kind'] == 'movie')]
    if genre:
        items = [x for x in items if (x.get('genre') or '').lower() == genre.lower()]
    return {'items': [{
        'id':       x['id'],
        'slug':     x['id'],
        'title':    x['title'],
        'year':     x.get('year'),
        'poster':   f'https://archive.org/services/img/{x["archive_id"]}',
        'kind':     x['kind'],
        'provider': 'archive',
    } for x in items], 'page': 1, 'hasMore': False, 'source': 'archive.org'}


def arch_details(kind, slug):
    entry = next((x for x in ARCHIVE_CATALOG if x['id'] == slug), None)
    if not entry: raise RuntimeError('Archive title not found')
    return {
        'id':       entry['id'],
        'kind':     entry['kind'],
        'title':    entry['title'],
        'year':     entry.get('year'),
        'poster':   f'https://archive.org/services/img/{entry["archive_id"]}',
        'backdrop': f'https://archive.org/services/img/{entry["archive_id"]}',
        'synopsis': entry.get('synopsis') or '',
        'seasons':  None,
        'provider': 'archive',
    }


def arch_stream(kind, slug, episode_id=None):
    entry = next((x for x in ARCHIVE_CATALOG if x['id'] == slug), None)
    if not entry: raise RuntimeError('Archive title not found')
    direct = f'https://archive.org/download/{entry["archive_id"]}/{urllib.parse.quote(entry["file"])}'
    return {
        'streams':   {'auto': direct},
        'subtitles': [],
        'sourceUrl': f'https://archive.org/details/{entry["archive_id"]}',
        'provider':  'archive',
    }


# ════════════════════════════════════════════════════════════════════════════
# DISPATCH
# ════════════════════════════════════════════════════════════════════════════
# Embed providers (vidsrc / 2embed / vidsrc.pm / multiembed) live in a
# sibling module so theater_providers.py stays focused on scraping logic.
try:
    from theater_embed import (
        vs_search, vs_details, vs_stream, vs_curated,
        te_search, te_details, te_stream, te_curated,
        vp_search, vp_details, vp_stream, vp_curated,
        me_search, me_details, me_stream, me_curated,
    )
    _EMBED_OK = True
except Exception as _embed_err:
    print(f'[theater_embed] unavailable: {_embed_err}')
    _EMBED_OK = False

try:
    from theater_youtube import yt_search, yt_details, yt_stream, yt_curated
    _YT_OK = True
except Exception as _yt_err:
    print(f'[theater_youtube] unavailable: {_yt_err}')
    _YT_OK = False

try:
    from theater_baddies import (
        bd_browse, bd_search, bd_details, bd_stream,
    )
    _BD_OK = True
except Exception as _bd_err:
    print(f'[theater_baddies] unavailable: {_bd_err}')
    _BD_OK = False


PROVIDERS = {
    'lookmovie': {'browse': lm_browse,   'search': lm_search, 'details': lm_details, 'stream': lm_stream, 'curated': lm_curated},
    'miruro':    {'browse': None,        'search': mr_search, 'details': mr_details, 'stream': mr_stream, 'curated': mr_curated},
    'archive':   {'browse': arch_browse, 'search': None,      'details': arch_details, 'stream': arch_stream},
}

if _EMBED_OK:
    PROVIDERS.update({
        'vidsrc':     {'browse': None, 'search': vs_search, 'details': vs_details, 'stream': vs_stream, 'curated': vs_curated},
        '2embed':     {'browse': None, 'search': te_search, 'details': te_details, 'stream': te_stream, 'curated': te_curated},
        'vidsrcpm':   {'browse': None, 'search': vp_search, 'details': vp_details, 'stream': vp_stream, 'curated': vp_curated},
        'multiembed': {'browse': None, 'search': me_search, 'details': me_details, 'stream': me_stream, 'curated': me_curated},
    })

if _YT_OK:
    PROVIDERS['youtube'] = {
        'browse': None, 'search': yt_search, 'details': yt_details,
        'stream': yt_stream, 'curated': yt_curated,
    }

if _BD_OK:
    # Search-only provider (no curated slates wired into the UI). browse is
    # exposed for completeness but the home rows don't pull from it.
    PROVIDERS['baddies'] = {
        'browse': bd_browse, 'search': bd_search, 'details': bd_details,
        'stream': bd_stream,
    }


# Cross-provider fallback chains: when a primary errors out, try the next.
# Anime tier: miruro -> vidsrc (most have IMDB ids). Movies/TV tier: vidsrc
# -> 2embed -> vidsrcpm -> multiembed. Lookmovie has no scrape-friendly mirror.
FALLBACK_CHAINS = {
    'miruro':     ['vidsrc', '2embed'],
    'lookmovie':  ['vidsrc', '2embed', 'vidsrcpm'],
    'vidsrc':     ['2embed', 'vidsrcpm', 'multiembed'],
    '2embed':     ['vidsrc', 'vidsrcpm', 'multiembed'],
    'vidsrcpm':   ['vidsrc', '2embed', 'multiembed'],
    'multiembed': ['vidsrc', '2embed', 'vidsrcpm'],
}


def call(provider, action, **kwargs):
    p = PROVIDERS.get(provider)
    if not p: raise RuntimeError(f'unknown provider: {provider}')
    fn = p.get(action)
    if not fn: raise RuntimeError(f'{provider} does not support {action}')
    return fn(**kwargs)

