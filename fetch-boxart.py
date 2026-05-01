#!/usr/bin/env python3
"""fetch-boxart.py — Kente's Korner cover art downloader

Fetches front-cover boxart for every game in library.js
from TheGamesDB (thegamesdb.net) and saves to ./boxart/

Requirements:  Python 3.8+   (stdlib only)

Quick start:
  1. Get a free API key → https://forums.thegamesdb.net/viewtopic.php?f=10&t=1
  2. python fetch-boxart.py --key YOUR_KEY
  3. Re-run any time to fill gaps (already-downloaded images are skipped)
"""

import os, re, json, time, argparse
import urllib.request, urllib.parse, urllib.error

# ── TheGamesDB platform IDs ─────────────────────────────────────────────────
PLATFORMS = {
    'nes': 7,      'snes': 6,      'genesis': 36,  'n64': 3,
    'ps1': 10,     'ps2': 11,      'gamecube': 2,  'gba': 5,
    'gameboy': 4,  'gbc': 41,      'dreamcast': 16,'saturn': 17,
    'neogeo': 80,  'turbografx': 34,'atari2600': 22,'atari7800': 23,
    'mastersys': 35,'psp': 13,     'wii': 9,       'ps3': 12,
    'xbox360': 15, 'xbox': 14,     'wiiu': 38,     'switch': 4924,
}
SKIP_SYSTEMS = {'flash', 'native'}   # no boxart needed

TGDB_BASE = 'https://api.thegamesdb.net/v1.1'
# Wikipedia requires an informative User-Agent to avoid 429/robot-policy blocks
HEADERS = {
    'User-Agent': ('KentesKorner/1.1 (personal game frontend; '
                   'https://github.com/user/KentesKorner; no-reply@local)'),
    'Accept': 'image/jpeg,image/png,image/webp,*/*',
}
WIKI_DELAY = 1.5   # seconds between Wikipedia requests

# ── Hardcoded overrides — verified working Wikipedia Commons URLs ────────────
# Only entries confirmed to return 200 are kept here; the rest go to the APIs.
OVERRIDES = {
    # NES
    'smb':        'https://upload.wikimedia.org/wikipedia/en/0/03/Super_Mario_Bros._box.png',
    'zelda1':     'https://upload.wikimedia.org/wikipedia/en/4/41/Legend_of_zelda_cover_%28with_cartridge%29_gold.png',
    # SNES
    'smw':        'https://upload.wikimedia.org/wikipedia/en/3/32/Super_Mario_World_Coverart.png',
    'chronotrig': 'https://upload.wikimedia.org/wikipedia/en/a/a7/Chrono_Trigger.jpg',
    'ff6':        'https://upload.wikimedia.org/wikipedia/en/0/05/Final_Fantasy_VI.jpg',
    # Game Boy
    'tetrisgb':   'https://upload.wikimedia.org/wikipedia/en/4/4a/Tetris_Boxshot.jpg',
    # N64
    'majora':     'https://upload.wikimedia.org/wikipedia/en/6/60/The_Legend_of_Zelda_-_Majora%27s_Mask_Box_Art.jpg',
    'oot':        'https://upload.wikimedia.org/wikipedia/en/5/57/The_Legend_of_Zelda_Ocarina_of_Time.jpg',
    # Wii
    'smgalaxy':   'https://upload.wikimedia.org/wikipedia/en/7/76/SuperMarioGalaxy.jpg',
    # Xbox 360
    'bioshock':   'https://upload.wikimedia.org/wikipedia/en/6/6d/BioShock_cover.jpg',
    'darksouls1': 'https://upload.wikimedia.org/wikipedia/en/8/8d/Dark_Souls_Cover_Art.jpg',
}

SGDB_BASE = 'https://www.steamgriddb.com/api/v2'



# ── Helpers ──────────────────────────────────────────────────────────────────

def parse_library(path='library.js'):
    """Extract id / title / systemId from game objects in library.js.
    Handles both single- and double-quoted JS strings (e.g. "Majora's Mask").
    Skips collection/tag objects that don't have a systemId field."""
    text = open(path, encoding='utf-8').read()
    # Match self-contained {...} blocks that contain all three fields
    block_pattern = re.compile(r'\{[^{}]+\}', re.S)
    id_re     = re.compile(r"\bid\s*:\s*['\"]([^'\"]+)['\"]")
    title_re  = re.compile(r"\btitle\s*:\s*['\"]([^'\"]+)['\"]")
    sysid_re  = re.compile(r"\bsystemId\s*:\s*['\"]([^'\"]+)['\"]")
    games = []
    for block in block_pattern.finditer(text):
        b = block.group()
        mi = id_re.search(b)
        mt = title_re.search(b)
        ms = sysid_re.search(b)
        if mi and mt and ms:
            games.append({'id': mi[1], 'title': mt[1], 'systemId': ms[1]})
    return games


def sgdb_search(title, sgdb_key):
    """Search SteamGridDB for portrait grid art (600x900). Returns URL or None.
    Free API key at steamgriddb.com → profile → API keys."""
    auth = {'Authorization': f'Bearer {sgdb_key}'}
    try:
        # Step 1 — find game ID
        url = f"{SGDB_BASE}/search/autocomplete/{urllib.parse.quote(title)}"
        req = urllib.request.Request(url, headers={**HEADERS, **auth})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        games = data.get('data', [])
        if not games:
            return None
        game_id = games[0]['id']
        # Step 2 — get portrait (600x900) grid images
        url = (f"{SGDB_BASE}/grids/game/{game_id}"
               f"?dimensions=600x900&types=static&nsfw=false")
        req = urllib.request.Request(url, headers={**HEADERS, **auth})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        grids = data.get('data', [])
        return grids[0]['url'] if grids else None
    except Exception as e:
        print(f'    SGDB error: {e}')
        return None


