"""Stage redistributable game engines and cached browser cores for packaging."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'batocera'))
from kente_config import NATIVE_EMU_WIN
from kente_runtime import ENGINE_EXES, copy_distribution, executable

SOURCES = {
    'pcsx2': [Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'PCSX2'],
    'dolphin': [ROOT / 'resources/dolphin'],
}
for engine, names in ENGINE_EXES.items():
    candidates = SOURCES.setdefault(engine, [])
    for sid, paths in NATIVE_EMU_WIN.items():
        for source in paths:
            expanded = Path(os.path.expandvars(source))
            if expanded.name.lower() in {name.lower() for name in names}:
                candidates.append(expanded.parent)
    candidates.append(Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs' / engine)

staged = {}
for engine, folders in SOURCES.items():
    destination = ROOT / 'resources/emulators' / engine
    source = next((folder for folder in folders if executable(folder, engine)), None)
    if source:
        copy_distribution(source, destination)
        exe = executable(destination, engine)
        manifest = {'engine': engine, 'sha256': hashlib.sha256(exe.read_bytes()).hexdigest(),
                    'source': f'Official {engine} distribution; upstream licenses are preserved.'}
        (destination / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        staged[engine] = str(destination.relative_to(ROOT))
    elif executable(destination, engine):
        staged[engine] = str(destination.relative_to(ROOT))
for required in ('pcsx2', 'dolphin'):
    if required not in staged:
        raise SystemExit(f'Missing {required} portable distribution. Place it in resources/emulators/{required} before building.')

runtime_dlls = ROOT / 'resources/runtime-dlls'
runtime_dlls.mkdir(parents=True, exist_ok=True)
system = Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32'
for name in ('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll',
             'msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'concrt140.dll'):
    source = system / name
    if source.is_file():
        shutil.copy2(source, runtime_dlls / name)

user_cache = Path(os.environ['APPDATA']) / 'kentecorner/KenteCorner/cache'
for cache_name in ('ejs-stable', 'ejs-cores'):
    source = user_cache / cache_name
    if source.is_dir():
        shutil.copytree(source, ROOT / 'cache' / cache_name, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('.extracted', '*.log', '*.tmp'))
pack = ROOT / 'cache/ejs-stable'
for relative in ('loader.js', 'emulator.min.js', 'emulator.min.css', 'src/compression.js', 'compression/extract7z.js'):
    if not (pack / relative).is_file():
        raise SystemExit('Missing offline browser assets. Run npm run fetch:ejs before packaging.')
print(json.dumps({'stagedEngines': staged, 'localRuntimeDlls': len(list(runtime_dlls.glob('*.dll'))),
                  'offlineCoreArchives': len(list((pack / 'cores').glob('*.data')))}))
