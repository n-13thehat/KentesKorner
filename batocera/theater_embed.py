"""
Kente's Korner — Embed-style theater providers.

VidSrc / 2Embed / VidSrc.pm / MultiEmbed all share the same protocol:
title -> IMDB id -> iframe embed URL.  No scraping, no auth, free.

Each provider's stream() returns:
  { embed: '<https://...>', streams: {}, subtitles: [], provider: '<name>' }

The frontend renders the `embed` URL inside an <iframe> instead of <video>.

Stdlib-only — relies on theater_providers' shared cache + AI helpers.
"""
import urllib.request, urllib.parse, urllib.error
import json, os, re, time

from theater_providers import (
    UA, _cache_get, _cache_put, _ai_synopsis, _http_text_resilient,
    _anilist_id_for,
)


# ── IMDB suggest (keyless title -> tt id) ───────────────────────────────────
# https://v3.sg.media-imdb.com/suggestion/t/<slug>.json -> {d:[{id,l,q,y,i}]}
# q values seen: 'feature', 'TV series', 'TV mini-series', 'short', 'video'
_IMDB_KIND_MOVIE = {'feature', 'video', 'TV movie'}
_IMDB_KIND_SHOW  = {'TV series', 'TV mini-series', 'TV special'}


def _imdb_slugify(title):
    s = (title or '').lower().strip()
    s = re.sub(r"[^a-z0-9]+", '_', s).strip('_')
    return s[:80] or 'q'


def imdb_suggest(title):
    """Return raw suggest results for a title. 24 h cached. Also populates
    a reverse-lookup cache (`imdb-rev:<tt>` -> (title, year, poster, kind))
    so subsequent calls to `_imdb_title_for_id` can skip the IMDB title page,
    which has anti-scrape measures."""
    slug = _imdb_slugify(title)
    if not slug:
        return []
    key = 'imdb-sug:' + slug
    cached = _cache_get(key)
    if cached is not None:
        return cached
    url = f'https://v3.sg.media-imdb.com/suggestion/t/{slug}.json'
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    out = []
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read().decode('utf-8', 'ignore'))
        out = data.get('d') or []
    except Exception as e:
        print(f'[imdb/suggest] {title!r}: {e}')
    # Populate reverse cache for every tt-id we got back.
    for it in out:
        tt = it.get('id') or ''
        if not tt.startswith('tt'): continue
        q = it.get('q') or ''
        kind = 'movie' if q in _IMDB_KIND_MOVIE else ('show' if q in _IMDB_KIND_SHOW else None)
        poster = (it.get('i') or {}).get('imageUrl')
        _cache_put('imdb-rev:' + tt,
                   (it.get('l'), it.get('y'), poster, kind),
                   ttl=86400 * 7)
    _cache_put(key, out, ttl=86400)
    return out


def imdb_lookup(title, year=None, kind=None):
    """Title -> best (tt_id, normalized_title, year, kind, poster). None if no match."""
    items = imdb_suggest(title)
    want_movie = kind in ('movie', 'movies')
    want_show  = kind in ('show', 'shows', 'tv')

    def score(it):
        s = 0
        q = it.get('q') or ''
        if want_movie and q in _IMDB_KIND_MOVIE: s += 30
        if want_show  and q in _IMDB_KIND_SHOW:  s += 30
        if not (want_movie or want_show) and (q in _IMDB_KIND_MOVIE or q in _IMDB_KIND_SHOW):
            s += 10
        if year and it.get('y') == int(year): s += 20
        # Prefer entries with images (real titles, not placeholders).
        if (it.get('i') or {}).get('imageUrl'): s += 5
        # Prefer earlier index (IMDB returns by relevance).
        return s

    if not items: return None
    best = max(items, key=score)
    if not best.get('id', '').startswith('tt'): return None
    poster = (best.get('i') or {}).get('imageUrl')
    out_kind = 'movie' if (best.get('q') or '') in _IMDB_KIND_MOVIE else 'show'
    return (best['id'], best.get('l') or title, best.get('y'), out_kind, poster)


