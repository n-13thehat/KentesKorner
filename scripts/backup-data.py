"""Create or safely restore a Kente's Korner user-data backup."""
import argparse
import os
from pathlib import Path, PurePosixPath
import shutil
import tempfile
import zipfile


def default_data_dir():
    if os.name == 'nt':
        return Path(os.environ.get('APPDATA', Path.home())) / 'KenteCorner'
    if Path('/userdata').is_dir():
        return Path('/userdata')
    return Path.home() / 'KenteCorner'


def create_backup(data_dir, output, include_cache=False):
    data_dir = Path(data_dir).resolve()
    roots = ['roms', 'bios', 'saves', 'emulators', 'system/kente-settings.json']
    if include_cache:
        roots.append('cache')
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for root in roots:
            source = data_dir / root
            if source.is_file():
                archive.write(source, source.relative_to(data_dir).as_posix())
            elif source.is_dir():
                for file in source.rglob('*'):
                    if file.resolve() != output and file.is_file() and not file.is_symlink():
                        archive.write(file, file.relative_to(data_dir).as_posix())
    return output


def restore_backup(archive_path, data_dir, overwrite=False):
    data_dir = Path(data_dir).resolve()
    data_dir.parent.mkdir(parents=True, exist_ok=True)
    allowed_roots = {'roms', 'bios', 'saves', 'emulators', 'cache', 'system'}
    max_total = 200 * 1024**3
    with tempfile.TemporaryDirectory(prefix='kente-restore-', dir=data_dir.parent) as temp_name:
        staging = Path(temp_name)
        with zipfile.ZipFile(archive_path) as archive:
            infos = archive.infolist()
            if len(infos) > 100_000:
                raise ValueError('Backup contains too many entries')
            total = 0
            seen = set()
            for info in infos:
                path = PurePosixPath(info.filename)
                if (path.is_absolute() or not path.parts or '..' in path.parts
                        or path.parts[0] not in allowed_roots or '\\' in info.filename
                        or ':' in info.filename or '\x00' in info.filename):
                    raise ValueError(f'Unsafe backup path: {info.filename}')
                if path.parts[0] == 'system' and info.filename != 'system/kente-settings.json':
                    raise ValueError(f'Unsupported system file in backup: {info.filename}')
                if info.filename in seen:
                    raise ValueError(f'Duplicate backup path: {info.filename}')
                seen.add(info.filename)
                mode = (info.external_attr >> 16) & 0o170000
                if mode == 0o120000:
                    raise ValueError('Backup contains a symbolic link')
                total += info.file_size
                if total > max_total:
                    raise ValueError('Backup expands beyond the 200 GB limit')
                if (info.file_size > 1024**2 and info.compress_size > 0
                        and info.file_size / info.compress_size > 1000):
                    raise ValueError(f'Backup entry has an unsafe expansion ratio: {info.filename}')
            archive.extractall(staging)

        incoming = [p for p in staging.rglob('*') if p.is_file()]
        for source in incoming:
            target = data_dir / source.relative_to(staging)
            for parent in target.parents:
                if parent == data_dir.parent:
                    break
                if parent.exists() and not parent.is_dir():
                    raise FileExistsError(f'A file blocks the restore path: {parent}')
        conflicts = [data_dir / p.relative_to(staging) for p in incoming
                     if (data_dir / p.relative_to(staging)).exists()]
        if conflicts and not overwrite:
            raise FileExistsError(f'{len(conflicts)} existing file(s) would be replaced; use --overwrite')
        required = sum(source.stat().st_size for source in incoming)
        if shutil.disk_usage(data_dir.parent).free < required:
            raise OSError('Not enough free space to restore this backup safely')
        for source in incoming:
            target = data_dir / source.relative_to(staging)
            target.parent.mkdir(parents=True, exist_ok=True)
            temp_target = target.with_name(target.name + '.kente-restore-tmp')
            shutil.copyfile(source, temp_target)
            os.replace(temp_target, target)
    return len(incoming)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('backup', 'restore'))
    parser.add_argument('archive', type=Path, help='ZIP file to create or restore')
    parser.add_argument('--data-dir', type=Path, default=default_data_dir())
    parser.add_argument('--include-cache', action='store_true', help='include rebuildable cached assets')
    parser.add_argument('--overwrite', action='store_true', help='replace existing files during restore')
    args = parser.parse_args()
    if args.action == 'backup':
        path = create_backup(args.data_dir, args.archive, args.include_cache)
        print(f'Backup created: {path}')
    else:
        count = restore_backup(args.archive, args.data_dir, args.overwrite)
        print(f'Restored {count} file(s) into {args.data_dir}')


if __name__ == '__main__':
    main()
