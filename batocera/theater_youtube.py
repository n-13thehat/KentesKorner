"""
Kente's Korner — YouTube provider for game walkthroughs.

Stdlib only, no API key. Fetches the public youtube.com/results page and
parses the `ytInitialData` JSON blob to extract video metadata. Streams
return a youtube-nocookie iframe URL the existing embed player overlay
loads directly.

Returns the same envelope as the iframe-style providers
(theater_embed.py) so the dispatcher and frontend treat it uniformly.
"""
import urllib.request, urllib.parse
import json, re

from theater_providers import UA, _cache_get, _cache_put

# Walkthrough seed list. yt_curated('walkthroughs') resolves each query to
# its top YouTube result and returns them as a single row of cards.
WALKTHROUGH_GAMES = [
    'Elden Ring',
    'The Legend of Zelda: Breath of the Wild',
    'God of War Ragnarok',
    'Final Fantasy VII Remake',
    'Cyberpunk 2077',
    'Persona 5 Royal',
    'Hollow Knight',
    'Sekiro: Shadows Die Twice',
    'Dark Souls III',
    'Bloodborne',
    'Resident Evil 4 Remake',
    'The Last of Us Part II',
    'Ghost of Tsushima',
    'Red Dead Redemption 2',
    'Metal Gear Solid V: The Phantom Pain',
    'Baldurs Gate 3',
]


def _http_text(url, timeout=12):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return data.decode('utf-8', errors='replace')


_INIT_RE = re.compile(r'var ytInitialData\s*=\s*({.+?});\s*</script>', re.DOTALL)
_VID_RE  = re.compile(
    r'"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"'
    r'.*?"title":\{"runs":\[\{"text":"([^"]{1,200})"'
    r'(?:.*?"longBylineText":\{"runs":\[\{"text":"([^"]{1,80})")?'
    r'(?:.*?"thumbnailOverlayTimeStatusRenderer".*?"text":"([0-9:]{1,8})")?',
    re.DOTALL)


def _parse_results(html):
    """Parse the youtube results page HTML into a list of video items."""
    items = []
    seen = set()
    for m in _VID_RE.finditer(html):
        vid, title, channel, dur = m.group(1), m.group(2), m.group(3), m.group(4)
        if vid in seen:
            continue
        seen.add(vid)
        # The title is a captured JSON string — unescape \uXXXX / \\ / \"
        # via json.loads. The previous encode/decode('unicode_escape') chain
        # corrupted non-ASCII UTF-8 bytes (interpreted them as Latin-1).
        try:
            title = json.loads('"' + title + '"')
        except (ValueError, TypeError):
            pass
        items.append({
            'videoId': vid,
            'title':   title.strip(),
            'channel': (channel or '').strip(),
            'duration': dur or '',
            'thumb':   f'https://i.ytimg.com/vi/{vid}/hqdefault.jpg',
        })
        if len(items) >= 15:
            break
    return items


def yt_search(query, kind='movies'):
    q = (query or '').strip()
    if not q:
        return {'items': [], 'kind': kind}
    cache_key = f'yt-search:{q.lower()}'
    cached = _cache_get(cache_key)
    if cached: return cached
    url = 'https://www.youtube.com/results?' + urllib.parse.urlencode({'search_query': q})
    try:
        html = _http_text(url)
    except Exception as e:
        print(f'[yt_search] {q!r}: {e}')
        return {'items': [], 'kind': kind, 'error': str(e)}
    raw = _parse_results(html)
    items = [{
        'id':       r['videoId'],
        'slug':     r['videoId'],
        'title':    r['title'],
        'year':     None,
        'kind':     'movie',
        'poster':   r['thumb'],
        'backdrop': r['thumb'],
        'rating':   r['duration'] or None,
        'quality':  r['channel'] or None,
        'provider': 'youtube',
    } for r in raw]
    out = {'items': items, 'kind': kind, 'source': 'youtube'}
    _cache_put(cache_key, out, ttl=21600)   # 6 h
    return out


def yt_curated(slate):
    if slate != 'walkthroughs':
        raise ValueError(f'unknown youtube slate: {slate}')
    cache_key = f'yt-curated:{slate}'
    cached = _cache_get(cache_key)
    if cached: return cached
    items = []
    seen = set()
    for game in WALKTHROUGH_GAMES:
        try:
            res = yt_search(f'{game} walkthrough part 1')
            top = (res.get('items') or [])[:1]
            for it in top:
                if it['id'] in seen: continue
                seen.add(it['id'])
                items.append({**it, 'gameTitle': game})
        except Exception as e:
            print(f'[yt_curated/{slate}] {game!r}: {e}')
    out = {'items': items, 'slate': slate, 'count': len(items),
           'source': f'yt-curated:{slate}'}
    _cache_put(cache_key, out, ttl=86400)   # 24 h
    return out


def yt_details(kind, slug, title_hint=None):
    """Synthesize a detail envelope for a videoId. We don't scrape the
    watch page (HTML is heavy + adversarial); the search-time metadata
    cached against the videoId is sufficient for the detail overlay."""
    if not slug:
        raise RuntimeError('youtube details requires a videoId slug')
    cached = _cache_get(f'yt-meta:{slug}')
    title = title_hint or (cached and cached.get('title')) or slug
    poster = (cached and cached.get('thumb')) or f'https://i.ytimg.com/vi/{slug}/hqdefault.jpg'
    return {
        'id':        slug,
        'kind':      'movie',
        'title':     title,
        'year':      None,
        'poster':    poster,
        'backdrop':  poster,
        'synopsis':  'Click PLAY to launch the YouTube walkthrough.',
        'seasons':   [],
        'provider':  'youtube',
        'sourceUrl': f'https://www.youtube.com/watch?v={slug}',
        'embedReady': True,
    }


def yt_stream(kind, slug, episode_id=None, season=None):
    if not slug:
        raise RuntimeError('youtube stream requires a videoId slug')
    embed = f'https://www.youtube-nocookie.com/embed/{slug}?autoplay=1&rel=0&modestbranding=1'
    return {'embed': embed, 'streams': {}, 'subtitles': [],
            'provider': 'youtube'}
