/* Kente's Korner — Systems (emulator tiers). */
'use strict';

/* ══════════════════════════════════════════
   SYSTEMS — Emulator Tiers
   All systems active — dev / supreme build.
   The Sacrifice Chamber progression mechanic
   is preserved in the UI but all systems ship
   unlocked so the full library is visible.
══════════════════════════════════════════ */
const SYSTEMS_DEFAULT = [
  // ── TIER 1 ──
  { id:'atari2600',  name:'Atari 2600',       tier:1, icon:'▪', active:true, sacrificed:false },
  { id:'atari7800',  name:'Atari 7800',       tier:1, icon:'▪', active:true, sacrificed:false },
  { id:'nes',        name:'NES',              tier:1, icon:'▪', active:true, sacrificed:false },
  { id:'gameboy',    name:'Game Boy',         tier:1, icon:'▪', active:true, sacrificed:false },
  { id:'mastersys',  name:'Master System',    tier:1, icon:'▪', active:true, sacrificed:false },
  { id:'gamegear',   name:'Game Gear',        tier:1, icon:'▪', active:true, sacrificed:false },
  // ── TIER 2 ──
  { id:'snes',       name:'SNES',             tier:2, icon:'▸', active:true, sacrificed:false },
  { id:'genesis',    name:'Genesis',          tier:2, icon:'▸', active:true, sacrificed:false },
  { id:'gbc',        name:'Game Boy Color',   tier:2, icon:'▸', active:true, sacrificed:false },
  { id:'turbografx', name:'TurboGrafx-16',    tier:2, icon:'▸', active:true, sacrificed:false },
  { id:'neogeo',     name:'Neo Geo',          tier:2, icon:'▸', active:true, sacrificed:false },
  { id:'segacd',     name:'Sega CD',          tier:2, icon:'▸', active:true, sacrificed:false },
  { id:'sega32x',    name:'Sega 32X',         tier:2, icon:'▸', active:true, sacrificed:false },
  // ── TIER 3 ──
  { id:'n64',        name:'Nintendo 64',      tier:3, icon:'▶', active:true, sacrificed:false },
  { id:'ps1',        name:'PlayStation',      tier:3, icon:'▶', active:true, sacrificed:false },
  { id:'gba',        name:'Game Boy Advance', tier:3, icon:'▶', active:true, sacrificed:false },
  { id:'saturn',     name:'Sega Saturn',      tier:3, icon:'▶', active:true, sacrificed:false },
  { id:'nds',        name:'Nintendo DS',      tier:3, icon:'▶', active:true, sacrificed:false },
  { id:'dreamcast',  name:'Dreamcast',        tier:3, icon:'▶', active:true, sacrificed:false },
  // ── TIER 4 ──
  { id:'ps2',        name:'PlayStation 2',    tier:4, icon:'◆', active:true, sacrificed:false },
  { id:'gamecube',   name:'GameCube',         tier:4, icon:'◆', active:true, sacrificed:false },
  { id:'xbox',       name:'Xbox',             tier:4, icon:'◆', active:true, sacrificed:false },
  { id:'psp',        name:'PSP',              tier:4, icon:'◆', active:true, sacrificed:false },
  // ── TIER 5 ──
  { id:'ps3',        name:'PlayStation 3',    tier:5, icon:'★', active:true, sacrificed:false },
  { id:'xbox360',    name:'Xbox 360',         tier:5, icon:'★', active:true, sacrificed:false },
  { id:'wii',        name:'Wii',              tier:5, icon:'★', active:true, sacrificed:false },
  { id:'wiiu',       name:'Wii U',            tier:5, icon:'★', active:true, sacrificed:false },
  { id:'switch',     name:'Nintendo Switch',  tier:5, icon:'★', active:true, sacrificed:false },
];

let SYSTEMS = loadSystemState();

function loadSystemState() {
  try {
    const saved = localStorage.getItem('kente_systems');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Always merge stored per-system data ON TOP of SYSTEMS_DEFAULT so that:
      //  • new systems added to SYSTEMS_DEFAULT appear with correct defaults
      //  • new properties (e.g. "sacrificed") are present even for old saves
      //  • user's existing active/sacrificed state is preserved
      return SYSTEMS_DEFAULT.map(def => {
        const stored = Array.isArray(parsed) ? parsed.find(s => s.id === def.id) : null;
        if (!stored) return { ...def };
        // A system that is active:true in the current defaults (e.g. newly unlocked
        // in a build update) must never be hidden by an old stored active:false.
        // Logical-OR: once the default says active, it stays active regardless of
        // what an older save said.  Explicit user sacrifices are still respected.
        return { ...def, ...stored, active: stored.active || def.active };
      });
    }
  } catch(e) {
    console.warn('[loadSystemState] Failed to parse saved system state:', e);
  }
  return SYSTEMS_DEFAULT.map(s => ({ ...s }));
}

function saveSystemState() {
  try { localStorage.setItem('kente_systems', JSON.stringify(SYSTEMS)); } catch(e) {
    console.warn('[saveSystemState]', e);
  }
}

function resetSystemState() {
  SYSTEMS = SYSTEMS_DEFAULT.map(s => ({ ...s }));
  saveSystemState();
}