# ── Shared search/details for embed providers ──────────────────────────────
# Cards encode the IMDB id as the slug so details/stream don't need to re-resolve.
def _embed_search(query, kind='movies', provider_name='vidsrc'):
    q = (query or '').strip()
    if not q:
        return {'items': [], 'query': '', 'source': 'imdb-suggest'}
    items_raw = imdb_suggest(q)
    items = []
    want_movie = kind in ('movie', 'movies')
    want_show  = kind in ('show', 'shows', 'tv')
    for it in items_raw:
        tt = it.get('id') or ''
        if not tt.startswith('tt'): continue
        q_kind = it.get('q') or ''
        is_movie = q_kind in _IMDB_KIND_MOVIE
        is_show  = q_kind in _IMDB_KIND_SHOW
        if not (is_movie or is_show): continue
        if want_movie and not is_movie: continue
        if want_show  and not is_show:  continue
        items.append({
            'id':       tt,
            'slug':     tt,
            'title':    it.get('l') or tt,
            'year':     it.get('y'),
            'kind':     'movie' if is_movie else 'show',
            'poster':   (it.get('i') or {}).get('imageUrl'),
            'rating':   None,
            'quality':  None,
            'provider': provider_name,
        })
    return {'items': items, 'query': q, 'source': 'imdb-suggest'}


def _embed_details(kind, slug, provider_name='vidsrc', title_hint=None):
    """Fetch synopsis / poster from AI helpers, keyed by IMDB title.
    `slug` is the IMDB tt id. We re-look-up title via imdb_suggest on the id.
    `title_hint` is an optional human title supplied by the frontend (e.g.
    from a saved My-List entry) used to seed lookups when the in-memory
    reverse-lookup cache is cold (server restart, fresh worker, etc)."""
    if not (slug or '').startswith('tt'):
        raise RuntimeError('embed providers require an IMDB tt id slug')
    cache_key = f'embed-det:{provider_name}:{kind}:{slug}'
    cached = _cache_get(cache_key)
    if cached: return cached
    # Resolve a human title for the id from the reverse-lookup cache
    # (populated by imdb_suggest / curated tables).
    title, year, poster = _imdb_title_for_id(slug)
    # Cold cache: use the hint to drive imdb_suggest, which populates the
    # reverse lookup as a side-effect.
    if (not title) and title_hint:
        try: imdb_suggest(title_hint)
        except Exception: pass
        title, year, poster = _imdb_title_for_id(slug)
        if not title:
            title = title_hint   # last-ditch — embed still works with the hint
    # Embed providers are overwhelmingly live-action; force Wikipedia-first
    # so AniList's fuzzy matching doesn't return the wrong anime entry.
    syn, ai_poster, ai_year = _ai_synopsis(title or slug, kind=kind, prefer='wiki')
    seasons = None
    if kind == 'show':
        # Embed providers don't expose episode lists, so synthesize a
        # navigable scaffold. The iframe gracefully handles out-of-range
        # episodes by showing its own "not available" UI.
        seasons = _embed_show_seasons(slug)
    runtime = imdb_runtime(slug, kind=kind)
    out = {
        'id':        slug,
        'kind':      kind,
        'title':     title or slug,
        'year':      year or ai_year,
        'poster':    poster or ai_poster,
        'backdrop':  poster or ai_poster,
        'synopsis':  syn or 'Click PLAY to launch the embedded player.',
        'seasons':   seasons,
        'runtime':   runtime,
        'provider':  provider_name,
        'sourceUrl': f'https://www.imdb.com/title/{slug}/',
        'embedReady': True,
    }
    # Skip caching when we couldn't resolve a real title \u2014 a later request
    # with a title hint should be allowed to retry (otherwise the stub poisons
    # the cache for 6 h and anime-only sources stay hidden).
    if title:
        _cache_put(cache_key, out, ttl=21600)   # 6 h
    return out


def _embed_show_seasons(tt_id, season_count=None, ep_per_season=None):
    """Scaffold a seasons/episodes array for a show. Counts are taken from
    the curated metadata when available (see EMBED_CURATED), otherwise we
    default to a generous 5 seasons \u00d7 26 episodes \u2014 the iframe gracefully
    handles out-of-range episodes by showing its own "not available" UI."""
    if season_count is None or ep_per_season is None:
        meta = _cache_get('imdb-show-meta:' + tt_id) or {}
        season_count  = season_count  or meta.get('seasons')        or 5
        ep_per_season = ep_per_season or meta.get('eps_per_season') or 26
    seasons = []
    for s in range(1, int(season_count) + 1):
        seasons.append({
            'season':   s,
            'number':   s,
            'episodes': [
                {'id': f's{s}-e{i}', 'number': i, 'title': f'Episode {i}'}
                for i in range(1, int(ep_per_season) + 1)
            ],
        })
    return seasons


