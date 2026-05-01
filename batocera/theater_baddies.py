"""
Kente's Korner — baddieseast.pro provider.

Scrapes the WordPress REST API + post HTML at https://baddieseast.pro/ for
Baddies / Zeus Network / reality-TV episodes. Each WP category is treated as
one show; each post inside that category is one episode. Episode pages embed
3-4 third-party iframe players (ok.ru, smoothpre, vkspeed, rpmplay, …) which
we surface as the active embed + a `sources` switcher.

Stdlib only — slots into theater_providers.PROVIDERS as 'baddies'.
"""
import re, html as html_mod, urllib.parse
from theater_providers import (
    _cache_get, _cache_put, _http_text, _http_text_resilient,
)

BD_BASE   = 'https://baddieseast.pro'
WP_API    = BD_BASE + '/wp-json/wp/v2'
PROVIDER  = 'baddies'

# Categories that are clearly NOT reality TV — excluded from search/browse so
# the provider only contributes Zeus-network / Baddies-style results.
EXCLUDE_FROM_REALITY = {
    '9-1-1-lone-star', 'criminal-minds', 'bmf', 'ncis', 'tulsa-king', 'watson',
    'all-american', 'abbott-elementary', 'high-potential', 'godfather-of-harlem',
    'power-book-iii-raising-kanan', 'power-book-iv-force', 'the-chi',
    'the-last-of-us', 'the-buccaneers', 'tyler-perrys-sistas', 'harlem',
    'euphoria', 'the-kardashians', 'beyond-the-gates', 'paul-american',
    'found', 'the-secret-lives-of-mormon-wives', 'movies', 'blog',
}

_IFRAME_RE = re.compile(r'<iframe[^>]+src="([^"]+)"', re.I)


def _wp_get(path):
    """Cached JSON fetch against the WP REST API. 30 min TTL."""
    import json
    url = WP_API + path
    cached = _cache_get('bd:' + url)
    if cached: return cached
    raw = _http_text_resilient(url, headers={'Accept': 'application/json'})
    data = json.loads(raw)
    _cache_put('bd:' + url, data, ttl=1800)
    return data


def _all_categories():
    """Every WP category, paginated. Cached 24 h."""
    cached = _cache_get('bd:cats')
    if cached: return cached
    out, page = [], 1
    while page <= 6:                      # safety cap (~600 cats)
        chunk = _wp_get(f'/categories?per_page=100&page={page}&orderby=name')
        if not chunk: break
        out.extend(chunk)
        if len(chunk) < 100: break
        page += 1
    _cache_put('bd:cats', out, ttl=86400)
    return out


def _label(name):
    return html_mod.unescape(name or '').strip()


def _show_card(cat):
    """WP category -> Theater show-card. Poster is hydrated lazily so the
    initial slate render doesn't fan out one HTTP per show."""
    slug = cat.get('slug') or ''
    return {
        'id':       slug,
        'slug':     slug,
        'title':    _label(cat.get('name')),
        'kind':     'show',
        'type':     'show',
        'poster':   _hydrate_poster(slug),
        'year':     None,
        'rating':   None,
        'quality':  None,
        'provider': PROVIDER,
    }


def _hydrate_poster(cat_slug):
    """Pull the first post's featured-media URL as the show poster.
    Cached 24 h per category. Falls back to the site logo on errors."""
    key = 'bd:poster:' + cat_slug
    cached = _cache_get(key)
    if cached is not None: return cached or None
    poster = None
    try:
        cats = _wp_get(f'/categories?slug={urllib.parse.quote(cat_slug)}')
        if cats:
            cid = cats[0].get('id')
            posts = _wp_get(f'/posts?categories={cid}&per_page=1&_embed=true')
            if posts:
                media = (posts[0].get('_embedded') or {}).get('wp:featuredmedia') or []
                if media:
                    poster = (media[0].get('source_url')
                              or ((media[0].get('media_details') or {}).get('sizes', {})
                                    .get('medium', {}).get('source_url')))
    except Exception as e:
        print(f'[baddies/poster] {cat_slug}: {e}')
    _cache_put(key, poster or '', ttl=86400)
    return poster



# ── Public API ──────────────────────────────────────────────────────────────
def bd_browse(kind='shows', page=1, genre=None, sort=None):
    """Browse all shows on the site (paginated, 24 per page)."""
    cats = [c for c in _all_categories() if (c.get('count') or 0) > 0
            and (c.get('slug') or '') not in EXCLUDE_FROM_REALITY]
    cats.sort(key=lambda c: _label(c.get('name')))
    per = 24
    start = max(0, (int(page) - 1) * per)
    chunk = cats[start:start + per]
    return {'items': [_show_card(c) for c in chunk],
            'page': int(page), 'hasMore': (start + per) < len(cats),
            'source': BD_BASE}


def bd_search(query, kind='shows'):
    """Search shows by category name. Falls back to substring match across
    the cached category list (instant, no extra HTTP)."""
    q = (query or '').strip().lower()
    if not q:
        return {'items': [], 'query': query, 'source': BD_BASE}
    cats = _all_categories()
    hits = [c for c in cats
            if q in (_label(c.get('name')).lower() or '')
            and (c.get('count') or 0) > 0
            and (c.get('slug') or '') not in EXCLUDE_FROM_REALITY]
    hits.sort(key=lambda c: (
        0 if _label(c.get('name')).lower().startswith(q) else 1,
        -(c.get('count') or 0)))
    return {'items': [_show_card(c) for c in hits[:24]],
            'query': query, 'source': BD_BASE}


