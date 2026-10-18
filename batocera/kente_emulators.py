"""Kente's Korner — BIOS manager and emulator dependency installer."""
import os, platform, re, shutil, subprocess
from pathlib import Path
import urllib.request, urllib.parse, urllib.error
from kente_config import BIOS_DIR, BIOS_FILES, NATIVE_EMU_WIN

# ── BIOS manager ──────────────────────────────────────────────────────────────
# Kente does not distribute BIOS/firmware images. Users must provide their own
# legally obtained BIOS files in BIOS_DIR.
#
# This helper thread only:
#   1) verifies which expected BIOS files are present
#   2) copies/configures PS2 BIOS into PCSX2's own bios folder(s) so the native
#      emulator can find it automatically.

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
    """Copy PS2 BIOS files into PCSX2's BIOS folder(s) and update PCSX2.ini.

    We support both:
      - Default config path:  %USERPROFILE%\\Documents\\PCSX2\\...
      - Portable installs:    <PCSX2 root>\\bios + <PCSX2 root>\\inis\\PCSX2.ini
    """
    import os as _os
    user = Path(_os.environ.get('USERPROFILE', _os.path.expanduser('~')))
    default_root = user / 'Documents' / 'PCSX2'

    # Pick a PS2 BIOS bin from BIOS_DIR. Filenames vary by region/model, so we
    # accept any plausible .bin (> 1 MB) and optionally copy sidecars matching
    # the same stem (.mec/.nvm/.rom1/.rom2/.erom).
    chosen_bin = None
    bundle = []
    try:
        candidates = []
        for p in bios_dir.iterdir():
            if not p.is_file() or p.suffix.lower() != '.bin':
                continue
            try:
                sz = p.stat().st_size
            except OSError:
                continue
            if sz >= 1_000_000:
                candidates.append((p, sz))
        if candidates:
            def _norm_name(s: str):
                return s.lower().replace('-', '').replace('_', '').replace(' ', '')
            preferred = None
            for p, _sz in candidates:
                if '39001' in _norm_name(p.name):  # common NTSC-U dump
                    preferred = p
                    break
            chosen_bin = preferred or max(candidates, key=lambda t: t[1])[0]
            bundle = [chosen_bin]
            side_exts = {'.mec', '.nvm', '.rom1', '.rom2', '.erom'}
            chosen_stem = chosen_bin.stem.lower()
            for p in bios_dir.iterdir():
                if not p.is_file() or p == chosen_bin:
                    continue
                if p.suffix.lower() in side_exts and p.stem.lower() == chosen_stem:
                    bundle.append(p)
    except Exception:
        chosen_bin = None
        bundle = []
    copied = []
    roots = [default_root]

    # Portable root candidates (Windows): prefer LOCALAPPDATA installs.
    localapp = Path(_os.environ.get('LOCALAPPDATA', '')) if platform.system() == 'Windows' else Path('')
    try:
        p_root   = localapp / 'Programs' / 'PCSX2'
        if p_root.exists():
            roots.append(p_root)
    except Exception:
        pass
    try:
        for candidate in NATIVE_EMU_WIN.get('ps2', []):
            ep = Path(_os.path.expandvars(candidate))
            if ep.exists():
                parent = ep.parent
                # Only treat user-writable installs as "portable roots"
                if str(parent).lower().startswith(str(user).lower()) or str(parent).lower().startswith(str(localapp).lower()):
                    if parent not in roots:
                        roots.append(parent)
    except Exception:
        pass

    def _copy_into(root: Path):
        bios_dst = root / 'bios'
        bios_dst.mkdir(parents=True, exist_ok=True)
        if not bundle:
            return
        import shutil as _sh
        for src in bundle:
            try:
                dst = bios_dst / src.name
                if src.exists() and not dst.exists():
                    _sh.copy2(str(src), str(dst))
                    copied.append(src.name)
                    print(f'[bios] copied {src.name} -> {dst}')
            except Exception:
                continue

    def _update_ini(ini_path: Path):
        # Update PCSX2.ini: set  BIOS = <chosen bin filename>  (only under [Filenames] section)
        # We do a line-by-line walk so we never accidentally touch the [Folders] Bios key.
        if not chosen_bin:
            return
        if not ini_path.exists():
            return
        try:
            lines = ini_path.read_text(encoding='utf-8', errors='replace').splitlines(keepends=True)
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
                        lines[i] = f'BIOS = {chosen_bin.name}{eol}'
                        changed = True
                        break
            if changed:
                ini_path.write_text(''.join(lines), encoding='utf-8')
                print(f'[bios] {ini_path} updated: BIOS = {chosen_bin.name}')
        except Exception as ex:
            print(f'[bios] PCSX2.ini update failed ({ini_path}): {ex}')

    for root in roots:
        _copy_into(root)
        _update_ini(root / 'inis' / 'PCSX2.ini')

    return copied