def _imdb_title_for_id(tt_id):
    """tt0133093 -> ('The Matrix', 1999, '<poster_url>'). Reads from the
    reverse-lookup cache populated by `imdb_suggest`. Returns (None, None,
    None) if we've never seen this id (caller falls back to AI helpers)."""
    rev = _cache_get('imdb-rev:' + tt_id)
    if rev:
        title, year, poster, _kind = rev
        return (title, year, poster)
    return (None, None, None)


def _imdb_prime_id(tt_id, title, year=None, poster=None, kind=None):
    """Manually seed the reverse cache. Used by EMBED_CURATED so curated
    lists don't need to re-scrape IMDB."""
    _cache_put('imdb-rev:' + tt_id,
               (title, year, poster, kind),
               ttl=86400 * 30)


# ── Runtime lookup (TVMaze for shows, OMDb for movies) ─────────────────────
# IMDB's title page is hard-blocked for unauth scrapers (returns 202 stub),
# so we rely on two free, no-CAPTCHA endpoints keyed by IMDB id:
#   - TVMaze:  /lookup/shows?imdb=ttN — returns {runtime, averageRuntime}
#   - OMDb:    ?i=ttN&apikey=...      — returns {Runtime: "136 min"}
# Both are cached 30 d on hit, 1 d on miss to soften repeated lookups for
# titles neither service indexes (e.g. very obscure imports).
_OMDB_KEY    = os.getenv('KENTE_OMDB_KEY', '')   # set KENTE_OMDB_KEY to enable
_RUNTIME_TTL = 86400 * 30
_RUNTIME_MISS_TTL = 86400


def _tvmaze_runtime(tt_id):
    url = f'https://api.tvmaze.com/lookup/shows?imdb={tt_id}'
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            j = json.loads(r.read().decode('utf-8', 'ignore') or '{}')
    except Exception as e:
        print(f'[runtime/tvmaze] {tt_id}: {e}')
        return None
    if not isinstance(j, dict): return None
    rt = j.get('runtime') or j.get('averageRuntime')
    try: return int(rt) if rt else None
    except (TypeError, ValueError): return None


def _omdb_runtime(tt_id):
    if not _OMDB_KEY:
        return None
    url = f'https://www.omdbapi.com/?i={tt_id}&apikey={urllib.parse.quote(_OMDB_KEY)}'
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            j = json.loads(r.read().decode('utf-8', 'ignore') or '{}')
    except Exception as e:
        print(f'[runtime/omdb] {tt_id}: {e}')
        return None
    if (j.get('Response') or '').lower() != 'true':
        return None
    raw = (j.get('Runtime') or '').strip()
    m = re.match(r'(\d+)', raw)
    if not m: return None
    try: return int(m.group(1))
    except ValueError: return None


def imdb_runtime(tt_id, kind=None):
    """tt-id -> integer minutes, or None if neither source indexes it.
    kind ('movie'|'show'|None) hints which API to try first; we still cross-
    check the other if the first misses, so misclassified titles still resolve.
    """
    if not (tt_id or '').startswith('tt'):
        return None
    cache_key = 'runtime:' + tt_id
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached or None   # 0 cached = known miss
    order = [_tvmaze_runtime, _omdb_runtime] if kind == 'show' \
            else [_omdb_runtime, _tvmaze_runtime]
    for fn in order:
        try:
            rt = fn(tt_id)
        except Exception as e:
            print(f'[runtime/{fn.__name__}] {tt_id}: {e}')
            rt = None
        if rt and rt > 0:
            _cache_put(cache_key, rt, ttl=_RUNTIME_TTL)
            return rt
    _cache_put(cache_key, 0, ttl=_RUNTIME_MISS_TTL)
    return None


