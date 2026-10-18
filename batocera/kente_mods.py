"""Kente's Korner — SSF2 mod system."""
import json, platform, shutil, subprocess
from pathlib import Path
from kente_config import MODS_DIR, SSF2_LIN_DATA, SSF2_WIN_DATA

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
