#!/usr/bin/env python3
"""
Kente's Korner — Native API Server
Serves the web shell and bridges to Batocera's emulation stack.
stdlib only — no pip required.
"""
__version__ = '9.1.9'

import hashlib, io, json, os, platform, re, shutil, signal, subprocess, sys, tempfile, threading, time, zipfile
import urllib.request, urllib.parse, urllib.error
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

# Local helpers — stdlib-only modules co-located in the batocera/ tree.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from kente_security import origin_allowed as _origin_allowed_helper
from kente_security import safe_resolve as _safe_resolve_helper
from kente_security import public_http_url as _public_http_url
from kente_security import safe_urlopen as _safe_urlopen
from kente_cache import directory_usage as _directory_usage
from kente_cache import trim_lru_cache as _trim_lru_cache

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

from kente_config import (
    ARCHIVE_PACKS, BASE, BIOS_DIR, BIOS_FILES, COMMUNITY_CORES, CONF_FILE,
    _FLYCAST_CORE_METADATA,
    EJS_CDN_BASE, EJS_CORES_DIR, EJS_SEED_DIR, EJS_STABLE_DIR,
    FLASH_CACHE_DIR, IS_APP, IS_BATOCERA, MAX_ROM_DL_SECS,
    MAX_ROM_FILE_BYTES, MIME, NATIVE_EMU_LIN, NATIVE_EMU_WIN, PORT,
    PROXY_ALLOWED_HOSTS, ROMS_DIR, SAVES_DIR, SYSTEM_FOLDER, WEB_DIR,
    _CONF_LOCK, _DOWNLOAD_LOCK, _PROC_LOCK, _active_downloads, _rom_host_ok,
    _rom_upstream_referer
)
from kente_emulators import (
    EMULATOR_DEPS, _bios_dl_state, _bios_download_thread,
    _check_emu_installed, _emu_install_state, _emulator_install_thread,
    _rpcs3_firmware_installed, _winget_portable_glob
)
from kente_ejs import _ejs_get_extracted_core, _ejs_prefetch_state, _ejs_prefetch_thread
from kente_native_host import NativeSession
from kente_lobby import start_lobby_relay
from kente_runtime import (SYSTEM_ENGINES, configure_engine, configure_installed_pcsx2,
                           configure_remote_pcsx2_player2, import_runtime, native_arguments,
                           provision_runtime)
from kente_mods import apply_mod, list_mods, mod_status, restore_mod
from kente_network import _net_connect, _net_disconnect, _net_forget, _net_scan, _net_status
from kente_boxart import _BOXART_DIR, _boxart_fetch_online

_ROM_STREAM_LOCK = threading.Lock()
_ROM_STREAM_ACTIVE = 0


# ── Archive.org cue+bin → zip bundling ──────────────────────────────────────
# Multi-track CD dumps on Archive.org are stored as separate files: a small
# .cue index plus one or more .bin data/audio tracks.  Emulators (and EJS's
# pcsx_rearmed core) need ALL of them to play the disc; downloading the .cue
# alone produces a 1-2 KB text file and an instant black screen.
#
# When the proxy is asked to fetch a .cue from archive.org we transparently:
#   1. Parse the archive item identifier from the URL.
#   2. List sibling files in the item.
#   3. Read the .cue text, extract its `FILE "track.bin" BINARY` references.
#   4. Stream the .cue + all referenced tracks into a single .zip (ZIP_STORED,
#      no compression — disc images are already compressed by Redump).
#   5. Stream the zip body back to the client and (optionally) save to disk.
#
# Memory bound: SpooledTemporaryFile rolls over to disk past `spool_max`,
# so a 700 MB PSX dump never lives in RAM in full.

_CUE_FILE_RE = re.compile(r'^\s*FILE\s+"([^"]+)"', re.I | re.M)

def _archive_cue_components(cue_url):
    """If `cue_url` is an archive.org .cue download URL, return
    (identifier, cue_name, [data_track_names]).  Otherwise return None.

    A second metadata round-trip lists the item to discover sibling tracks;
    cached by _archive_item_files() (TTL 900s) so repeat downloads are free.
    """
    if not cue_url.lower().endswith('.cue'): return None
    parsed = urllib.parse.urlparse(cue_url)
    host = (parsed.hostname or '').lower()
    if not (host == 'archive.org' or host.endswith('.archive.org')):
        return None
    m = re.match(r'^/download/([^/]+)/(.+)$', parsed.path)
    if not m: return None
    ident = urllib.parse.unquote(m.group(1))
    cue_name = urllib.parse.unquote(m.group(2))
    if '/' in cue_name:  # nested file inside item; bundling not supported
        return None
    # Inline metadata fetch (no cache shared with rom_providers module — keep
    # this stdlib-only path self-contained).
    meta_url = f'https://archive.org/metadata/{urllib.parse.quote(ident)}'
    try:
        with _safe_urlopen(meta_url, timeout=12) as r:
            data = json.loads(r.read().decode('utf-8', 'replace'))
    except Exception as e:
        print(f'[cue-bundle] metadata fetch failed for {ident}: {e}')
        return None
    sibling_names = [(f.get('name') or '') for f in (data.get('files') or [])]
    sibling_names = [n for n in sibling_names if n and '/' not in n]
    if cue_name not in sibling_names:
        return None
    # Also fetch the cue body so we can resolve relative FILE references.
    cue_body_url = (f'https://archive.org/download/{urllib.parse.quote(ident)}/'
                    f'{urllib.parse.quote(cue_name)}')
    try:
        with _safe_urlopen(cue_body_url, timeout=12) as r:
            cue_text = r.read().decode('utf-8', 'replace')
    except Exception as e:
        print(f'[cue-bundle] cue read failed for {ident}/{cue_name}: {e}')
        return None
    refs = [m.strip() for m in _CUE_FILE_RE.findall(cue_text) if m.strip()]
    tracks = []
    sib_low = {s.lower(): s for s in sibling_names}
    for r in refs:
        rl = Path(r).name.lower()
        if rl in sib_low:
            tracks.append(sib_low[rl])
    # Some Redump cues reference uppercase names; fall back to any sibling
    # .bin/.img whose stem matches the .cue stem.
    if not tracks:
        stem = Path(cue_name).stem.lower()
        for s in sibling_names:
            sl = s.lower()
            if sl.endswith(('.bin', '.img')) and Path(s).stem.lower().startswith(stem):
                tracks.append(s)
    if not tracks:
        print(f'[cue-bundle] no data tracks found alongside {ident}/{cue_name}')
        return None
    return ident, cue_name, tracks, cue_text


