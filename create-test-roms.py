"""
Kente's Korner — Test ROM Stub Generator
Creates zero-content stub files matching every library game so the
ROM library scanner can index them and show green dots in the UI.
These stubs are NOT real ROMs — they will not run in an emulator.
"""
import pathlib

STUB = b'KENTE_STUB_ROM_DO_NOT_LAUNCH'

ROMS = [
    # Tier 1 - NES
    ('nes',       'Super Mario Bros.nes'),
    ('nes',       'Mega Man 2.nes'),
    ('nes',       'Contra.nes'),
    ('nes',       'DuckTales.nes'),
    ('nes',       'Castlevania.nes'),
    # Tier 1 - Game Boy
    ('gameboy',   'Tetris.gb'),
    ('gameboy',   'Pokemon Red.gb'),
    ('gameboy',   'Kirbys Dream Land.gb'),
    ('gameboy',   'Links Awakening.gb'),
    # Tier 1 - Master System
    ('mastersys', 'Sonic the Hedgehog.sms'),
    ('mastersys', 'Alex Kidd in MW.sms'),
    # Tier 2 - SNES
    ('snes',      'Super Mario World.sfc'),
    ('snes',      'A Link to the Past.sfc'),
    ('snes',      'Donkey Kong Country.sfc'),
    ('snes',      'Super Mario RPG.sfc'),
    # Tier 2 - Genesis
    ('genesis',   'Sonic the Hedgehog 2.md'),
    ('genesis',   'Streets of Rage 2.md'),
    ('genesis',   'Ecco the Dolphin.md'),
    # Tier 2 - GBA
    ('gba',       'Metroid Fusion.gba'),
    ('gba',       'Aria of Sorrow.gba'),
    # Tier 3 - N64
    ('n64',       'Super Mario 64.z64'),
    ('n64',       'GoldenEye 007.z64'),
    ('n64',       'Majoras Mask.z64'),
    # Tier 3 - PS1
    ('ps1',       'Final Fantasy VII.bin'),
    ('ps1',       'Crash Bandicoot.bin'),
    ('ps1',       'Tony Hawks Pro Skater 2.bin'),
    # Tier 4 - PS2
    ('ps2',       'Shadow of the Colossus.iso'),
    ('ps2',       'God of War.iso'),
    # Tier 4 - GameCube
    ('gamecube',  'The Wind Waker.iso'),
    # Tier 5 - Wii
    ('wii',       'Super Mario Galaxy.iso'),
]

base = pathlib.Path('roms')
count = 0

for system, filename in ROMS:
    d = base / system
    d.mkdir(parents=True, exist_ok=True)
    f = d / filename
    f.write_bytes(STUB)
    print(f'  OK  {system}/{filename}')
    count += 1

print(f'\n{count} stub ROMs ready in roms/')
print('\nFolder structure:')
for p in sorted(base.iterdir()):
    files = list(p.iterdir())
    print(f'  roms/{p.name}/  ({len(files)} file(s))')

print('\nNext: open SOURCES menu -> ROM LIBRARY -> SET UP ROM LIBRARY -> pick the roms/ folder')

