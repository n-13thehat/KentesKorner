"""App-owned native engines; packaged code and user saves use separate folders."""
import configparser
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading

from kente_config import BASE, BIOS_DIR, IS_APP

SYSTEM_ENGINES = {
    'ps2': 'pcsx2', 'gamecube': 'dolphin', 'wii': 'dolphin',
    'ps3': 'rpcs3', 'wiiu': 'cemu', 'dreamcast': 'flycast',
    'xbox': 'xemu', 'xbox360': 'xenia', 'switch': 'ryujinx',
}
ENGINE_EXES = {
    'pcsx2': ('pcsx2-qt.exe', 'pcsx2-qtx64.exe', 'pcsx2-qtx64-avx2.exe'),
    'dolphin': ('Dolphin.exe',), 'rpcs3': ('rpcs3.exe',),
    'cemu': ('Cemu.exe',), 'flycast': ('flycast.exe',),
    'xemu': ('xemu.exe',), 'xenia': ('xenia.exe', 'xenia_canary.exe'),
    'ryujinx': ('Ryujinx.exe',),
}
RUNTIME_DIR = BASE / 'emulators'
SEED_DIR = Path(os.environ.get('KENTE_RUNTIME_DIR') or BASE / '_bundled_engines')
RUNTIME_DLL_DIR = Path(os.environ.get('KENTE_RUNTIME_DLL_DIR') or BASE / '_runtime_dlls')
_RUNTIME_LOCK = threading.RLock()
# Copy distribution files only, including upstream licenses; never import games,
# firmware, an installed user's configuration, memory cards, logs, or caches.
ASSET_DIRS = {'resources', 'sys', 'qtplugins', 'qt6', 'plugins', 'platforms',
              'imageformats', 'styles', 'tls', 'translations', 'fonts', 'icons',
              'docs', 'licenses', 'license', 'shaders', 'lang'}
ASSET_EXTS = {'.exe', '.dll', '.pak', '.rcc', '.dat', '.html', '.txt', '.md', '.conf'}


def executable(folder, engine):
    for name in ENGINE_EXES.get(engine, ()):
        candidate = Path(folder) / name
        if candidate.is_file():
            return candidate
    return None


def available_runtime(engine):
    return executable(RUNTIME_DIR / engine, engine) or executable(SEED_DIR / engine, engine)


def copy_distribution(source, destination):
    source, destination = Path(source), Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for entry in source.iterdir():
        if entry.is_symlink():
            continue
        lower = entry.name.lower()
        if entry.is_dir() and lower in ASSET_DIRS:
            shutil.copytree(entry, destination / entry.name, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns('*.log', '*.dmp', 'bios', 'roms', 'saves'))
        elif entry.is_file() and (entry.suffix.lower() in ASSET_EXTS or lower.startswith(('copying', 'license'))
                                  or lower.endswith(('.deps.json', '.runtimeconfig.json'))):
            if not lower.startswith(('unins', 'portable', 'log', 'config')) and lower != 'emu.cfg':
                shutil.copy2(entry, destination / entry.name)