def bd_details(kind, slug):
    """Show detail — emits one season filled with every post in the category,
    oldest-first (so episode 1 lands at index 0)."""
    cache_key = f'bd-details:{slug}'
    cached = _cache_get(cache_key)
    if cached: return cached
    cats = _wp_get(f'/categories?slug={urllib.parse.quote(slug)}')
    if not cats:
        raise RuntimeError(f'baddies: category not found for slug {slug!r}')
    cat = cats[0]
    cid = cat.get('id')
    posts, page = [], 1
    while page <= 6:
        chunk = _wp_get(f'/posts?categories={cid}&per_page=100&page={page}'
                        f'&order=asc&_embed=true')
        if not chunk: break
        posts.extend(chunk)
        if len(chunk) < 100: break
        page += 1
    episodes = []
    for i, p in enumerate(posts, 1):
        title = _label((p.get('title') or {}).get('rendered'))
        media = (p.get('_embedded') or {}).get('wp:featuredmedia') or []
        still = media[0].get('source_url') if media else None
        episodes.append({
            'id':        str(p.get('id')),
            'slug':      p.get('slug') or '',
            'title':     title or f'Episode {i}',
            'episode':   i,
            'number':    i,
            'season':    1,
            'idEpisode': str(p.get('id')),
            'airDate':   (p.get('date') or '')[:10] or None,
            'still':     still,
        })
    poster = _hydrate_poster(slug)
    result = {
        'id':        slug,
        'kind':      'show',
        'type':      'show',
        'title':     _label(cat.get('name')),
        'year':      None,
        'poster':    poster,
        'backdrop':  poster,
        'synopsis':  _label(cat.get('description')) or None,
        'seasons':   [{'season': 1, 'number': 1, 'episodes': episodes}] if episodes else [],
        'provider':  PROVIDER,
        'sourceUrl': f'{BD_BASE}/{slug}/',
    }
    _cache_put(cache_key, result, ttl=1800)
    return result


# Friendly labels for the source-switcher pills, keyed on hostname keywords.
_HOST_LABELS = (
    ('ok.ru',          'OK.RU'),
    ('smoothpre',      'SMOOTHPRE'),
    ('vkspeed',        'VKSPEED'),
    ('rpmplay',        'RPMPLAY'),
    ('rpmshare',       'RPMSHARE'),
    ('streamtape',     'STREAMTAPE'),
    ('mixdrop',        'MIXDROP'),
    ('doodstream',     'DOODSTREAM'),
    ('vidoza',         'VIDOZA'),
    ('filemoon',       'FILEMOON'),
)


def _source_label(url):
    low = (url or '').lower()
    for needle, label in _HOST_LABELS:
        if needle in low: return label
    host = urllib.parse.urlparse(url).hostname or 'EMBED'
    return host.upper().replace('.COM', '').replace('.PRO', '')


def bd_stream(kind, slug, episode_id=None, season=None):
    """Resolve an episode page to its embed iframes. `slug` is the show
    (category) slug; `episode_id` is the WP post id (or post slug)."""
    if not episode_id:
        # Fall back to first episode in the show — keeps the show-card click
        # working even when the user lands on the detail page directly.
        det = bd_details('show', slug)
        eps = (det.get('seasons') or [{}])[0].get('episodes') or []
        if not eps: raise RuntimeError('baddies: no episodes found')
        episode_id = eps[0]['id']
    # Try post-id first (numeric), then post-slug.
    page_url = None
    if str(episode_id).isdigit():
        try:
            post = _wp_get(f'/posts/{episode_id}')
            page_url = (post.get('link') or '').rstrip('/')
        except Exception: pass
    if not page_url:
        page_url = f'{BD_BASE}/{episode_id}'
    cache_key = 'bd-stream:' + page_url
    cached = _cache_get(cache_key)
    if cached: return cached
    html = _http_text_resilient(page_url + '/')
    raw_srcs = _IFRAME_RE.findall(html)
    srcs = []
    seen = set()
    for s in raw_srcs:
        s = html_mod.unescape(s).strip()
        if s.startswith('//'): s = 'https:' + s
        # Skip non-player iframes (comments, ads, social sharing).
        low = s.lower()
        if any(b in low for b in ('disqus.com', 'facebook.com/plugins',
                                   'platform.twitter', 'pinterest.com',
                                   'about:blank')):
            continue
        if s in seen: continue
        seen.add(s); srcs.append(s)
    if not srcs:
        raise RuntimeError('baddies: no embed iframes on episode page')
    sources = [{
        'name':  f'baddies-{i}',
        'label': _source_label(s),
        'url':   s,
    } for i, s in enumerate(srcs)]
    result = {
        'streams':   {},
        'subtitles': [],
        'embed':     srcs[0],
        'provider':  PROVIDER,
        'season':    1,
        'episode':   episode_id,
        'sourceUrl': page_url,
        'sources':   sources,
    }
    _cache_put(cache_key, result, ttl=1800)
    return result