def tgdb_search(title, platform_id, api_key):
    """Search TheGamesDB, return front boxart URL or None."""
    q = urllib.parse.urlencode({
        'apikey': api_key,
        'name': title,
        'fields': 'boxart',
        'filter[platform]': platform_id,
    })
    try:
        req = urllib.request.Request(f'{TGDB_BASE}/Games/ByGameName?{q}',
                                     headers=HEADERS)
        with urllib.request.urlopen(req, timeout=12) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f'    API error: {e}')
        return None

    games = data.get('data', {}).get('games', [])
    if not games:
        return None

    tl = title.lower()
    best = next((g for g in games
                 if tl in g['game_title'].lower() or
                    g['game_title'].lower() in tl), games[0])

    gid   = best['id']
    art   = data.get('include', {}).get('boxart', {})
    base  = art.get('base_url', {}).get('medium',
                    'https://cdn.thegamesdb.net/images/medium/')
    imgs  = art.get('data', {}).get(str(gid), [])
    front = next((i for i in imgs if i.get('side') == 'front'), None)
    return (base + front['filename']) if front else None


def download(url, dest):
    """Download url to dest. Returns True on success."""
    tmp = dest + '.tmp'
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
        if len(raw) < 1024:
            return False          # suspiciously small → probably an error page
        # Atomic write: stage to .tmp then os.replace so a mid-write
        # interrupt never leaves a corrupt jpg that the UI would render
        # as a broken image and refuse to re-fetch (file exists).
        with open(tmp, 'wb') as f:
            f.write(raw)
        os.replace(tmp, dest)
        return True
    except Exception as e:
        print(f'    Download error: {e}')
        try: os.unlink(tmp)
        except OSError: pass
        return False


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Download boxart for Kente's Korner")
    ap.add_argument('--key', metavar='TGDB_KEY',
                    help='TheGamesDB API key (forums.thegamesdb.net)')
    ap.add_argument('--sgdb-key', metavar='SGDB_KEY',
                    help='SteamGridDB API key — RECOMMENDED (steamgriddb.com → API keys). '
                         'Fetches beautiful portrait-format cover art for all 158 games.')
    ap.add_argument('--delay', type=float, default=0.6,
                    help='Seconds between API calls (default 0.6)')
    args = ap.parse_args()

    os.makedirs('boxart', exist_ok=True)
    games = parse_library()
    ok = skip = fail = 0
    missing = []

    for g in games:
        sid, gid, title = g['systemId'], g['id'], g['title']
        dest = f'boxart/{gid}.jpg'

        if sid in SKIP_SYSTEMS:
            continue
        if os.path.exists(dest):
            print(f'[SKIP] {title}')
            skip += 1
            continue

        print(f'[FETCH] {title}  ({sid})', end='  ')

        # 1 — Hardcoded override (verified Wikipedia URLs, no key needed)
        if gid in OVERRIDES:
            time.sleep(WIKI_DELAY)
            if download(OVERRIDES[gid], dest):
                print('OK (Wikipedia)')
                ok += 1
                continue
            print('FAIL Wikipedia -- trying API...')

        # 2 — SteamGridDB (best portrait art for our 3/4 card layout)
        fetched = False
        if args.sgdb_key:
            img_url = sgdb_search(title, args.sgdb_key)
            if img_url and download(img_url, dest):
                print('OK (SteamGridDB)')
                ok += 1
                fetched = True
            time.sleep(args.delay)

        if fetched:
            continue

        # 3 — TheGamesDB fallback
        if args.key:
            pid = PLATFORMS.get(sid)
            if pid is None:
                print(f'SKIP unknown platform {sid}')
                fail += 1
                missing.append(g)
                continue
            img_url = tgdb_search(title, pid, args.key)
            if img_url and download(img_url, dest):
                print('OK (TGDB)')
                ok += 1
            else:
                print('FAIL not found')
                fail += 1
                missing.append(g)
            time.sleep(args.delay)
        elif not args.sgdb_key:
            print('FAIL (no API key)')
            fail += 1
            missing.append(g)
        else:
            # sgdb was tried but failed
            print('FAIL SteamGridDB miss')
            fail += 1
            missing.append(g)

    print(f'\n-- Done --  OK:{ok}  skipped:{skip}  failed:{fail}')

    if missing:
        print('\nStill missing:')
        for g in missing:
            print(f'  {g["id"]:<22} {g["title"]}  [{g["systemId"]}]')

    if missing and not (args.sgdb_key or args.key):
        print('\n' + '-' * 60)
        print('RECOMMENDED — get a FREE SteamGridDB key (best portrait art):')
        print('  1. Sign in at https://www.steamgriddb.com/profile/preferences/api')
        print('  2. Generate an API key')
        print('  3. Run:  python fetch-boxart.py --sgdb-key YOUR_KEY')
        print()
        print('Alternative — TheGamesDB (classic box scans):')
        print('  https://forums.thegamesdb.net/viewtopic.php?f=10&t=1')
        print('  Run:  python fetch-boxart.py --key YOUR_KEY')
        print()
        print('Both keys can be combined for maximum coverage:')
        print('  python fetch-boxart.py --sgdb-key S_KEY --key T_KEY')


if __name__ == '__main__':
    main()
