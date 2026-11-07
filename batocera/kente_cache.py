"""Bounded filesystem accounting and least-recently-used cache eviction."""
import os
from pathlib import Path


def directory_usage(root, max_entries=100_000):
    """Return file count and bytes without following links or exposing paths."""
    root = Path(root)
    if not root.is_dir():
        return {'files': 0, 'bytes': 0, 'truncated': False}
    pending = [root]
    files = size = seen = 0
    truncated = False
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    seen += 1
                    if seen > max_entries:
                        truncated = True
                        pending.clear()
                        break
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            pending.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            files += 1
                            size += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return {'files': files, 'bytes': size, 'truncated': truncated}


def trim_lru_cache(cache_dir, required, max_bytes):
    """Evict oldest hash-named assets paired with .meta.json until budget fits."""
    cache_dir = Path(cache_dir)
    if not cache_dir.exists():
        return
    records = []
    for meta in cache_dir.glob('*.meta.json'):
        try:
            prefix = meta.name[:-10]
            data_file = next((candidate for candidate in cache_dir.glob(prefix + '.*')
                              if candidate != meta and not candidate.name.endswith('.tmp')),
                             cache_dir / (prefix + '.bin'))
            if data_file.is_file():
                stat = data_file.stat()
                records.append((stat.st_mtime, stat.st_size, data_file, meta))
        except OSError:
            continue
    total = sum(item[1] for item in records)
    for _, size, data_file, meta in sorted(records):
        if total + required <= max_bytes:
            break
        try:
            data_file.unlink(missing_ok=True)
            meta.unlink(missing_ok=True)
            total -= size
        except OSError:
            continue
