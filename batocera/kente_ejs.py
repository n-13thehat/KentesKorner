"""Kente's Korner — EmulatorJS offline pack prefetch and core extraction."""
import platform, re, shutil, subprocess, tempfile, zipfile
from pathlib import Path
from kente_security import safe_resolve as _safe_resolve_helper
from kente_config import CACHE_DIR, EJS_CDN_BASE, EJS_CORES_DIR, EJS_SEED_DIR, EJS_STABLE_DIR
from kente_emulators import _download_to_file

# ── EmulatorJS offline pack prefetch (optional) ──────────────────────────────
# In Electron app mode we can prefetch EmulatorJS stable assets + core blobs into
# BASE/cache/ejs-stable so browser-mode systems work offline after the first run.
_ejs_prefetch_state = {
    'running': False,
    'done':    False,
    'error':   None,
    'current': '',
    'total':   0,
    'done_count': 0,
    'errors':  [],   # [{file, error}]
}

# Core list mirrors js/config.js CORE_MAP (excluding dreamcast which is handled via COMMUNITY_CORES)
EJS_REQUIRED_CORES = [
    'nestopia',
    'gambatte',
    'genesis_plus_gx',
    'stella2014',
    'prosystem',
    'snes9x',
    'mgba',
    'mednafen_pce',
    'fbneo',
    'picodrive',
    'mupen64plus_next',
    'pcsx_rearmed',
    'yabause',
    'desmume2015',
    'melonds',
    'ppsspp',
]

EJS_PREFETCH_FILES = [
    'loader.js',
    'emulator.min.js',
    'emulator.min.css',
    'emulator.css',
    'version.json',
    # Support scripts used by loader/emulator runtime
    'src/GameManager.js',
    'src/compression.js',
    'src/emulator.js',
    'src/gamepad.js',
    'src/nipplejs.js',
    'src/shaders.js',
    'src/socket.io.min.js',
    'src/storage.js',
    # Archive extraction helpers (zip/rar/7z)
    'compression/extract7z.js',
    'compression/extractzip.js',
    'compression/libunrar.js',
    'compression/libunrar.wasm',
    # Default language packs (others can be downloaded on demand)
    'localization/en-US.json',
    'localization/retroarch.json',
]

