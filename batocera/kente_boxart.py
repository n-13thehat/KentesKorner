"""Kente's Korner — Boxart on-demand fetcher."""
import json, os
import urllib.request, urllib.parse, urllib.error
from kente_config import BASE

# ── Boxart on-demand fetcher ─────────────────────────────────────────────────
# Store cached boxart in a writable location.
# - App mode:  %APPDATA%/KenteCorner/boxart (via BASE)
# - Batocera:  /userdata/boxart
# - Dev:       <repo>/boxart
_BOXART_DIR  = str((BASE / 'boxart').resolve())
_ART_KEYS    = {}                              # lazy-loaded from artkeys.json / env
_BOXART_LOCK = {}                              # per-id in-flight guard (simple dict)

def _load_art_keys():
    """Load SteamGridDB / TheGamesDB keys.
    Priority: artkeys.json in project root  →  environment variables."""
    global _ART_KEYS
    if _ART_KEYS:
        return _ART_KEYS
    try:
        cfg = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'artkeys.json')
        with open(cfg, encoding='utf-8') as f:
            _ART_KEYS = json.load(f)
    except Exception:
        _ART_KEYS = {}
    _ART_KEYS.setdefault('sgdb', os.environ.get('SGDB_KEY', ''))
    _ART_KEYS.setdefault('tgdb', os.environ.get('TGDB_KEY', ''))
    return _ART_KEYS

def _art_http_get(url, headers=None):
    """Simple HTTP GET returning bytes, or None on error."""
    try:
        hdr = {'User-Agent': 'KentesKorner/1.1'}
        if headers:
            hdr.update(headers)
        req = urllib.request.Request(url, headers=hdr)
        with urllib.request.urlopen(req, timeout=12) as r:
            data = r.read()
        return data if len(data) > 1024 else None
    except Exception:
        return None

def _sgdb_fetch(title, key):
    """Fetch portrait grid art (600x900) from SteamGridDB. Returns bytes or None."""
    auth = {'Authorization': f'Bearer {key}'}
    try:
        q   = urllib.parse.quote(title)
        raw = _art_http_get(f'https://www.steamgriddb.com/api/v2/search/autocomplete/{q}',
                            headers=auth)
        if not raw:
            return None
        games = json.loads(raw).get('data', [])
        if not games:
            return None
        gid = games[0]['id']
        raw2 = _art_http_get(
            f'https://www.steamgriddb.com/api/v2/grids/game/{gid}'
            f'?dimensions=600x900&types=static&nsfw=false',
            headers=auth)
        if not raw2:
            return None
        grids = json.loads(raw2).get('data', [])
        if not grids:
            return None
        return _art_http_get(grids[0]['url'])
    except Exception:
        return None

def _tgdb_fetch(title, sys_id, key):
    """Fetch front boxart from TheGamesDB. Returns bytes or None."""
    _TGDB_PLAT = {
        'nes':7,'snes':6,'genesis':36,'n64':3,'ps1':10,'ps2':11,
        'gamecube':2,'gba':5,'gameboy':4,'gbc':41,'dreamcast':16,
        'saturn':17,'neogeo':80,'turbografx':34,'atari2600':22,
        'atari7800':23,'mastersys':35,'psp':13,'wii':9,'ps3':12,
        'xbox360':15,'xbox':14,'wiiu':38,'switch':4924,
    }
    pid = _TGDB_PLAT.get(sys_id)
    if not pid:
        return None
    try:
        q = urllib.parse.urlencode({
            'apikey': key, 'name': title, 'fields': 'boxart',
            'filter[platform]': pid,
        })
        raw = _art_http_get(f'https://api.thegamesdb.net/v1.1/Games/ByGameName?{q}')
        if not raw:
            return None
        data  = json.loads(raw)
        games = data.get('data', {}).get('games', [])
        if not games:
            return None
        tl   = title.lower()
        best = next((g for g in games
                     if tl in g['game_title'].lower() or g['game_title'].lower() in tl),
                    games[0])
        gid  = best['id']
        art  = data.get('include', {}).get('boxart', {})
        base = art.get('base_url', {}).get('medium',
                       'https://cdn.thegamesdb.net/images/medium/')
        imgs = art.get('data', {}).get(str(gid), [])
        front = next((i for i in imgs if i.get('side') == 'front'), None)
        if not front:
            return None
        return _art_http_get(base + front['filename'])
    except Exception:
        return None

def _boxart_fetch_online(game_id, title, sys_id=''):
    """Try SteamGridDB → TheGamesDB. Save result to disk. Returns path or None."""
    if _BOXART_LOCK.get(game_id):
        return None                        # already in-flight
    _BOXART_LOCK[game_id] = True
    try:
        keys = _load_art_keys()
        os.makedirs(_BOXART_DIR, exist_ok=True)
        dest = os.path.join(_BOXART_DIR, f'{game_id}.jpg')

        data = None
        if keys.get('sgdb'):
            data = _sgdb_fetch(title or game_id, keys['sgdb'])
        if not data and keys.get('tgdb'):
            data = _tgdb_fetch(title or game_id, sys_id, keys['tgdb'])

        if data:
            with open(dest, 'wb') as f:
                f.write(data)
            return dest
        return None
    finally:
        _BOXART_LOCK.pop(game_id, None)