def provision_runtime(engine, installed=None):
    if engine not in ENGINE_EXES:
        raise ValueError('Unknown native engine')
    with _RUNTIME_LOCK:
        destination = RUNTIME_DIR / engine
        seed = SEED_DIR / engine
        source = seed if executable(seed, engine) else Path(installed).parent if installed else None
        current = executable(destination, engine)
        if source and source.resolve() != destination.resolve():
            source_exe = executable(source, engine)
            if source_exe:
                stamp = hashlib.sha256(source_exe.read_bytes()).hexdigest()
                marker = destination / '.kente-runtime.json'
                previous = {}
                try:
                    previous = json.loads(marker.read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    pass
                if not current or (not previous.get('userImported') and previous.get('sha256') != stamp):
                    copy_distribution(source, destination)
                    marker.write_text(json.dumps({'sha256': stamp, 'engine': engine}), encoding='utf-8')
                    current = executable(destination, engine)
        if not current:
            return None
        if RUNTIME_DLL_DIR.is_dir():
            for dll in RUNTIME_DLL_DIR.glob('*.dll'):
                target = destination / dll.name
                if not target.is_file():
                    shutil.copy2(dll, target)
        return current


def import_runtime(engine, source):
    if not isinstance(engine, str) or engine not in ENGINE_EXES:
        raise ValueError('Unknown game engine')
    source = Path(source)
    if not source.is_absolute() or not executable(source, engine):
        raise ValueError('Choose the folder containing the portable game engine.')
    with _RUNTIME_LOCK:
        destination = RUNTIME_DIR / engine
        if source.resolve() != destination.resolve():
            copy_distribution(source, destination)
        exe = executable(destination, engine)
        (destination / '.kente-runtime.json').write_text(json.dumps({
            'engine': engine, 'sha256': hashlib.sha256(exe.read_bytes()).hexdigest(), 'userImported': True,
        }), encoding='utf-8')
        return exe


def configure_pcsx2_controller(config):
    """Give PCSX2 a standard SDL controller mapping when Port 1 has none.

    Kente's Gamepad API is confined to the Electron window. Native emulators
    read devices through their own input backends, so PCSX2 needs its own SDL
    bindings. Preserve any existing SDL/XInput/DirectInput mapping.
    """
    config = Path(config)
    ini = configparser.ConfigParser(interpolation=None, strict=False)
    ini.optionxform = str
    ini.read(config, encoding='utf-8-sig')
    if not ini.has_section('InputSources'):
        ini.add_section('InputSources')
    if not ini.has_section('Pad1'):
        ini.add_section('Pad1')

    pad = ini['Pad1']
    defaults = {
        'Up': 'SDL-0/DPadUp', 'Right': 'SDL-0/DPadRight',
        'Down': 'SDL-0/DPadDown', 'Left': 'SDL-0/DPadLeft',
        'Triangle': 'SDL-0/Y', 'Circle': 'SDL-0/B',
        'Cross': 'SDL-0/A', 'Square': 'SDL-0/X',
        'Select': 'SDL-0/Back', 'Start': 'SDL-0/Start',
        'L1': 'SDL-0/LeftShoulder', 'R1': 'SDL-0/RightShoulder',
        'L2': 'SDL-0/+LeftTrigger', 'R2': 'SDL-0/+RightTrigger',
        'L3': 'SDL-0/LeftStick', 'R3': 'SDL-0/RightStick',
        'LUp': 'SDL-0/-LeftY', 'LRight': 'SDL-0/+LeftX',
        'LDown': 'SDL-0/+LeftY', 'LLeft': 'SDL-0/-LeftX',
        'RUp': 'SDL-0/-RightY', 'RRight': 'SDL-0/+RightX',
        'RDown': 'SDL-0/+RightY', 'RLeft': 'SDL-0/-RightX',
    }
    changed = pad.get('Type', '').lower() in ('', 'none')
    if changed:
        pad['Type'] = 'DualShock2'
    for key, default in defaults.items():
        current = pad.get(key, '').strip()
        if not current.startswith(('SDL-', 'XInput-', 'DInput-')):
            pad[key] = default
            changed = True
    ini['InputSources']['SDL'] = 'true'
    ini['InputSources']['Keyboard'] = 'true'
    config.parent.mkdir(parents=True, exist_ok=True)
    with config.open('w', encoding='utf-8') as handle:
        ini.write(handle)
    return changed


_REMOTE_PAD2 = {
    'Type': 'DualShock2',
    'Up': 'Keyboard/W', 'Down': 'Keyboard/S', 'Left': 'Keyboard/A', 'Right': 'Keyboard/D',
    'LUp': 'Keyboard/W', 'LDown': 'Keyboard/S', 'LLeft': 'Keyboard/A', 'LRight': 'Keyboard/D',
    'Triangle': 'Keyboard/I', 'Circle': 'Keyboard/L', 'Cross': 'Keyboard/K', 'Square': 'Keyboard/J',
    'Select': 'Keyboard/U', 'Start': 'Keyboard/O', 'L1': 'Keyboard/Q', 'R1': 'Keyboard/E',
    'L2': 'Keyboard/Z', 'R2': 'Keyboard/C',
}


def configure_remote_pcsx2_player2(config):
    """Temporarily map the guest keyboard to Pad 2, returning the prior bindings."""
    config = Path(config)
    ini = configparser.ConfigParser(interpolation=None, strict=False)
    ini.optionxform = str
    ini.read(config, encoding='utf-8-sig')
    if not ini.has_section('Pad2'):
        ini.add_section('Pad2')
    if not ini.has_section('InputSources'):
        ini.add_section('InputSources')
    pad = ini['Pad2']
    backup = {key: pad.get(key) for key in _REMOTE_PAD2}
    ini['InputSources']['Keyboard'] = 'true'
    pad.update(_REMOTE_PAD2)
    with config.open('w', encoding='utf-8') as handle:
        ini.write(handle)
    return backup


def restore_remote_pcsx2_player2(config, backup):
    """Restore the host's Pad 2 bindings after a shared session ends."""
    if not config or not isinstance(backup, dict):
        return
    config = Path(config)
    ini = configparser.ConfigParser(interpolation=None, strict=False)
    ini.optionxform = str
    ini.read(config, encoding='utf-8-sig')
    if not ini.has_section('Pad2'):
        ini.add_section('Pad2')
    for key, value in backup.items():
        if value is None:
            ini['Pad2'].pop(key, None)
        else:
            ini['Pad2'][key] = value
    with config.open('w', encoding='utf-8') as handle:
        ini.write(handle)


def _nvidia_adapter_name():
    """Return the installed NVIDIA display adapter name on Windows, if any."""
    if os.name != 'nt':
        return None
    try:
        import winreg
        key_path = r'SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path) as adapters:
            index = 0
            while True:
                try:
                    name = winreg.EnumKey(adapters, index)
                except OSError:
                    break
                index += 1
                try:
                    with winreg.OpenKey(adapters, name) as adapter:
                        description, _ = winreg.QueryValueEx(adapter, 'DriverDesc')
                    if 'nvidia' in str(description).lower():
                        return str(description)
                except OSError:
                    continue
    except (ImportError, OSError):
        pass
    return None


def configure_engine(engine, exe, embedded=False):
    """Use a private writable profile, including the user's own firmware."""
    root = Path(exe).parent
    if engine == 'pcsx2':
        (root / 'portable.ini').touch(exist_ok=True)
        config = root / 'inis/PCSX2.ini'
        if not config.is_file():
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 0
            subprocess.run([str(exe), '-portable', '-testconfig'], cwd=str(root),
                           startupinfo=startup, capture_output=True, timeout=30)
        ini = configparser.ConfigParser(interpolation=None, strict=False)
        ini.optionxform = str
        ini.read(config, encoding='utf-8-sig')
        for section in ('UI', 'Folders', 'Filenames', 'Hotkeys'):
            if not ini.has_section(section):
                ini.add_section(section)
        if not ini.has_section('EmuCore/GS'):
            ini.add_section('EmuCore/GS')
        # For hybrid-graphics Windows laptops, explicitly use the discrete
        # NVIDIA adapter. Vulkan avoids a silent fallback to CPU rendering;
        # native internal resolution keeps the GPU workload modest.
        nvidia_adapter = _nvidia_adapter_name()
        if nvidia_adapter:
            ini['EmuCore/GS'].update({'Renderer': '14', 'Adapter': nvidia_adapter,
                                      'upscale_multiplier': '1'})
        ini['EmuCore/GS'].update({'OsdShowFPS': 'true', 'OsdShowSpeed': 'true'})
        ini['UI'].update({'SettingsVersion': '1', 'SetupWizardIncomplete': 'false',
                          'ConfirmShutdown': 'false', 'StartFullscreen': 'false',
                          'RenderToSeparateWindow': 'true', 'HideMainWindowWhenRunning': 'true',
                          'DoubleClickTogglesFullscreen': 'false', 'PauseOnFocusLoss': 'false'})
        ini['Folders']['Bios'] = str(BIOS_DIR)
        # Memory cards and save states stay under Kente's data directory.
        for name, folder in [('MemoryCards', 'memcards'), ('Savestates', 'sstates')]:
            target = BASE / 'saves/ps2' / folder
            target.mkdir(parents=True, exist_ok=True)
            ini['Folders'][name] = str(target)
        bios = [p for p in BIOS_DIR.glob('*.bin') if p.name.lower().startswith(('scph', 'ps2')) and p.stat().st_size >= 1_000_000]
        if not bios:
            raise RuntimeError('PS2_BIOS_MISSING: Add your PlayStation 2 BIOS in Sources before playing.')
        chosen = next((p for p in bios if '39001' in p.name), bios[0])
        ini['Filenames']['BIOS'] = chosen.name
        if embedded:
            ini['Hotkeys']['TogglePause'] = 'Keyboard/F12'
            ini['Hotkeys']['ToggleFullscreen'] = ''
        config.parent.mkdir(parents=True, exist_ok=True)
        with config.open('w', encoding='utf-8') as handle:
            ini.write(handle)
        configure_pcsx2_controller(config)
    elif engine == 'dolphin':
        user = root / 'User'
        config = user / 'Config/Dolphin.ini'
        config.parent.mkdir(parents=True, exist_ok=True)
        ini = configparser.ConfigParser(interpolation=None, strict=False)
        ini.optionxform = str
        ini.read(config, encoding='utf-8-sig')
        for section in ('Display', 'Interface'):
            if not ini.has_section(section):
                ini.add_section(section)
        ini['Display'].update({'Fullscreen': 'False', 'RenderToMain': 'False'})
        ini['Interface']['ConfirmStop'] = 'False'
        with config.open('w', encoding='utf-8') as handle:
            ini.write(handle)
    elif engine == 'rpcs3':
        # RPCS3's official Windows portable distribution keeps data beside its exe.
        (root / 'config').mkdir(exist_ok=True)


def configure_installed_pcsx2(exe):
    """Configure the profile used by a detected modern Windows PCSX2 install."""
    root = Path(exe).parent
    localapp = Path(os.environ.get('LOCALAPPDATA', ''))
    is_portable = (root / 'portable.ini').exists() or (
        str(root).lower().startswith(str(localapp).lower()) and bool(os.environ.get('LOCALAPPDATA'))
    )
    if is_portable:
        config = root / 'inis/PCSX2.ini'
    else:
        user = Path(os.environ.get('USERPROFILE', Path.home()))
        config = user / 'Documents/PCSX2/inis/PCSX2.ini'
    added = configure_pcsx2_controller(config)
    print(f"[controller] PCSX2 Port 1 {'SDL controller mapping configured' if added else 'existing mapping kept'}: {config}")


def native_arguments(engine, exe, rom, embedded=False):
    root = Path(exe).parent
    if engine == 'pcsx2':
        return ['-portable', '-nogui' if embedded else '-batch', '-nofullscreen' if embedded else '-fullscreen', '--', str(rom)]
    if engine == 'dolphin':
        return ['-u', str(root / 'User'), '-b', '--config', 'Display.Fullscreen=' + ('False' if embedded else 'True'), '-e', str(rom)]
    if engine == 'cemu':
        return (['-g', str(rom)] if embedded else ['-f', '-g', str(rom)])
    if engine == 'xenia':
        return ['--fullscreen=false' if embedded else '--fullscreen', str(rom)]
    if engine == 'rpcs3':
        return ['--no-gui', str(rom)] if embedded else [str(rom)]
    return [str(rom)]
