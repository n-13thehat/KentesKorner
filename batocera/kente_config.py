"""Kente's Korner — Configuration: deployment mode, paths, system/emulator tables, locks, host allowlists."""
import os, platform, re, threading
from pathlib import Path

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
    # Web files: Electron tells us where via KENTE_WEB_DIR (points at
    # <install>/resources/web in packaged builds, repo root in dev). Falls
    # back to the script's grand-parent only if the env var is missing,
    # which is wrong inside a PyInstaller --onefile bundle (where __file__
    # resolves to a temp _MEI dir) but kept as a last-resort default.
    _web_env = os.getenv('KENTE_WEB_DIR')
    WEB_DIR  = Path(_web_env) if _web_env else Path(__file__).parent.parent
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
# NOTE: WEB_DIR may be read-only in packaged Electron installs (Program Files).
# Keep caches under BASE (userData) so offline play works without admin rights.
CACHE_DIR     = BASE / 'cache'
try:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    # If the data dir is not writable for some reason, fall back to WEB_DIR.
    CACHE_DIR = WEB_DIR / 'cache'
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

EJS_CORES_DIR  = CACHE_DIR / 'ejs-cores'    # local cache for community-built cores
EJS_STABLE_DIR = CACHE_DIR / 'ejs-stable'   # offline mirror + write-through CDN cache
# Optional build-time seed pack (read-only) bundled into packaged Electron builds.
# When present, EmulatorJS assets can be served fully offline even before the
# user cache is populated.
EJS_SEED_DIR   = WEB_DIR / 'cache' / 'ejs-stable'

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
                  r'%ProgramFiles%\PCSX2\pcsx2-qtx64.exe',
                  r'%ProgramFiles%\PCSX2\pcsx2-qtx64-avx2.exe',
                  r'%ProgramFiles%\PCSX2\PCSX2.exe',
                  r'%ProgramFiles(x86)%\PCSX2\PCSX2.exe',
                  r'%LOCALAPPDATA%\Programs\PCSX2\pcsx2-qt.exe',
                  r'%LOCALAPPDATA%\Programs\PCSX2\pcsx2-qtx64.exe',
                  r'%LOCALAPPDATA%\Programs\PCSX2\pcsx2-qtx64-avx2.exe'],
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

# ── ROM provider host allowlist ──────────────────────────────────────────────
# Static set of full hostnames registered for direct download.  Vimm's
# download CDN uses load-balanced numbered subdomains (dl2.vimm.net,
# dl3.vimm.net, dl4.vimm.net, …) so it gets a regex match in _rom_host_ok().
_ROM_PROXY_HOSTS = {
    'myrient.erista.me', 'www.myrient.erista.me',
    'coolrom.com.au',    'www.coolrom.com.au', 'dl.coolrom.com.au',
    'emuparadise.me',    'www.emuparadise.me',
    'vimm.net',          'www.vimm.net',
    'cdromance.org',     'www.cdromance.org',
    'hshop.erista.me',   'www.hshop.erista.me',
}
_ROM_PROXY_HOST_RE = re.compile(r'^dl\d+\.vimm\.net$', re.I)


def _rom_host_ok(host):
    """Return True if `host` is allowed to be fetched by the ROM proxy."""
    if not host: return False
    h = host.lower()
    return (h == 'archive.org' or h.endswith('.archive.org')
            or h in _ROM_PROXY_HOSTS
            or bool(_ROM_PROXY_HOST_RE.match(h)))


def _rom_upstream_referer(host):
    """Some ROM CDNs hot-link-protect against blank/unknown referers.

    Return the Referer to send to `host`, or None to send no Referer header.
    """
    if not host: return None
    h = host.lower()
    if _ROM_PROXY_HOST_RE.match(h) or h.endswith('vimm.net'):
        return 'https://vimm.net/'
    return None