def _build_cue_bundle_zip(ident, cue_name, cue_text, track_names, spool_max=64*1024*1024):
    """Return a seekable SpooledTemporaryFile containing a ZIP of cue + tracks.

    Caller is responsible for closing the file once streaming is complete.
    """
    spool = tempfile.SpooledTemporaryFile(max_size=spool_max)
    with zipfile.ZipFile(spool, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        zf.writestr(cue_name, cue_text)
        for tname in track_names:
            track_url = (f'https://archive.org/download/{urllib.parse.quote(ident)}/'
                         f'{urllib.parse.quote(tname)}')
            req = urllib.request.Request(track_url, headers={
                'User-Agent': 'Mozilla/5.0 (compatible; KenteKorner/1.0)',
            })
            with _safe_urlopen(req, timeout=300) as resp, \
                 zf.open(tname, 'w', force_zip64=True) as zf_out:
                while True:
                    chunk = resp.read(262144)
                    if not chunk: break
                    zf_out.write(chunk)
    spool.seek(0)
    return spool


active_proc = None

# ── Helpers ──────────────────────────────────────────────────────────────────

def bios_status():
    # PS2 BIOS dumps vary by region/model filename; accept any plausible .bin.
    out = {}
    for sid, fname in BIOS_FILES.items():
        if sid == 'ps2':
            ok = False
            try:
                for p in BIOS_DIR.iterdir():
                    if not p.is_file() or p.suffix.lower() != '.bin':
                        continue
                    try:
                        if p.stat().st_size >= 1_000_000:  # PS2 BIOS bins are typically >1MB
                            ok = True
                            break
                    except OSError:
                        continue
            except Exception:
                ok = False
            out[sid] = ok
        else:
            out[sid] = (BIOS_DIR / fname).exists()
    return out

def _norm_rom_key(s):
    """Strip separators / punctuation so 'Bratz: Adult!' and 'bratz_adult'
    collapse to the same comparable key for find_rom matching."""
    return (s or '').lower() \
        .replace(' ', '').replace('_', '').replace('-', '') \
        .replace(':', '').replace("'", '').replace('&', '') \
        .replace('(', '').replace(')', '').replace('[', '').replace(']', '') \
        .replace('.', '').replace(',', '').replace('!', '')

def find_rom(system_id, title):
    """Fuzzy-match a ROM file for system_id by title.

    Searches two candidate directories:
      1. ROMS_DIR / SYSTEM_FOLDER[system_id]  — Batocera canonical name (e.g. 'psx')
      2. ROMS_DIR / system_id                 — local desktop layout (e.g. 'ps1')
    Returns the full path string of the first match, or None. Skips partial
    downloads (.tmp/.part) and metadata sidecars (.txt/.nfo/.json) so a stray
    readme never wins over the actual ROM/ISO.
    """
    needle = _norm_rom_key(title)
    _META_EXT = {'.txt', '.nfo', '.md', '.json', '.xml', '.url', '.sfv', '.diz'}

    # Build search dirs without duplicates
    batocera_folder = SYSTEM_FOLDER.get(system_id)
    if not batocera_folder:
        return None
    dirs_to_search = []
    if batocera_folder:
        dirs_to_search.append(ROMS_DIR / batocera_folder)
    local_dir = ROMS_DIR / system_id
    if local_dir not in dirs_to_search:
        dirs_to_search.append(local_dir)

    candidates = []
    for rom_dir in dirs_to_search:
        if not rom_dir.exists():
            continue
        for f in sorted(rom_dir.iterdir()):
            if not f.is_file():
                continue
            suf = f.suffix.lower()
            if suf in ('.tmp', '.part') or suf in _META_EXT:
                continue
            if f.stat().st_size <= 64:
                continue
            stem = _norm_rom_key(f.stem)
            if roms is not None:
                if not roms.title_matches(f.stem, title):
                    continue
                score = roms._title_overlap(f.stem, title)
            elif needle and (needle in stem or stem in needle):
                score = 1.0
            else:
                continue
            candidates.append((score, f.stat().st_size, str(f)))
    return max(candidates)[2] if candidates else None

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

_FLASH_CACHE_LOCK = threading.Lock()
_FLASH_CACHE_MAX_BYTES = 2 * 1024 ** 3
_FLASH_ASSET_MAX_BYTES = 128 * 1024 ** 2


def _trim_flash_cache(required=0):
    """Evict oldest cached Flash assets until there is room under the budget."""
    _trim_lru_cache(FLASH_CACHE_DIR, required, _FLASH_CACHE_MAX_BYTES)


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
        try:
            os.utime(cache_file, None)
        except OSError:
            pass
        return cache_file.read_bytes(), meta['ct']

    # Download from origin
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (compatible; KenteKorner/1.0)',
        'Referer':    'https://www.supersmashflash.com/',
    })
    with _safe_urlopen(req, timeout=30) as resp:
        ct   = resp.headers.get('Content-Type', 'application/octet-stream').split(';')[0].strip()
        declared_size = int(resp.headers.get('Content-Length') or 0)
        if declared_size > _FLASH_ASSET_MAX_BYTES:
            raise ValueError('Flash asset exceeds the 128 MB limit')
        data = resp.read(_FLASH_ASSET_MAX_BYTES + 1)
        if len(data) > _FLASH_ASSET_MAX_BYTES or resp.read(1):
            raise ValueError('Flash asset exceeds the 128 MB limit')

    FLASH_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    # Write atomically: stage to .tmp then rename so a mid-write crash
    # never leaves a truncated file that would be served on the next request.
    unique_tmp = f'.{threading.get_ident()}.tmp'
    tmp_cache = cache_file.with_name(cache_file.name + unique_tmp)
    try:
        with _FLASH_CACHE_LOCK:
            _trim_flash_cache(len(data))
            tmp_cache.write_bytes(data)
            tmp_cache.replace(cache_file)      # atomic on POSIX; near-atomic on Windows
    except Exception:
        tmp_cache.unlink(missing_ok=True)      # discard incomplete temp
        raise
    # Atomic meta write — same pattern as the cache body above.
    # A partial meta.json write (e.g. server kill mid-write) would leave a
    # corrupt JSON fragment; the next request then crashes on json.loads().
    tmp_meta = meta_file.with_name(meta_file.name + unique_tmp)
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
        # Some provider CDNs (Vimm's dl*.vimm.net) hot-link-protect and
        # refuse blank/unknown Referers — inject the matching origin.
        try:
            _dl_host = (urllib.parse.urlparse(url).hostname or '').lower()
        except Exception:
            _dl_host = ''
        _ref = _rom_upstream_referer(_dl_host)
        if _ref: headers['Referer'] = _ref
        req     = urllib.request.Request(url, headers=headers)
        # 30 s covers each blocking socket read; wall-clock cap below covers
        # slow-but-continuous transfers that would otherwise run for hours.
        deadline = time.monotonic() + MAX_ROM_DL_SECS
        with _safe_urlopen(req, timeout=30) as resp:
            expected = int(resp.headers.get('Content-Length') or '0')
            if expected < 0 or expected > MAX_ROM_FILE_BYTES:
                raise ValueError('Invalid ROM size')
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
            if not received or (expected and received != expected):
                raise ValueError(f'Incomplete ROM response ({received}/{expected} bytes)')
        # Atomic promotion: replace dest only after a complete write
        tmp_file.replace(dest_file)
        return True, str(dest_file), received
    except urllib.error.HTTPError as e:
        # Surface upstream HTTP status (archive.org returns 503 under load,
        # 500 when a CDN node is broken for that item) so the UI/log can
        # tell the user it's an upstream issue rather than a local bug.
        tmp_file.unlink(missing_ok=True)
        if dest_file.exists() and dest_file.stat().st_size == 0:
            dest_file.unlink(missing_ok=True)
        return False, f'Upstream {e.code} {e.reason} ({_dl_host})', 0
    except Exception as e:
        tmp_file.unlink(missing_ok=True)   # clean up incomplete temp file
        if dest_file.exists() and dest_file.stat().st_size == 0:
            dest_file.unlink(missing_ok=True)
        return False, f'{type(e).__name__}: {e}', 0
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
        return False, f'Unknown system: {system_id}', 'UNKNOWN_SYSTEM'
    if not Path(rom_path).exists():
        return False, 'ROM file not found on disk', 'ROM_MISSING'

    launcher = Path('/usr/bin/emulatorlauncher')
    if not launcher.exists():
        # Not Batocera — use the native desktop emulator (Dolphin, PCSX2, etc.)
        ok, method, err_code, err_msg = find_and_launch_rom(system_id, rom_path)
        if ok:
            return True, method, None
        msg = err_msg or f'Launch failed for {system_id}'
        code = err_code or 'LAUNCH_FAILED'
        return False, msg, code

    try:
        proc = subprocess.Popen(
            [str(launcher), '-system', folder, '-rom', rom_path],
            env={**os.environ, 'DISPLAY': ':0'},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
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
                detail = f'exit {exit_code}'
                return False, f'emulatorlauncher failed ({detail}) — check emulator install for {folder}', 'LAUNCHER_FAILED'
            # exit_code 0 in < 2 s: unusual but treat as clean handoff
        except subprocess.TimeoutExpired:
            pass  # Still running after 2 s → emulator is loading normally ✓

        def _wait_refocus():
            proc.wait()
            _refocus_browser()
        threading.Thread(target=_wait_refocus, daemon=True).start()
        return True, 'launched', None
    except Exception as e:
        return False, str(e), 'LAUNCH_EXCEPTION'

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

def _safe_zip_extract(zip_path: Path, dest_dir: Path, max_files=5000, max_total_bytes=100 * 1024**3):
    """Safely extract a zip file into dest_dir (ZipSlip + basic bomb limits)."""
    import zipfile as _zf
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_abs = os.path.abspath(str(dest_dir))
    total = 0
    with _zf.ZipFile(str(zip_path)) as zf:
        infos = zf.infolist()
        if len(infos) > max_files:
            raise RuntimeError(f'Zip has too many files ({len(infos)} > {max_files})')
        for info in infos:
            # Directories are represented either by trailing slash or external attrs.
            name = info.filename
            if not name or name.endswith('/'):
                continue
            if '\x00' in name:
                raise RuntimeError('Zip contains NUL in filename')
            total += int(getattr(info, 'file_size', 0) or 0)
            if total > max_total_bytes:
                raise RuntimeError('Zip uncompressed size too large')
            compressed = int(getattr(info, 'compress_size', 0) or 0)
            expanded = int(getattr(info, 'file_size', 0) or 0)
            if expanded > max_total_bytes or (expanded > 1024**2 and compressed > 0
                    and expanded / compressed > 1000):
                raise RuntimeError(f'Zip entry has an unsafe expansion ratio: {name}')
            if len(name) > 1024:
                raise RuntimeError('Zip entry path is too long')
            # Zip uses forward slashes; os.path handles it fine on Windows.
            out_path = os.path.abspath(os.path.join(dest_abs, name))
            if os.path.commonpath([dest_abs, out_path]) != dest_abs:
                raise RuntimeError(f'Blocked unsafe zip path: {name}')
            zf.extract(info, dest_abs)

def _extract_rom_container(system_id: str, rom_file: Path) -> Path:
    """Extract a ROM container (.zip/.7z) to a stable cache dir and return the inner ROM path."""
    rom_file = Path(rom_file)
    st = rom_file.stat()
    cache_root = ROMS_DIR / '_extracted' / (system_id or 'unknown')
    # Hash key includes mtime/size so updated archives re-extract automatically.
    key = hashlib.sha256(f'{rom_file.resolve()}|{st.st_size}|{int(st.st_mtime)}'.encode('utf-8', errors='ignore')).hexdigest()[:16]
    dest = cache_root / key
    meta = dest / '_meta.json'

    if meta.exists():
        try:
            m = json.loads(meta.read_text(encoding='utf-8', errors='replace'))
            if m.get('size') == st.st_size and m.get('mtime') == int(st.st_mtime):
                chosen_rel = m.get('chosen')
                if chosen_rel:
                    chosen = dest / chosen_rel
                    if chosen.exists():
                        return chosen
        except Exception:
            pass

    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)

    ext = rom_file.suffix.lower()
    if ext == '.zip':
        # ROM downloads may be highly compressed: this NBA Street archive is
        # 1.3 GB on disk but expands to a 4.1 GB ISO. Check the destination
        # volume before extraction so the emulator never receives a truncated
        # image after the drive fills up.
        try:
            with zipfile.ZipFile(str(rom_file)) as zf:
                required_bytes = sum(int(info.file_size or 0) for info in zf.infolist()
                                     if info.filename and not info.filename.endswith('/'))
        except Exception as exc:
            shutil.rmtree(dest, ignore_errors=True)
            raise RuntimeError(f'Could not read ROM archive: {exc}')
        free_bytes = shutil.disk_usage(str(ROMS_DIR)).free
        reserve_bytes = 128 * 1024 * 1024
        if free_bytes < required_bytes + reserve_bytes:
            shutil.rmtree(dest, ignore_errors=True)
            need_gb = (required_bytes + reserve_bytes) / (1024 ** 3)
            free_gb = free_bytes / (1024 ** 3)
            raise RuntimeError(
                f'Not enough free disk space to extract this game. '
                f'It needs about {need_gb:.1f} GB free; only {free_gb:.1f} GB is available. '
                f'Free disk space and try again.'
            )
    try:
        if ext == '.zip':
            _safe_zip_extract(rom_file, dest)
        elif ext in ('.7z', '.rar'):
            tar = shutil.which('tar')
            if not tar:
                raise RuntimeError(f'tar not available for {ext} extraction')
            r = subprocess.run([tar, '-xf', str(rom_file), '-C', str(dest)],
                               capture_output=True, text=True, timeout=60 * 60)
            if r.returncode != 0:
                raise RuntimeError((r.stdout + r.stderr).strip()[:500] or f'tar exit {r.returncode}')
        else:
            raise RuntimeError(f'Unsupported ROM container type: {rom_file.name}')
    except Exception:
        # Never leave a partial ISO in the extraction cache. A subsequent
        # launch can retry cleanly after the user frees disk space.
        shutil.rmtree(dest, ignore_errors=True)
        raise

    # Pick the best inner payload for the system. The preference tuple is
    # ranked best-first; a smaller rank wins, with file size as the tie-break
    # so multi-disc dumps land on the largest disc image. Metadata sidecars
    # (.txt/.nfo/.json) are excluded from the generic fallback so a stray
    # readme can never out-rank the actual ROM/ISO.
    _META_SIDECARS = {'.txt', '.nfo', '.md', '.json', '.xml', '.url', '.sfv', '.diz'}

    def _pick_by_ext(prefer):
        best_rank, best_size, picked = 999, -1, None
        for p in dest.rglob('*'):
            if not p.is_file():
                continue
            suf = p.suffix.lower()
            if suf not in prefer:
                continue
            rank = prefer.index(suf)
            try: size = p.stat().st_size
            except OSError: size = 0
            if rank < best_rank or (rank == best_rank and size > best_size):
                best_rank, best_size, picked = rank, size, p
        return picked

    chosen = None
    if system_id == 'ps3':
        # PS3 — prefer folder dumps containing PS3_GAME, then ISO, then PKG.
        for p in dest.rglob('*'):
            if p.is_dir() and (p / 'PS3_GAME').is_dir():
                chosen = p
                break
        if not chosen:
            isos = sorted([p for p in dest.rglob('*.iso') if p.is_file()],
                          key=lambda x: x.stat().st_size if x.exists() else 0,
                          reverse=True)
            if isos: chosen = isos[0]
        if not chosen:
            pkgs = sorted([p for p in dest.rglob('*.pkg') if p.is_file()],
                          key=lambda x: x.stat().st_size if x.exists() else 0,
                          reverse=True)
            if pkgs: chosen = pkgs[0]
    elif system_id == 'wiiu':
        # Wii U — Cemu prefers a folder containing code/<name>.rpx; fall back
        # to packed images (.wud/.wux) or the .rpx itself.
        for p in dest.rglob('*'):
            if p.is_dir() and (p / 'code').is_dir():
                rpxs = list((p / 'code').glob('*.rpx'))
                if rpxs:
                    chosen = rpxs[0]
                    break
        if not chosen:
            chosen = _pick_by_ext(('.wud', '.wux', '.rpx'))
    else:
        # Per-system preference table: extensions ranked best-first.
        _PREFS = {
            # PCEE2 accepts these PS2 disc image formats. Keep archive
            # selection aligned with the Mac in-process core and ROM_EXT.
            'ps2':       ('.m3u', '.chd', '.iso', '.cso', '.zso', '.gz', '.mdf', '.nrg', '.cue', '.bin', '.elf', '.irx', '.gs', '.acgame'),
            'ps1':       ('.chd', '.pbp', '.cue', '.bin', '.iso'),
            'psx':       ('.chd', '.pbp', '.cue', '.bin', '.iso'),
            'psp':       ('.chd', '.cso', '.iso', '.pbp'),
            'gamecube':  ('.rvz', '.nkit.iso', '.gcm', '.iso', '.wbfs', '.wad'),
            'wii':       ('.rvz', '.nkit.iso', '.wbfs', '.iso', '.wad', '.gcm'),
            '3ds':       ('.3ds', '.cci', '.cxi', '.cia'),
            'switch':    ('.xci', '.nsp', '.nca'),
            'saturn':    ('.chd', '.cue', '.ccd', '.iso', '.bin'),
            'dreamcast': ('.gdi', '.chd', '.cdi', '.iso'),
            'segacd':    ('.chd', '.cue', '.bin', '.iso'),
            'n64':       ('.z64', '.v64', '.n64'),
            'nds':       ('.nds',),
            'ds':        ('.nds',),
            'snes':      ('.sfc', '.smc'),
            'nes':       ('.nes',),
            'gameboy':   ('.gb',),
            'gbc':       ('.gbc',),
            'gba':       ('.gba',),
            'genesis':   ('.md', '.gen', '.smd', '.bin'),
            'mastersys': ('.sms',),
            'gamegear':  ('.gg',),
            'sega32x':   ('.32x',),
            'turbografx':('.pce',),
            'neogeo':    ('.neo',),
            'atari2600': ('.a26', '.bin'),
            'atari7800': ('.a78', '.bin'),
        }
        prefer = _PREFS.get(system_id)
        if prefer:
            chosen = _pick_by_ext(prefer)
        if not chosen:
            # Fallback: largest non-sidecar file. Skips .txt/.nfo/etc so a
            # bundled readme never wins over the actual ROM payload.
            files = [p for p in dest.rglob('*')
                     if p.is_file() and p.suffix.lower() not in _META_SIDECARS]
            if files:
                chosen = max(files, key=lambda x: x.stat().st_size if x.exists() else 0)

    if not chosen:
        raise RuntimeError('No usable ROM file found inside archive')

    try:
        meta.write_text(json.dumps({'size': st.st_size, 'mtime': int(st.st_mtime),
                                    'chosen': str(chosen.relative_to(dest))}, indent=2),
                        encoding='utf-8')
    except Exception:
        pass

    return chosen