# ── Shared curated trending lists ───────────────────────────────────────────
# Self-describing entries so embed providers don't need to scrape IMDB
# (which is now hardened against unauth GETs). Each entry: (tt_id, title,
# year). Show entries may add 'seasons' and 'eps_per_season'.
# Slates are anime + game-adaptation focused; universal media is still
# reachable via the search fan-out.
EMBED_CURATED = {
    'anime-films': [
        ('tt0245429',  'Spirited Away',                  2001),
        ('tt0119698',  'Princess Mononoke',              1997),
        ('tt0094625',  'Akira',                          1988),
        ('tt0113568',  'Ghost in the Shell',             1995),
        ('tt0347149',  "Howl's Moving Castle",           2004),
        ('tt0096283',  'My Neighbor Totoro',             1988),
        ('tt5311514',  'Your Name',                      2016),
        ('tt9426210',  'Weathering with You',            2019),
        ('tt12343534', 'Demon Slayer: Mugen Train',      2020),
        ('tt16513188', 'Jujutsu Kaisen 0',               2021),
        ('tt5323662',  'A Silent Voice',                 2016),
        ('tt0156887',  'Perfect Blue',                   1997),
        ('tt0107433',  'Ninja Scroll',                   1993),
        ('tt0275277',  'Cowboy Bebop: The Movie',        2001),
    ],
    'anime-series': [
        ('tt2560140',  'Attack on Titan',                2013, {'seasons': 4,  'eps_per_season': 25}),
        ('tt9335498',  'Demon Slayer: Kimetsu no Yaiba', 2019, {'seasons': 4,  'eps_per_season': 26}),
        ('tt11192442', 'Jujutsu Kaisen',                 2020, {'seasons': 2,  'eps_per_season': 24}),
        ('tt0388629',  'One Piece',                      1999, {'seasons': 20, 'eps_per_season': 50}),
        ('tt5626028',  'My Hero Academia',               2016, {'seasons': 7,  'eps_per_season': 25}),
        ('tt0877057',  'Death Note',                     2006, {'seasons': 1,  'eps_per_season': 37}),
        ('tt1355642',  'Fullmetal Alchemist: Brotherhood', 2009, {'seasons': 5, 'eps_per_season': 64}),
        ('tt2098220',  'Hunter x Hunter',                2011, {'seasons': 6,  'eps_per_season': 24}),
        ('tt0988824',  'Naruto Shippuden',               2007, {'seasons': 21, 'eps_per_season': 25}),
        ('tt0434665',  'Bleach',                         2004, {'seasons': 17, 'eps_per_season': 26}),
        ('tt0213338',  'Cowboy Bebop',                   1998, {'seasons': 1,  'eps_per_season': 26}),
        ('tt4508902',  'One-Punch Man',                  2015, {'seasons': 2,  'eps_per_season': 12}),
        ('tt15125222', 'Spy x Family',                   2022, {'seasons': 2,  'eps_per_season': 25}),
        ('tt14397406', 'Chainsaw Man',                   2022, {'seasons': 1,  'eps_per_season': 12}),
        ('tt8421496',  'Vinland Saga',                   2019, {'seasons': 2,  'eps_per_season': 24}),
        ('tt12343574', 'Mob Psycho 100',                 2016, {'seasons': 3,  'eps_per_season': 12}),
    ],
    'game-movies': [
        ('tt3794354',  'Sonic the Hedgehog',             2020),
        ('tt6718170',  'The Super Mario Bros. Movie',    2023),
        ('tt5884052',  'Pokémon Detective Pikachu',      2019),
        ('tt5279008',  'Mortal Kombat',                  2021),
        ('tt0120804',  'Resident Evil',                  2002),
        ('tt1365519',  'Tomb Raider',                    2018),
        ('tt1464335',  'Uncharted',                      2022),
        ('tt0803096',  'Warcraft',                       2016),
        ('tt2094766',  "Assassin's Creed",               2016),
        ('tt0473075',  'Prince of Persia: The Sands of Time', 2010),
        ('tt0384537',  'Silent Hill',                    2006),
        ('tt2369135',  'Need for Speed',                 2014),
        ('tt0419706',  'Doom',                           2005),
        ('tt0411951',  'Tekken',                         2010),
        ('tt0111301',  'Street Fighter',                 1994),
        ('tt0293429',  'Mortal Kombat',                  1995),
    ],
    'game-shows': [
        ('tt3581920',  'The Last of Us',                 2023, {'seasons': 2,  'eps_per_season': 9}),
        ('tt11126994', 'Arcane',                         2021, {'seasons': 2,  'eps_per_season': 9}),
        ('tt12590266', 'Cyberpunk: Edgerunners',         2022, {'seasons': 1,  'eps_per_season': 10}),
        ('tt6517102',  'Castlevania',                    2017, {'seasons': 4,  'eps_per_season': 10}),
        ('tt2934286',  'Halo',                           2022, {'seasons': 2,  'eps_per_season': 9}),
        ('tt5180504',  'The Witcher',                    2019, {'seasons': 3,  'eps_per_season': 8}),
        ('tt15745330', 'Sonic Prime',                    2022, {'seasons': 3,  'eps_per_season': 8}),
        ('tt6072068',  'Twisted Metal',                  2023, {'seasons': 2,  'eps_per_season': 10}),
        ('tt11304740', 'Resident Evil',                  2022, {'seasons': 1,  'eps_per_season': 8}),
        ('tt15009428', 'Castlevania: Nocturne',          2023, {'seasons': 2,  'eps_per_season': 8}),
        ('tt13491894', 'Tomb Raider: The Legend of Lara Croft', 2024, {'seasons': 1, 'eps_per_season': 8}),
        ('tt12877078', 'Like a Dragon: Yakuza',          2024, {'seasons': 1,  'eps_per_season': 6}),
    ],
}


