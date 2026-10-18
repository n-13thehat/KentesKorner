/* Kente's Korner — application logic.
   The frontend is split into classic scripts under js/, loaded in order by
   index.html with `defer`. They share one global scope, so a file may only
   use, at load time, names declared in itself or in an earlier file.
   Function bodies run later (after DOMContentLoaded) and may use any file. */
'use strict';

/* ── TV ZONE CONFIGURATION ──
   Positions are % of the room container.
   Adjust top/left/width/height to match your room image. */
const TV_ZONES = [
  {
    id: 'play',
    label: 'PLAY',
    desc: 'Full Library',
    accent: '#e84040',         // red
    accentRgb: '232,64,64',
    icon: '▶',
    pos: { top:'55.5%', left:'46.6%', width:'13.7%', height:'22.6%' }
  },
  {
    id: 'collections',
    label: 'COLLECTIONS',
    desc: 'Curated Shelves',
    accent: '#4080ff',         // blue
    accentRgb: '64,128,255',
    icon: '◈',
    pos: { top:'7.6%', left:'28.5%', width:'12.2%', height:'20.9%' }
  },
  {
    id: 'sources',
    label: 'SOURCES',
    desc: 'Storage & Providers',
    accent: '#30d880',         // green
    accentRgb: '48,216,128',
    icon: '⬡',
    pos: { top:'20.7%', left:'49.7%', width:'12.2%', height:'21.9%' }
  },
  {
    id: 'memory',
    label: 'MEMORY CARD',
    desc: 'Saves & Profiles',
    accent: '#f0d000',         // yellow
    accentRgb: '240,208,0',
    icon: '◉',
    pos: { top:'38.4%', left:'24.0%', width:'11.8%', height:'21.3%' }
  },
  {
    id: 'theater',
    label: 'THEATER',
    desc: 'Videos & Previews',
    accent: '#c050ff',         // purple
    accentRgb: '192,80,255',
    icon: '◧',
    pos: { top:'46.3%', left:'71.8%', width:'8.9%', height:'14.3%' }
  },
  {
    id: 'settings',
    label: 'SETTINGS',
    desc: 'System Config',
    accent: '#888aaa',         // gray
    accentRgb: '136,138,170',
    icon: '⚙',
    pos: { top:'81.0%', left:'24.6%', width:'9.9%', height:'6.6%' }
  }
];

/* ══════════════════════════════════════════
   EMULATOR CORE MAP  (EmulatorJS core names)
══════════════════════════════════════════ */
const CORE_MAP = {
  // ── Tier 1 ── All confirmed present on cdn.emulatorjs.org/stable/data/cores/
  nes:        'nestopia',
  gameboy:    'gambatte',
  gbc:        'gambatte',
  mastersys:  'genesis_plus_gx',   // genesis_plus_gx handles SMS + MegaDrive + GG
  atari2600:  'stella2014',
  atari7800:  'prosystem',
  gamegear:   'genesis_plus_gx',   // Game Gear uses same genesis_plus_gx core
  // ── Tier 2 ──
  snes:       'snes9x',
  genesis:    'genesis_plus_gx',
  gba:        'mgba',
  turbografx: 'mednafen_pce',
  neogeo:     'fbneo',
  segacd:     'genesis_plus_gx',   // Sega CD: genesis_plus_gx handles CD mode
  sega32x:    'picodrive',         // Sega 32X: picodrive confirmed on CDN
  // ── Tier 3 ──
  n64:        'mupen64plus_next',
  ps1:        'pcsx_rearmed',
  saturn:     'yabause',
  psp:        'ppsspp',
  nds:        'desmume2015',       // Nintendo DS: desmume2015 (no BIOS required)
  // ── Community WASM core — served via kente-server.py /api/ejs/ proxy ───────────────
  // flycast-wasm.data is a community-built Flycast WebAssembly core (nasomers/flycast-wasm,
  // Feb 2026).  It is NOT on the official CDN; kente-server downloads and caches it from
  // GitHub releases on first use, then proxies all other EJS requests to the stable CDN.
  // REQUIRES: kente-server online + dc_boot.bin BIOS.  Falls back to native if offline.
  dreamcast: 'flycast',
  // ── Not on EmulatorJS stable CDN — no alternative browser WASM build ────────────
  // gamecube / wii → Dolphin uses a non-libretro standalone build not on the CDN.
  // ── No WebAssembly emulator build exists anywhere for these ─────────────────────
  // ps2    → pcsx2   requires JIT + SIMD; no WASM build
  // xbox   → xemu    no libretro core; no WASM build
  // ps3    → rpcs3   requires JIT + hardware rendering; no WASM build
  // xbox360→ xenia   requires JIT; no WASM build
  // wiiu   → cemu    no WASM build
  // switch → ryujinx no WASM build
};

