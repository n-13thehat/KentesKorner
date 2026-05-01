#!/usr/bin/env python3
"""
Kente's Korner — Native API Server
Serves the web shell and bridges to Batocera's emulation stack.
stdlib only — no pip required.
"""
__version__ = '1.1.0'

import json, subprocess, os, threading, shutil, time, platform, hashlib, re, tempfile, sys
import urllib.request, urllib.parse, urllib.error
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

# Local helpers — stdlib-only modules co-located in the batocera/ tree.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from kente_security import origin_allowed as _origin_allowed_helper
from kente_security import safe_resolve as _safe_resolve_helper

# Make sibling modules importable when launched via `python kente-server.py`
# from any cwd.
sys.path.insert(0, str(Path(__file__).parent))
try:
    import theater_providers as theater
except Exception as _theater_err:
    theater = None
    print(f'[theater] provider module unavailable: {_theater_err}')

try:
    import rom_providers as roms
except Exception as _roms_err:
    roms = None
    print(f'[roms] provider module unavailable: {_roms_err}')

PORT = 7777

# ── Deployment mode detection ───────────────────────────────────────────────
# IS_BATOCERA: running on Batocera Linux (or KENTE_FORCE_NATIVE=1 dev override)
# IS_APP:      running as a packaged Electron desktop app (KENTE_APP_MODE=electron)
# Default:     browser/dev mode — web files relative to script, no native paths
IS_BATOCERA = platform.system() == 'Linux' or os.getenv('KENTE_FORCE_NATIVE') == '1'
IS_APP      = os.getenv('KENTE_APP_MODE') == 'electron'

if IS_APP:
    # Electron passes KENTE_DATA_DIR = %APPDATA%/KenteCorner (or equivalent).
    # ROMs, BIOS files, and saves all live there — not in the install directory.
    _data    = Path(os.getenv('KENTE_DATA_DIR', Path.home() / 'KenteCorner'))
    BASE     = _data
    BIOS_DIR = _data / 'bios'
    ROMS_DIR = _data / 'roms'
    # Web files live next to the script (inside the packaged asar) or at the
    # workspace root in dev mode — same as the default/non-Batocera layout.
    WEB_DIR  = Path(__file__).parent.parent
elif IS_BATOCERA:
    BASE     = Path('/userdata')
    BIOS_DIR = BASE / 'bios'
    ROMS_DIR = BASE / 'roms'
    WEB_DIR  = Path(__file__).parent   # server lives in /userdata/kente/
else:
    BASE     = Path(__file__).parent.parent
    BIOS_DIR = BASE / 'bios'
    ROMS_DIR = BASE / 'roms'
    WEB_DIR  = BASE

# Ensure app-mode data directories exist on first launch
if IS_APP:
    ROMS_DIR.mkdir(parents=True, exist_ok=True)
    BIOS_DIR.mkdir(parents=True, exist_ok=True)
    (BASE / 'saves').mkdir(parents=True, exist_ok=True)

# ── EmulatorJS CDN proxy ────────────────────────────────────────────────────
# Community cores not on the official CDN are served from a local cache dir.
# /api/ejs/<subpath> proxies everything else to cdn.emulatorjs.org/stable/data/
EJS_CDN_BASE  = 'https://cdn.emulatorjs.org/stable/data/'
EJS_CORES_DIR = WEB_DIR / 'ejs-cores'   # local cache for community-built cores

# Flycast (Dreamcast) — built by nasomers/flycast-wasm (github.com/nasomers/flycast-wasm)
# The stable CDN doesn't host this core.  We serve it from a local cache and
# download it on first request.  Both the "wasm" and "legacy-wasm" names are
# mapped to the same WebGL2 file so EJS works regardless of its requiresWebGL2
# flag (Flycast is not in EJS's built-in list, so EJS requests the legacy name).
COMMUNITY_CORES = {
    'flycast-wasm.data':        'https://github.com/nasomers/flycast-wasm/releases/download/v1.0.0/flycast-wasm.data',
    'flycast-legacy-wasm.data': 'https://github.com/nasomers/flycast-wasm/releases/download/v1.0.0/flycast-wasm.data',
}

# Kente systemId → Batocera ROM folder name
# Values must match Batocera's /userdata/roms/<folder>/ directory names exactly.
SYSTEM_FOLDER = {
    # Kente systemId  →  Batocera ROM folder / emulatorlauncher system name
    # All values verified against https://wiki.batocera.org/systems (2025)
    # Tier 1
    'nes':        'nes',
    'gameboy':    'gb',
    'mastersys':  'mastersystem',   # Batocera: mastersystem  (NOT mastersys)
    'atari2600':  'atari2600',
    'atari7800':  'atari7800',
    'gamegear':   'gamegear',
    # Tier 2
    'snes':       'snes',
    'genesis':    'megadrive',
    'gbc':        'gbc',
    'gba':        'gba',
    'turbografx': 'pcengine',
    'neogeo':     'neogeo',
    'segacd':     'megacd',         # Batocera: megacd        (NOT segacd)
    'sega32x':    'sega32x',
    # Tier 3
    'n64':        'n64',
    'ps1':        'psx',
    'saturn':     'saturn',
    'dreamcast':  'dreamcast',
    'nds':        'nds',
    'psp':        'psp',
    # Tier 4
    'ps2':        'ps2',
    'gamecube':   'gamecube',
    'wii':        'wii',
    'xbox':       'xbox',
    # Tier 5
    'wiiu':       'wiiu',
    'xbox360':    'xbox360',
    'ps3':        'ps3',
    'switch':     'switch',
}

# ── Archive.org Pack Collections ─────────────────────────────────────────────
# These Archive.org identifiers host individual ROM files (not monolithic archives).
# Used by /api/pack/search as a fallback when the general subject search misses.
# Only systems with a verified individual-file pack are listed here.
ARCHIVE_PACKS = {
    'nes':  'pack-roms-nintendo-entertainment-system',  # 953 individual .7z files
    'snes': 'chrono-trigger-2-crimson-echoes-usa',      # 961 individual .sfc files
    # PSP: individual game items exist on Archive.org (subject:PSP, mediatype:data)
    # and are found by the general search; no verified individual-file pack available.
}

# System → ordered candidate emulator paths (Windows, env-var strings expanded at call time)
NATIVE_EMU_WIN = {
    'ps2':       [r'%ProgramFiles%\PCSX2\pcsx2-qt.exe',
                  r'%ProgramFiles%\PCSX2\PCSX2.exe',
                  r'%ProgramFiles(x86)%\PCSX2\PCSX2.exe',
                  r'%LOCALAPPDATA%\Programs\PCSX2\pcsx2-qt.exe'],
    'dreamcast': [r'%ProgramFiles%\Flycast\flycast.exe',
                  r'%LOCALAPPDATA%\Programs\Flycast\flycast.exe',
                  r'%ProgramFiles%\Redream\redream.exe',
                  r'%LOCALAPPDATA%\Programs\Redream\redream.exe'],
    'gamecube':  [r'%ProgramFiles%\Dolphin\Dolphin.exe',
                  r'%LOCALAPPDATA%\Programs\Dolphin\Dolphin.exe'],
    'wii':       [r'%ProgramFiles%\Dolphin\Dolphin.exe',
                  r'%LOCALAPPDATA%\Programs\Dolphin\Dolphin.exe'],
    'wiiu':      [r'%ProgramFiles%\Cemu\Cemu.exe',
                  r'%LOCALAPPDATA%\Programs\Cemu\Cemu.exe',
                  r'%LOCALAPPDATA%\Microsoft\WinGet\Packages\Cemu.Cemu_Microsoft.Winget.Source_8wekyb3d8bbwe\Cemu.exe'],
    'switch':    [r'%APPDATA%\Ryujinx\publish\Ryujinx.exe',
                  r'%ProgramFiles%\Ryujinx\publish\Ryujinx.exe',
                  r'%LOCALAPPDATA%\Programs\Ryujinx\Ryujinx.exe'],
    'xbox':      [r'%ProgramFiles%\xemu\xemu.exe',
                  r'%LOCALAPPDATA%\Programs\xemu\xemu.exe'],
    'xbox360':   [r'%ProgramFiles%\Xenia\xenia.exe',
                  r'%LOCALAPPDATA%\Programs\Xenia\xenia.exe'],
    'ps3':       [r'%ProgramFiles%\RPCS3\rpcs3.exe',
                  r'%LOCALAPPDATA%\Programs\RPCS3\rpcs3.exe'],
}

# In Electron app mode, prepend the bundled Dolphin portable path so it is
# found before any system-installed Dolphin.  KENTE_DOLPHIN_PATH is set by
# electron/main.js and points to resources/dolphin/Dolphin.exe inside the app.
_bundled_dolphin = os.getenv('KENTE_DOLPHIN_PATH', '')
if _bundled_dolphin:
    for _sid in ('gamecube', 'wii'):
        NATIVE_EMU_WIN.setdefault(_sid, []).insert(0, _bundled_dolphin)

# System → ordered candidate emulator commands (Linux — resolved via shutil.which)
NATIVE_EMU_LIN = {
    'ps2':       ['pcsx2-qt', 'pcsx2'],
    'dreamcast': ['flycast', 'redream'],
    'gamecube':  ['dolphin-emu', 'dolphin'],
    'wii':       ['dolphin-emu', 'dolphin'],
    'switch':    ['ryujinx'],
    'ps3':       ['rpcs3'],
    'xbox':      ['xemu'],
}

# Required / optional BIOS filenames per system
BIOS_FILES = {
    'gba':'gba_bios.bin', 'gameboy':'gb_bios.bin', 'gbc':'gbc_bios.bin',
    'nds':'bios7.bin',
    'ps1':'scph1001.bin', 'ps2':'scph39001.bin', 'saturn':'saturn_bios.bin',
    'dreamcast':'dc_boot.bin', 'dreamcast_flash':'dc_flash.bin',
    'neogeo':'neogeo.zip', 'mastersys':'bios_U.sms',
    'atari7800':'7800 BIOS (U).rom',
}

MIME = {
    # Text / scripts
    '.html':'text/html', '.js':'application/javascript',
    '.css':'text/css',   '.json':'application/json',
    '.txt':'text/plain', '.xml':'application/xml',
    # Images
    '.png':'image/png',  '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
    '.gif':'image/gif',  '.webp':'image/webp', '.avif':'image/avif',
    '.svg':'image/svg+xml', '.ico':'image/x-icon',
    # Fonts
    '.woff':'font/woff', '.woff2':'font/woff2',
    '.ttf':'font/ttf',   '.otf':'font/otf',
    # Audio / video
    '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav',
    '.mp4':'video/mp4',  '.webm':'video/webm',
    # Flash / Ruffle / EmulatorJS
    '.swf':'application/x-shockwave-flash',
    '.wasm':'application/wasm',
}

SAVES_DIR       = BASE / 'saves'
CONF_FILE       = BASE / 'system' / 'batocera.conf'

# ── Mod system ──────────────────────────────────────────────────────────────
# Mods live in workspace/mods/<gameId>/<modName>/*.ssf
# _backup/ inside each game folder stores the originals before a mod is applied.
MODS_DIR         = Path(__file__).parent.parent / 'mods'

# SSF2 data directories — contains the DAT*.ssf files that mods replace.
SSF2_WIN_DATA    = Path('C:/Program Files (x86)/Super Smash Flash 2 Beta')
SSF2_LIN_DATA    = Path.home() / 'ssf2' / 'data' / 'data'  # ~/ssf2/data/data on Linux

# Lock protecting read-modify-write access to batocera.conf from concurrent threads
_CONF_LOCK = threading.Lock()
# Lock protecting active_proc from concurrent launch/status races
_PROC_LOCK = threading.Lock()
# Guards _active_downloads so concurrent requests for the same file are serialised
_DOWNLOAD_LOCK  = threading.Lock()
_active_downloads: set = set()          # set of dest_file paths currently downloading
FLASH_CACHE_DIR = BASE / 'games' / 'flash' / 'ssf2-cache'
# Maximum wall-clock seconds for a single ROM download.
# 4 hours covers Switch/PS3/Wii U titles (up to 50 GB) at ~3 MB/s.
MAX_ROM_DL_SECS  = 14400  # 4 hours
# Hard per-file size cap: reject any response that exceeds this to prevent a
# malicious or misconfigured URL from filling the disk with garbage data.
MAX_ROM_FILE_BYTES = 100 * 1024 ** 3  # 100 GB

# Hosts allowed to be fetched through the flash proxy
PROXY_ALLOWED_HOSTS = {
    'www.supersmashflash.com', 'supersmashflash.com',
    'www.mcleodgaming.com',    'mcleodgaming.com',
}

active_proc = None

# ── Helpers ──────────────────────────────────────────────────────────────────

def bios_status():
    return {sid: (BIOS_DIR / fname).exists() for sid, fname in BIOS_FILES.items()}