def _resolve_curated_titles(entries, provider_name, default_kind='movie'):
    """Curated entries -> theater item cards. Self-describing tuples mean
    no scraping needed. Also primes the reverse-lookup cache so the same
    cards work in details/stream calls. Posters are resolved opportunistically
    via imdb-suggest by title (1 call per entry, results cached 24 h)."""
    seen = set(); items = []
    for entry in entries:
        if len(entry) == 3:
            tt, title, year = entry; show_meta = None
        else:
            tt, title, year, show_meta = entry
        if tt in seen: continue
        seen.add(tt)
        kind = 'show' if (show_meta or default_kind == 'show') else 'movie'
        # Resolve poster via imdb-suggest by title; matches our tt-id when present.
        poster = None
        try:
            for sug in imdb_suggest(title):
                if sug.get('id') == tt:
                    poster = (sug.get('i') or {}).get('imageUrl')
                    break
            # If exact tt match failed, accept the first suggestion's poster
            # if its title is very close (handles minor punctuation diffs).
            if not poster:
                for sug in imdb_suggest(title)[:3]:
                    sug_title = (sug.get('l') or '').lower().strip()
                    if sug_title and sug_title[:20] == title.lower()[:20]:
                        poster = (sug.get('i') or {}).get('imageUrl')
                        if poster: break
        except Exception:
            pass
        # Prime the reverse cache so details/stream lookups succeed.
        _imdb_prime_id(tt, title, year, poster=poster, kind=kind)
        if show_meta:
            _cache_put('imdb-show-meta:' + tt, show_meta, ttl=86400 * 30)
        items.append({
            'id':       tt,
            'slug':     tt,
            'title':    title,
            'year':     year,
            'kind':     kind,
            'poster':   poster,
            'backdrop': poster,
            'rating':   None,
            'quality':  None,
            'provider': provider_name,
        })
    return items


def _embed_curated(slate, provider_name='vidsrc'):
    entries = EMBED_CURATED.get(slate)
    if not entries:
        raise ValueError(f'unknown embed slate: {slate}')
    cache_key = f'embed-curated:{provider_name}:{slate}'
    cached = _cache_get(cache_key)
    if cached: return cached
    show_slates = ('popular-shows', 'anime-series', 'game-shows')
    default_kind = 'show' if slate in show_slates else 'movie'
    items = _resolve_curated_titles(entries, provider_name, default_kind)
    if slate in show_slates:
        for it in items:
            it['kind'] = 'show'
    out = {'items': items, 'slate': slate, 'count': len(items),
           'source': f'embed-curated:{slate}'}
    _cache_put(cache_key, out, ttl=86400)
    return out


# ════════════════════════════════════════════════════════════════════════════
# PROVIDER-SPECIFIC EMBED URL TEMPLATES
# ════════════════════════════════════════════════════════════════════════════
# Each builder takes (kind, tt_id, season, episode) -> str.

def _vidsrc_embed_url(kind, tt, season=None, episode=None):
    if kind == 'show' and season and episode:
        return f'https://vidsrc.xyz/embed/tv/{tt}/{int(season)}-{int(episode)}'
    if kind == 'show':
        return f'https://vidsrc.xyz/embed/tv/{tt}'
    return f'https://vidsrc.xyz/embed/movie/{tt}'