def find_and_launch_rom(system_id, rom_path):
    """Open rom_path with a known emulator for system_id.

    Attempts in order:
      1. Known emulator paths / commands for this system
      2. OS file-type association  (os.startfile / xdg-open)
      3. Open the containing folder in the file manager

    Returns (success: bool, method: str, error_code: str | None, error_message: str | None)
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
            return True, 'folder', None, None
        except Exception as e:
            return False, '', 'ROM_MISSING', f'ROM not found and could not open folder: {e}'

    # If the ROM is in an archive container, extract to a cache dir and launch
    # the inner file/folder instead (many native emulators cannot boot .zip/.7z).
    try:
        if rom.is_file() and rom.suffix.lower() in ('.zip', '.7z', '.rar'):
            rom = _extract_rom_container(system_id, rom)
    except Exception as _ex:
        return False, '', 'EXTRACT_FAILED', f'Failed to extract ROM archive: {_ex}'

    # ── PS3 preflight ───────────────────────────────────────────────────────
    if system_id == 'ps3':
        # Folder dumps must contain a PS3_GAME directory.
        if rom.is_dir():
            try:
                if not (rom / 'PS3_GAME').is_dir():
                    return False, '', 'PS3_BAD_DUMP', 'PS3 folder must contain PS3_GAME/ (folder-format disc dump)'
            except Exception:
                pass
        # ISO images often require a matching disc key file next to the ISO.
        if rom.is_file() and rom.suffix.lower() == '.iso':
            try:
                has_key = rom.with_suffix('.key').exists() or rom.with_suffix('.dkey').exists()
            except Exception:
                has_key = False
            if not has_key:
                return False, '', 'PS3_KEY_MISSING', 'PS3 ISO needs a matching disc key (.key/.dkey) next to it'

    # Per-emulator fullscreen + ROM argument builders.
    # Each lambda receives the rom Path and returns the arg list AFTER the exe.
    _EMU_ARGS = {
        'dolphin':   lambda r: ['--config', 'Display.Fullscreen=True', '-e', str(r)],
        # PCSX2 v1.7+ (pcsx2-qt / pcsx2-qtx64): use -fullscreen/-batch before the ISO path.
        # Old PCSX2 v1.6: uses --fullscreen after the ISO.
        'pcsx2-qt':  lambda r: ['-fullscreen', '-batch', '--', str(r)],
        'pcsx2':     lambda r: [str(r), '--fullscreen', '--nogui'],
        # RPCS3 CLI flags are inconsistent across versions; avoid --no-gui for
        # compatibility and let the GUI handle boot/install flows.
        'rpcs3':     lambda r: [str(r)],
        'flycast':   lambda r: [str(r)],
        'redream':   lambda r: [str(r)],
        'cemu':      lambda r: ['-f', '-g', str(r)],
        'xenia':     lambda r: ['--fullscreen', str(r)],
        'xemu':      lambda r: [str(r)],
        'ryujinx':   lambda r: [str(r)],
    }

    def _build_cmd(exe_str, r):
        stem = Path(exe_str).stem.lower()
        # Normalize common binary name variants → arg profile.
        key = stem
        if stem.startswith('pcsx2-qt') or stem.startswith('pcsx2-qtx'):
            key = 'pcsx2-qt'
        args = _EMU_ARGS.get(key, lambda x: [str(x)])(r)
        # Prefer portable mode for user-space PCSX2 installs so BIOS/config stays
        # self-contained under %LOCALAPPDATA%\\Programs\\PCSX2.
        if key == 'pcsx2-qt':
            try:
                configure_installed_pcsx2(exe_str)
            except Exception as ex:
                # Input setup must never block an otherwise valid game launch.
                print(f'[controller] PCSX2 input setup skipped: {ex}')
            try:
                exe_p = Path(exe_str)
                localapp = os.environ.get('LOCALAPPDATA', '')
                if localapp and str(exe_p).lower().startswith(str(Path(localapp)).lower()):
                    args = ['-portable'] + args
            except Exception:
                pass
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
            # PS3: ensure RPCS3 firmware is installed before attempting to boot a game.
            if system_id == 'ps3' and Path(exe_str).stem.lower().startswith('rpcs3'):
                if not _rpcs3_firmware_installed(exe_str):
                    # If the background BIOS thread is currently installing firmware, surface that.
                    try:
                        if _bios_dl_state.get('running') and 'rpcs3' in str(_bios_dl_state.get('phase') or '').lower():
                            return False, '', 'PS3_FIRMWARE_INSTALLING', 'Installing PS3 firmware in RPCS3 — try again in a minute'
                    except Exception:
                        pass
                    return False, '', 'PS3_FIRMWARE_MISSING', 'PS3 firmware not installed yet (PS3UPDAT.PUP)'
            cmd  = _build_cmd(exe_str, rom)
            proc = subprocess.Popen(cmd, close_fds=True)
            threading.Thread(target=_track_proc, args=(proc,), daemon=True).start()
            return True, f'emulator:{emu_name}', None, None
        except Exception:
            continue   # try next candidate

    # 1b. WinGet portable package glob + PATH fallback
    if is_win:
        # For emulators installed as WinGet portables, scan the packages directory
        _WINGET_IDS = {
            'ps2':    ('PCSX2Team.PCSX2', 'pcsx2-qt.exe'),
            'wiiu':   ('Cemu.Cemu',   'Cemu.exe'),
            'ps3':    ('RPCS3.RPCS3', 'rpcs3.exe'),
        }
        wg_pair = _WINGET_IDS.get(system_id)
        if wg_pair:
            pkg_id, exe_name = wg_pair
            alt = []
            if system_id == 'ps2' and exe_name.lower() == 'pcsx2-qt.exe':
                alt = ['pcsx2-qtx64.exe', 'pcsx2-qtx64-avx2.exe']
            for exn in [exe_name] + alt:
                wg_path = _winget_portable_glob(pkg_id, exn)
                if not wg_path:
                    continue
                try:
                    if system_id == 'ps3' and Path(wg_path).stem.lower().startswith('rpcs3'):
                        if not _rpcs3_firmware_installed(wg_path):
                            try:
                                if _bios_dl_state.get('running') and 'rpcs3' in str(_bios_dl_state.get('phase') or '').lower():
                                    return False, '', 'PS3_FIRMWARE_INSTALLING', 'Installing PS3 firmware in RPCS3 — try again in a minute'
                            except Exception:
                                pass
                            return False, '', 'PS3_FIRMWARE_MISSING', 'PS3 firmware not installed yet (PS3UPDAT.PUP)'
                    cmd  = _build_cmd(wg_path, rom)
                    proc = subprocess.Popen(cmd, close_fds=True)
                    threading.Thread(target=_track_proc, args=(proc,), daemon=True).start()
                    return True, f'emulator:{Path(wg_path).stem}', None, None
                except Exception:
                    pass

        _WIN_CMD_FALLBACK = {
            'ps2':       ['pcsx2-qt', 'pcsx2-qtx64', 'PCSX2'],
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
                if system_id == 'ps3' and Path(found).stem.lower().startswith('rpcs3'):
                    if not _rpcs3_firmware_installed(found):
                        try:
                            if _bios_dl_state.get('running') and 'rpcs3' in str(_bios_dl_state.get('phase') or '').lower():
                                return False, '', 'PS3_FIRMWARE_INSTALLING', 'Installing PS3 firmware in RPCS3 — try again in a minute'
                        except Exception:
                            pass
                        return False, '', 'PS3_FIRMWARE_MISSING', 'PS3 firmware not installed yet (PS3UPDAT.PUP)'
                cmd  = _build_cmd(found, rom)
                proc = subprocess.Popen(cmd, close_fds=True)
                threading.Thread(target=_track_proc, args=(proc,), daemon=True).start()
                return True, f'emulator:{cmd_name}', None, None
            except Exception:
                continue

    # 2. No emulator found. Let the UI decide whether to install dependencies
    # or fall back to "open folder" based on platform/mode.
    return False, '', 'NO_EMULATOR', f'No emulator found for {system_id} — install required'

_native_session = None
_NATIVE_LOCK = threading.RLock()
_NATIVE_CANCELLED = {}


def start_native_player(body):
    """Launch an app-owned engine, then attach its game surface to Electron."""
    global _native_session, active_proc
    if not IS_APP or platform.system() != 'Windows':
        return {'success': False, 'error': 'NATIVE_UNAVAILABLE', 'message': 'Use the Windows desktop app for this system.'}
    sid = body.get('systemId', '')
    engine = SYSTEM_ENGINES.get(sid)
    if not engine:
        return {'success': False, 'error': 'UNKNOWN_SYSTEM', 'message': 'No native engine is configured for this system.'}
    with _NATIVE_LOCK:
        requested_id = str((body.get('host') or {}).get('sessionId') or '')[:128]
        if requested_id and requested_id in _NATIVE_CANCELLED:
            return {'success': False, 'error': 'CANCELLED', 'message': 'Game launch cancelled.'}
        if _native_session and not _native_session.cancelled.is_set():
            previous = _native_session.proc
            if previous is None or previous.poll() is None:
                return {'success': False, 'error': 'NATIVE_BUSY', 'message': 'Close the current game before starting another.'}
            _native_session.stop()  # Restore temporary PS2 Player 2 bindings before replacing the session.
        try:
            session = NativeSession(body.get('host') or {}, engine)
        except (ValueError, RuntimeError) as error:
            return {'success': False, 'error': 'INVALID_NATIVE_HOST', 'message': str(error)}
        _native_session = session
    try:
        title = body.get('title', '')
        filename = body.get('filename')
        if not isinstance(title, str) or (filename is not None and (not isinstance(filename, str)
                or not filename or any(char in filename for char in ('/', '\\', ':', '\x00')) or filename in ('.', '..'))):
            raise ValueError('Invalid game title or filename')
        if filename:
            folder = SYSTEM_FOLDER.get(sid)
            rom = ROMS_DIR / folder / filename
            if not rom.is_file():
                rom = None
        else:
            found = find_rom(sid, title)
            rom = Path(found) if found else None
        if not rom:
            session.stop()
            return {'success': False, 'error': 'ROM_NOT_FOUND', 'message': 'Add this game to your local library or download it in Kente.'}
        installed = next((os.path.expandvars(path) for path in NATIVE_EMU_WIN.get(sid, [])
                          if Path(os.path.expandvars(path)).is_file()), None)
        exe = provision_runtime(engine, installed)
        if not exe:
            session.stop()
            return {'success': False, 'error': 'NO_EMULATOR', 'engine': engine, 'message': 'This game engine needs to be added to Kente.'}
        configure_engine(engine, exe, embedded=True)
        if body.get('remotePlayer2') is True and engine == 'pcsx2':
            session.remote_pad_config = Path(exe).parent / 'inis/PCSX2.ini'
            session.remote_pad_backup = configure_remote_pcsx2_player2(session.remote_pad_config)
        if sid == 'ps3' and not _rpcs3_firmware_installed(str(exe)):
            session.stop()
            return {'success': False, 'error': 'PS3_FIRMWARE_MISSING', 'engine': engine,
                    'message': 'Install PlayStation 3 firmware in Sources before playing.'}
        if rom.suffix.lower() in ('.zip', '.7z', '.rar'):
            rom = _extract_rom_container(sid, rom)
        if session.cancelled.is_set():
            return {'success': False, 'error': 'CANCELLED', 'message': 'Game launch cancelled.'}
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = 0
        proc = subprocess.Popen([str(exe)] + native_arguments(engine, exe, rom, embedded=True),
                                cwd=str(exe.parent), startupinfo=startup, close_fds=True)
        with _PROC_LOCK:
            active_proc = proc
        session.attach(proc)
        def wait_for_game():
            global active_proc
            proc.wait()
            with _PROC_LOCK:
                if active_proc is proc:
                    active_proc = None
        threading.Thread(target=wait_for_game, daemon=True).start()
        return {'success': True, 'embedded': True, 'engine': engine, 'pid': proc.pid}
    except Exception as error:
        session.error = str(error)
        session.stop()
        message = str(error)
        return {'success': False, 'error': 'PS2_BIOS_MISSING' if message.startswith('PS2_BIOS_MISSING:') else 'NATIVE_START_FAILED',
                'message': message}


# ── Request Handler ───────────────────────────────────────────────────────────

class KenteHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Optional access diagnostics omit query strings, which may contain
        # signed media URLs or provider tokens.
        if os.getenv('KENTE_ACCESS_LOG') == '1':
            safe_path = ''.join(ch for ch in self.path.split('?', 1)[0][:200]
                                if ch.isprintable())
            sys.stderr.write('[http] %s %s %s %s\n' % (
                self.client_address[0], self.command or '-',
                safe_path, args[0] if args else '-'))

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def _stream_rom(self, source, dest_file, content_type, content_length=None):
        """Stream a ROM with bounded memory; publish disk saves only at EOF."""
        global _ROM_STREAM_ACTIVE
        expected = int(content_length) if content_length not in (None, '') else None
        if expected is not None and (expected <= 0 or expected > MAX_ROM_FILE_BYTES):
            raise ValueError('Invalid ROM size')
        output = None
        temp_path = None
        tracked = False
        deadline = time.monotonic() + MAX_ROM_DL_SECS
        try:
            # Keep one chunk back so the client only sees a complete response
            # after the saved file has been closed and atomically promoted.
            pending = source.read(262144)
            if not pending:
                raise ValueError('Empty ROM response')
            if dest_file:
                output = tempfile.NamedTemporaryFile(mode='wb', dir=dest_file.parent,
                                                     prefix='.kente-', suffix='.part', delete=False)
                temp_path = Path(output.name)
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Expose-Headers', 'X-Kente-Saved-Path')
            if expected is not None:
                self.send_header('Content-Length', str(expected))
            if dest_file:
                self.send_header('X-Kente-Saved-Path', str(dest_file))
            self.end_headers()
            self._rom_stream_started = True
            with _ROM_STREAM_LOCK:
                _ROM_STREAM_ACTIVE += 1
            tracked = True

            received = 0
            while pending:
                received += len(pending)
                if received > MAX_ROM_FILE_BYTES or (expected is not None and received > expected):
                    raise ValueError('ROM exceeds expected size')
                if time.monotonic() > deadline:
                    raise TimeoutError('ROM download exceeded time limit')
                if output:
                    output.write(pending)
                chunk = source.read(262144)
                if not chunk:
                    break
                self.wfile.write(pending)
                pending = chunk
            if expected is not None and received != expected:
                raise ValueError(f'Incomplete ROM response ({received}/{expected} bytes)')
            if output:
                output.close()
                temp_path.replace(dest_file)
            self.wfile.write(pending)
        finally:
            if output:
                output.close()
            if temp_path:
                temp_path.unlink(missing_ok=True)
            if tracked:
                with _ROM_STREAM_LOCK:
                    _ROM_STREAM_ACTIVE = max(0, _ROM_STREAM_ACTIVE - 1)

    def serve_static(self, url_path):
        if url_path in ('', '/'):
            url_path = '/index.html'
        # safe_resolve URL-decodes, resolves, and rejects path traversal in
        # one step.  Returns None if the request escapes WEB_DIR.
        fpath = _safe_resolve_helper(WEB_DIR, url_path)
        if fpath is None:
            self.send_response(403); self.end_headers(); return
        # WEB_DIR is the repository in development. Serve only the public web
        # assets, never credentials, source files, ROMs, or repository metadata.
        relative = fpath.relative_to(WEB_DIR.resolve())
        public_files = {'index.html', 'style.css', 'library.js'}
        public_dirs = {'js', 'vendor', 'games', 'boxart', 'Conceptual Artifacts'}
        if (any(part.startswith('.') for part in relative.parts)
                or not relative.parts
                or (relative.as_posix() not in public_files
                    and relative.parts[0] not in public_dirs)):
            self.send_response(403); self.end_headers(); return
        if not fpath.exists() or not fpath.is_file():
            self.send_response(404); self.end_headers(); return
        size = fpath.stat().st_size
        self.send_response(200)
        self.send_header('Content-Type', MIME.get(fpath.suffix.lower(), 'application/octet-stream'))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(size))
        # HTML/JS/CSS must never be served from the browser disk cache: when
        # we ship a frontend JS fix, the renderer has to see it on the next
        # reload, not a stale Chromium-cached copy. Other asset types keep
        # the default heuristic caching for performance.
        if fpath.suffix.lower() in ('.html', '.js', '.css'):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.end_headers()
        with fpath.open('rb') as source:
            shutil.copyfileobj(source, self.wfile, 256 * 1024)

    def _send_file(self, path, content_type):
        """Stream a trusted local asset without buffering the complete file."""
        size = path.stat().st_size
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(size))
        self.end_headers()
        with path.open('rb') as source:
            shutil.copyfileobj(source, self.wfile, 256 * 1024)

    def _serve_ejs(self, subpath):
        """Serve EmulatorJS assets:
        - Community cores (flycast) → served from local EJS_CORES_DIR cache,
          downloading from GitHub releases on first request.
        - Everything else → serve from local EJS_STABLE_DIR cache/mirror when
          present, otherwise transparently proxy to cdn.emulatorjs.org/stable/data/
        CORS header is always added so the browser page can load the JS/WASM.
        """
        # 1) Serve from local stable cache/mirror if present.
        stable_path = _safe_resolve_helper(EJS_STABLE_DIR, '/' + (subpath or ''))
        if stable_path is None:
            self.send_response(403); self.end_headers(); return
        if stable_path.exists() and stable_path.is_file():
            self._send_file(stable_path, MIME.get(stable_path.suffix.lower(), 'application/octet-stream'))
            return

        # 1b) Serve from packaged seed pack (WEB_DIR/cache/ejs-stable) when present.
        # This enables fully-offline play on first launch when the installer bundles
        # an offline EmulatorJS pack.
        try:
            if EJS_SEED_DIR.exists():
                seed_path = _safe_resolve_helper(EJS_SEED_DIR, '/' + (subpath or ''))
                if seed_path is not None and seed_path.exists() and seed_path.is_file():
                    # Best-effort: write-through into user cache so subsequent loads
                    # continue to work even if WEB_DIR is moved/removed.
                    try:
                        EJS_STABLE_DIR.mkdir(parents=True, exist_ok=True)
                        stable_path.parent.mkdir(parents=True, exist_ok=True)
                        tmp = stable_path.with_name(stable_path.name + '.tmp')
                        shutil.copyfile(seed_path, tmp)
                        tmp.replace(stable_path)
                    except Exception:
                        pass
                    self._send_file(seed_path, MIME.get(seed_path.suffix.lower(), 'application/octet-stream'))
                    return
        except Exception:
            pass

        # Community core? (e.g. cores/flycast-wasm.data or flycast-legacy-wasm.data)
        fname = subpath[len('cores/'):] if subpath.startswith('cores/') else None
        if fname and fname in COMMUNITY_CORES:
            cached = EJS_CORES_DIR / fname
            if not cached.exists():
                seed = EJS_SEED_DIR.parent / 'ejs-cores' / fname
                try:
                    EJS_CORES_DIR.mkdir(parents=True, exist_ok=True)
                    if seed.is_file():
                        shutil.copyfile(seed, cached)
                        print(f'[ejs-core] Installed bundled {fname}')
                    else:
                        core_assets = COMMUNITY_CORES[fname]
                        print(f'[ejs-core] Downloading pinned assets for {fname}…')
                        asset_bytes = {}
                        for asset_name, (dl_url, expected_hash) in core_assets.items():
                            req = urllib.request.Request(
                                dl_url, headers={'User-Agent': 'KenteKorner/1.0'})
                            with _safe_urlopen(req, timeout=120) as resp:
                                payload = resp.read()
                            if hashlib.sha256(payload).hexdigest() != expected_hash:
                                raise ValueError(f'{asset_name} checksum mismatch')
                            asset_bytes[asset_name] = payload
                        data_buffer = io.BytesIO()
                        with zipfile.ZipFile(data_buffer, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
                            for asset_name, payload in asset_bytes.items():
                                bundle.writestr(asset_name, payload)
                            bundle.writestr('core.json', json.dumps(_FLYCAST_CORE_METADATA, separators=(',', ':')))
                        data = data_buffer.getvalue()
                        tmp = cached.with_suffix('.tmp')
                        tmp.write_bytes(data)
                        tmp.replace(cached)
                        print(f'[ejs-core] Cached {fname} ({len(data)//1024} KB)')
                except Exception as e:
                    print(f'[ejs-core] Core setup failed: {e}')
                    self.send_response(502); self.end_headers(); return
            self._send_file(cached, 'application/octet-stream')
            return

        # Proxy everything else to the stable CDN
        cdn_url = EJS_CDN_BASE + subpath
        try:
            req = urllib.request.Request(
                cdn_url, headers={'User-Agent': 'KenteKorner/1.0'})
            with _safe_urlopen(req, timeout=60) as resp:
                ct   = resp.headers.get('Content-Type', 'application/octet-stream')
                data = resp.read()
            # Skip write-through for empty/zero-byte responses (defensive).
            if data:
                try:
                    EJS_STABLE_DIR.mkdir(parents=True, exist_ok=True)
                    stable_path.parent.mkdir(parents=True, exist_ok=True)
                    tmp = stable_path.with_name(stable_path.name + '.tmp')
                    tmp.write_bytes(data)
                    tmp.replace(stable_path)
                except Exception as _:
                    pass
            self.send_response(200)
            self.send_header('Content-Type', ct)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except urllib.error.HTTPError as he:
            # Community cores (flycast, dolphin) have no report on the official
            # CDN. Synthesize a stub with a deterministic buildStart so the
            # browser-side IndexedDB core cache is effective (otherwise EJS
            # falls back to Math.random() and re-downloads every launch).
            if he.code == 404 and subpath.startswith('cores/reports/') and subpath.endswith('.json'):
                core_name = subpath[len('cores/reports/'):-len('.json')]
                stub = {
                    'core': core_name,
                    'buildStart': f'{core_name}-community-1',
                    'options': {},
                }
                payload = json.dumps(stub).encode('utf-8')
                try:
                    EJS_STABLE_DIR.mkdir(parents=True, exist_ok=True)
                    stable_path.parent.mkdir(parents=True, exist_ok=True)
                    tmp = stable_path.with_name(stable_path.name + '.tmp')
                    tmp.write_bytes(payload)
                    tmp.replace(stable_path)
                except Exception:
                    pass
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            print(f'[ejs-proxy] {subpath}: HTTP {he.code}')
            self.send_response(he.code if 400 <= he.code < 600 else 502)
            self.end_headers()
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
    _HLS_LINE_RE = re.compile(r'(\bURI=")([^"]+)(")')

    def _serve_theater_proxy(self, target_url):
        if not target_url:
            self.send_json({'error': 'Missing url'}, 400); return
        started = False
        try:
            # parse_qs already decoded the outer query parameter. Another
            # unquote would corrupt escaped paths and signed CDN tokens.
            parsed = urllib.parse.urlparse(target_url)
            if not _public_http_url(target_url):
                self.send_json({'error': 'URL must resolve to a public HTTP(S) address'}, 400); return
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
            req_headers['Referer'] = f'{parsed.scheme}://{parsed.netloc}/'
            rng = self.headers.get('Range')
            if rng: req_headers['Range'] = rng
            req = urllib.request.Request(target_url, headers=req_headers)
            with _safe_urlopen(req, timeout=30) as resp:
                ct   = resp.headers.get('Content-Type', 'application/octet-stream')
                ce   = (resp.headers.get('Content-Encoding') or '').lower()
                # Resolve relative playlist links against the final CDN URL,
                # since a redirect may move the manifest into another folder.
                final_url = resp.geturl()
                data = resp.read(65536)
                status = resp.status
                ar = resp.headers.get('Accept-Ranges')
                cr = resp.headers.get('Content-Range')
                is_m3u8 = (
                    'mpegurl' in ct.lower()
                    or urllib.parse.urlparse(final_url).path.lower().endswith('.m3u8')
                    or data.startswith((b'#EXTM3U', b'\xef\xbb\xbf#EXTM3U'))
                )
                if is_m3u8:
                    # Buffer only playlists, never a complete movie or segment.
                    # Reject oversized manifests instead of exhausting RAM.
                    limit = 8 * 1024 * 1024
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        data += chunk
                        if len(data) > limit:
                            raise ValueError('HLS playlist too large')
                    if ce == 'gzip':
                        import gzip, io
                        with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
                            data = compressed.read(limit + 1)
                    elif ce == 'deflate':
                        import zlib
                        try:
                            data = zlib.decompressobj().decompress(data, limit + 1)
                        except zlib.error:
                            data = zlib.decompressobj(-zlib.MAX_WBITS).decompress(data, limit + 1)
                    elif ce not in ('', 'identity'):
                        raise ValueError('Unsupported HLS content encoding')
                    if len(data) > limit:
                        raise ValueError('HLS playlist too large')
                    text = data.decode('utf-8-sig')
                    if not text.startswith('#EXTM3U'):
                        raise ValueError('Invalid HLS playlist')
                    data = self._rewrite_hls(text, final_url).encode('utf-8')
                    ct, ce = 'application/vnd.apple.mpegurl', ''
                    status, ar, cr = 200, None, None

                self.send_response(status)
                self.send_header('Content-Type', ct)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
                if ar: self.send_header('Accept-Ranges', ar)
                if cr: self.send_header('Content-Range', cr)
                if ce: self.send_header('Content-Encoding', ce)
                length = str(len(data)) if is_m3u8 else resp.headers.get('Content-Length')
                if length is not None: self.send_header('Content-Length', length)
                self.end_headers()
                started = True
                self.wfile.write(data)
                if not is_m3u8:
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
        except urllib.error.HTTPError as e:
            print(f'[theater-proxy] HTTP {e.code} for {target_url[:120]}')
            if not started:
                self.send_response(e.code); self.end_headers()
        except Exception as e:
            print(f'[theater-proxy] {target_url[:120]} -> {e}')
            if not started:
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
        # GET routes can launch OS UI, stop games, clear caches, and save ROMs.
        # Apply the same browser-origin policy as POST before any API action.
        # The public health check remains usable by the file-based kiosk splash.
        if path.startswith('/api/') and path != '/api/ping' and not self._origin_allowed():
            self.send_json({'error': 'Origin not allowed'}, 403)
            return
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
                'romProvidersAvailable': roms is not None,
                'romProviderCount': len(roms.PROVIDERS) if roms is not None else 0,
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
        elif path == '/api/bios/file':
            sid = qs.get('systemId', [''])[0]
            filename = BIOS_FILES.get(sid)
            target = BIOS_DIR / filename if filename else None
            if not target or not target.is_file():
                self.send_json({'error': 'BIOS not present'}, 404)
                return
            data = target.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('X-Kente-Filename', filename)
            self.end_headers()
            self.wfile.write(data)
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
        elif path == '/api/ejs/prefetch/status':
            self.send_json(dict(_ejs_prefetch_state))
        elif path == '/api/system/info':
            self.send_json(system_info())
        elif path == '/api/diagnostics':
            with _DOWNLOAD_LOCK:
                active_downloads = len(_active_downloads)
            with _ROM_STREAM_LOCK:
                active_downloads += _ROM_STREAM_ACTIVE
            semaphore = getattr(self.server, '_worker_slots', None)
            free_slots = getattr(semaphore, '_value', None)
            max_requests = getattr(self.server, 'max_workers', 32)
            diagnostics = {
                'version': __version__,
                'mode': 'electron' if IS_APP else ('batocera' if IS_BATOCERA else 'browser'),
                'server': {'activeRequests': max_requests - free_slots if free_slots is not None else None,
                           'maxRequests': max_requests},
                'downloads': {'active': active_downloads},
                'providers': {
                    'rom': sorted((roms.PROVIDERS if roms else {}).keys()),
                    'theater': sorted((theater.PROVIDERS if theater else {}).keys()),
                },
                'cache': {
                    'flash': _directory_usage(FLASH_CACHE_DIR),
                    'emulatorCores': _directory_usage(EJS_CORES_DIR),
                    'emulatorAssets': _directory_usage(EJS_STABLE_DIR),
                },
            }
            self.send_json(diagnostics)
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
            host    = (parsed.hostname or '').lower()
            # Allowlist centralised in _rom_host_ok() so background downloads
            # and the streaming proxy stay in sync.  Vimm's dlN.vimm.net
            # load-balanced subdomains are matched by regex.
            if not _rom_host_ok(host):
                self.send_json({'error': 'URL host not allowed'}, 403); return

            # Detect "orphan .cue" downloads on archive.org and transparently
            # switch to bundle mode: fetch cue + sibling .bin tracks, pack as
            # a single .zip on the fly, stream that to the client.  Saved
            # filename is rewritten <stem>.zip so EJS auto-extracts the bundle.
            bundle_info = _archive_cue_components(url) if url.lower().endswith('.cue') else None
            if bundle_info and fname and fname.lower().endswith('.cue'):
                fname = Path(fname).stem + '.zip'

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
                # Each response writes to its own temporary file. This also lets
                # a replacement source save while a canceled connection unwinds;
                # sharing a reservation would silently make that retry stream-only.
                if not candidate.exists():
                    dest_file = candidate

            # ── Bundle path: archive.org .cue + sibling .bin → synthetic zip ──
            self._rom_stream_started = False
            if bundle_info:
                ident, cue_name, tracks, cue_text = bundle_info
                print(f'[ROM Proxy/bundle] {ident}: {cue_name} + {len(tracks)} track(s)')
                try:
                    with _build_cue_bundle_zip(ident, cue_name, cue_text, tracks) as spool:
                        spool.seek(0, 2)
                        total = spool.tell()
                        spool.seek(0)
                        self._stream_rom(spool, dest_file, 'application/zip', total)
                except Exception as e:
                    print(f'[ROM Proxy/bundle] failed: {type(e).__name__}: {e}')
                    if self._rom_stream_started:
                        return
                    try:
                        self.send_json({
                            'error': f'cue+bin bundling failed: {type(e).__name__}',
                            'code':  'BUNDLE_FAILED',
                        }, 502)
                    except Exception:
                        pass
                return

            try:
                hdrs = {'User-Agent': 'Mozilla/5.0 (compatible; KenteKorner/1.0)'}
                # Vimm's dl* CDN refuses requests without a vimm.net Referer;
                # inject the right one based on the upstream host.
                _ref = _rom_upstream_referer(host)
                if _ref: hdrs['Referer'] = _ref
                req = urllib.request.Request(url, headers=hdrs)
                with _safe_urlopen(req, timeout=300) as resp:
                    ct = resp.headers.get('Content-Type', 'application/octet-stream')
                    cl = resp.headers.get('Content-Length', '')
                    self._stream_rom(resp, dest_file, ct, cl)

            except urllib.error.HTTPError as e:
                # Forward the upstream status verbatim so the UI can show
                # "DOWNLOAD FAILED (UPSTREAM 503)" instead of a flat 502.
                # Common: archive.org returns 503 when load-balancers throttle,
                # 500 when a CDN node is broken for a specific item.
                print(f'[ROM Proxy] upstream {e.code} for {host}: {e.reason}')
                if self._rom_stream_started:
                    return
                try:
                    self.send_json({
                        'error':         f'Upstream {e.code} {e.reason}',
                        'upstreamStatus': e.code,
                        'upstreamHost':   host,
                        'code':           'UPSTREAM_HTTP_ERROR',
                    }, 502)
                except Exception:
                    pass
            except urllib.error.URLError as e:
                # DNS / connection refused / TLS handshake — distinct signal
                # from "upstream returned an HTTP error".
                print(f'[ROM Proxy] network error for {host}: {e}')
                if self._rom_stream_started:
                    return
                try:
                    self.send_json({
                        'error':       f'Network error reaching {host}',
                        'upstreamHost': host,
                        'code':         'UPSTREAM_NETWORK_ERROR',
                    }, 502)
                except Exception:
                    pass
            except Exception as e:
                print(f'[ROM Proxy] {type(e).__name__}: {e}')
                # An interrupted body must end at EOF. A second HTTP response
                # here would be appended to the ROM and corrupt the download.
                if self._rom_stream_started:
                    return
                try:
                    self.send_json({
                        'error': f'ROM proxy failed: {type(e).__name__}',
                        'code':  'PROXY_INTERNAL_ERROR',
                    }, 502)
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
                with _safe_urlopen(req, timeout=20) as resp:
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
        elif path == '/api/rom/resolve':
            sid = qs.get('systemId', [''])[0]
            title = qs.get('title', [''])[0]
            filename = qs.get('filename', [''])[0]
            if sid not in SYSTEM_FOLDER or not title:
                self.send_json({'error': 'Invalid systemId or title'}, 400); return
            found = None
            if filename and Path(filename).name == filename and filename not in ('.', '..') \
                    and not any(c in filename for c in ('/', '\\', ':', '\x00')):
                # A completed Download Center item should reopen the exact ROM
                # it saved, even when another region/revision also matches the
                # same catalog title. Search both supported library layouts.
                for folder in dict.fromkeys((SYSTEM_FOLDER[sid], sid)):
                    candidate = (ROMS_DIR / folder / filename).resolve()
                    try:
                        candidate.relative_to((ROMS_DIR / folder).resolve())
                    except ValueError:
                        continue
                    if candidate.is_file() and candidate.stat().st_size > 64:
                        found = str(candidate)
                        break
            if not found:
                found = find_rom(sid, title)
            if not found:
                self.send_json({'found': False}); return
            target = Path(found)
            params = urllib.parse.urlencode({'systemId': sid, 'filename': target.name,
                                              'folder': target.parent.name})
            self.send_json({'found': True, 'filename': target.name,
                            'sizeBytes': target.stat().st_size, 'url': '/api/rom/file?' + params})
        elif path == '/api/rom/file':
            sid = qs.get('systemId', [''])[0]
            fname = qs.get('filename', [''])[0]
            folder = qs.get('folder', [SYSTEM_FOLDER.get(sid, '')])[0]
            if (sid not in SYSTEM_FOLDER or folder not in (sid, SYSTEM_FOLDER[sid])
                    or not fname or fname in ('.', '..')
                    or any(c in fname for c in ('/', '\\', ':', '\x00'))):
                self.send_json({'error': 'Invalid ROM path'}, 400); return
            base = (ROMS_DIR / folder).resolve()
            target = (base / fname).resolve()
            try:
                target.relative_to(base)
            except ValueError:
                self.send_json({'error': 'ROM outside system folder'}, 403); return
            if not target.is_file():
                self.send_json({'error': 'ROM not found'}, 404); return
            self._rom_stream_started = False
            try:
                with target.open('rb') as source:
                    self._stream_rom(source, None, 'application/octet-stream', target.stat().st_size)
            except (OSError, ValueError) as error:
                if not self._rom_stream_started:
                    self.send_json({'error': str(error)}, 500)
        # ─────────────────────────────────────────────────────────────────────

        elif path == '/api/native/status':
            self.send_json(_native_session.status() if _native_session else
                           {'running': False, 'embedded': False, 'pid': None})

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
        # /api/ejs/extract-core?name=<corename>.data  fallback for the upstream
        # browser 7z worker — returns extracted file contents as JSON+base64
        # so js/ejs_patches.js can synthesize the decompression result when the worker
        # silently emits zero files.
        elif path == '/api/ejs/extract-core':
            import base64 as _b64
            name = qs.get('name', [''])[0]
            files = _ejs_get_extracted_core(name)
            if files is None:
                self.send_json({'success': False, 'error': 'Core not found or extraction failed',
                                'name': name}, 404)
            else:
                payload = {'success': True, 'name': name,
                           'files': [{'name': k, 'data': _b64.b64encode(v).decode('ascii')}
                                     for k, v in files.items()]}
                self.send_json(payload)
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
            _EMBED_PROVIDERS = ('vidsrc', '2embed', 'vidsrcpm', 'multiembed',
                                'vidsrcnet', 'embedsu', 'vidlink', 'autoembed',
                                '2embedstream')
            def _ep_token(raw, prov):
                if not raw: return None
                if prov in _EMBED_PROVIDERS or prov == 'youtube':
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
                    if provider in _EMBED_PROVIDERS or provider == 'youtube':
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
                    if provider in _EMBED_PROVIDERS:
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

            # Packaged builds ship a small starter set of boxart under WEB_DIR/boxart.
            # Use it as a read-only fallback when nothing is cached yet in _BOXART_DIR.
            if not served_path:
                try:
                    web_art_dir = (WEB_DIR / 'boxart')
                    for ext in ('jpg', 'png', 'webp', 'jpeg'):
                        p = web_art_dir / f'{gid}.{ext}'
                        if p.exists():
                            served_path = str(p)
                            break
                except Exception:
                    pass

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
        origin = self.headers.get('Origin', '')
        if origin:
            return _origin_allowed_helper(origin)
        # Images and top-level navigations can omit Origin. Fetch Metadata
        # still identifies attempts from an unrelated website on modern browsers.
        return self.headers.get('Sec-Fetch-Site', '').lower() != 'cross-site'

    def do_POST(self):
        global active_proc
        if not self._origin_allowed():
            self.send_json({'error': 'Origin not allowed'}, 403)
            return
        path   = self.path.split('?')[0]
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length < 0:
                raise ValueError('Negative Content-Length')
        except ValueError:
            self.send_json({'error': 'Invalid Content-Length'}, 400)
            return
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
        if not isinstance(body, dict):
            self.send_json({'error': 'JSON body must be an object'}, 400)
            return

        if path == '/api/rom/prepare':
            sid = body.get('systemId')
            filename = body.get('filename')
            folder = SYSTEM_FOLDER.get(sid) if isinstance(sid, str) else None
            if (not folder or not isinstance(filename, str) or not filename
                    or filename in ('.', '..')
                    or any(char in filename for char in ('/', '\\', ':', '\x00'))):
                self.send_json({'success': False, 'error': 'Invalid systemId or filename'}, 400)
                return
            rom = None
            for candidate_folder in dict.fromkeys((folder, sid)):
                base = (ROMS_DIR / candidate_folder).resolve()
                candidate = (base / filename).resolve()
                try:
                    candidate.relative_to(base)
                except ValueError:
                    continue
                if candidate.is_file() and candidate.stat().st_size > 64:
                    rom = candidate
                    break
            if rom is None:
                self.send_json({'success': False, 'error': 'ROM_NOT_FOUND'}, 404)
                return
            try:
                if rom.suffix.lower() in ('.zip', '.7z', '.rar'):
                    rom = _extract_rom_container(sid, rom)
                if not rom.is_file() or rom.stat().st_size <= 64:
                    raise RuntimeError('The prepared game image is missing or empty')
                self.send_json({'success': True, 'path': str(rom), 'filename': rom.name,
                                'sizeBytes': rom.stat().st_size})
            except Exception as error:
                self.send_json({'success': False, 'error': 'ROM_PREPARE_FAILED',
                                'message': str(error)[:500]}, 422)
            return

        if path == '/api/emulators/install':
            # Install missing OS-level emulator dependencies in the background.
            # Idempotent — safe to call repeatedly; already-installed ones are skipped.
            if _emu_install_state.get('running'):
                self.send_json({'started': False, 'reason': 'already_running',
                                'state': dict(_emu_install_state)})
                return
            # Optional: restrict install to a single system/emulator.
            system_id = (body.get('systemId') or body.get('system_id') or '').strip()
            only_keys = None
            requested = body.get('only')
            if requested is not None:
                if not isinstance(requested, list) or not requested or any(key not in EMULATOR_DEPS for key in requested):
                    self.send_json({'error': 'Unknown game engine'}, 400)
                    return
                only_keys = list(dict.fromkeys(requested))
            elif system_id:
                only_keys = [k for k, dep in EMULATOR_DEPS.items()
                             if system_id in (dep.get('systems') or [])]
                if not only_keys:
                    self.send_json({'started': False, 'reason': 'unknown_system',
                                    'message': f'No emulator dependency is registered for systemId={system_id}'}, 400)
                    return
            import threading as _th
            t = _th.Thread(target=_emulator_install_thread, args=(only_keys,), daemon=True)
            t.start()
            self.send_json({'started': True,
                            'message': 'Emulator install started — poll /api/emulators/install/status'})
            return

        elif path == '/api/ejs/prefetch':
            # Download EmulatorJS stable assets and cores into the user cache so
            # browser-mode emulation works offline after the first run.
            if _ejs_prefetch_state.get('running'):
                self.send_json({'started': False, 'reason': 'already_running',
                                'state': dict(_ejs_prefetch_state)})
                return
            cores = body.get('cores')
            if cores and isinstance(cores, list):
                cores = [str(c).strip() for c in cores if str(c).strip()]
            else:
                cores = None
            import threading as _th
            t = _th.Thread(target=_ejs_prefetch_thread, args=(cores,), daemon=True)
            t.start()
            self.send_json({'started': True,
                            'message': 'EJS prefetch started — poll /api/ejs/prefetch/status'})
            return

        elif path == '/api/bios/import':
            sid = body.get('systemId')
            filename = BIOS_FILES.get(sid) if isinstance(sid, str) else None
            if not filename:
                self.send_json({'success': False, 'error': 'Unknown BIOS system'}, 400)
                return
            try:
                import base64
                encoded = body.get('data')
                if not isinstance(encoded, str):
                    raise ValueError('Invalid BIOS contents')
                data = base64.b64decode(encoded, validate=True)
                if not data or len(data) > 6 * 1024 * 1024:
                    raise ValueError('Invalid BIOS size')
                BIOS_DIR.mkdir(parents=True, exist_ok=True)
                target = BIOS_DIR / filename
                temp = target.with_suffix(target.suffix + '.importing')
                temp.write_bytes(data)
                temp.replace(target)
                self.send_json({'success': True, 'filename': filename, 'sizeBytes': len(data)})
            except (ValueError, TypeError) as error:
                self.send_json({'success': False, 'error': str(error)}, 400)

        elif path == '/api/bios/download':
            # Start the BIOS background verifier/configurer (idempotent — ignored if already running)
            if _bios_dl_state.get('running'):
                self.send_json({'started': False, 'reason': 'already_running',
                                'state': dict(_bios_dl_state)})
                return
            allow_download = bool(body.get('allowDownload') or body.get('allow_download') or False)
            import threading as _th
            t = _th.Thread(target=_bios_download_thread, args=(allow_download,), daemon=True)
            t.start()
            self.send_json({'started': True,
                            'message': 'BIOS check started — poll /api/bios/download/status'})
            return

        elif path == '/api/settings':
            # Write Kente UI settings to a sidecar file next to batocera.conf
            # and mirror Batocera-relevant keys to batocera.conf
            try:
                boolean_keys = {'crtScanlines', 'vignette', 'fullScreen', 'uiSounds',
                                'ambientHum', 'cameraVR', 'wiiPointer', 'theaterAdShield'}
                allowed = boolean_keys | {'roomTheme', 'volume', 'theaterSandbox'}
                if set(body) - allowed:
                    self.send_json({'success': False, 'error': 'Unknown settings key'}, 400)
                    return
                if any(not isinstance(body.get(key), bool) for key in boolean_keys if key in body):
                    self.send_json({'success': False, 'error': 'Boolean setting has invalid value'}, 400)
                    return
                if 'roomTheme' in body and body['roomTheme'] not in {
                        'DEFAULT', 'NEON', 'MIDNIGHT', 'CRIMSON', 'MATRIX', 'VAPOR', 'AMBER', 'ICE', 'COPPER'}:
                    self.send_json({'success': False, 'error': 'Invalid room theme'}, 400)
                    return
                if 'theaterSandbox' in body and body['theaterSandbox'] not in {'OFF', 'PERMISSIVE', 'STRICT', 'ULTRA'}:
                    self.send_json({'success': False, 'error': 'Invalid theater sandbox mode'}, 400)
                    return
                if 'volume' in body and (isinstance(body['volume'], bool)
                        or not isinstance(body['volume'], (int, float))
                        or not 0 <= body['volume'] <= 100):
                    self.send_json({'success': False, 'error': 'Invalid volume'}, 400)
                    return
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
                parsed_host = (urllib.parse.urlparse(url).hostname or '').lower()
            except Exception:
                parsed_host = ''
            # Mirrors the /api/rom-proxy allowlist so registered providers can
            # save through the background download path as well.
            if not _rom_host_ok(parsed_host):
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

        elif path == '/api/native/import':
            if not IS_APP:
                self.send_json({'success': False, 'error': 'Use the desktop app'}, 400)
                return
            try:
                exe = import_runtime(body.get('engine'), body.get('source', ''))
                self.send_json({'success': True, 'engine': body.get('engine')})
            except (ValueError, TypeError, OSError) as error:
                self.send_json({'success': False, 'error': str(error)}, 400)

        elif path == '/api/native/start':
            self.send_json(start_native_player(body))

        elif path == '/api/native/control':
            action = body.get('action')
            session = _native_session
            try:
                session_id = body.get('sessionId')
                if action == 'stop' and isinstance(session_id, str) and session_id:
                    with _NATIVE_LOCK:
                        _NATIVE_CANCELLED[session_id[:128]] = True
                        while len(_NATIVE_CANCELLED) > 128:
                            _NATIVE_CANCELLED.pop(next(iter(_NATIVE_CANCELLED)))
                if session_id and session and session_id != session.session_id:
                    self.send_json({'success': True})
                    return
                if action == 'stop':
                    if session:
                        session.stop()
                    # Also stop games launched through the legacy emulator
                    # route, which are tracked separately from NativeSession.
                    with _PROC_LOCK:
                        proc = active_proc
                        if proc is not None and proc.poll() is None:
                            if platform.system() == 'Windows':
                                try:
                                    subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                                                   capture_output=True, timeout=8, check=False,
                                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                                except (OSError, subprocess.TimeoutExpired):
                                    proc.kill()
                            else:
                                proc.terminate()
                            try:
                                proc.wait(timeout=3)
                            except subprocess.TimeoutExpired:
                                proc.kill()
                                proc.wait(timeout=2)
                        active_proc = None
                elif action == 'resize' and session:
                    session.update_rect(body.get('rect'))
                elif action in ('menu', 'resume') and session:
                    session.menu(action == 'menu')
                else:
                    self.send_json({'success': False, 'error': 'Invalid native player action'}, 400)
                    return
                self.send_json({'success': True})
            except (ValueError, RuntimeError) as error:
                self.send_json({'success': False, 'error': str(error)}, 400)

        elif path == '/api/native/remote-key':
            session = _native_session
            try:
                if not session or body.get('sessionId') != session.session_id:
                    self.send_json({'success': False, 'error': 'No matching game session'}, 409); return
                session.remote_key(body.get('key'), body.get('down'))
                self.send_json({'success': True})
            except (ValueError, RuntimeError) as error:
                self.send_json({'success': False, 'error': str(error)}, 400)

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
            ok, msg, err = launch_game(sid, rom_path)
            out = {'success': ok, 'message': msg}
            if not ok and err:
                out['error'] = err
            self.send_json(out)

        elif path == '/api/launch-rom':
            # Open a downloaded ROM with a locally-installed emulator (non-Batocera host).
            # Tries known emulator paths → OS file association → folder open.
            sid      = body.get('systemId', '')
            filename = body.get('filename', '')
            if (not isinstance(sid, str) or not isinstance(filename, str)
                    or not sid or not filename):
                self.send_json({'success': False, 'error': 'Missing systemId or filename'}, 400)
                return
            folder = SYSTEM_FOLDER.get(sid)
            if (not folder or filename in ('.', '..')
                    or any(char in filename for char in ('/', '\\', ':', '\x00'))):
                self.send_json({'success': False, 'error': 'Invalid systemId or filename'}, 400)
                return
            rom_dir = (ROMS_DIR / folder).resolve()
            target = (rom_dir / filename).resolve()
            try:
                target.relative_to(rom_dir)
            except ValueError:
                self.send_json({'success': False, 'error': 'ROM outside system folder'}, 403)
                return
            rom_path = str(target)
            ok, method, err_code, err_msg = find_and_launch_rom(sid, rom_path)
            self.send_json({'success': ok, 'method': method, 'error': err_code, 'message': err_msg})

        else:
            self.send_json({'error': 'Not found'}, 404)

# ── Entry Point ───────────────────────────────────────────────────────────────

class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """Cap concurrent request threads; excess clients queue in the OS backlog."""
    request_queue_size = 64
    daemon_threads = True

    def __init__(self, *args, max_workers=32, **kwargs):
        super().__init__(*args, **kwargs)
        self.max_workers = max_workers
        self._worker_slots = threading.BoundedSemaphore(max_workers)

    def process_request(self, request, client_address):
        if not self._worker_slots.acquire(blocking=False):
            try:
                request.sendall(b'HTTP/1.1 503 Service Unavailable\r\n'
                                b'Connection: close\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._worker_slots.release()
            self.shutdown_request(request)
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._worker_slots.release()


if __name__ == '__main__':
    print(f'[Kente Server] Starting on port {PORT}...')
    if IS_APP and platform.system() == 'Windows':
        try:
            relay = start_lobby_relay()
            print(f"[Kente Lobby] LAN relay listening on port {relay['port']}")
        except OSError as error:
            print(f'[Kente Lobby] Multiplayer unavailable: {error}')
    # ThreadingHTTPServer handles each request in its own thread so long-running
    # ROM-proxy streaming downloads do not block API calls (ping, settings, etc.).
    server = BoundedThreadingHTTPServer(('127.0.0.1', PORT), KenteHandler)
    if hasattr(signal, 'SIGTERM'):
        def _handle_terminate(_signum, _frame):
            raise KeyboardInterrupt()
        signal.signal(signal.SIGTERM, _handle_terminate)
    print(f'[Kente Server] Ready at http://localhost:{PORT}')
    if IS_BATOCERA and os.getenv('KENTE_FORCE_NATIVE'):
        print('[Kente Server] KENTE_FORCE_NATIVE=1 — running in forced native mode')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('[Kente Server] Stopped.')
    finally:
        server.server_close()