def _bios_download_thread(allow_download: bool = False):
    global _bios_dl_state
    _bios_dl_state.update({
        'running': True,
        'done':    False,
        'error':   None,
        'phase':   'checking',
        'results': {},
        'downloaded_mb': 0,
        'total_mb':      0,
    })
    BIOS_DIR.mkdir(parents=True, exist_ok=True)
    results = {}

    try:
        # ── Phase 1: verify expected BIOS presence ───────────────────────────
        for sid, fname in BIOS_FILES.items():
            try:
                if sid == 'ps2':
                    # PS2 BIOS dumps vary by filename; accept any plausible .bin (>1MB).
                    present = False
                    for p in BIOS_DIR.iterdir():
                        if not p.is_file() or p.suffix.lower() != '.bin':
                            continue
                        try:
                            if p.stat().st_size >= 1_000_000:
                                present = True
                                break
                        except OSError:
                            continue
                else:
                    present = (BIOS_DIR / fname).exists()
            except Exception:
                present = False
            results[fname] = 'present' if present else 'missing'

        # ── Phase 2: configure PCSX2 with its BIOS (if present) ──────────────
        _bios_dl_state['phase'] = 'configuring pcsx2'
        copied = _bios_configure_pcsx2(BIOS_DIR)
        if copied:
            results['pcsx2_setup'] = f'copied {copied}, ini updated'
        else:
            results['pcsx2_setup'] = 'already configured'

        # ── Phase 3: install PS3 firmware into RPCS3 ───────────────────────
        _bios_dl_state['phase'] = 'configuring rpcs3 firmware'
        try:
            installed, rpcs3_path = _check_emu_installed('rpcs3')
            if installed and rpcs3_path:
                # Install firmware if present; optionally download official firmware when allowed.
                results['rpcs3_firmware'] = _ensure_ps3_firmware(rpcs3_path, BIOS_DIR, allow_download=allow_download)
            else:
                results['rpcs3_firmware'] = {'ok': False, 'reason': 'rpcs3_not_found'}
        except Exception as _ex:
            results['rpcs3_firmware'] = {'ok': False, 'reason': 'exception', 'detail': str(_ex)[:200]}

        # Surface PS3 firmware failure at top-level so the UI can show a helpful message.
        try:
            fw = results.get('rpcs3_firmware') if isinstance(results, dict) else None
            if isinstance(fw, dict) and not fw.get('ok'):
                reason = fw.get('reason') or 'failed'
                _bios_dl_state['error'] = f'rpcs3_firmware:{reason}'
        except Exception:
            pass

        _bios_dl_state.update({'running': False, 'done': True, 'phase': 'done',
                                'results': results})
        print(f'[bios] all done: {results}')

    except Exception as ex:
        _bios_dl_state.update({'running': False, 'done': False,
                                'error': str(ex), 'phase': 'error'})
        print(f'[bios] download failed: {ex}')
    finally:
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
    'pcsx2': {
        'name':       'PCSX2 (PlayStation 2)',
        'systems':    ['ps2'],
        # WinGet is preferred when available, but we also support a direct download
        # fallback because WinGet is not always present on kiosk-style Windows setups.
        'winget_id':  'PCSX2Team.PCSX2',
        'win_exe':    Path(_LOCALAPP) / 'Programs' / 'PCSX2' / 'pcsx2-qt.exe',
        'win_dest':   Path(_LOCALAPP) / 'Programs' / 'PCSX2',
        # Portable .7z build (no admin rights). Extracted via bsdtar (tar.exe) on Windows.
        'win_dl':     {'kind': 'github_release', 'repo': 'PCSX2/pcsx2',
                       'asset_re': r'windows.*x64.*Qt.*\.7z$'},
        'lin_appimg': {'kind': 'github_release', 'repo': 'PCSX2/pcsx2',
                       'asset_re': r'linux.*appimage.*x64.*Qt.*\.AppImage$'},
    },
    'rpcs3': {
        'name':       'RPCS3 (PlayStation 3)',
        'systems':    ['ps3'],
        'winget_id':  'RPCS3.RPCS3',
        'win_exe':    Path(_LOCALAPP) / 'Programs' / 'RPCS3' / 'rpcs3.exe',
        'win_dest':   Path(_LOCALAPP) / 'Programs' / 'RPCS3',
        # WinGet preferred; fallback downloads the latest official Windows .7z build
        # from GitHub and extracts it using Windows' bundled bsdtar (tar.exe).
        'win_dl':     {'kind': 'github_release', 'repo': 'RPCS3/rpcs3-binaries-win',
                       'asset_re': r'win64.*\.7z$'},
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

WINDOWS_RUNTIME_DEPS = [
    {
        'key':  'vcredist_x64',
        'name': 'Microsoft Visual C++ 2015-2022 Redistributable (x64)',
        'url':  'https://aka.ms/vs/17/release/vc_redist.x64.exe',
        'args': ['/install', '/quiet', '/norestart'],
        'check': lambda: Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'vcruntime140.dll',
    },
]

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

def _github_latest_release_asset(repo_full_name, asset_re, headers):
    """Return (download_url, asset_name) for the first asset matching asset_re.

    Uses the public GitHub REST API. No auth is required, but requests may be
    rate-limited. asset_re is a compiled regex or pattern string.
    """
    import re as _re, urllib.request as _ur, json as _json
    pat = _re.compile(asset_re, _re.IGNORECASE) if isinstance(asset_re, str) else asset_re
    api = f'https://api.github.com/repos/{repo_full_name}/releases/latest'
    req = _ur.Request(api, headers={**headers, 'Accept': 'application/vnd.github+json'})
    with _ur.urlopen(req, timeout=30) as resp:
        data = _json.loads(resp.read().decode('utf-8', errors='replace'))
    for asset in (data.get('assets') or []):
        name = asset.get('name') or ''
        url  = asset.get('browser_download_url') or ''
        if url and pat.search(name):
            return url, name
    raise RuntimeError(f'No release asset matched {asset_re!r} in {repo_full_name}')

def _download_to_file(url, dest_path, headers, timeout=300):
    """Stream-download url to dest_path atomically (stage .tmp then rename)."""
    import urllib.request as _ur
    dest_path = Path(dest_path)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest_path.with_suffix(dest_path.suffix + '.tmp')
    req = _ur.Request(url, headers=headers)
    with _ur.urlopen(req, timeout=timeout) as resp:
        with open(tmp, 'wb') as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
    tmp.replace(dest_path)
    return dest_path

def _extract_archive_to(archive_path, dest_dir):
    """Extract .zip/.7z archives into dest_dir.

    For .7z on Windows, we use the bundled bsdtar (tar.exe). bsdtar applies
    path traversal and symlink safety checks by default unless -P is provided.
    """
    archive_path = Path(archive_path)
    dest_dir     = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    ext = archive_path.suffix.lower()
    if ext == '.zip':
        import zipfile as _zf
        with _zf.ZipFile(str(archive_path)) as zf:
            zf.extractall(str(dest_dir))
        return
    if ext == '.7z':
        tar = shutil.which('tar')
        if not tar:
            raise RuntimeError('tar not available for .7z extraction (install 7-Zip or enable Windows tar.exe)')
        r = subprocess.run([tar, '-xf', str(archive_path), '-C', str(dest_dir)],
                           capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise RuntimeError((r.stdout + r.stderr).strip()[:500] or f'tar exit {r.returncode}')
        return
    raise RuntimeError(f'Unsupported archive type: {archive_path.name}')

def _flatten_single_subdir(dest_dir):
    """If dest_dir contains exactly one subdirectory and no files, move it up one level."""
    dest_dir = Path(dest_dir)
    try:
        entries = [p for p in dest_dir.iterdir() if p.name not in ('.', '..')]
    except Exception:
        return
    subdirs = [p for p in entries if p.is_dir()]
    files   = [p for p in entries if p.is_file()]
    if len(subdirs) == 1 and not files:
        inner = subdirs[0]
        import shutil as _sh2
        for p in inner.iterdir():
            _sh2.move(str(p), str(dest_dir / p.name))
        try:
            inner.rmdir()
        except OSError:
            pass

def _rpcs3_firmware_installed(rpcs3_exe_path: str | None):
    """Return True if RPCS3 appears to have PS3 firmware installed."""
    if not rpcs3_exe_path:
        return False
    try:
        root = Path(rpcs3_exe_path).parent
        # Firmware install populates dev_flash with vsh modules.
        sentinel = root / 'dev_flash' / 'vsh' / 'module' / 'vsh.self'
        return sentinel.exists()
    except Exception:
        return False

def _ps3_firmware_url():
    """Fetch the official PS3 firmware URL from PlayStation support page."""
    import urllib.request as _ur
    page = 'https://www.playstation.com/en-us/support/hardware/ps3/system-software/'
    req = _ur.Request(page, headers={'User-Agent': 'Mozilla/5.0 KenteOS/1.0'})
    with _ur.urlopen(req, timeout=30) as resp:
        html = resp.read().decode('utf-8', errors='replace')
    # The page includes a direct link to <region>.ps3.update.playstation.net/.../PS3UPDAT.PUP
    # Region varies (dus01, deu01, dsa01, ...), so match any "d??01" host.
    m = re.search(r'https://d[a-z]{2}01\.ps3\.update\.playstation\.net/[^\s"<>]+/PS3UPDAT\.PUP', html, re.IGNORECASE)
    if not m:
        raise RuntimeError('Could not find PS3UPDAT.PUP link on PlayStation page')
    return m.group(0)

def _ensure_ps3_firmware(rpcs3_exe_path: str | None, bios_dir: Path, allow_download: bool = True):
    """Ensure PS3 firmware is present and installed in RPCS3 (best-effort)."""
    if not rpcs3_exe_path:
        return {'ok': False, 'reason': 'rpcs3_not_found'}
    try:
        if _rpcs3_firmware_installed(rpcs3_exe_path):
            return {'ok': True, 'status': 'already_installed'}

        bios_dir = Path(bios_dir)
        bios_dir.mkdir(parents=True, exist_ok=True)

        # Prefer user-provided firmware if present.
        pup = bios_dir / 'PS3UPDAT.PUP'
        if not pup.exists():
            pup2 = bios_dir / 'ps3' / 'PS3UPDAT.PUP'
            if pup2.exists():
                pup = pup2

        # Otherwise, download the official firmware into BIOS_DIR (one-time).
        if not pup.exists():
            if not allow_download:
                return {'ok': False, 'reason': 'pup_missing'}
            try:
                url = _ps3_firmware_url()
            except Exception as e:
                return {'ok': False, 'reason': 'firmware_url_failed', 'detail': str(e)[:500]}
            try:
                pup = bios_dir / 'PS3UPDAT.PUP'
                _download_to_file(url, pup, headers={'User-Agent': 'Mozilla/5.0 KenteOS/1.0'}, timeout=600)
            except Exception as e:
                return {'ok': False, 'reason': 'download_failed', 'detail': str(e)[:500]}

        # Install into RPCS3. This may take a while.
        r = subprocess.run([rpcs3_exe_path, '--installfw', str(pup)],
                           capture_output=True, text=True, timeout=1800)
        if r.returncode != 0:
            return {'ok': False, 'reason': 'install_failed',
                    'detail': (r.stdout + r.stderr).strip()[:500] or f'exit {r.returncode}'}
        return {'ok': True, 'status': 'installed'}
    except Exception as e:
        return {'ok': False, 'reason': 'exception', 'detail': str(e)[:500]}

def _emulator_install_thread(only_keys=None):
    import zipfile as _zf, urllib.request as _ur, io as _io
    global _emu_install_state
    _emu_install_state.update({'running': True, 'done': False,
                               'error': None, 'current': '', 'results': {}})
    results  = {}
    is_win   = platform.system() == 'Windows'
    headers  = {'User-Agent': 'Mozilla/5.0 KenteOS/1.0'}
    keys     = list(only_keys) if only_keys else list(EMULATOR_DEPS.keys())
    targeted = only_keys is not None

    # ── Windows runtime dependencies (best-effort) ─────────────────────────
    if is_win:
        for dep in WINDOWS_RUNTIME_DEPS:
            try:
                _emu_install_state['current'] = dep['name']
                check_path = dep['check']() if callable(dep.get('check')) else None
                if isinstance(check_path, Path) and check_path.exists():
                    results[dep['key']] = {'status': 'already_installed'}
                    continue
                import tempfile as _tf
                dl_path = Path(_tf.gettempdir()) / f'kente_{dep["key"]}.exe'
                _download_to_file(dep['url'], dl_path, headers=headers, timeout=300)
                r = subprocess.run([str(dl_path)] + list(dep.get('args') or []),
                                   capture_output=True, text=True, timeout=900)
                if r.returncode == 0:
                    results[dep['key']] = {'status': 'installed'}
                else:
                    results[dep['key']] = {'status': 'error',
                                           'error': (r.stdout + r.stderr).strip()[:500] or f'exit {r.returncode}'}
            except Exception as ex:
                results[dep['key']] = {'status': 'error', 'error': str(ex)}

    for key in keys:
        if key not in EMULATOR_DEPS:
            results[key] = {'status': 'error', 'error': 'Unknown emulator key'}
            continue
        dep = EMULATOR_DEPS[key]
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
                    rec = {'status': 'installed_winget', 'path': p2}
                    # Post-install hooks (best-effort)
                    if key == 'pcsx2':
                        try:
                            if p2:
                                subprocess.run([p2, '-portable', '-testconfig'],
                                               capture_output=True, text=True, timeout=30)
                            _bios_configure_pcsx2(BIOS_DIR)
                            rec['bios'] = 'configured'
                        except Exception:
                            rec['bios'] = 'skipped'
                    if key == 'rpcs3':
                        try:
                            has_pup = any([
                                (BIOS_DIR / 'PS3UPDAT.PUP').exists(),
                                (BIOS_DIR / 'ps3' / 'PS3UPDAT.PUP').exists(),
                            ])
                            if targeted or has_pup:
                                rec['firmware'] = _ensure_ps3_firmware(p2, BIOS_DIR) if p2 else {'ok': False, 'reason': 'rpcs3_not_found'}
                            else:
                                rec['firmware'] = {'ok': False, 'reason': 'skipped'}
                        except Exception as _ex:
                            rec['firmware'] = {'ok': False, 'reason': 'exception', 'detail': str(_ex)[:200]}
                    results[key] = rec
                    print(f'[emu] {dep["name"]} installed via WinGet')
                    continue
                print(f'[emu] WinGet failed for {key}: {out}')

            # 2. Direct download (zip/7z/exe)
            dl = dep.get('win_dl')
            if dl:
                try:
                    dl_url  = None
                    dl_name = None
                    if isinstance(dl, dict) and dl.get('kind') == 'github_release':
                        dl_url, dl_name = _github_latest_release_asset(dl['repo'], dl['asset_re'], headers)
                    elif isinstance(dl, str):
                        dl_url  = dl
                        dl_name = Path(urllib.parse.urlparse(dl).path).name or f'{key}.bin'
                    else:
                        raise RuntimeError('Unsupported win_dl format')

                    dest_dir = dep['win_dest']
                    dest_dir.mkdir(parents=True, exist_ok=True)
                    import tempfile as _tf
                    dl_path = Path(_tf.gettempdir()) / f'kente_{key}_{dl_name}'
                    _download_to_file(dl_url, dl_path, headers=headers, timeout=600)

                    # Extract archive or run installer
                    ext = dl_path.suffix.lower()
                    if ext in ('.zip', '.7z'):
                        _extract_archive_to(dl_path, dest_dir)
                        _flatten_single_subdir(dest_dir)
                    elif ext == '.exe':
                        args = dep.get('win_dl_args') or []
                        r = subprocess.run([str(dl_path)] + list(args),
                                           capture_output=True, text=True, timeout=900)
                        if r.returncode != 0:
                            raise RuntimeError((r.stdout + r.stderr).strip()[:500] or f'installer exit {r.returncode}')
                    else:
                        raise RuntimeError(f'Unsupported download type: {dl_name}')

                    # Post-install hooks (best-effort)
                    if key == 'pcsx2':
                        try:
                            _, pcsx2_path = _check_emu_installed('pcsx2')
                            if pcsx2_path:
                                # Initialize portable config (creates inis/ etc) then drop BIOS into place.
                                subprocess.run([pcsx2_path, '-portable', '-testconfig'],
                                               capture_output=True, text=True, timeout=30)
                            # Copy BIOS into portable folder if we installed to LOCALAPPDATA, and also into
                            # the standard Documents folder for non-portable installs.
                            _bios_configure_pcsx2(BIOS_DIR)
                        except Exception:
                            pass
                    if key == 'rpcs3':
                        try:
                            has_pup = any([
                                (BIOS_DIR / 'PS3UPDAT.PUP').exists(),
                                (BIOS_DIR / 'ps3' / 'PS3UPDAT.PUP').exists(),
                            ])
                            if targeted or has_pup:
                                _, rpcs3_path = _check_emu_installed('rpcs3')
                                fw = _ensure_ps3_firmware(rpcs3_path, BIOS_DIR) if rpcs3_path else {'ok': False, 'reason': 'rpcs3_not_found'}
                            else:
                                fw = {'ok': False, 'reason': 'skipped'}
                        except Exception:
                            fw = {'ok': False, 'reason': 'exception'}

                    _, p3 = _check_emu_installed(key)
                    rec = {'status': 'installed_download', 'path': p3}
                    if key == 'rpcs3':
                        rec['firmware'] = fw
                    results[key] = rec
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
                    if isinstance(url, dict) and url.get('kind') == 'github_release':
                        url, _ = _github_latest_release_asset(url['repo'], url['asset_re'], headers)
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