const ROM_EXT = {
  // EmulatorJS detects zip archives by magic bytes (PK header), not by URL extension,
  // so adding .zip to every system lets us pick up No-Intro / Redump sets that
  // Archive.org stores as zipped archives — which is the majority of their collection.
  // RAR/7z are added to disc-based systems because many Archive.org uploaders use them.
  // The 10 MB minimum-size guard in the file pickers prevents false-positive non-ROM hits.
  // NOTE: .7z is only added to native-only systems (no CORE_MAP entry) since EmulatorJS
  // cannot decompress 7-Zip archives in-browser; Batocera's emulatorlauncher can.
  nes:        ['.nes','.zip'],
  gameboy:    ['.gb','.zip'],
  gbc:        ['.gbc','.zip'],
  mastersys:  ['.sms','.sg','.zip'],
  atari2600:  ['.a26','.bin','.zip'],
  atari7800:  ['.a78','.bin','.zip'],
  gamegear:   ['.gg','.zip'],
  snes:       ['.sfc','.smc','.zip'],
  genesis:    ['.md','.bin','.gen','.zip'],
  gba:        ['.gba','.zip'],
  turbografx: ['.pce','.zip'],
  neogeo:     ['.zip'],
  segacd:     ['.bin','.cue','.iso','.zip','.rar'],
  sega32x:    ['.32x','.bin','.zip'],
  n64:        ['.n64','.z64','.v64','.zip'],
  ps1:        ['.chd','.pbp','.cue','.bin','.iso','.img','.zip','.rar'],
  saturn:     ['.bin','.iso','.cue','.zip','.rar','.7z'],
  nds:        ['.nds','.zip'],
  dreamcast:  ['.cdi','.gdi','.iso','.zip','.rar','.7z'],
  psp:        ['.iso','.cso','.pbp','.zip','.rar'],
  ps2:        ['.iso','.bin','.zip','.rar','.7z'],
  gamecube:   ['.iso','.gcm','.rvz','.zip','.rar','.7z'],
  wii:        ['.iso','.wbfs','.rvz','.zip','.rar','.7z'],
  xbox:       ['.iso','.xiso','.zip','.rar','.7z'],
  xbox360:    ['.iso','.zip','.rar','.7z'],
  ps3:        ['.iso','.pkg','.zip','.rar','.7z'],
  wiiu:       ['.wud','.wux','.iso','.zip','.rar','.7z'],
  // Switch: only include formats the emulator can open directly.
  // .zip is intentionally excluded — Switch .zip files on Archive.org are
  // Thingiverse 3D-printing models, not ROM archives.
  switch:     ['.nsp','.xci','.nsz','.xcz'],
};

// Per-system extension preference, best-first.  Used by the mirror picker
// (js/cloud_launch.js _collectCloudMirrors) and the server-side resolver
// (rom_providers.py _EXT_RANK) to favour single-file formats and full archives
// over orphan .cue files on disc systems.  Keep in sync with rom_providers.py.
const EXT_RANK_BY_SYS = {
  ps1:        ['.chd','.pbp','.zip','.7z','.rar','.iso','.cue','.bin','.img'],
  ps2:        ['.chd','.zip','.7z','.iso','.cue','.bin'],
  psp:        ['.chd','.cso','.zip','.7z','.iso','.pbp'],
  saturn:     ['.chd','.zip','.7z','.iso','.cue','.bin'],
  segacd:     ['.chd','.zip','.7z','.iso','.cue','.bin'],
  dreamcast:  ['.chd','.gdi','.zip','.7z','.cdi','.iso'],
  gamecube:   ['.rvz','.zip','.7z','.iso','.gcm'],
  wii:        ['.rvz','.zip','.7z','.wbfs','.iso'],
  wiiu:       ['.wud','.wux','.zip','.7z','.iso'],
  xbox:       ['.iso','.xiso','.zip','.7z'],
  xbox360:    ['.iso','.zip','.7z'],
  ps3:        ['.iso','.pkg','.zip','.7z'],
  n64:        ['.z64','.v64','.n64','.zip'],
};

const EJS_CDN = 'https://cdn.emulatorjs.org/stable/data/';

// Set KENTE_DEBUG=true in the browser console to enable verbose logging.
// Never commit with this set to true — hot paths log on every search/download tick.
const DEBUG = typeof window !== 'undefined' && !!window.KENTE_DEBUG;

// Container archive formats — require a minimum file size to filter out
// non-ROM downloads (e.g. 3D-model zips that share a game title in the search
// index). Used in searchArchive() and launchFromCloud() — defined once here.
const CONTAINER_FORMATS = new Set(['.zip', '.rar', '.7z']);
const CONTAINER_MIN_BYTES = 10 * 1024 * 1024; // 10 MB

// Download status string enum — prevents typos and makes grep easy.
const DL_STATUS = Object.freeze({
  QUEUED:      'queued',
  SEARCHING:   'searching',
  DOWNLOADING: 'downloading',
  COMPLETE:    'complete',
  ERROR:       'error',
});