# ── BIOS downloader ───────────────────────────────────────────────────────────
# Strategy:
#   1. Files with a DIRECT URL → downloaded individually (fast, no big zip needed).
#   2. Remaining missing files → downloaded from the 246 MB BIOS pack zip on
#      archive.org; only files not already on disk are extracted.
#   3. PS2 BIOS files are also copied into PCSX2's own bios folder so the
#      emulator can find them, and PCSX2.ini is updated with the correct filename.

BIOS_PACK_URL = 'https://archive.org/download/bios-v-30_202103/BIOS%20-V-%2030.zip'

# archive.org serves individual files from within zips at this URL pattern:
#   /download/<id>/<zipname>/<internal-path>
_IA_BASE = 'https://archive.org/download/bios-v-30_202103/BIOS%20-V-%2030.zip/BIOS%20-V-%2030%2F'

# Files we can fetch individually (small, or otherwise separately available)
BIOS_DIRECT_URLS = {
    'scph39001.bin': _IA_BASE + 'scph39001.bin',   # PS2 NTSC-U  4 MB
    'scph39001.MEC': _IA_BASE + 'scph39001.MEC',   # PS2 MEC companion  4 B
}

# Files in the pack zip that require a full-zip download (path inside zip)
BIOS_PACK_ENTRIES = {
    'gba_bios.bin':    'BIOS -V- 30/gba_bios.bin',
    'gb_bios.bin':     'BIOS -V- 30/gb_bios.bin',
    'gbc_bios.bin':    'BIOS -V- 30/gbc_bios.bin',
    'bios7.bin':       'BIOS -V- 30/bios7.bin',
    'scph1001.bin':    'BIOS -V- 30/scph1001.bin',
    'saturn_bios.bin': 'BIOS -V- 30/saturn_bios.bin',
    'dc_boot.bin':     'BIOS -V- 30/dc_boot.bin',
    'dc_flash.bin':    'BIOS -V- 30/dc_flash.bin',
    'neogeo.zip':      'BIOS -V- 30/neogeo.zip',
    # bios_U.sms / 7800 BIOS (U).rom not in pack — optional, skip.
}

# Shared state — written by background thread, read by status endpoint
_bios_dl_state = {
    'running': False,
    'done':    False,
    'error':   None,
    'phase':   '',
    'downloaded_mb': 0,
    'total_mb':      0,
    'results':       {},
}

def _bios_configure_pcsx2(bios_dir: Path):
    """Copy PS2 BIOS files into PCSX2's bios folder and update PCSX2.ini."""
    import os as _os
    user = Path(_os.environ.get('USERPROFILE', _os.path.expanduser('~')))
    pcsx2_bios = user / 'Documents' / 'PCSX2' / 'bios'
    pcsx2_ini  = user / 'Documents' / 'PCSX2' / 'inis' / 'PCSX2.ini'

    ps2_files = ['scph39001.bin', 'scph39001.MEC']
    pcsx2_bios.mkdir(parents=True, exist_ok=True)
    copied = []
    for fname in ps2_files:
        src = bios_dir / fname
        dst = pcsx2_bios / fname
        if src.exists() and not dst.exists():
            import shutil as _sh
            _sh.copy2(str(src), str(dst))
            copied.append(fname)
            print(f'[bios] copied {fname} -> {dst}')

    # Update PCSX2.ini: set  BIOS = scph39001.bin  (only under [Filenames] section)
    # We do a line-by-line walk so we never accidentally touch the [Folders] Bios key.
    if pcsx2_ini.exists():
        try:
            lines = pcsx2_ini.read_text(encoding='utf-8', errors='replace').splitlines(keepends=True)
            in_filenames = False
            changed = False
            for i, line in enumerate(lines):
                stripped = line.strip()
                if stripped.startswith('['):
                    in_filenames = stripped.lower() == '[filenames]'
                elif in_filenames and stripped.upper().startswith('BIOS') and '=' in stripped:
                    key, _, _ = stripped.partition('=')
                    if key.strip().upper() == 'BIOS':
                        eol = '\r\n' if line.endswith('\r\n') else '\n'
                        lines[i] = f'BIOS = scph39001.bin{eol}'
                        changed = True
                        break
            if changed:
                pcsx2_ini.write_text(''.join(lines), encoding='utf-8')
                print('[bios] PCSX2.ini updated: BIOS = scph39001.bin')
        except Exception as ex:
            print(f'[bios] PCSX2.ini update failed: {ex}')
    return copied

def _bios_download_thread():
    import tempfile, zipfile as _zf, urllib.request as _ur
    global _bios_dl_state
    _bios_dl_state.update({'running': True, 'done': False, 'error': None,
                           'phase': 'downloading', 'results': {},
                           'downloaded_mb': 0, 'total_mb': 0})
    BIOS_DIR.mkdir(parents=True, exist_ok=True)
    headers = {'User-Agent': 'Mozilla/5.0 KenteKorner/1.0'}
    results = {}
    tmp_path = None

    try:
        # ── Phase 1: direct per-file downloads ────────────────────────────────
        for fname, url in BIOS_DIRECT_URLS.items():
            dest = BIOS_DIR / fname
            if dest.exists():
                results[fname] = 'already_exists'
                continue
            _bios_dl_state['phase'] = f'downloading {fname}'
            try:
                req = _ur.Request(url, headers=headers)
                with _ur.urlopen(req, timeout=120) as resp:
                    dest.write_bytes(resp.read())
                results[fname] = 'ok'
                print(f'[bios] downloaded {fname} ({dest.stat().st_size//1024} KB)')
            except Exception as ex:
                results[fname] = f'direct_error: {ex}'
                print(f'[bios] direct download failed for {fname}: {ex}')

        # ── Phase 2: pack download for anything still missing ─────────────────
        pack_needed = [fn for fn, zp in BIOS_PACK_ENTRIES.items()
                       if not (BIOS_DIR / fn).exists()]
        if pack_needed:
            _bios_dl_state['phase'] = 'downloading pack'
            req = _ur.Request(BIOS_PACK_URL, headers=headers)
            with _ur.urlopen(req, timeout=300) as resp:
                total = int(resp.headers.get('Content-Length', 0))
                _bios_dl_state['total_mb'] = round(total / 1e6, 1)
                with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as tmp:
                    tmp_path = tmp.name
                    downloaded = 0
                    chunk = 1 << 17
                    while True:
                        buf = resp.read(chunk)
                        if not buf:
                            break
                        tmp.write(buf)
                        downloaded += len(buf)
                        _bios_dl_state['downloaded_mb'] = round(downloaded / 1e6, 1)

            _bios_dl_state['phase'] = 'extracting'
            with _zf.ZipFile(tmp_path, 'r') as zf:
                for dest_name, zip_path in BIOS_PACK_ENTRIES.items():
                    dest = BIOS_DIR / dest_name
                    if dest.exists():
                        results[dest_name] = 'already_exists'
                        continue
                    try:
                        data = zf.read(zip_path)
                        dest.write_bytes(data)
                        results[dest_name] = 'ok'
                        print(f'[bios] extracted {dest_name} ({len(data)//1024} KB)')
                    except KeyError:
                        results[dest_name] = f'not_found_in_zip'
                    except Exception as ex:
                        results[dest_name] = f'error: {ex}'
        else:
            for fn in BIOS_PACK_ENTRIES:
                if fn not in results:
                    results[fn] = 'already_exists'

        # ── Phase 3: configure PCSX2 with its BIOS ────────────────────────────
        _bios_dl_state['phase'] = 'configuring pcsx2'
        copied = _bios_configure_pcsx2(BIOS_DIR)
        if copied:
            results['pcsx2_setup'] = f'copied {copied}, ini updated'
        else:
            results['pcsx2_setup'] = 'already configured'

        _bios_dl_state.update({'running': False, 'done': True, 'phase': 'done',
                                'results': results})
        print(f'[bios] all done: {results}')

    except Exception as ex:
        _bios_dl_state.update({'running': False, 'done': False,
                                'error': str(ex), 'phase': 'error'})
        print(f'[bios] download failed: {ex}')
    finally:
        if tmp_path:
            try:
                import os as _os; _os.unlink(tmp_path)
            except Exception:
                pass

# ── Emulator dependency installer ─────────────────────────────────────────────
# Emulators are treated as OS-level dependencies.  Missing ones are installed
# automatically via WinGet (preferred) or direct GitHub release download.
# On Linux (KenteOS bootable) AppImages are downloaded to /opt/kente/emulators/.

_APPDATA   = os.environ.get('APPDATA',      os.path.expanduser('~'))
_LOCALAPP  = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
_PROGFILES = os.environ.get('ProgramFiles', r'C:\Program Files')

EMULATOR_DEPS = {
    'flycast': {
        'name':       'Flycast (Dreamcast)',
        'systems':    ['dreamcast'],
        'winget_id':  None,   # not in WinGet registry
        'win_exe':    Path(_LOCALAPP) / 'Programs' / 'Flycast' / 'flycast.exe',
        'win_dest':   Path(_LOCALAPP) / 'Programs' / 'Flycast',
        'win_dl':     'https://github.com/flyinghead/flycast/releases/download/v2.6/flycast-win64-2.6.zip',
        'win_dl_exe': 'flycast.exe',
        'lin_appimg': 'https://github.com/flyinghead/flycast/releases/download/v2.6/flycast-linux-x86_64',
    },
    'rpcs3': {
        'name':       'RPCS3 (PlayStation 3)',
        'systems':    ['ps3'],
        'winget_id':  'RPCS3.RPCS3',
        'win_exe':    Path(_LOCALAPP) / 'Programs' / 'RPCS3' / 'rpcs3.exe',
        'win_dest':   Path(_LOCALAPP) / 'Programs' / 'RPCS3',
        'win_dl':     None,   # WinGet preferred; .7z needs external extractor
        'lin_appimg': 'https://github.com/RPCS3/rpcs3-binaries-linux/releases/latest/download/rpcs3.AppImage',
    },
    'cemu': {
        'name':       'Cemu (Wii U)',
        'systems':    ['wiiu'],
        'winget_id':  'Cemu.Cemu',
        'win_exe':    Path(_LOCALAPP) / 'Programs' / 'Cemu' / 'Cemu.exe',
        'win_dest':   Path(_LOCALAPP) / 'Programs' / 'Cemu',
        'win_dl':     None,   # WinGet preferred
        'lin_appimg': 'https://github.com/cemu-project/Cemu/releases/latest/download/Cemu-2.0-x86_64.AppImage',
    },
}

_emu_install_state = {
    'running': False,
    'done':    False,
    'error':   None,
    'current': '',
    'results': {},
}

def _winget_portable_glob(pkg_id, exe_name):
    """Search %LOCALAPPDATA%\\Microsoft\\WinGet\\Packages for a WinGet portable install.

    WinGet portable packages land at:
      %LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\{PackageId}_{Publisher}_{hash}\\[subdir]\\{exe}
    We match any directory whose name starts with the PackageId (e.g. 'Cemu.Cemu').
    """
    winget_base = Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft' / 'WinGet' / 'Packages'
    if not winget_base.exists():
        return None
    try:
        pkg_dirs = list(winget_base.iterdir())
    except PermissionError:
        return None
    for pkg_dir in pkg_dirs:
        if not pkg_dir.name.startswith(pkg_id):
            continue
        # Check directly inside the package folder
        exe = pkg_dir / exe_name
        if exe.exists():
            return str(exe)
        # Check one level deep (some packages unzip into a versioned subfolder)
        try:
            for sub in pkg_dir.iterdir():
                if sub.is_dir():
                    exe2 = sub / exe_name
                    if exe2.exists():
                        return str(exe2)
        except PermissionError:
            continue
    return None

def _check_emu_installed(key):
    """Return (installed: bool, path: str|None) for an emulator key."""
    dep    = EMULATOR_DEPS[key]
    is_win = platform.system() == 'Windows'
    if is_win:
        # 1. Check declared win_exe path
        p = dep.get('win_exe')
        if p and p.exists():
            return True, str(p)
        # 2. Check NATIVE_EMU_WIN paths for each system this emulator covers
        for sid in dep.get('systems', []):
            for candidate in NATIVE_EMU_WIN.get(sid, []):
                ep = Path(os.path.expandvars(candidate))
                if ep.exists():
                    return True, str(ep)
        # 3. Glob WinGet portable packages directory
        wg_id  = dep.get('winget_id', '')
        if wg_id:
            exe_name = dep['win_exe'].name if dep.get('win_exe') else f'{key}.exe'
            found = _winget_portable_glob(wg_id, exe_name)
            if found:
                return True, found
    else:
        appimg = Path('/opt/kente/emulators') / f'{key}.AppImage'
        if appimg.exists():
            return True, str(appimg)
        found = shutil.which(key) or shutil.which(key.upper())
        if found:
            return True, found
    return False, None

def _run_winget(pkg_id):
    """Install via winget silently. Returns (ok: bool, output: str)."""
    try:
        r = subprocess.run(
            ['winget', 'install', '--id', pkg_id, '--silent',
             '--accept-package-agreements', '--accept-source-agreements', '--force'],
            capture_output=True, text=True, timeout=300,
        )
        return r.returncode == 0, (r.stdout + r.stderr)[:500]
    except FileNotFoundError:
        return False, 'winget not available'
    except Exception as ex:
        return False, str(ex)