def _twoembed_embed_url(kind, tt, season=None, episode=None):
    if kind == 'show' and season and episode:
        return f'https://www.2embed.cc/embedtv/{tt}&s={int(season)}&e={int(episode)}'
    if kind == 'show':
        return f'https://www.2embed.cc/embedtv/{tt}'
    return f'https://www.2embed.cc/embed/{tt}'

def _vidsrcpm_embed_url(kind, tt, season=None, episode=None):
    if kind == 'show' and season and episode:
        return f'https://vidsrc.pm/embed/tv/{tt}/{int(season)}/{int(episode)}'
    if kind == 'show':
        return f'https://vidsrc.pm/embed/tv/{tt}'
    return f'https://vidsrc.pm/embed/movie/{tt}'

def _multiembed_embed_url(kind, tt, season=None, episode=None):
    base = f'https://multiembed.mov/?video_id={tt}'
    if kind == 'show' and season and episode:
        return f'{base}&s={int(season)}&e={int(episode)}'
    return base

def _vidsrcnet_embed_url(kind, tt, season=None, episode=None):
    # vidsrc.net mirrors vidsrc.xyz; kept separate so the switcher exposes
    # both as distinct sources (different CDN edges).
    if kind == 'show' and season and episode:
        return f'https://vidsrc.net/embed/tv/{tt}/{int(season)}-{int(episode)}'
    if kind == 'show':
        return f'https://vidsrc.net/embed/tv/{tt}'
    return f'https://vidsrc.net/embed/movie/{tt}'

def _embedsu_embed_url(kind, tt, season=None, episode=None):
    if kind == 'show' and season and episode:
        return f'https://embed.su/embed/tv/{tt}/{int(season)}/{int(episode)}'
    if kind == 'show':
        return f'https://embed.su/embed/tv/{tt}'
    return f'https://embed.su/embed/movie/{tt}'

def _vidlink_embed_url(kind, tt, season=None, episode=None):
    if kind == 'show' and season and episode:
        return f'https://vidlink.pro/tv/{tt}/{int(season)}/{int(episode)}'
    if kind == 'show':
        return f'https://vidlink.pro/tv/{tt}'
    return f'https://vidlink.pro/movie/{tt}'

def _autoembed_embed_url(kind, tt, season=None, episode=None):
    if kind == 'show' and season and episode:
        return f'https://player.autoembed.cc/embed/tv/{tt}/{int(season)}/{int(episode)}'
    if kind == 'show':
        return f'https://player.autoembed.cc/embed/tv/{tt}'
    return f'https://player.autoembed.cc/embed/movie/{tt}'

def _2embedstream_embed_url(kind, tt, season=None, episode=None):
    # 2embedstream.xyz \u2014 universal IMDB host. Same URL shape as 2embed.cc
    # but different CDN / player; valuable as one more fallback rung.
    if kind == 'show' and season and episode:
        return f'https://www.2embedstream.xyz/embed/tv/{tt}/{int(season)}/{int(episode)}'
    if kind == 'show':
        return f'https://www.2embedstream.xyz/embed/tv/{tt}'
    return f'https://www.2embedstream.xyz/embed/movie/{tt}'

def _vidplus_anime_embed_url(kind, anilist_id, season=None, episode=None, dub=False):
    # vidplus.to \u2014 anime player keyed by AniList id + episode. Series only;
    # movies/specials with a single episode resolve fine at episode=1.
    # `dub=True` adds ?dub=true so the player loads the English-dub track when
    # the title has one; otherwise the default subbed (Japanese) track plays.
    ep = int(episode) if episode else 1
    base = f'https://player.vidplus.to/embed/anime/{int(anilist_id)}/{ep}'
    return base + ('?dub=true' if dub else '')


def _vidsrcicu_anime_embed_url(kind, anilist_id, season=None, episode=None, dub=False):
    # vidsrc.icu \u2014 anime player keyed by AniList id + episode. Trailing
    # path segment is 1 for dub, 0 for sub.
    ep = int(episode) if episode else 1
    flag = 1 if dub else 0
    return f'https://vidsrc.icu/embed/anime/{int(anilist_id)}/{ep}/{flag}'