def _ejs_transcode_core_7z_to_zip(core_path: Path) -> bool:
    """Rewrite an EmulatorJS *.data core from 7z -> zip in-place (Windows only).

    EmulatorJS supports both 7z and zip containers for cores. In practice, zip
    extraction tends to be faster and less failure-prone in the browser worker.
    We only attempt this on Windows where bsdtar (tar.exe) can extract 7z by
    default; on Linux builds tar often cannot, so we skip.
    """
    try:
        if platform.system() != 'Windows':
            return False
        if not core_path or not core_path.is_file():
            return False
        if not core_path.name.lower().endswith('.data'):
            return False

        with open(core_path, 'rb') as f:
            sig = f.read(6)
            if sig[:2] == b'PK':  # already zip
                return False
            # 7z magic bytes: 37 7A BC AF 27 1C
            if sig != b"7z\xbc\xaf'\x1c":
                return False

        tar_exe = shutil.which('tar')
        if not tar_exe:
            return False

        tmp_root = Path(tempfile.mkdtemp(prefix='kente-ejs-core-', dir=str(CACHE_DIR)))
        try:
            # Extract the 7z payload into a temp folder.
            subprocess.run([tar_exe, '-xf', str(core_path), '-C', str(tmp_root)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            files = [p for p in tmp_root.rglob('*') if p.is_file()]
            if not files:
                return False

            tmp_zip = core_path.with_name(core_path.name + '.tmpzip')
            try:
                with zipfile.ZipFile(tmp_zip, 'w',
                                     compression=zipfile.ZIP_DEFLATED,
                                     compresslevel=6) as zf:
                    for p in files:
                        arc = str(p.relative_to(tmp_root)).replace('\\', '/')
                        zf.write(str(p), arcname=arc)

                with open(tmp_zip, 'rb') as f:
                    if f.read(2) != b'PK':
                        try: tmp_zip.unlink()
                        except Exception: pass
                        return False

                # Atomic replace so readers never see a half-written core.
                tmp_zip.replace(core_path)
                return True
            finally:
                try:
                    if tmp_zip.exists():
                        tmp_zip.unlink()
                except Exception:
                    pass
        finally:
            shutil.rmtree(tmp_root, ignore_errors=True)
    except Exception:
        return False

_EJS_CORE_NAME_RE = re.compile(r'^[A-Za-z0-9._-]+\.data$')

def _ejs_locate_core(core_name: str):
    """Find a cached *.data core file across the user, seed, and community dirs."""
    if not core_name or not _EJS_CORE_NAME_RE.match(core_name):
        return None
    for root in (EJS_STABLE_DIR / 'cores', EJS_SEED_DIR / 'cores', EJS_CORES_DIR):
        try:
            p = root / core_name
            if p.is_file():
                return p
        except Exception:
            pass
    return None

def _ejs_extract_core_to_dir(core_path: Path, dest_dir: Path) -> bool:
    """Extract a *.data core archive (7z or zip) into dest_dir using stdlib +
    bundled tar where needed. Returns True on success."""
    try:
        with open(core_path, 'rb') as f:
            sig = f.read(6)
        dest_dir.mkdir(parents=True, exist_ok=True)
        if sig[:2] == b'PK':
            with zipfile.ZipFile(str(core_path)) as zf:
                zf.extractall(str(dest_dir))
            return True
        if sig == b"7z\xbc\xaf'\x1c":
            tar_exe = shutil.which('tar')
            if not tar_exe:
                return False
            subprocess.run([tar_exe, '-xf', str(core_path), '-C', str(dest_dir)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        return False
    except Exception as e:
        print(f'[ejs-extract] {core_path.name}: {e}')
        return False

def _ejs_get_extracted_core(core_name: str):
    """Return a dict {filename: bytes} for a core archive's contents, using a
    persistent on-disk cache so we extract each archive only once."""
    src = _ejs_locate_core(core_name)
    if src is None:
        return None
    cache_root = EJS_STABLE_DIR / 'cores' / '.extracted' / core_name
    marker = cache_root / '.ok'
    if not marker.exists():
        try:
            if cache_root.exists():
                shutil.rmtree(cache_root, ignore_errors=True)
            if not _ejs_extract_core_to_dir(src, cache_root):
                return None
            marker.write_bytes(b'ok')
        except Exception as e:
            print(f'[ejs-extract] cache build failed for {core_name}: {e}')
            return None
    out = {}
    try:
        for p in cache_root.rglob('*'):
            if p.is_file() and p.name != '.ok':
                rel = str(p.relative_to(cache_root)).replace('\\', '/')
                out[rel] = p.read_bytes()
    except Exception as e:
        print(f'[ejs-extract] read failed for {core_name}: {e}')
        return None
    return out

def _ejs_try_seed_copy(rel_path: str, dest: Path) -> bool:
    """If WEB_DIR/cache/ejs-stable contains rel_path, copy it into dest."""
    try:
        if not EJS_SEED_DIR.exists():
            return False
        seed_path = _safe_resolve_helper(EJS_SEED_DIR, '/' + (rel_path or ''))
        if seed_path is None or not seed_path.exists() or not seed_path.is_file():
            return False
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + '.tmp')
        tmp.write_bytes(seed_path.read_bytes())
        tmp.replace(dest)
        return True
    except Exception:
        return False

def _ejs_prefetch_thread(cores=None):
    global _ejs_prefetch_state
    headers = {'User-Agent': 'KenteKorner/1.0'}
    targets = list(cores) if cores else list(EJS_REQUIRED_CORES)

    # Build the download list (best-effort; missing files are recorded but not fatal)
    todo = []
    todo.extend(EJS_PREFETCH_FILES)
    for c in targets:
        for suffix in (
            '-wasm.data',
            '-legacy-wasm.data',
            '-thread-wasm.data',
            '-thread-legacy-wasm.data',
        ):
            todo.append(f'cores/{c}{suffix}')
        # Report JSON: lets EmulatorJS use a stable buildStart for IndexedDB
        # caching (otherwise it falls back to Math.random() and re-downloads
        # the core on every launch).
        todo.append(f'cores/reports/{c}.json')
        if c == 'ppsspp':
            todo.append('cores/ppsspp-assets.zip')

    # De-dupe while preserving order
    seen = set()
    todo2 = []
    for p in todo:
        if p in seen:
            continue
        seen.add(p)
        todo2.append(p)

    _ejs_prefetch_state.update({
        'running': True,
        'done': False,
        'error': None,
        'current': '',
        'total': len(todo2),
        'done_count': 0,
        'errors': [],
    })

    try:
        EJS_STABLE_DIR.mkdir(parents=True, exist_ok=True)
        for rel in todo2:
            _ejs_prefetch_state['current'] = rel
            dest = _safe_resolve_helper(EJS_STABLE_DIR, '/' + rel)
            if dest is None:
                _ejs_prefetch_state['errors'].append({'file': rel, 'error': 'path_traversal_rejected'})
                _ejs_prefetch_state['done_count'] += 1
                continue
            if dest.exists() and dest.is_file():
                # 7z\u2192zip transcode disabled: extractzip.js (Emscripten unzip) was
                # silently hanging the browser on "Decompress Game Core" for some
                # cores. Native 7z files served as-is are handled by extract7z.js
                # without the issue. Function kept above for future use.
                _ejs_prefetch_state['done_count'] += 1
                continue

            # 1) Copy from build-time seed pack if present
            if _ejs_try_seed_copy(rel, dest):
                _ejs_prefetch_state['done_count'] += 1
                continue

            # 2) Download from CDN
            url = EJS_CDN_BASE + rel
            try:
                _download_to_file(url, dest, headers=headers, timeout=600)
            except Exception as ex:
                _ejs_prefetch_state['errors'].append({'file': rel, 'error': str(ex)[:300]})
            finally:
                _ejs_prefetch_state['done_count'] += 1

        _ejs_prefetch_state.update({'running': False, 'done': True, 'current': ''})
        print(f'[ejs] prefetch done ({_ejs_prefetch_state["done_count"]}/{_ejs_prefetch_state["total"]})')
    except Exception as ex:
        _ejs_prefetch_state.update({'running': False, 'done': False, 'error': str(ex)[:400], 'current': ''})
        print(f'[ejs] prefetch failed: {ex}')