def _emulator_install_thread():
    import zipfile as _zf, urllib.request as _ur, io as _io
    global _emu_install_state
    _emu_install_state.update({'running': True, 'done': False,
                               'error': None, 'current': '', 'results': {}})
    results  = {}
    is_win   = platform.system() == 'Windows'
    headers  = {'User-Agent': 'Mozilla/5.0 KenteOS/1.0'}

    for key, dep in EMULATOR_DEPS.items():
        installed, path = _check_emu_installed(key)
        if installed:
            results[key] = {'status': 'already_installed', 'path': path}
            continue

        _emu_install_state['current'] = dep['name']
        print(f'[emu] Installing {dep["name"]}...')

        if is_win:
            # 1. Try WinGet
            wg = dep.get('winget_id')
            if wg:
                ok, out = _run_winget(wg)
                if ok:
                    _, p2 = _check_emu_installed(key)
                    results[key] = {'status': 'installed_winget', 'path': p2}
                    print(f'[emu] {dep["name"]} installed via WinGet')
                    continue
                print(f'[emu] WinGet failed for {key}: {out}')

            # 2. Direct zip download
            dl = dep.get('win_dl')
            if dl:
                try:
                    dest_dir = dep['win_dest']
                    dest_dir.mkdir(parents=True, exist_ok=True)
                    req = _ur.Request(dl, headers=headers)
                    with _ur.urlopen(req, timeout=120) as resp:
                        raw = resp.read()
                    with _zf.ZipFile(_io.BytesIO(raw)) as zf:
                        zf.extractall(str(dest_dir))
                    # Flatten one nested folder if present (some zips wrap in a subdir)
                    import shutil as _sh2
                    for sub in list(dest_dir.iterdir()):
                        if sub.is_dir():
                            for f in sub.iterdir():
                                dst = dest_dir / f.name
                                # shutil.move handles FileExistsError on Windows correctly
                                _sh2.move(str(f), str(dst))
                            try: sub.rmdir()
                            except OSError: pass
                    _, p3 = _check_emu_installed(key)
                    results[key] = {'status': 'installed_download', 'path': p3}
                    print(f'[emu] {dep["name"]} installed via direct download')
                except Exception as ex:
                    results[key] = {'status': 'error', 'error': str(ex)}
                    print(f'[emu] {dep["name"]} install failed: {ex}')
            else:
                results[key] = {'status': 'manual_required',
                                'reason': 'No WinGet entry and no zip URL — install manually'}
        else:
            # Linux: download AppImage
            url = dep.get('lin_appimg')
            if url:
                try:
                    dest = Path('/opt/kente/emulators') / f'{key}.AppImage'
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    req = _ur.Request(url, headers=headers)
                    with _ur.urlopen(req, timeout=300) as resp:
                        dest.write_bytes(resp.read())
                    dest.chmod(0o755)
                    results[key] = {'status': 'installed_appimage', 'path': str(dest)}
                    print(f'[emu] {dep["name"]} AppImage installed -> {dest}')
                except Exception as ex:
                    results[key] = {'status': 'error', 'error': str(ex)}
                    print(f'[emu] {dep["name"]} AppImage install failed: {ex}')
            else:
                results[key] = {'status': 'unavailable'}

    _emu_install_state.update({'running': False, 'done': True,
                               'current': '', 'results': results})
    print(f'[emu] install complete: {results}')

def find_rom(system_id, title):
    """Fuzzy-match a ROM file for system_id by title.

    Searches two candidate directories:
      1. ROMS_DIR / SYSTEM_FOLDER[system_id]  — Batocera canonical name (e.g. 'psx')
      2. ROMS_DIR / system_id                 — local desktop layout (e.g. 'ps1')
    Returns the full path string of the first match, or None.
    """
    needle = title.lower().replace(' ', '').replace(':', '').replace("'", '').replace('&', '')

    # Build search dirs without duplicates
    batocera_folder = SYSTEM_FOLDER.get(system_id)
    dirs_to_search = []
    if batocera_folder:
        dirs_to_search.append(ROMS_DIR / batocera_folder)
    local_dir = ROMS_DIR / system_id
    if local_dir not in dirs_to_search:
        dirs_to_search.append(local_dir)

    for rom_dir in dirs_to_search:
        if not rom_dir.exists():
            continue
        for f in sorted(rom_dir.iterdir()):
            if not f.is_file() or f.suffix.lower() in ('.tmp', '.part'):
                continue
            stem = f.stem.lower().replace(' ', '').replace('_', '').replace('-', '').replace("'", '').replace('&', '')
            if needle in stem or stem in needle:
                return str(f)
    return None

def system_info():
    """Return disk stats, Batocera version, uptime, controller count."""
    info = {}
    # Disk usage for /userdata
    try:
        usage = shutil.disk_usage(str(BASE))
        info['disk_total']    = f'{usage.total / 1e9:.1f} GB'
        info['disk_free']     = f'{usage.free  / 1e9:.1f} GB'
        info['disk_used_pct'] = int((usage.used / usage.total) * 100)
    except Exception:
        info['disk_total'] = info['disk_free'] = '—'
        info['disk_used_pct'] = 0
    # Batocera version
    try:
        ver = Path('/usr/share/batocera/batocera.version').read_text().strip()
        info['batocera_version'] = ver
    except Exception:
        info['batocera_version'] = 'unknown'
    # Uptime
    try:
        secs = float(Path('/proc/uptime').read_text().split()[0])
        h, r = divmod(int(secs), 3600)
        m, s = divmod(r, 60)
        info['uptime'] = f'{h}:{m:02d}:{s:02d}'
    except Exception:
        info['uptime'] = '—'
    # Connected controllers (count /dev/input/js* joystick devices)
    try:
        info['controllers'] = len(list(Path('/dev/input').glob('js*')))
    except Exception:
        info['controllers'] = 0
    # Hostname
    try:
        info['hostname'] = Path('/etc/hostname').read_text().strip()
    except Exception:
        info['hostname'] = 'batocera'
    return info

def list_saves():
    """Scan /userdata/saves and return a flat list of save file entries.

    Both iterdir() calls are guarded so a permission error or stale symlink
    inside a single system folder never crashes the entire endpoint.
    """
    saves = []
    if not SAVES_DIR.exists():
        return saves
    sys_name_map = {v: k for k, v in SYSTEM_FOLDER.items()}
    try:
        top_entries = sorted(SAVES_DIR.iterdir())
    except OSError:
        return saves   # saves dir itself is inaccessible
    for sys_dir in top_entries:
        if not sys_dir.is_dir():
            continue
        system_id = sys_name_map.get(sys_dir.name, sys_dir.name)
        try:
            file_entries = sorted(sys_dir.iterdir())
        except OSError:
            continue   # skip unreadable system subdirectory
        for f in file_entries:
            if f.is_file():
                try:
                    st      = f.stat()
                    size_kb = st.st_size // 1024
                    mtime   = time.strftime('%Y-%m-%d', time.localtime(st.st_mtime))
                except OSError:
                    size_kb, mtime = 0, '—'
                saves.append({
                    'systemId':   system_id,
                    'systemName': sys_dir.name.upper(),
                    'file':       f.name,
                    'size':       f'{size_kb} KB' if size_kb else '< 1 KB',
                    'modified':   mtime,
                })
    return saves

def write_conf_key(key, value):
    """Write or update a single key=value line in batocera.conf.

    The write is atomic: the new content is staged to a sibling .tmp file
    and renamed into place only after a complete successful write, so a
    server crash mid-write can never leave batocera.conf truncated.
    """
    with _CONF_LOCK:
        CONF_FILE.parent.mkdir(parents=True, exist_ok=True)
        lines = CONF_FILE.read_text().splitlines() if CONF_FILE.exists() else []
        found = False
        for i, line in enumerate(lines):
            if line.startswith(f'{key}='):
                lines[i] = f'{key}={value}'
                found = True
                break
        if not found:
            lines.append(f'{key}={value}')
        tmp = CONF_FILE.with_suffix('.tmp')
        try:
            tmp.write_text('\n'.join(lines) + '\n')
            tmp.replace(CONF_FILE)      # atomic on POSIX; near-atomic on Windows
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

def proxy_asset(url):
    """Fetch a McLeod/SSF2 asset, persist to disk cache, return (bytes, mime_type).
    Uses a 16-char SHA-256 hex prefix as the cache key so filenames stay short
    but unique. The original file extension is preserved for debuggability."""
    parsed = urllib.parse.urlparse(url)
    if parsed.hostname not in PROXY_ALLOWED_HOSTS:
        raise PermissionError(f'Host not in allowlist: {parsed.hostname}')

    url_hash = hashlib.sha256(url.encode()).hexdigest()[:20]
    # Preserve extension from the path portion (ignore query-string)
    raw_path = parsed.path.split('?')[0]
    ext      = Path(raw_path).suffix or '.bin'
    cache_file = FLASH_CACHE_DIR / f'{url_hash}{ext}'
    meta_file  = FLASH_CACHE_DIR / f'{url_hash}.meta.json'

    if cache_file.exists() and meta_file.exists():
        meta = json.loads(meta_file.read_text())
        return cache_file.read_bytes(), meta['ct']

    # Download from origin
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (compatible; KenteKorner/1.0)',
        'Referer':    'https://www.supersmashflash.com/',
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        ct   = resp.headers.get('Content-Type', 'application/octet-stream').split(';')[0].strip()
        data = resp.read()

    FLASH_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    # Write atomically: stage to .tmp then rename so a mid-write crash
    # never leaves a truncated file that would be served on the next request.
    tmp_cache = cache_file.with_suffix(cache_file.suffix + '.tmp')
    try:
        tmp_cache.write_bytes(data)
        tmp_cache.replace(cache_file)          # atomic on POSIX; near-atomic on Windows
    except Exception:
        tmp_cache.unlink(missing_ok=True)      # discard incomplete temp
        raise
    # Atomic meta write — same pattern as the cache body above.
    # A partial meta.json write (e.g. server kill mid-write) would leave a
    # corrupt JSON fragment; the next request then crashes on json.loads().
    tmp_meta = meta_file.with_suffix('.meta.json.tmp')
    try:
        tmp_meta.write_text(json.dumps({'url': url, 'ct': ct, 'size': len(data)}))
        tmp_meta.replace(meta_file)
    except Exception:
        tmp_meta.unlink(missing_ok=True)
        raise
    return data, ct

def flash_cache_status():
    """Return stats about the SSF2 asset disk cache."""
    if not FLASH_CACHE_DIR.exists():
        return {'files': 0, 'bytes': 0, 'ready': False}
    meta_files  = list(FLASH_CACHE_DIR.glob('*.meta.json'))
    # Sum sizes of cached asset files only (exclude the companion .meta.json sidecars)
    total_bytes = sum(
        f.stat().st_size for f in FLASH_CACHE_DIR.iterdir()
        if not f.name.endswith('.meta.json')
    )
    return {'files': len(meta_files), 'bytes': total_bytes,
            'ready': len(meta_files) > 0}

def download_rom(system_id, filename, url):
    """Download a ROM from a URL directly into /userdata/roms/<system>/.

    Thread-safety: concurrent calls for the *same* dest_file are serialised
    via _DOWNLOAD_LOCK / _active_downloads so they don't corrupt the file.

    Timeout: a per-read socket timeout of 30 s prevents a stalled TCP
    connection from hanging forever.  A wall-clock cap (MAX_ROM_DL_SECS)
    additionally limits very slow-but-continuous transfers.

    Security: system_id must be a key in SYSTEM_FOLDER.  The previous
    fallback of using the raw system_id as the folder name allowed a
    caller to supply "../../etc" and write outside ROMS_DIR.
    """
    folder = SYSTEM_FOLDER.get(system_id)
    if not folder:
        return False, f'Unknown system: {system_id}', 0
    dest_dir  = ROMS_DIR / folder
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_file = dest_dir / filename
    dest_key  = str(dest_file)

    # ── Serialise concurrent downloads of the same file ──────────────────
    with _DOWNLOAD_LOCK:
        if dest_key in _active_downloads:
            return False, 'Download already in progress for this file', 0
        _active_downloads.add(dest_key)

    tmp_file = dest_file.with_suffix(dest_file.suffix + '.tmp')
    try:
        headers = {'User-Agent': 'KenteKorner/1.0'}
        req     = urllib.request.Request(url, headers=headers)
        # 30 s covers each blocking socket read; wall-clock cap below covers
        # slow-but-continuous transfers that would otherwise run for hours.
        deadline = time.monotonic() + MAX_ROM_DL_SECS
        with urllib.request.urlopen(req, timeout=30) as resp:
            received = 0
            chunk    = 65536  # 64 KB chunks
            with open(tmp_file, 'wb') as f:
                while True:
                    if time.monotonic() > deadline:
                        raise TimeoutError(
                            f'Download exceeded {MAX_ROM_DL_SECS // 3600}h wall-clock limit'
                        )
                    data = resp.read(chunk)
                    if not data:
                        break
                    f.write(data)
                    received += len(data)
                    if received > MAX_ROM_FILE_BYTES:
                        raise ValueError(
                            f'File exceeds {MAX_ROM_FILE_BYTES // 1024**3} GB hard limit — '
                            'aborting to protect disk space'
                        )
        # Atomic promotion: replace dest only after a complete write
        tmp_file.replace(dest_file)
        return True, str(dest_file), received
    except Exception as e:
        tmp_file.unlink(missing_ok=True)   # clean up incomplete temp file
        if dest_file.exists() and dest_file.stat().st_size == 0:
            dest_file.unlink(missing_ok=True)
        return False, str(e), 0
    finally:
        with _DOWNLOAD_LOCK:
            _active_downloads.discard(dest_key)