# Ordered list of (key, label, builder, flags) tuples used by _all_embed_sources().
# `flags` is an optional dict:
#   id_kind:    'imdb' (default) | 'anilist'  \u2014 selects which id is fed to the builder.
#   anime_only: True              \u2014 entry only included when AniList resolves the title.
#   audio:      'sub' | 'dub'     \u2014 anime audio variant; surfaces in the label so
#                                   the source switcher shows SUB / DUB explicitly.
# Order = preferred trial order when the user cycles via the source switcher.
_EMBED_SOURCES = [
    ('vidsrc',         'VIDSRC',           _vidsrc_embed_url,        {}),
    ('vidsrcnet',      'VIDSRC.NET',       _vidsrcnet_embed_url,     {}),
    ('2embed',         '2EMBED',           _twoembed_embed_url,      {}),
    ('embedsu',        'EMBED.SU',         _embedsu_embed_url,       {}),
    ('vidlink',        'VIDLINK',          _vidlink_embed_url,       {}),
    ('autoembed',      'AUTOEMBED',        _autoembed_embed_url,     {}),
    ('vidplus_sub',    'VIDPLUS · SUB',
        lambda k, i, s, e: _vidplus_anime_embed_url(k, i, s, e, dub=False),
        {'id_kind': 'anilist', 'anime_only': True, 'audio': 'sub'}),
    ('vidplus_dub',    'VIDPLUS · DUB',
        lambda k, i, s, e: _vidplus_anime_embed_url(k, i, s, e, dub=True),
        {'id_kind': 'anilist', 'anime_only': True, 'audio': 'dub'}),
    ('vidsrcicu_sub',  'VIDSRC.ICU · SUB',
        lambda k, i, s, e: _vidsrcicu_anime_embed_url(k, i, s, e, dub=False),
        {'id_kind': 'anilist', 'anime_only': True, 'audio': 'sub'}),
    ('vidsrcicu_dub',  'VIDSRC.ICU · DUB',
        lambda k, i, s, e: _vidsrcicu_anime_embed_url(k, i, s, e, dub=True),
        {'id_kind': 'anilist', 'anime_only': True, 'audio': 'dub'}),
    ('2embedstream',   '2EMBEDSTREAM',     _2embedstream_embed_url,  {}),
    ('vidsrcpm',       'VIDSRC.PM',        _vidsrcpm_embed_url,      {}),
    ('multiembed',     'MULTIEMBED',       _multiembed_embed_url,    {}),
]


def _all_embed_sources(kind, tt, season=None, episode=None, primary=None):
    """Return [{name, label, url}, ...] for every known iframe host.
    `primary` (provider key) is moved to the front so the requested
    provider is tried first; the rest follow in _EMBED_SOURCES order.
    Used by the frontend source-switcher pills.

    Anime-only entries (id_kind='anilist') require an AniList id for the
    title; we resolve it lazily via the IMDB reverse cache + AniList GraphQL.
    Failures silently skip the entry so the chain stays clean for non-anime."""
    pri = (primary or '').lower()
    anilist_id = None
    anilist_resolved = False   # lazy: only call AniList if a builder needs it
    title, _yr, _poster = _imdb_title_for_id(tt) if tt else (None, None, None)

    head = []; tail = []
    for entry in _EMBED_SOURCES:
        # Back-compat: tuples may be 3- or 4-tuple.
        if len(entry) == 4:
            key, label, build, flags = entry
        else:
            key, label, build = entry
            flags = {}
        id_kind = flags.get('id_kind', 'imdb')
        if id_kind == 'anilist':
            if not title:
                continue
            if not anilist_resolved:
                try: anilist_id = _anilist_id_for(title)
                except Exception: anilist_id = None
                anilist_resolved = True
            if not anilist_id:
                continue
            try:
                url = build(kind, anilist_id, season, episode)
            except Exception:
                continue
        else:
            try:
                url = build(kind, tt, season, episode)
            except Exception:
                continue
        item = {'name': key, 'label': label, 'url': url}
        if key == pri: head.append(item)
        else:          tail.append(item)
    return head + tail


# ════════════════════════════════════════════════════════════════════════════
# VIDSRC.XYZ — Main #2 (movies + tv + anime via IMDB id)
# ════════════════════════════════════════════════════════════════════════════
def vs_search(query, kind='movies'):
    return _embed_search(query, kind, 'vidsrc')

def vs_details(kind, slug, title_hint=None):
    return _embed_details(kind, slug, 'vidsrc', title_hint)

def vs_stream(kind, slug, episode_id=None, season=None):
    """For shows: episode_id may be 'sN-eM' or just an integer episode.
    Defaults to S1E1 when omitted."""
    s, e = _parse_se(episode_id, season)
    url = _vidsrc_embed_url(kind, slug, s, e)
    return _embed_stream_envelope(url, 'vidsrc', s, e, kind=kind, tt=slug)

def vs_curated(slate):
    return _embed_curated(slate, 'vidsrc')


# ════════════════════════════════════════════════════════════════════════════
# 2EMBED.CC — Main #3
# ════════════════════════════════════════════════════════════════════════════
def te_search(query, kind='movies'):
    return _embed_search(query, kind, '2embed')

def te_details(kind, slug, title_hint=None):
    return _embed_details(kind, slug, '2embed', title_hint)

def te_stream(kind, slug, episode_id=None, season=None):
    s, e = _parse_se(episode_id, season)
    url = _twoembed_embed_url(kind, slug, s, e)
    return _embed_stream_envelope(url, '2embed', s, e, kind=kind, tt=slug)

def te_curated(slate):
    return _embed_curated(slate, '2embed')


# ════════════════════════════════════════════════════════════════════════════
# VIDSRC.PM — Backup #1 (lightweight player UI)
# ════════════════════════════════════════════════════════════════════════════
def vp_search(query, kind='movies'):
    return _embed_search(query, kind, 'vidsrcpm')

def vp_details(kind, slug, title_hint=None):
    return _embed_details(kind, slug, 'vidsrcpm', title_hint)

def vp_stream(kind, slug, episode_id=None, season=None):
    s, e = _parse_se(episode_id, season)
    url = _vidsrcpm_embed_url(kind, slug, s, e)
    return _embed_stream_envelope(url, 'vidsrcpm', s, e, kind=kind, tt=slug)

def vp_curated(slate):
    return _embed_curated(slate, 'vidsrcpm')


# ════════════════════════════════════════════════════════════════════════════
# MULTIEMBED.MOV — Backup #2 (multi-server aggregator)
# ════════════════════════════════════════════════════════════════════════════
def me_search(query, kind='movies'):
    return _embed_search(query, kind, 'multiembed')

def me_details(kind, slug, title_hint=None):
    return _embed_details(kind, slug, 'multiembed', title_hint)

def me_stream(kind, slug, episode_id=None, season=None):
    s, e = _parse_se(episode_id, season)
    url = _multiembed_embed_url(kind, slug, s, e)
    return _embed_stream_envelope(url, 'multiembed', s, e, kind=kind, tt=slug)

def me_curated(slate):
    return _embed_curated(slate, 'multiembed')


# ── Shared stream helpers ──────────────────────────────────────────────────
def _parse_se(episode_id, season):
    """Accept 'sN-eM', 'NxM', plain integer, or (season, episode) split.
    Returns (season:int|None, episode:int|None). Defaults to (1,1) if both
    are unparseable but the caller indicated a show by passing an episode_id."""
    if episode_id is None and season is None:
        return (None, None)
    s = e = None
    if season is not None:
        try: s = int(season)
        except (TypeError, ValueError): pass
    if episode_id is not None:
        ep_str = str(episode_id).lower()
        m = re.match(r'^s(\d+)[-_x]?e?(\d+)$', ep_str)
        if m:
            s = s or int(m.group(1)); e = int(m.group(2))
        else:
            m = re.match(r'^(\d+)x(\d+)$', ep_str)
            if m:
                s = s or int(m.group(1)); e = int(m.group(2))
            else:
                try: e = int(ep_str)
                except ValueError: pass
    if s is None and e is not None: s = 1
    return (s, e)


def _embed_stream_envelope(url, provider_name, season, episode,
                           kind=None, tt=None):
    """Build the iframe-style stream response.
    When `kind` and `tt` are supplied (the IMDB id), include a `sources`
    fallback list spanning every known iframe host so the frontend can
    render a source-switcher when the primary host shows no working stream.
    `provider_name` is moved to the front of that list as the default."""
    sources = []
    if kind and tt:
        try:
            sources = _all_embed_sources(kind, tt, season, episode,
                                         primary=provider_name)
        except Exception:
            sources = []
    return {
        'streams':   {},                     # iframe path — no quality variants
        'subtitles': [],
        'embed':     url,
        'provider':  provider_name,
        'season':    season,
        'episode':   episode,
        'sourceUrl': url,
        'sources':   sources,
    }