def _refocus_browser():
    """Best-effort: bring the browser window back to the foreground after a game exits."""
    sys = platform.system()
    if sys == 'Linux':
        for name in ('Chromium', 'chromium', 'chromium-browser', 'chrome', 'firefox'):
            subprocess.run(['xdotool', 'search', '--name', name, 'windowactivate'],
                           capture_output=True)
    elif sys == 'Windows':
        try:
            subprocess.run(
                ['powershell', '-NoProfile', '-Command',
                 '$p = Get-Process -Name chrome,chromium,msedge,firefox '
                 '-ErrorAction SilentlyContinue '
                 '| Where-Object {$_.MainWindowHandle -ne 0} '
                 '| Sort-Object MainWindowHandle -Descending '
                 '| Select-Object -First 1; '
                 'if ($p) { Add-Type -AssemblyName Microsoft.VisualBasic; '
                 '[Microsoft.VisualBasic.Interaction]::AppActivate($p.Id) }'],
                capture_output=True, timeout=6,
            )
        except Exception:
            pass  # focus restore is best-effort; never block the server thread

def launch_game(system_id, rom_path):
    global active_proc
    folder = SYSTEM_FOLDER.get(system_id)
    if not folder:
        return False, f'Unknown system: {system_id}'
    if not Path(rom_path).exists():
        return False, 'ROM file not found on disk'

    launcher = Path('/usr/bin/emulatorlauncher')
    if not launcher.exists():
        # Not Batocera — use the native desktop emulator (Dolphin, PCSX2, etc.)
        ok, method, error = find_and_launch_rom(system_id, rom_path)
        if ok:
            return True, method
        return False, error or f'No emulator found for {system_id} — is one installed?'

    try:
        proc = subprocess.Popen(
            [str(launcher), '-system', folder, '-rom', rom_path],
            env={**os.environ, 'DISPLAY': ':0'},
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        with _PROC_LOCK:
            active_proc = proc

        # Give emulatorlauncher 2 s to fail fast.
        # A successful launch keeps the process alive for the entire game session;
        # a bad system name / missing core / unsupported ROM exits in < 1 s with a
        # non-zero code.  We surface that as an error so the UI shows a real message
        # instead of silently closing the overlay while nothing launched.
        try:
            exit_code = proc.wait(timeout=2)
            if exit_code != 0:
                stderr_text = ''
                try:
                    stderr_text = proc.stderr.read(200).decode('utf-8', errors='replace').strip()
                except Exception:
                    pass
                detail = stderr_text or f'exit {exit_code}'
                return False, f'emulatorlauncher failed ({detail}) — check emulator install for {folder}'
            # exit_code 0 in < 2 s: unusual but treat as clean handoff
        except subprocess.TimeoutExpired:
            pass  # Still running after 2 s → emulator is loading normally ✓

        def _wait_refocus():
            proc.wait()
            _refocus_browser()
        threading.Thread(target=_wait_refocus, daemon=True).start()
        return True, 'launched'
    except Exception as e:
        return False, str(e)

def launch_native_app(exe_path=None, linux_exe=None):
    """Launch a native game executable.

    exe_path   — Windows .exe path (used on Windows platform)
    linux_exe  — Linux shell script / binary path, e.g. '~/ssf2/data/run.sh'
                 Used directly on Linux; launched via WSL on Windows.

    SSF2 run.sh convention: the script must run from its grandparent directory
    (~/ssf2/) because it references './data/fp64 $PWD/data/run'.
    """
    global active_proc
    sys_name = platform.system()

    # ── Linux native (Batocera / direct Linux) ─────────────────────────────
    if sys_name == 'Linux' and linux_exe:
        script = Path(linux_exe).expanduser()
        if not script.exists():
            return False, f'Linux exe not found: {script}'
        # run.sh lives at ~/ssf2/data/run.sh; needs cwd = ~/ssf2/
        cwd = str(script.parent.parent)
        try:
            proc = subprocess.Popen(
                ['bash', str(script)],
                cwd=cwd,
                env={**os.environ, 'DISPLAY': os.environ.get('DISPLAY', ':0')},
            )
            with _PROC_LOCK:
                active_proc = proc
            def _wl(): proc.wait(); _refocus_browser()
            threading.Thread(target=_wl, daemon=True).start()
            return True, str(proc.pid)
        except Exception as e:
            return False, str(e)

    # ── Windows native .exe ─────────────────────────────────────────────────
    if sys_name == 'Windows' and exe_path:
        exe = Path(exe_path)
        if not exe.exists():
            return False, f'Executable not found: {exe_path}'
        try:
            proc = subprocess.Popen([str(exe)], cwd=str(exe.parent))
            with _PROC_LOCK:
                active_proc = proc
            def _ww(): proc.wait(); _refocus_browser()
            threading.Thread(target=_ww, daemon=True).start()
            return True, str(proc.pid)
        except Exception as e:
            return False, str(e)

    # ── Windows + Linux exe = launch via WSL ───────────────────────────────
    if sys_name == 'Windows' and linux_exe:
        return _launch_via_wsl(linux_exe)

    return False, f'No valid executable for platform: {sys_name}'


def _launch_via_wsl(linux_exe):
    """Launch a Linux shell script via WSL on Windows.
    Requires WSL2 + WSLg (Windows 11) for GUI output.
    The run.sh is started from its grandparent directory (~/ssf2/) so that
    relative paths inside the script resolve correctly.

    Security: linux_exe is passed as a positional argument ($1) to the bash
    script, never interpolated into the command string.  This eliminates the
    shell-injection vector that existed when the value was eval-expanded
    directly inside the one-liner string.
    """
    global active_proc
    # The helper script receives the raw path as $1, expands ~ itself with
    # the shell's own tilde expansion (no eval), then derives the working dir.
    bash_helper = (
        'set -e; '
        'SCRIPT="${1/#\\~/$HOME}"; '          # expand leading ~ without eval
        'WD=$(dirname "$(dirname "$SCRIPT")"); '
        'cd "$WD" && exec "$SCRIPT"'
    )
    try:
        # Pass linux_exe as a positional argument — bash never re-parses it.
        proc = subprocess.Popen(['wsl', 'bash', '-c', bash_helper, '--', linux_exe])
        with _PROC_LOCK:
            active_proc = proc
        def _ww(): proc.wait(); _refocus_browser()
        threading.Thread(target=_ww, daemon=True).start()
        return True, str(proc.pid)
    except FileNotFoundError:
        return False, 'WSL not found — install Windows Subsystem for Linux to run the Linux version'
    except Exception as e:
        return False, str(e)

def find_and_launch_rom(system_id, rom_path):
    """Open rom_path with a known emulator for system_id.

    Attempts in order:
      1. Known emulator paths / commands for this system
      2. OS file-type association  (os.startfile / xdg-open)
      3. Open the containing folder in the file manager

    Returns (success: bool, method: str, error: str | None)
      method is one of  'emulator:<name>' | 'os' | 'folder'
    """
    rom    = Path(rom_path)
    is_win = platform.system() == 'Windows'

    if not rom.exists():
        # Last-ditch: open the roms folder even if the specific file is gone
        folder = rom.parent
        folder.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.Popen(['explorer', str(folder)] if is_win else ['xdg-open', str(folder)])
            return True, 'folder', None
        except Exception as e:
            return False, '', f'ROM not found and could not open folder: {e}'

    # Per-emulator fullscreen + ROM argument builders.
    # Each lambda receives the rom Path and returns the arg list AFTER the exe.
    _EMU_ARGS = {
        'dolphin':   lambda r: ['--config', 'Display.Fullscreen=True', '-e', str(r)],
        # PCSX2 v1.7+ (pcsx2-qt): use --fullscreen before the ISO path
        # Old PCSX2 v1.6: uses --fullscreen after the ISO
        'pcsx2-qt':  lambda r: ['--fullscreen', '--', str(r)],
        'pcsx2':     lambda r: [str(r), '--fullscreen', '--nogui'],
        'rpcs3':     lambda r: ['--no-gui', str(r)],
        'flycast':   lambda r: [str(r)],
        'redream':   lambda r: [str(r)],
        'cemu':      lambda r: ['-f', '-g', str(r)],
        'xenia':     lambda r: ['--fullscreen', str(r)],
        'xemu':      lambda r: [str(r)],
        'ryujinx':   lambda r: [str(r)],
    }

    def _build_cmd(exe_str, r):
        stem = Path(exe_str).stem.lower()
        args = _EMU_ARGS.get(stem, lambda x: [str(x)])(r)
        return [exe_str] + args

    def _track_proc(proc):
        """Set active_proc, wait for exit, then clear it."""
        global active_proc
        with _PROC_LOCK:
            active_proc = proc
        proc.wait()
        with _PROC_LOCK:
            if active_proc is proc:
                active_proc = None

    # 1. Try known emulators for this system
    candidates = (NATIVE_EMU_WIN if is_win else NATIVE_EMU_LIN).get(system_id, [])
    for emu in candidates:
        if is_win:
            emu_path = Path(os.path.expandvars(emu))
            if not emu_path.exists():
                continue
            exe_str  = str(emu_path)
            emu_name = emu_path.stem
        else:
            found = shutil.which(emu)
            if not found:
                continue
            exe_str  = found
            emu_name = emu
        try:
            cmd  = _build_cmd(exe_str, rom)
            proc = subprocess.Popen(cmd, close_fds=True)
            threading.Thread(target=_track_proc, args=(proc,), daemon=True).start()
            return True, f'emulator:{emu_name}', None
        except Exception:
            continue   # try next candidate

    # 1b. WinGet portable package glob + PATH fallback
    if is_win:
        # For emulators installed as WinGet portables, scan the packages directory
        _WINGET_IDS = {
            'wiiu':   ('Cemu.Cemu',   'Cemu.exe'),
            'ps3':    ('RPCS3.RPCS3', 'rpcs3.exe'),
        }
        wg_pair = _WINGET_IDS.get(system_id)
        if wg_pair:
            wg_path = _winget_portable_glob(*wg_pair)
            if wg_path:
                try:
                    cmd  = _build_cmd(wg_path, rom)
                    proc = subprocess.Popen(cmd, close_fds=True)
                    threading.Thread(target=_track_proc, args=(proc,), daemon=True).start()
                    return True, f'emulator:{Path(wg_path).stem}', None
                except Exception:
                    pass

        _WIN_CMD_FALLBACK = {
            'ps2':       ['pcsx2-qt', 'PCSX2'],
            'dreamcast': ['flycast', 'redream'],
            'gamecube':  ['Dolphin'],
            'wii':       ['Dolphin'],
            'wiiu':      ['Cemu'],
            'switch':    ['Ryujinx'],
            'xbox':      ['xemu'],
            'xbox360':   ['xenia'],
            'ps3':       ['rpcs3'],
        }
        for cmd_name in _WIN_CMD_FALLBACK.get(system_id, []):
            found = shutil.which(cmd_name)
            if not found:
                continue
            try:
                cmd  = _build_cmd(found, rom)
                proc = subprocess.Popen(cmd, close_fds=True)
                threading.Thread(target=_track_proc, args=(proc,), daemon=True).start()
                return True, f'emulator:{cmd_name}', None
            except Exception:
                continue

    # 2. Open the containing folder in the file manager as last resort.
    # Note: os.startfile() is intentionally omitted — on Windows it shows a
    # blocking "How do you want to open this file?" dialog for unknown extensions
    # which freezes the server thread.
    try:
        if is_win:
            subprocess.Popen(['explorer', str(rom.parent)])
        else:
            subprocess.Popen(['xdg-open', str(rom.parent)], close_fds=True)
        return True, 'folder', None
    except Exception as e:
        return False, '', str(e)

# ── Mod System ────────────────────────────────────────────────────────────────
# Mods are folders inside workspace/mods/<gameId>/<modName>/
# containing replacement DAT*.ssf files.
# Originals are backed up to mods/<gameId>/_backup/ before the first apply.

def _ssf2_data_dir():
    """Return the SSF2 data directory for the current platform."""
    if platform.system() == 'Windows':
        return SSF2_WIN_DATA
    return SSF2_LIN_DATA.expanduser()

def _ssf2_wsl_data_dir():
    """Return the SSF2 WSL data dir path as a Windows UNC path (\\wsl$\\Ubuntu\\...)."""
    try:
        # Ask WSL for the absolute path of the data dir
        result = subprocess.run(
            ['wsl', 'wslpath', '-w', str(SSF2_LIN_DATA)],
            capture_output=True, text=True, timeout=4
        )
        p = result.stdout.strip()
        return Path(p) if p else None
    except Exception:
        return None

def list_mods(game_id):
    game_mods = MODS_DIR / game_id
    if not game_mods.exists():
        return []
    mods = []
    for mod_dir in sorted(game_mods.iterdir()):
        if not mod_dir.is_dir() or mod_dir.name.startswith('_'):
            continue
        ssf_files = list(mod_dir.glob('*.ssf'))
        info_path = mod_dir / 'mod.json'
        info = {}
        if info_path.exists():
            try:
                info = json.loads(info_path.read_text(encoding='utf-8'))
            except Exception:
                pass
        mods.append({
            'id':          mod_dir.name,
            'name':        info.get('name', mod_dir.name),
            'author':      info.get('author', 'Unknown'),
            'description': info.get('description', ''),
            'characters':  info.get('characters', []),
            'files':       [f.name for f in ssf_files],
            'fileCount':   len(ssf_files),
        })
    return mods

def _resolve_target(game_id):
    """Return (target_dir, error_str).  target_dir is None on failure."""
    if game_id == 'ssf2':
        if platform.system() == 'Windows':
            # Try native Windows dir first; fall back to WSL path
            d = SSF2_WIN_DATA
            if d.exists():
                return d, None
            wsl = _ssf2_wsl_data_dir()
            if wsl and wsl.exists():
                return wsl, None
            return None, 'SSF2 data directory not found on Windows or WSL'
        else:
            d = SSF2_LIN_DATA.expanduser()
            if d.exists():
                return d, None
            return None, f'SSF2 Linux data dir not found: {d}'
    return None, f'Unknown game: {game_id}'

def apply_mod(game_id, mod_id):
    game_mods  = MODS_DIR / game_id
    mod_dir    = game_mods / mod_id
    if not mod_dir.exists():
        return False, f'Mod not found: {mod_id}'

    target, err = _resolve_target(game_id)
    if not target:
        return False, err

    backup_dir = game_mods / '_backup'
    backup_dir.mkdir(parents=True, exist_ok=True)

    mod_files = list(mod_dir.glob('*.ssf'))
    if not mod_files:
        return False, 'No .ssf files found in this mod folder'

    applied = []
    for mf in mod_files:
        target_file = target / mf.name
        backup_file = backup_dir / mf.name
        # Back up original only if a backup doesn't already exist (preserve first original).
        if target_file.exists() and not backup_file.exists():
            shutil.copy2(str(target_file), str(backup_file))
        elif not target_file.exists():
            # Mod file will be placed fresh — this is valid for add-only mods.
            print(f'[apply_mod] {game_id}/{mod_id}: {mf.name} is a new file (no original to back up)')
        try:
            shutil.copy2(str(mf), str(target_file))
            applied.append(mf.name)
        except PermissionError:
            # Roll back every file we already wrote so the game isn't left half-modded.
            for name in applied:
                rolled_target = target / name
                rolled_backup = backup_dir / name
                try:
                    if rolled_backup.exists():
                        shutil.copy2(str(rolled_backup), str(rolled_target))
                    else:
                        # No backup existed → original didn't exist; remove the file we added.
                        rolled_target.unlink(missing_ok=True)
                except Exception:
                    pass  # best-effort rollback; log nothing to avoid masking the real error
            return False, (
                f'Permission denied writing to {target_file}. '
                'On Windows, run kente-server.py as Administrator to mod the SSF2 install, '
                'or the Linux (WSL) version will be modded instead. '
                f'All {len(applied)} previously written file(s) have been rolled back.'
            )
    return True, applied

def restore_mod(game_id):
    game_mods  = MODS_DIR / game_id
    backup_dir = game_mods / '_backup'
    if not backup_dir.exists() or not any(backup_dir.glob('*.ssf')):
        return True, []  # nothing to restore

    target, err = _resolve_target(game_id)
    if not target:
        return False, err

    restored = []
    errors   = []
    for bf in backup_dir.glob('*.ssf'):
        target_file = target / bf.name
        try:
            shutil.copy2(str(bf), str(target_file))
            bf.unlink()
            restored.append(bf.name)
        except (PermissionError, FileNotFoundError, OSError) as exc:
            # Continue restoring remaining files rather than aborting.
            # FileNotFoundError: backup was deleted between glob() and copy2().
            # OSError: covers cross-device moves, read-only filesystems, etc.
            # Collecting all errors lets the caller report a complete picture.
            errors.append(f'{bf.name}: {exc}')
    if errors:
        return False, (
            f'Permission denied restoring {len(errors)} file(s) — run as Administrator. '
            f'Errors: {"; ".join(errors)}'
        )
    return True, restored

def mod_status(game_id):
    backup_dir = MODS_DIR / game_id / '_backup'
    backed_up  = list(backup_dir.glob('*.ssf')) if backup_dir.exists() else []
    return {
        'modActive':   len(backed_up) > 0,
        'backupCount': len(backed_up),
    }

# ── Network Management ─────────────────────────────────────────────────────────
_IS_WINDOWS = platform.system() == 'Windows'

def _net_run(args, timeout=10):
    """Run a command and return (stdout, stderr, returncode). Never raises."""
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return r.stdout, r.stderr, r.returncode
    except Exception as ex:
        return '', str(ex), -1

# ── Boxart on-demand fetcher ─────────────────────────────────────────────────
_BOXART_DIR  = os.path.abspath('boxart')      # <project-root>/boxart/
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

# ── Network helpers ───────────────────────────────────────────────────────────
def _net_status():
    """Return current WiFi/network connection status."""
    result = {'connected': False, 'ssid': None, 'ip': None, 'signal': None, 'interface': None}
    if _IS_WINDOWS:
        out, _, _ = _net_run(['netsh', 'wlan', 'show', 'interfaces'])
        for line in out.splitlines():
            l = line.strip()
            if l.startswith('SSID') and not l.startswith('BSSID'):
                result['ssid'] = l.split(':', 1)[-1].strip() or None
            elif l.startswith('Signal'):
                try: result['signal'] = int(l.split(':', 1)[-1].strip().rstrip('%'))
                except: pass
            elif l.startswith('Name'):
                result['interface'] = l.split(':', 1)[-1].strip()
        result['connected'] = bool(result['ssid'])
        if result['connected'] and result['interface']:
            out2, _, _ = _net_run(['ipconfig'])
            in_iface = False
            for line in out2.splitlines():
                if result['interface'] in line:
                    in_iface = True
                if in_iface and 'IPv4 Address' in line:
                    # Remove trailing annotations like "(Preferred)" using regex
                    raw_ip = line.split(':', 1)[-1].strip()
                    result['ip'] = re.sub(r'\s*\(.*?\)\s*$', '', raw_ip).strip()
                    break
    else:
        out, _, _ = _net_run(['nmcli', '-t', '-f', 'ACTIVE,SSID,SIGNAL', 'dev', 'wifi'])
        for line in out.splitlines():
            parts = line.split(':')
            if len(parts) >= 3 and parts[0] == 'yes':
                result['connected'] = True
                result['ssid'] = parts[1]
                try: result['signal'] = int(parts[2])
                except: pass
                break
        out2, _, _ = _net_run(['hostname', '-I'])
        ips = out2.strip().split()
        if ips: result['ip'] = ips[0]
        out3, _, _ = _net_run(['nmcli', '-t', '-f', 'DEVICE,TYPE,STATE', 'dev'])
        for line in out3.splitlines():
            p = line.split(':')
            if len(p) >= 3 and p[1] == 'wifi' and 'connected' in p[2]:
                result['interface'] = p[0]; break
    return result

def _net_scan():
    """Scan for visible WiFi networks. Returns {'networks': [...]}."""
    networks = []
    if _IS_WINDOWS:
        out, _, _ = _net_run(['netsh', 'wlan', 'show', 'networks', 'mode=Bssid'])
        cur = {}
        for line in out.splitlines():
            l = line.strip()
            if l.startswith('SSID') and not l.startswith('BSSID'):
                if cur.get('ssid'): networks.append(cur)
                cur = {'ssid': l.split(':', 1)[-1].strip(), 'signal': 0, 'secured': True}
            elif l.startswith('Authentication') and cur:
                cur['secured'] = l.split(':', 1)[-1].strip().lower() not in ('open', '')
            elif l.startswith('Signal') and cur:
                try: cur['signal'] = int(l.split(':', 1)[-1].strip().rstrip('%'))
                except: pass
        if cur.get('ssid'): networks.append(cur)
    else:
        out, _, _ = _net_run(
            ['nmcli', '-t', '-f', 'SSID,SIGNAL,SECURITY,ACTIVE', 'dev', 'wifi', 'list', '--rescan', 'yes'],
            timeout=20)
        seen = set()
        for line in out.splitlines():
            p = line.split(':')
            if len(p) < 4 or not p[0] or p[0] in seen: continue
            seen.add(p[0])
            try: sig = int(p[1])
            except: sig = 0
            networks.append({'ssid': p[0], 'signal': sig,
                             'secured': p[2].strip() not in ('', '--'), 'active': p[3] == 'yes'})
    networks.sort(key=lambda n: n.get('signal', 0), reverse=True)
    return {'networks': networks}

def _net_connect(ssid, password=''):
    """Connect to a WiFi network (creates a profile on Windows via netsh XML)."""
    if not ssid:
        return False, 'No SSID provided'
    if _IS_WINDOWS:
        import xml.sax.saxutils as _sax
        safe_ssid = _sax.escape(ssid)
        if password:
            safe_pw = _sax.escape(password)
            xml_body = (f'<authEncryption><authentication>WPA2PSK</authentication>'
                        f'<encryption>AES</encryption><useOneX>false</useOneX></authEncryption>'
                        f'<sharedKey><keyType>passPhrase</keyType><protected>false</protected>'
                        f'<keyMaterial>{safe_pw}</keyMaterial></sharedKey>')
        else:
            xml_body = ('<authEncryption><authentication>open</authentication>'
                        '<encryption>none</encryption><useOneX>false</useOneX></authEncryption>')
        xml_content = (
            f'<?xml version="1.0"?>'
            f'<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">'
            f'<name>{safe_ssid}</name>'
            f'<SSIDConfig><SSID><name>{safe_ssid}</name></SSID></SSIDConfig>'
            f'<connectionType>ESS</connectionType><connectionMode>auto</connectionMode>'
            f'<MSM><security>{xml_body}</security></MSM></WLANProfile>'
        )
        fd, tmp_xml = tempfile.mkstemp(suffix='.xml')
        try:
            os.write(fd, xml_content.encode()); os.close(fd)
            _, err, rc = _net_run(['netsh', 'wlan', 'add', 'profile', f'filename={tmp_xml}'])
            if rc != 0: return False, f'Profile error: {err.strip()}'
            out2, err2, rc2 = _net_run(['netsh', 'wlan', 'connect', f'name={ssid}'], timeout=15)
            return rc2 == 0, out2.strip() or err2.strip() or f'Connecting to {ssid}'
        finally:
            try: os.unlink(tmp_xml)
            except: pass
    else:
        args = ['nmcli', 'dev', 'wifi', 'connect', ssid]
        if password: args += ['password', password]
        out, err, rc = _net_run(args, timeout=30)
        return rc == 0, out.strip() or err.strip() or f'Connected to {ssid}'

def _net_disconnect():
    """Disconnect the active WiFi interface."""
    if _IS_WINDOWS:
        out, err, rc = _net_run(['netsh', 'wlan', 'disconnect'])
        return rc == 0, out.strip() or err.strip()
    else:
        out, _, _ = _net_run(['nmcli', '-t', '-f', 'DEVICE,TYPE,STATE', 'dev'])
        iface = next((l.split(':')[0] for l in out.splitlines()
                      if ':wifi:' in l and 'connected' in l), None)
        if not iface: return False, 'No active WiFi interface'
        out2, err2, rc = _net_run(['nmcli', 'dev', 'disconnect', iface])
        return rc == 0, out2.strip() or err2.strip()

def _net_forget(ssid):
    """Delete a saved network profile."""
    if not ssid: return False, 'No SSID provided'
    if _IS_WINDOWS:
        out, err, rc = _net_run(['netsh', 'wlan', 'delete', 'profile', f'name={ssid}'])
        return rc == 0, out.strip() or err.strip()
    else:
        out, err, rc = _net_run(['nmcli', 'connection', 'delete', ssid])
        return rc == 0, out.strip() or err.strip()

# ── Request Handler ───────────────────────────────────────────────────────────

class KenteHandler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass  # silence access log

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, url_path):
        if url_path in ('', '/'):
            url_path = '/index.html'
        # safe_resolve URL-decodes, resolves, and rejects path traversal in
        # one step.  Returns None if the request escapes WEB_DIR.
        fpath = _safe_resolve_helper(WEB_DIR, url_path)
        if fpath is None:
            self.send_response(403); self.end_headers(); return
        if not fpath.exists() or not fpath.is_file():
            self.send_response(404); self.end_headers(); return
        data = fpath.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', MIME.get(fpath.suffix.lower(), 'application/octet-stream'))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)

    def _serve_ejs(self, subpath):
        """Serve EmulatorJS assets:
        - Community cores (flycast) → served from local EJS_CORES_DIR cache,
          downloading from GitHub releases on first request.
        - Everything else → transparent proxy to cdn.emulatorjs.org/stable/data/
        CORS header is always added so the browser page can load the JS/WASM.
        """
        # Community core? (e.g. cores/flycast-wasm.data or flycast-legacy-wasm.data)
        fname = subpath[len('cores/'):] if subpath.startswith('cores/') else None
        if fname and fname in COMMUNITY_CORES:
            cached = EJS_CORES_DIR / fname
            if not cached.exists():
                dl_url = COMMUNITY_CORES[fname]
                try:
                    print(f'[ejs-core] Downloading {fname} from GitHub…')
                    EJS_CORES_DIR.mkdir(parents=True, exist_ok=True)
                    req = urllib.request.Request(
                        dl_url, headers={'User-Agent': 'KenteKorner/1.0'})
                    with urllib.request.urlopen(req, timeout=120) as resp:
                        data = resp.read()
                    tmp = cached.with_suffix('.tmp')
                    tmp.write_bytes(data)
                    tmp.rename(cached)
                    print(f'[ejs-core] Cached {fname} ({len(data)//1024} KB)')
                except Exception as e:
                    print(f'[ejs-core] Download failed: {e}')
                    self.send_response(502); self.end_headers(); return
            data = cached.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        # Proxy everything else to the stable CDN
        cdn_url = EJS_CDN_BASE + subpath
        try:
            req = urllib.request.Request(
                cdn_url, headers={'User-Agent': 'KenteKorner/1.0'})
            with urllib.request.urlopen(req, timeout=60) as resp:
                ct   = resp.headers.get('Content-Type', 'application/octet-stream')
                data = resp.read()
            self.send_response(200)
            self.send_header('Content-Type', ct)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            print(f'[ejs-proxy] {subpath}: {e}')
            self.send_response(502); self.end_headers()

    # ── Theater HLS / asset proxy ───────────────────────────────────────────
    # The lookmovie CDN does not send CORS headers, so the browser cannot
    # fetch the m3u8 manifest or its .ts segments directly.  This proxy:
    #   1. forwards Range / User-Agent / Referer to the upstream
    #   2. mirrors Content-Type, Content-Length, Accept-Ranges
    #   3. when the body is an HLS playlist, rewrites every nested URI to
    #      come back through this same endpoint
    # Image responses are also served through here so posters display under
    # any browser referrer policy.
    _HLS_LINE_RE = re.compile(r'^(URI=")([^"]+)(")', re.M)

    def _serve_theater_proxy(self, target_url):
        if not target_url:
            self.send_json({'error': 'Missing url'}, 400); return
        try:
            target_url = urllib.parse.unquote(target_url)
            req_headers = {
                'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                               'AppleWebKit/537.36 (KHTML, like Gecko) '
                               'Chrome/120.0.0.0 Safari/537.36'),
                'Accept': '*/*',
                # Ask the upstream NOT to gzip — keeps proxy simple and lets us
                # rewrite manifest text without an extra decompress step.
                'Accept-Encoding': 'identity',
            }
            # Pass a Referer matching the upstream origin so CDNs that hot-link-
            # protect against random referers will still serve the asset.
            parsed = urllib.parse.urlparse(target_url)
            req_headers['Referer'] = f'{parsed.scheme}://{parsed.netloc}/'
            rng = self.headers.get('Range')
            if rng: req_headers['Range'] = rng
            req = urllib.request.Request(target_url, headers=req_headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                ct   = resp.headers.get('Content-Type', 'application/octet-stream')
                ce   = (resp.headers.get('Content-Encoding') or '').lower()
                data = resp.read()
                status = resp.status
                ar = resp.headers.get('Accept-Ranges')
                cr = resp.headers.get('Content-Range')

            # Some CDNs ignore Accept-Encoding: identity and still send gzip.
            if ce == 'gzip':
                import gzip as _gz
                try: data = _gz.decompress(data)
                except Exception: pass
            elif ce in ('deflate', 'br'):
                try:
                    if ce == 'deflate':
                        import zlib as _zl
                        data = _zl.decompress(data)
                except Exception: pass

            # Rewrite HLS playlists so segment / key / media URIs route back
            # through this proxy.
            is_m3u8 = (
                ('mpegurl' in ct.lower())
                or target_url.lower().split('?', 1)[0].endswith('.m3u8')
                or data[:7] == b'#EXTM3U'
            )
            if is_m3u8 and data[:7] == b'#EXTM3U':
                try:
                    text = data.decode('utf-8', 'ignore')
                    text = self._rewrite_hls(text, target_url)
                    data = text.encode('utf-8')
                    ct = 'application/vnd.apple.mpegurl'
                except Exception as _e:
                    print(f'[theater-proxy] m3u8 rewrite failed: {_e}')

            self.send_response(status)
            self.send_header('Content-Type', ct)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
            if ar: self.send_header('Accept-Ranges', ar)
            if cr: self.send_header('Content-Range', cr)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except urllib.error.HTTPError as e:
            print(f'[theater-proxy] HTTP {e.code} for {target_url[:120]}')
            self.send_response(e.code); self.end_headers()
        except Exception as e:
            print(f'[theater-proxy] {target_url[:120]} -> {e}')
            self.send_response(502); self.end_headers()

    def _rewrite_hls(self, text, base_url):
        """Rewrite every segment / key / media URI in an HLS playlist to be
        fetched via /api/theater/proxy?url=<absolute>."""
        def proxify(uri):
            absolute = urllib.parse.urljoin(base_url, uri)
            return '/api/theater/proxy?url=' + urllib.parse.quote(absolute, safe='')
        out = []
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                out.append(line); continue
            if stripped.startswith('#'):
                # Rewrite inline URI="..." attributes (EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP)
                out.append(self._HLS_LINE_RE.sub(
                    lambda m: m.group(1) + proxify(m.group(2)) + m.group(3),
                    line))
                continue
            out.append(proxify(stripped))
        return '\n'.join(out) + '\n'

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
        self.end_headers()

    def do_GET(self):
        global active_proc
        path = self.path.split('?')[0]
        # Parse query string once so all branches can use qs.get(...)
        qs = urllib.parse.parse_qs(self.path.split('?', 1)[1] if '?' in self.path else '')
        if path == '/api/ping':
            self.send_json({
                'status':  'ok',
                # The server is always the native layer — report 'native' so the
                # frontend enables native launching regardless of which OS is hosting.
                # IS_BATOCERA controls filesystem paths; the mode field controls
                # whether the frontend treats this machine as the emulation backend.
                'mode':    'native',
                'version': __version__,
                'platform': platform.system(),
                'batocera': IS_BATOCERA,   # true only on real Batocera/Linux
                'electron': IS_APP,        # true when running inside Electron desktop app
            })
        elif path == '/api/local-library':
            # Returns installed emulators + local ROMs so the Kente's Repo panel
            # is always populated, even when the GitHub repo is empty.
            is_win = platform.system() == 'Windows'

            # ── Installed emulators ──────────────────────────────────────────
            EMU_META = {
                'gamecube': {'name': 'Dolphin',  'icon': '🐬', 'systems': 'GameCube · Wii'},
                'wii':      {'name': 'Dolphin',  'icon': '🐬', 'systems': 'GameCube · Wii'},
                'ps2':      {'name': 'PCSX2',    'icon': '🎮', 'systems': 'PlayStation 2'},
                'ps3':      {'name': 'RPCS3',    'icon': '🎮', 'systems': 'PlayStation 3'},
                'wiiu':     {'name': 'Cemu',     'icon': '🎮', 'systems': 'Wii U'},
                'dreamcast':{'name': 'Flycast',  'icon': '🎮', 'systems': 'Dreamcast'},
                'switch':   {'name': 'Ryujinx',  'icon': '🎮', 'systems': 'Nintendo Switch'},
                'xbox360':  {'name': 'Xenia',    'icon': '🎮', 'systems': 'Xbox 360'},
            }
            seen_emus = set()
            installed_emus = []
            candidates_map = NATIVE_EMU_WIN if is_win else {}
            for sid, meta in EMU_META.items():
                if meta['name'] in seen_emus:
                    continue
                paths = candidates_map.get(sid, [])
                found_path = None
                for p in paths:
                    ep = Path(os.path.expandvars(p))
                    if ep.exists():
                        found_path = str(ep)
                        break
                if not found_path and is_win:
                    import shutil as _sh
                    cmd = _sh.which(meta['name'])
                    if cmd:
                        found_path = cmd
                if found_path:
                    seen_emus.add(meta['name'])
                    installed_emus.append({
                        'name':    meta['name'],
                        'icon':    meta['icon'],
                        'systems': meta['systems'],
                        'path':    found_path,
                    })

            # ── Local ROMs ───────────────────────────────────────────────────
            local_roms = []
            sid_label = {v: k for k, v in SYSTEM_FOLDER.items()}
            if ROMS_DIR.exists():
                for sys_dir in sorted(ROMS_DIR.iterdir()):
                    if not sys_dir.is_dir():
                        continue
                    sid = sid_label.get(sys_dir.name, sys_dir.name)
                    for f in sorted(sys_dir.iterdir()):
                        if not f.is_file() or f.suffix.lower() in ('.tmp', '.part'):
                            continue
                        local_roms.append({
                            'title':    f.stem,
                            'filename': f.name,
                            'systemId': sid,
                            'sizeBytes': f.stat().st_size,
                        })

            self.send_json({'emulators': installed_emus, 'roms': local_roms})

        elif path == '/api/bios/status':
            self.send_json(bios_status())
        elif path == '/api/bios/download/status':
            self.send_json(dict(_bios_dl_state))
        elif path == '/api/emulators/status':
            # Report installed / missing state for every OS-level emulator dep
            out = {}
            for key in EMULATOR_DEPS:
                installed, path_ = _check_emu_installed(key)
                out[key] = {'installed': installed, 'path': path_,
                             'name': EMULATOR_DEPS[key]['name']}
            self.send_json(out)
        elif path == '/api/emulators/install/status':
            self.send_json(dict(_emu_install_state))
        elif path == '/api/system/info':
            self.send_json(system_info())
        elif path == '/api/saves':
            self.send_json(list_saves())
        elif path == '/api/sources':
            sources = [{'name': 'Internal Storage', 'path': str(ROMS_DIR), 'type': 'local', 'icon': '💾'}]
            media = Path('/media')
            if media.exists():
                try:
                    entries = sorted(media.iterdir())
                except OSError:
                    entries = []   # stale mount or permission error — skip external drives
                for m in entries:
                    if m.is_dir():
                        try:
                            u = shutil.disk_usage(str(m))
                            free = f'{u.free/1e9:.1f} GB free'
                        except Exception:
                            free = ''
                        sources.append({'name': m.name.upper(), 'path': str(m),
                                        'type': 'external', 'icon': '🔌', 'free': free})
            self.send_json(sources)

        # ── Flash / SSF2 asset proxy ─────────────────────────────────────────
        elif path == '/api/flash/proxy':
            url = qs.get('url', [None])[0]
            if not url:
                self.send_json({'error': 'Missing url parameter'}, 400); return
            try:
                data, ct = proxy_asset(url)
                self.send_response(200)
                self.send_header('Content-Type', ct)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Length', len(data))
                self.end_headers()
                self.wfile.write(data)
            except PermissionError:
                self.send_json({'error': 'Permission denied accessing asset'}, 403)
            except Exception as e:
                print(f'[flash/proxy] {e}')
                self.send_json({'error': 'Asset fetch failed'}, 502)

        # ── Archive.org ROM download proxy ──────────────────────────────────
        # Streams ROM files server-side (no CORS restrictions) with ACAO: *.
        # Optional save-while-streaming: pass save=1&systemId=ps1&filename=X
        # to also write the ROM to /userdata/roms/<system>/ in parallel.
        # The response header X-Kente-Saved-Path tells the client where it landed.
        # Security: only archive.org and its CDN subdomains are allowed.
        elif path == '/api/rom-proxy':
            url    = qs.get('url',      [None])[0]
            save   = qs.get('save',     ['0'])[0] == '1'
            sid    = qs.get('systemId', [None])[0]
            fname  = qs.get('filename', [None])[0]
            if not url:
                self.send_json({'error': 'Missing url parameter'}, 400); return
            parsed  = urllib.parse.urlparse(url)
            allowed = parsed.hostname and (
                parsed.hostname == 'archive.org' or
                parsed.hostname.endswith('.archive.org')
            )
            if not allowed:
                self.send_json({'error': 'URL host not allowed'}, 403); return

            # Resolve disk save destination — Batocera and Electron app mode.
            # Both modes have a writable ROMS_DIR; dev/browser mode does not.
            dest_file = None
            if save and sid and fname:
                folder = SYSTEM_FOLDER.get(sid)
                if not folder:
                    # Unknown system ID — reject to prevent arbitrary path writes.
                    self.send_json({'error': f'Unknown systemId: {sid}'}, 400)
                    return
                # Restrict filename to its base component (strip any directory parts)
                # so values like "../../etc/passwd" can never escape the ROM folder.
                safe_fname = Path(fname).name
                if not safe_fname:
                    self.send_json({'error': 'Invalid filename'}, 400)
                    return
                dest_dir = ROMS_DIR / folder
                dest_dir.mkdir(parents=True, exist_ok=True)
                candidate = dest_dir / safe_fname
                # Serialise concurrent saves of the same file — prevents two requests
                # from both opening the file in 'wb' mode and truncating each other.
                with _DOWNLOAD_LOCK:
                    if str(candidate) in _active_downloads:
                        # Already in progress — stream-only, don't save again.
                        pass
                    elif not candidate.exists():
                        _active_downloads.add(str(candidate))
                        dest_file = candidate

            try:
                req = urllib.request.Request(url, headers={
                    'User-Agent': 'Mozilla/5.0 (compatible; KenteKorner/1.0)',
                })
                with urllib.request.urlopen(req, timeout=300) as resp:
                    ct = resp.headers.get('Content-Type', 'application/octet-stream')
                    cl = resp.headers.get('Content-Length', '')
                    self.send_response(200)
                    self.send_header('Content-Type', ct)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.send_header('Access-Control-Expose-Headers', 'X-Kente-Saved-Path')
                    if cl:
                        self.send_header('Content-Length', cl)
                    if dest_file:
                        self.send_header('X-Kente-Saved-Path', str(dest_file))
                    self.end_headers()

                    f_out = open(dest_file, 'wb') if dest_file else None
                    try:
                        while True:
                            chunk = resp.read(65536)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            if f_out:
                                f_out.write(chunk)
                    except Exception:
                        # Partial transfer — remove incomplete file so polling
                        # never mistakes a fragment for a complete ROM.
                        if f_out:
                            f_out.close()
                            f_out = None
                        if dest_file and dest_file.exists():
                            dest_file.unlink()
                        raise
                    finally:
                        if f_out:
                            f_out.close()
                        # Release the concurrency lock regardless of success/failure.
                        if dest_file:
                            with _DOWNLOAD_LOCK:
                                _active_downloads.discard(str(dest_file))

            except Exception as e:
                print(f'[ROM Proxy] {e}')
                try:
                    self.send_json({'error': 'ROM proxy failed'}, 502)
                except Exception:
                    pass  # headers may already be sent; nothing more we can do

        # ── ROM existence / progress check ───────────────────────────────────
        # Returns whether a ROM is fully on disk and its current byte count.
        # ── Archive.org pack collection search ────────────────────────────────
        # Queries the Archive.org metadata API for a known per-system pack
        # identifier, lists individual ROM files, fuzzy-matches by title, and
        # returns up to 20 results with direct archive.org download URLs.
        # Used as a fallback when the general subject search finds nothing.
        elif path == '/api/pack/search':
            sid   = qs.get('systemId', [None])[0] or ''
            title = qs.get('title',    [None])[0] or ''
            if not sid or not title:
                self.send_json({'error': 'Missing systemId or title'}, 400); return
            identifier = ARCHIVE_PACKS.get(sid)
            if not identifier:
                self.send_json([], 200); return  # no pack for this system
            meta_url = f'https://archive.org/metadata/{identifier}/files'
            try:
                req = urllib.request.Request(
                    meta_url,
                    headers={'User-Agent': 'KenteKorner/1.0', 'Accept': 'application/json'},
                )
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = json.loads(resp.read())
            except Exception as e:
                print(f'[pack/search] {e}')
                self.send_json({'error': 'Pack search failed'}, 502); return

            def _norm(s):
                s = re.sub(r'\([^)]*\)', ' ', s)   # strip (USA), (Europe) etc.
                s = re.sub(r'\.[^.]+$', ' ', s)     # strip extension
                return re.sub(r'[^a-z0-9 ]', ' ', s.lower()).split()

            title_words = set(_norm(title))
            results = []
            for f in data.get('result', []):
                fname = f.get('name', '')
                if fname.startswith('_') or '/' in fname:
                    continue
                score = len(title_words & set(_norm(fname)))
                if score > 0:
                    dl_url = (f'https://archive.org/download/{identifier}/'
                              + urllib.parse.quote(fname, safe=''))
                    results.append({'name': fname, 'url': dl_url, 'score': score})
            results.sort(key=lambda r: -r['score'])
            self.send_json(results[:20]); return

        # ── Multi-provider ROM source fan-out ──────────────────────────────
        # Fans out across every registered rom_providers.PROVIDERS entry in
        # parallel, ranks by score, returns up to `limit` candidates.
        # Optional `providers=archive,archive_packs` narrows the fan-out to
        # a subset (used by the SOURCE dropdown when the user pins a host).
        elif path == '/api/roms/sources':
            if roms is None:
                self.send_json({'error': 'rom_providers unavailable'}, 503); return
            sid   = qs.get('systemId', [None])[0] or ''
            title = qs.get('title',    [None])[0] or ''
            limit = int(qs.get('limit', ['20'])[0] or '20')
            prov  = qs.get('providers', [None])[0]
            providers = [p.strip() for p in prov.split(',') if p.strip()] if prov else None
            if not sid or not title:
                self.send_json({'error': 'Missing systemId or title'}, 400); return
            try:
                cands = roms.fan_out_search(sid, title, providers=providers, timeout=18)
            except Exception as e:
                print(f'[roms/sources] fan-out failed: {e}')
                self.send_json({'error': 'Source search failed'}, 502); return
            # Provider catalog so the frontend can render labels for empty sets.
            catalog = [{'id': pid, 'label': p.get('label', pid.upper())}
                       for pid, p in roms.PROVIDERS.items()]
            self.send_json({
                'systemId':  sid,
                'title':     title,
                'providers': catalog,
                'sources':   cands[:limit],
            }); return

        # sizeBytes grows while a background download is in progress, letting
        # the client show live MB progress without a streaming connection.
        elif path == '/api/rom/exists':
            sid    = qs.get('systemId', [None])[0]
            fname  = qs.get('filename', [None])[0]
            if not sid or not fname:
                self.send_json({'exists': False, 'sizeBytes': 0}, 400); return
            folder = SYSTEM_FOLDER.get(sid)
            if not folder:
                self.send_json({'exists': False, 'sizeBytes': 0, 'error': 'Unknown system'}, 400); return
            # Path.name strips any directory component — prevents path traversal
            # e.g. "../../etc/passwd" becomes "passwd" which can't leave ROMS_DIR/folder/
            safe_fname = Path(fname).name
            if not safe_fname:
                self.send_json({'exists': False, 'sizeBytes': 0}, 400); return
            target  = ROMS_DIR / folder / safe_fname
            exists  = target.is_file()
            # Report byte count even for partial .tmp files (mid-download).
            # Use is_file() — not exists() — so a directory collision never
            # returns a non-zero size for a file that doesn't actually exist.
            size    = target.stat().st_size if exists else 0
            self.send_json({
                'exists':    exists,
                'sizeBytes': size,
                'path':      str(target) if exists else None,
            })
        # ─────────────────────────────────────────────────────────────────────

        elif path == '/api/app/status':
            with _PROC_LOCK:
                running = active_proc is not None and active_proc.poll() is None
                pid     = active_proc.pid if running else None
            self.send_json({'running': running, 'pid': pid})

        elif path == '/api/kill':
            # Kill the currently running emulator/game process
            with _PROC_LOCK:
                if active_proc is None or active_proc.poll() is not None:
                    self.send_json({'success': False, 'error': 'No game is running'})
                    return
                try:
                    pid = active_proc.pid
                    active_proc.terminate()  # Try graceful termination first
                    try:
                        active_proc.wait(timeout=2)  # Wait up to 2 seconds
                    except subprocess.TimeoutExpired:
                        active_proc.kill()  # Force kill if it doesn't terminate
                        active_proc.wait()
                    active_proc = None
                    self.send_json({'success': True, 'message': f'Process {pid} terminated'})
                except Exception as e:
                    self.send_json({'success': False, 'error': str(e)}, 500)

        elif path == '/api/mods':
            game_id = qs.get('game', [''])[0]
            if not game_id:
                self.send_json({'error': 'Missing ?game= parameter'}, 400); return
            self.send_json({
                'mods':   list_mods(game_id),
                'status': mod_status(game_id),
            })

        elif path == '/api/mods/status':
            game_id = qs.get('game', [''])[0]
            if not game_id:
                self.send_json({'error': 'Missing ?game= parameter'}, 400); return
            self.send_json(mod_status(game_id))

        elif path == '/api/open-folder':
            # Open a workspace-relative folder in the OS file manager.
            # Security: resolve() + is_relative_to() rejects symlink traversal
            # and any other path that escapes the workspace root even after the
            # lstrip + replace pre-filter.
            rel        = qs.get('path', [''])[0].lstrip('/').replace('..', '')
            workspace  = Path(__file__).parent.parent.resolve()
            folder     = (workspace / rel).resolve()
            try:
                folder.relative_to(workspace)   # raises ValueError if outside workspace
            except ValueError:
                self.send_json({'ok': False, 'error': 'Path outside workspace'}, 403)
                return
            folder.mkdir(parents=True, exist_ok=True)
            try:
                if platform.system() == 'Windows':
                    subprocess.Popen(['explorer', str(folder)])
                elif platform.system() == 'Darwin':
                    subprocess.Popen(['open', str(folder)])
                else:
                    subprocess.Popen(['xdg-open', str(folder)])
                self.send_json({'ok': True})
            except Exception as e:
                print(f'[open-folder] {e}')
                self.send_json({'ok': False, 'error': 'Could not open folder'})

        elif path == '/api/flash/cache-status':
            self.send_json(flash_cache_status())

        elif path == '/api/flash/cache-clear':
            try:
                if FLASH_CACHE_DIR.exists():
                    shutil.rmtree(FLASH_CACHE_DIR)
                self.send_json({'success': True, 'message': 'SSF2 disk cache cleared'})
            except Exception as e:
                print(f'[flash/cache-clear] {e}')
                self.send_json({'success': False, 'error': 'Cache clear failed'}, 500)

        # ── EmulatorJS CDN proxy ─────────────────────────────────────────────
        # /api/ejs/<subpath>  transparently proxies to cdn.emulatorjs.org/stable/data/
        # Community cores (e.g. flycast) are served from a local cache instead.
        elif path.startswith('/api/ejs/'):
            subpath = path[len('/api/ejs/'):]
            self._serve_ejs(subpath)

        # ── Theater (movies / shows) ─────────────────────────────────────────
        # /api/theater/browse?provider=lookmovie&kind=movies&page=1&genre=
        # /api/theater/details?provider=lookmovie&kind=movie&slug=<id-slug>
        # /api/theater/stream?provider=lookmovie&kind=movie&slug=<id-slug>&episode=<id>
        # /api/theater/search?provider=lookmovie&q=&kind=movies
        # /api/theater/proxy?url=<urlencoded>     (HLS / image / segment passthrough)
        elif path == '/api/theater/proxy':
            self._serve_theater_proxy(qs.get('url', [None])[0])

        elif path.startswith('/api/theater/'):
            if theater is None:
                self.send_json({'error': 'theater providers unavailable'}, 503); return
            action   = path[len('/api/theater/'):]
            provider = qs.get('provider', ['lookmovie'])[0]
            # Accept both numeric ('5') and seasoned ('s1-e5') episode tokens.
            # Embed providers parse seasoned forms internally; scraper providers
            # only expect ints, so we coerce when possible.
            def _ep_token(raw, prov):
                if not raw: return None
                if prov in ('vidsrc', '2embed', 'vidsrcpm', 'multiembed', 'youtube'):
                    return raw   # let the embed/youtube module parse it
                try: return int(raw)
                except (TypeError, ValueError): return None
            try:
                if action == 'browse':
                    out = theater.call(provider, 'browse',
                        kind=qs.get('kind', ['movies'])[0],
                        page=int(qs.get('page', ['1'])[0] or 1),
                        genre=qs.get('genre', [None])[0],
                        sort=qs.get('sort', [None])[0])
                elif action == 'search':
                    out = theater.call(provider, 'search',
                        query=qs.get('q', [''])[0],
                        kind=qs.get('kind', ['movies'])[0])
                elif action == 'curated':
                    out = theater.call(provider, 'curated',
                        slate=qs.get('slate', [''])[0])
                elif action == 'details':
                    det_kwargs = {'kind': qs.get('kind', ['movie'])[0],
                                  'slug': qs.get('slug', [''])[0]}
                    # Embed providers accept an optional title hint that lets
                    # cold-cache deep links (e.g. from My List after a server
                    # restart) resolve their metadata.
                    if provider in ('vidsrc', '2embed', 'vidsrcpm', 'multiembed', 'youtube'):
                        hint = qs.get('title', [None])[0]
                        if hint: det_kwargs['title_hint'] = hint
                    out = theater.call(provider, 'details', **det_kwargs)
                elif action == 'stream':
                    # Accept both ?episode= and ?episode_id= for compatibility
                    # with older callers and the current frontend build.
                    ep_raw = qs.get('episode', [None])[0] or qs.get('episode_id', [None])[0]
                    # Title hint: lets the embed source-switcher resolve the
                    # AniList id for anime-only hosts (vidplus) when reached
                    # via a deep link / cold reverse-lookup cache.
                    if provider in ('vidsrc', '2embed', 'vidsrcpm', 'multiembed'):
                        hint = qs.get('title', [None])[0]
                        if hint:
                            try:
                                from theater_embed import imdb_suggest
                                imdb_suggest(hint)
                            except Exception: pass
                    out = theater.call(provider, 'stream',
                        kind=qs.get('kind', ['movie'])[0],
                        slug=qs.get('slug', [''])[0],
                        episode_id=_ep_token(ep_raw, provider))
                    # Embed providers return an `embed` URL — pass through
                    # untouched (iframe is loaded directly by the browser).
                    if not out.get('embed'):
                        # Rewrite stream URLs to go through our proxy so the
                        # browser can fetch them without CORS / referrer issues.
                        out['streams'] = {q: '/api/theater/proxy?url=' + urllib.parse.quote(u, safe='')
                                           for q, u in (out.get('streams') or {}).items()}
                        out['subtitles'] = [
                            {**s, 'url': '/api/theater/proxy?url=' + urllib.parse.quote(s['url'], safe='')}
                            for s in (out.get('subtitles') or [])
                        ]
                else:
                    self.send_json({'error': f'unknown theater action: {action}'}, 404); return
                self.send_json(out)
            except Exception as e:
                print(f'[theater/{action}] {e}')
                self.send_json({'error': str(e), 'provider': provider, 'action': action}, 502)

        # ── Network ──────────────────────────────────────────────────────────
        elif path == '/api/network/status':
            self.send_json(_net_status())

        elif path == '/api/network/scan':
            # Scanning blocks for ~5 s on Linux; run in a short thread and wait
            import threading as _th2
            result = {}
            def _do_scan(): result.update(_net_scan())
            t = _th2.Thread(target=_do_scan, daemon=True)
            t.start(); t.join(timeout=25)
            self.send_json(result if result else {'networks': [], 'error': 'Scan timed out'})

        # ── Boxart on-demand ─────────────────────────────────────────────────
        # GET /boxart/<game_id>  or  /boxart/<game_id>.jpg
        # 1. Serve cached file immediately if present on disk.
        # 2. Otherwise fetch from SteamGridDB/TheGamesDB (if artkeys.json configured),
        #    save to disk, then serve. Returns 404 if no keys or fetch fails.
        # Query params:  ?title=<game title>  &sys=<systemId>   (used for API search)
        elif path.startswith('/boxart/'):
            raw   = path[len('/boxart/'):]
            gid   = raw.split('.')[0]           # strip .jpg/.png extension if present
            # Security: block any non-safe characters to prevent path traversal
            if not gid or not re.match(r'^[A-Za-z0-9_\-]+$', gid):
                self.send_response(400); self.end_headers(); return

            art_dir = os.path.normpath(_BOXART_DIR)
            dest    = os.path.join(art_dir, f'{gid}.jpg')

            # Check disk — accept any image extension
            served_path = None
            if os.path.exists(dest):
                served_path = dest
            else:
                for ext in ('png', 'webp', 'jpeg'):
                    alt = os.path.join(art_dir, f'{gid}.{ext}')
                    if os.path.exists(alt):
                        served_path = alt
                        break

            # Fetch online if not cached
            if not served_path:
                title  = qs.get('title', [gid])[0]
                sys_id = qs.get('sys',   [''])[0]
                fetched = _boxart_fetch_online(gid, title, sys_id)
                if fetched and os.path.exists(fetched):
                    served_path = fetched

            if not served_path:
                self.send_response(404)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(b'{"error":"not found"}')
                return

            with open(served_path, 'rb') as f:
                img_data = f.read()
            ext  = os.path.splitext(served_path)[-1].lower().lstrip('.')
            mime = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                    'png': 'image/png', 'webp': 'image/webp'}.get(ext, 'image/jpeg')
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(img_data)))
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(img_data)

        # ────────────────────────────────────────────────────────────────────
        else:
            self.serve_static(path)

    def _origin_allowed(self):
        # CSRF guard delegated to kente_security so it can be unit-tested in
        # isolation.  Policy lives there; this method just supplies the header.
        return _origin_allowed_helper(self.headers.get('Origin', ''))

    def do_POST(self):
        if not self._origin_allowed():
            self.send_json({'error': 'Origin not allowed'}, 403)
            return
        path   = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length', 0))
        if length > 10 * 1024 * 1024:
            self.send_json({'error': 'Request body too large'}, 413)
            return
        if length:
            try:
                body = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, ValueError):
                self.send_json({'error': 'Invalid JSON body'}, 400)
                return
        else:
            body = {}

        if path == '/api/emulators/install':
            # Install missing OS-level emulator dependencies in the background.
            # Idempotent — safe to call repeatedly; already-installed ones are skipped.
            if _emu_install_state.get('running'):
                self.send_json({'started': False, 'reason': 'already_running',
                                'state': dict(_emu_install_state)})
                return
            import threading as _th
            t = _th.Thread(target=_emulator_install_thread, daemon=True)
            t.start()
            self.send_json({'started': True,
                            'message': 'Emulator install started — poll /api/emulators/install/status'})
            return

        elif path == '/api/bios/download':
            # Start the BIOS background download (idempotent — ignored if already running)
            if _bios_dl_state.get('running'):
                self.send_json({'started': False, 'reason': 'already_running',
                                'state': dict(_bios_dl_state)})
                return
            import threading as _th
            t = _th.Thread(target=_bios_download_thread, daemon=True)
            t.start()
            self.send_json({'started': True,
                            'message': 'BIOS download started — poll /api/bios/download/status'})
            return

        elif path == '/api/settings':
            # Write Kente UI settings to a sidecar file next to batocera.conf
            # and mirror Batocera-relevant keys to batocera.conf
            try:
                sidecar = CONF_FILE.parent / 'kente-settings.json'
                # Atomic write: stage to .tmp then rename so a server kill
                # mid-write never leaves a truncated kente-settings.json that
                # would raise JSONDecodeError on every subsequent boot.
                tmp_sidecar = sidecar.with_suffix('.json.tmp')
                try:
                    tmp_sidecar.write_text(json.dumps(body, indent=2))
                    tmp_sidecar.replace(sidecar)
                except Exception:
                    tmp_sidecar.unlink(missing_ok=True)
                    raise
                # Mirror mappable keys → batocera.conf
                # Format: 'kenteSettingsKey': ('batocera.conf key', value_transform_fn)
                # Only keys with a direct batocera.conf equivalent are listed here.
                # UI-only settings (themes, scanlines, etc.) are kept in the sidecar only.
                BATOCERA_KEY_MAP = {
                    'volume': ('audio.volume', str),   # Kente 0-100 → batocera audio.volume
                }
                for kk, (bk, fn) in BATOCERA_KEY_MAP.items():
                    if kk in body:
                        write_conf_key(bk, fn(body[kk]))
                self.send_json({'success': True})
            except Exception as e:
                print(f'[settings] {e}')
                self.send_json({'success': False, 'error': 'Failed to save settings'}, 500)
            return
        # ── Network ──────────────────────────────────────────────────────────
        elif path == '/api/network/connect':
            ssid     = body.get('ssid', '').strip()
            password = body.get('password', '').strip()
            if not ssid:
                self.send_json({'success': False, 'error': 'ssid required'}, 400)
                return
            ok, msg = _net_connect(ssid, password)
            self.send_json({'success': ok, 'message': msg})
            return

        elif path == '/api/network/disconnect':
            ok, msg = _net_disconnect()
            self.send_json({'success': ok, 'message': msg})
            return

        elif path == '/api/network/forget':
            ssid = body.get('ssid', '').strip()
            ok, msg = _net_forget(ssid)
            self.send_json({'success': ok, 'message': msg})
            return

        elif path == '/api/download':
            sid      = body.get('systemId', '')
            filename = body.get('filename', '')
            url      = body.get('url', '')
            if not all([sid, filename, url]):
                self.send_json({'success': False, 'error': 'Missing systemId, filename, or url'}, 400)
                return

            # ── #2 Path-traversal guard ───────────────────────────────────────
            # Reduce filename to its base component so values like
            # "../../etc/crontab" can never escape the ROM folder.
            filename = Path(filename).name
            if not filename:
                self.send_json({'success': False, 'error': 'Invalid filename'}, 400)
                return

            # ── #3 SSRF guard ─────────────────────────────────────────────────
            # Only allow downloads from the one host the UI uses.
            # file://, ftp://, or arbitrary HTTP hosts are all rejected here.
            try:
                parsed_host = urllib.parse.urlparse(url).hostname or ''
            except Exception:
                parsed_host = ''
            ALLOWED_HOSTS = {'archive.org', 'ia800100.us.archive.org'}
            if not (parsed_host == 'archive.org' or parsed_host.endswith('.archive.org')):
                self.send_json({'success': False, 'error': 'URL host not allowed'}, 403)
                return

            # Run download in background thread so response returns immediately
            def _do_download():
                ok, result, size = download_rom(sid, filename, url)
                print(f'[Download] {"OK" if ok else "FAIL"} {filename} -> {result}')
            threading.Thread(target=_do_download, daemon=True).start()
            self.send_json({'success': True, 'message': f'Downloading {filename} in background'})
            return
        elif path == '/api/mods/apply':
            game_id = body.get('game', '')
            mod_id  = body.get('modId', '')
            if not game_id or not mod_id:
                self.send_json({'success': False, 'error': 'Missing game or modId'}, 400); return
            ok, result = apply_mod(game_id, mod_id)
            if ok:
                self.send_json({'success': True, 'applied': result, 'status': mod_status(game_id)})
            else:
                self.send_json({'success': False, 'error': result}, 500)
            return

        elif path == '/api/mods/restore':
            game_id = body.get('game', '')
            if not game_id:
                self.send_json({'success': False, 'error': 'Missing game'}, 400); return
            ok, result = restore_mod(game_id)
            if ok:
                self.send_json({'success': True, 'restored': result, 'status': mod_status(game_id)})
            else:
                self.send_json({'success': False, 'error': result}, 500)
            return

        elif path == '/api/launch-app':
            # Launch a native executable (Windows .exe) or Linux script (via WSL or directly).
            exe_path  = body.get('exePath',  '') or None
            linux_exe = body.get('linuxExe', '') or None
            if not exe_path and not linux_exe:
                self.send_json({'success': False, 'error': 'Missing exePath or linuxExe'}, 400)
                return
            ok, result = launch_native_app(exe_path=exe_path, linux_exe=linux_exe)
            if ok:
                try:
                    pid = int(result)
                except (TypeError, ValueError):
                    pid = None
                self.send_json({'success': True, 'pid': pid})
            else:
                self.send_json({'success': False, 'error': result}, 500)
            return

        elif path == '/api/launch':
            sid       = body.get('systemId', '')
            rom_path  = body.get('romPath', '')
            title     = body.get('title', '')
            if not rom_path and title:
                rom_path = find_rom(sid, title) or ''
            if not rom_path:
                # SYSTEM_FOLDER.get(sid) or sid: use known folder name for display;
                # fall back to the raw sid only as a hint — never used for disk writes.
                rom_dir = str(ROMS_DIR / (SYSTEM_FOLDER.get(sid) or sid))
                self.send_json({'success': False, 'error': 'ROM_NOT_FOUND', 'romDir': rom_dir}, 422)
                return
            ok, msg = launch_game(sid, rom_path)
            self.send_json({'success': ok, 'message': msg})

        elif path == '/api/launch-rom':
            # Open a downloaded ROM with a locally-installed emulator (non-Batocera host).
            # Tries known emulator paths → OS file association → folder open.
            sid      = body.get('systemId', '')
            filename = body.get('filename', '')
            if not sid or not filename:
                self.send_json({'success': False, 'error': 'Missing systemId or filename'}, 400)
                return
            folder   = SYSTEM_FOLDER.get(sid, sid)
            rom_path = str(ROMS_DIR / folder / filename)
            ok, method, error = find_and_launch_rom(sid, rom_path)
            self.send_json({'success': ok, 'method': method, 'error': error})

        else:
            self.send_json({'error': 'Not found'}, 404)

# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print(f'[Kente Server] Starting on port {PORT}...')
    # ThreadingHTTPServer handles each request in its own thread so long-running
    # ROM-proxy streaming downloads do not block API calls (ping, settings, etc.).
    server = ThreadingHTTPServer(('127.0.0.1', PORT), KenteHandler)
    print(f'[Kente Server] Ready at http://localhost:{PORT}')
    if IS_BATOCERA and os.getenv('KENTE_FORCE_NATIVE'):
        print('[Kente Server] KENTE_FORCE_NATIVE=1 — running in forced native mode')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('[Kente Server] Stopped.')

