/* ═══════════════════════════════════════════════════
   KENTE'S KORNER — APPLICATION LOGIC
   kente.js v1.0 — BUILD 01
═══════════════════════════════════════════════════

   TABLE OF CONTENTS
   ─────────────────────────────────────────────────
   §01  TV Zone Configuration          (~  11)
   §02  System & ROM Extension Maps    (~ 100)
   §03  Core / BIOS Maps               (~ 200)
   §04  Settings & Defaults            (~ 300)
   §05  Cloud Browser State            (~ 430)
   §06  Cloud Download / Stream        (~ 470)
   §07  Archive.org Search             (~ 530)
   §08  IndexedDB Layers               (~ 750)
         RomDB · BiosDB · LibraryDB · DownloadDB
   §09  System State (unlock/sacrifice)(~ 940)
   §10  App Settings                   (~1100)
   §11  Kente Server Detection         (~1190)
   §12  ROM Library (OPFS scan)        (~1370)
   §13  Boot Splash                    (~1490)
   §14  TV Zone Rendering & Noise      (~1540)
   §15  Menu Shell & Navigation        (~1680)
   §16  Ticker / Accent Updates        (~1790)
   §17  Audio Engine                   (~1820)
   §18  Gamepad Manager                (~1940)
   §19  Camera / VR Manager            (~2010)
   §20  Content Renderers (per zone)   (~2060)
         Play · Collections · Memory · Sources
         Settings · Cloud · Credits · Debug
   §21  Toast Notifications            (~2700)
   §22  ROM Options Overlay            (~3140)
   §23  BIOS Picker                    (~3280)
   §24  Cloud Launch (launchFromCloud) (~3395)
   §25  Cloud Download Orchestrator    (~3555)
   §26  EmulatorJS Launcher            (~3690)
   §27  Native (Batocera) Launcher     (~3870)
   §28  Downloads Panel                (~3950)
   §29  Save Cloud ROM to Library      (~4330)
   §30  Sacrifice Chamber              (~4365)
   §31  Debug / ROM Editor             (~4490)
   §32  Boot Sequence                  (~5440)
   ─────────────────────────────────────────────────
   NOTE: This file is intentionally kept as a single
   module for zero-build-step deployability on Batocera.
   If it grows significantly beyond ~6000 lines, consider
   splitting along the section boundaries above using
   native ES module imports (no bundler required).
═══════════════════════════════════════════════════ */

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
  ps1:        ['.bin','.cue','.iso','.img','.zip','.rar'],
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

/* ══════════════════════════════════════════
   CLOUD PROVIDERS
   Pluggable cloud ROM sources. Each provider
   exposes search + file listing. Downloads
   stream directly to the local library root.
══════════════════════════════════════════ */
const CLOUD_PROVIDERS = {
  archive: {
    id:      'archive',
    name:    'INTERNET ARCHIVE',
    icon:    '🌐',
    desc:    'Free digital preservation archive — millions of titles',
    apiBase: 'https://archive.org',
  },
  vimm: {
    id:   'vimm',
    name: "VIMM'S LAIR",
    icon: '🎮',
    desc: 'Community ROM vault — curated library, fast downloads',
    type: 'link',
    sysMap: {
      nes:        'NES',     snes:       'SNES',    n64:       'N64',
      gameboy:    'GB',      gbc:        'GBC',     gba:       'GBA',
      genesis:    'Genesis', gamecube:   'GC',      wii:       'Wii',
      ps1:        'PS1',     ps2:        'PS2',     psp:       'PSP',
      saturn:     'Saturn',  dreamcast:  'DC',
      atari2600:  'Atari2600', atari7800: 'Atari7800', turbografx: 'TG16',
    },
    buildSearchUrl(sysCode, title) {
      const params = new URLSearchParams({ p: 'list' });
      if (sysCode) params.set('system', sysCode);
      if (title)   params.set('q',      title);
      return `https://vimm.net/vault/?${params}`;
    },
  },
  packs: {
    id:   'packs',
    name: 'ARCHIVE PACKS',
    icon: '📦',
    // Searchable via /api/pack/search — server queries Archive.org metadata API
    // for known per-system pack collections with individual ROM files.
    // Currently covers NES (953 ROMs) and SNES (961 ROMs).
    desc:    'Curated Archive.org ROM packs — individual files, fast results',
    type:    'packs',   // handled separately in runCloudSearch()
    buildSearchUrl(_sysCode, _title) {
      return 'https://archive.org/search?query=ROM+pack&mediatype=software';
    },
  },
  cdromance: {
    id:   'cdromance',
    name: 'CDROMANCE',
    icon: '💿',
    desc: 'Pre-patched, translated and regional ROM variants',
    type: 'link',
    buildSearchUrl(_sysCode, title) {
      return `https://cdromance.org/?s=${encodeURIComponent(title || '')}`;
    },
  },
  romheaven: {
    id:   'romheaven',
    name: 'ROMHEAVEN',
    icon: '🌤',
    desc: 'Decentralized ROM archive — fast downloads, no ads',
    type: 'link',
    buildSearchUrl(_sysCode, title) {
      return `https://romheaven.com/catalog?q=${encodeURIComponent(title || '')}`;
    },
  },
};

// Per-system Archive.org subject query fragments.
// These are matched against the item-level 'subject' field.
// Tags were determined by inspecting how real uploaders tag their archives —
// they often differ from what you'd expect (e.g. PSX not "PlayStation").
const ARCHIVE_SYS_QUERY = {
  nes:        'subject:"Nintendo Entertainment System"',
  gameboy:    'subject:"Game Boy"',
  mastersys:  'subject:"Master System"',
  atari2600:  'subject:"Atari 2600"',
  atari7800:  'subject:"Atari 7800"',
  gamegear:   'subject:"Game Gear"',
  snes:       'subject:"Super Nintendo"',
  genesis:    '(subject:"Mega Drive" OR subject:"Sega Genesis")',
  gbc:        'subject:"Game Boy Color"',
  gba:        'subject:"Game Boy Advance"',
  turbografx: '(subject:"PC Engine" OR subject:"TurboGrafx")',
  neogeo:     '(subject:"Neo-Geo" OR subject:NeoGeo)',
  // Sega CD uploaders use both "Sega CD" and "Mega CD" tags
  segacd:     '(subject:"Sega CD" OR subject:"Mega CD")',
  // 32X uploaders use both "Sega 32X" and bare "32X"
  sega32x:    '(subject:"Sega 32X" OR subject:"32X")',
  n64:        '(subject:"Nintendo 64" OR subject:N64)',
  // PSX uploaders tag with 'PSX', not 'PlayStation' — using PSX hits real disc archives
  ps1:        '(subject:PSX OR subject:"PlayStation 1")',
  // Saturn uploaders use bare 'Saturn', NOT 'Sega Saturn' — confirmed live test
  saturn:     'subject:Saturn',
  // Nintendo DS uploaders use "Nintendo DS" tag
  nds:        'subject:"Nintendo DS"',
  // Dreamcast — both bare and long form used by uploaders
  dreamcast:  '(subject:Dreamcast OR subject:"Sega Dreamcast")',
  // PSP items are often tagged 'PSP' as a bare word, and many use mediatype:data
  psp:        'subject:PSP',
  // PS2 items appear with both "PlayStation 2" and "Sony PlayStation 2" tags
  ps2:        '(subject:"PlayStation 2" OR subject:"Sony PlayStation 2")',
  gamecube:   '(subject:GameCube OR subject:"Nintendo GameCube")',
  // Wii: bare 'Wii' tag is used by uploaders — confirmed live test
  wii:        'subject:Wii',
  // Xbox original: uploaders use bare 'Xbox' tag — confirmed live test
  xbox:       'subject:Xbox',
  // Xbox 360: uploaders use both 'Xbox360' (no space) and 'Xbox 360' (space)
  xbox360:    '(subject:Xbox360 OR subject:"Xbox 360")',
  // PS3: bare 'PS3' tag is used by uploaders — confirmed live test
  ps3:        'subject:PS3',
  // Wii U: subject:"Wii U" (with space) hits real ROM uploads — confirmed live test
  wiiu:       'subject:"Wii U"',
  // Switch: file-format subjects (NSP/XCI/NSZ) are the only reliable tags on
  // Archive.org — "Nintendo Switch" and "Switch" subjects return Thingiverse
  // 3D-printing models named after games. Confirmed live test: Mario Kart 8
  // Deluxe (6.9 GB .nsp) and others are found with this query.
  switch:     '(subject:NSP OR subject:nsp OR subject:XCI OR subject:xci OR subject:NSZ OR subject:nsz)',
};

// Per-system mediatype overrides for Archive.org searches.
// Most cartridge/disc game archives are tagged mediatype:software, but some
// systems are frequently uploaded as mediatype:data instead.
// The default for any unlisted system is 'mediatype:software'.
const ARCHIVE_MEDIATYPE = {
  // All disc-based systems: ROM sets are frequently uploaded as mediatype:data
  // rather than mediatype:software. Use OR to catch both.
  psp:      '(mediatype:software OR mediatype:data)',
  ps2:      '(mediatype:software OR mediatype:data)',
  saturn:   '(mediatype:software OR mediatype:data)',
  gamecube: '(mediatype:software OR mediatype:data)',
  segacd:   '(mediatype:software OR mediatype:data)',
  sega32x:  '(mediatype:software OR mediatype:data)',
  dreamcast:'(mediatype:software OR mediatype:data)',
  wii:      '(mediatype:software OR mediatype:data)',
  xbox:     '(mediatype:software OR mediatype:data)',
  xbox360:  '(mediatype:software OR mediatype:data)',
  ps3:      '(mediatype:software OR mediatype:data)',
  wiiu:     '(mediatype:software OR mediatype:data)',
  switch:   '(mediatype:software OR mediatype:data)',
};

/* ── ARCHIVE PACK COLLECTION SEARCH ─────────────────────────────────────────
   Calls /api/pack/search on the local server. The server queries the Archive.org
   metadata API for a known per-system pack identifier, lists individual ROM files,
   fuzzy-matches by title, and returns up to 20 results as { name, url, score }.
   Currently has individual-file packs for NES and SNES; other systems return [].  */
async function searchPackCollection(title, systemId) {
  if (!KENTE_SERVER_ONLINE) return [];
  if (!title || !systemId) return [];
  try {
    const params = new URLSearchParams({ systemId, title });
    const res = await fetch(
      `${KENTE_SERVER_URL}/api/pack/search?${params}`,
      { signal: _abortTimeout(20000) },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[Kente/Pack] search error:', e.message);
    return [];
  }
}

/* ── AbortSignal.timeout() polyfill ─────────────────────────────────────────
   AbortSignal.timeout() is native in Chrome 117+, Firefox 123+, Safari 17.4+.
   Older Chromium builds (e.g. the browser bundled with some Batocera versions)
   don't have it.  This shim returns a real AbortSignal regardless of browser
   age so every fetch() call works identically everywhere.                    */
const _abortTimeout = typeof AbortSignal.timeout === 'function'
  ? (ms) => AbortSignal.timeout(ms)
  : (ms) => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(new DOMException('TimeoutError', 'TimeoutError')), ms);
      return ctrl.signal;
    };

/* ── HTML escape utility — use for any API / user data injected into innerHTML ── */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/* ── ARCHIVE.ORG API ──────────────────────────────────────── */

async function searchArchive(query, systemId) {
  const sysQ = ARCHIVE_SYS_QUERY[systemId] || '';

  // Strip characters that break Archive.org's Lucene query parser
  // (apostrophes in "Tony Hawk's", periods in "Super Mario Bros.", parens, quotes, colons)
  const cleanQ = query
    .replace(/['"():[\]{}.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const doSearch = async (parts) => {
    const q   = encodeURIComponent(parts.join(' AND '));
    const url = `https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=year&rows=40&output=json`;
    if (DEBUG) console.log(`[Kente/search] Query: ${decodeURIComponent(q)}`);
    const res = await fetch(url, { signal: _abortTimeout(12000) });
    if (!res.ok) throw new Error(`SEARCH_HTTP_${res.status}`);
    const data = await res.json();
    const docs = data.response?.docs || [];
    if (DEBUG) console.log(`[Kente/search] → ${docs.length} results`);
    return docs;
  };

  // Use the per-system mediatype override if one exists, otherwise default to
  // 'mediatype:software'.  PSP items are often tagged as 'mediatype:data'.
  const mediatype = ARCHIVE_MEDIATYPE[systemId] || 'mediatype:software';

  // Phase 1 — precise: title + system subject tag
  const phase1 = [mediatype];
  if (cleanQ) phase1.push(`title:(${cleanQ})`);
  if (sysQ)   phase1.push(sysQ);
  const r1 = await doSearch(phase1);
  if (r1.length) return r1;

  // Phase 2 — drop subject tag; keep system mediatype.
  // Many Archive.org ROM collections use collection tags instead of subject tags,
  // so removing the subject filter catches well-maintained No-Intro / Redump sets.
  if (cleanQ) {
    const phase2 = [mediatype, `title:(${cleanQ})`];
    const r2 = await doSearch(phase2);
    if (r2.length) return r2;
  }

  // Phase 3 — broaden to both mediatype:software and mediatype:data.
  // Archive.org increasingly stores large ROM packs as mediatype:data,
  // not mediatype:software.  This catches those collections for all systems.
  if (cleanQ) {
    const phase3 = ['(mediatype:software OR mediatype:data)', `title:(${cleanQ})`];
    const r3 = await doSearch(phase3);
    if (r3.length) return r3;
  }

  // Phase 4 — shortened title + any mediatype.
  // Catches long / subtitle-heavy names like "The Legend of Zelda: Majora's Mask"
  // where the full title yields no hits but the first 3 words would.
  const words = cleanQ.split(' ').filter(Boolean);
  if (words.length > 2) {
    const shortQ = words.slice(0, 3).join(' ');
    const phase4 = ['(mediatype:software OR mediatype:data)', `title:(${shortQ})`];
    const r4 = await doSearch(phase4);
    if (r4.length) return r4;
  }

  console.warn(`[Kente/search] No results found for "${query}" (${systemId})`);
  return [];
}

// systemId is optional: when provided, only files whose extension matches that
// system's ROM_EXT are returned.  When omitted (e.g. the manual cloud browser)
// the universal set of all known extensions is used as a fallback.
async function getArchiveFiles(identifier, systemId) {
  const url = `https://archive.org/metadata/${identifier}/files`;
  if (DEBUG) console.log(`[Kente/files] Fetching file list: ${identifier}`);
  const res  = await fetch(url, { signal: _abortTimeout(10000) });
  if (!res.ok) throw new Error(`FILES_HTTP_${res.status}`);
  const data = await res.json();
  const validExts = systemId
    ? new Set((ROM_EXT[systemId] || []).map(e => e.toLowerCase()))
    : new Set(Object.values(ROM_EXT).flat());
  const files = (data.result || []).filter(f => {
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    return validExts.has(ext);
  });
  if (DEBUG) console.log(`[Kente/files] ${identifier} → ${(data.result||[]).length} total files, ${files.length} ROM-eligible`);
  return files;
}

/* ── DOWNLOAD TO LIBRARY ──────────────────────────────────── */

async function downloadToLibrary(systemId, filename, url, onProgress) {
  // Helper: record this download in DownloadDB regardless of mode
  const _recordDownload = async (sizeBytes = 0) => {
    const sys = window.KenteLibrary?.games.find(g => g.systemId === systemId);
    const systemName = sys?.system || systemId.toUpperCase();
    await DownloadDB.add({
      id:           'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      filename,
      systemId,
      systemName,
      archiveUrl:   url,
      downloadedAt: Date.now(),
      sizeBytes,
    });
  };

  if (KENTE_SERVER_ONLINE) {
    // Native: server downloads directly to /userdata/roms/<system>/
    const res  = await fetch(`${KENTE_SERVER_URL}/api/download`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ systemId, filename, url }),
      signal:  _abortTimeout(30_000),
    });
    const data = await res.json();
    if (data.success) await _recordDownload();
    return data;
  }

  // ── Browser path ──────────────────────────────────────────────────────────
  // Priority:
  //  1. User-set manual library (FileSystemAccessAPI folder picked via Sources)
  //  2. OPFS auto-library (KenteKorner/roms/{systemId}/ — no prompt, always available)
  // ROMs are always stored in a per-system subfolder for clean organisation.

  const libEntry = await LibraryDB.getRoot();
  let rootHandle;
  let usingOPFS = false;

  if (libEntry?.handle) {
    // User has a manual library — verify permission before writing
    const perm = await libEntry.handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('NO_PERMISSION');
    rootHandle = libEntry.handle;
  } else if (navigator?.storage?.getDirectory) {
    // No manual library — fall back to the OPFS auto-library.
    // OPFS lives inside the browser's private storage for this origin;
    // no OS permission dialog is ever shown to the user.
    rootHandle = await getOPFSLibrary();
    usingOPFS  = true;
  } else {
    throw new Error('NO_LIBRARY');
  }

  // Write ROM to {root}/{systemId}/{filename}
  const sysFolder  = await rootHandle.getDirectoryHandle(systemId, { create: true });
  const fileHandle = await sysFolder.getFileHandle(filename, { create: true });
  const writable   = await fileHandle.createWritable();

  // Guarantee the stream is closed (or aborted) on every exit path.
  // Leaving a FileSystemWritableFileStream open locks the file in Chromium
  // and prevents any subsequent write until the page is reloaded.
  let received = 0;
  try {
    // 15-minute max per file — generous for large ISOs but prevents zombie fetches.
    const response = await fetch(url, { signal: _abortTimeout(15 * 60 * 1000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total  = parseInt(response.headers.get('Content-Length') || '0');
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.length;
      // Pass -1 when Content-Length was absent — signals indeterminate to caller
      if (onProgress) onProgress(total ? received / total : -1);
    }
    await writable.close();
  } catch (err) {
    // abort() discards the incomplete write and releases the file lock
    await writable.abort().catch(() => {});
    throw err;
  }

  // Auto-index the saved file into RomDB + ROM_STATUS
  // Same fuzzy matcher used by the library scanner — handles Archive.org filenames
  // like "Super Mario Bros. (USA).nes" → "Super Mario Bros."
  const matchedGame = findGameForDownload(systemId, filename);
  if (matchedGame) {
    await RomDB.set(matchedGame.id, fileHandle, filename);
    ROM_STATUS[matchedGame.id] = true;
    refreshGameCardDots();
  }

  // Record in DownloadDB — note where the file ended up for the downloads panel
  const sys = window.KenteLibrary?.games.find(g => g.systemId === systemId);
  await DownloadDB.add({
    id:           'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    filename,
    systemId,
    systemName:   sys?.system || systemId.toUpperCase(),
    archiveUrl:   url,
    downloadedAt: Date.now(),
    sizeBytes:    received,
    storage:      usingOPFS ? 'opfs' : 'library',
  });

  console.log(`[Kente] ROM saved to ${usingOPFS ? 'OPFS' : 'manual library'}: ${systemId}/${filename}`);
  // Return fileHandle so startCloudDownload can offer PLAY NOW for unlisted ROMs
  return { success: true, fileHandle };
}

/* ── CLOUD BROWSER UI ─────────────────────────────────────── */

let _cloudState = { providerId: 'archive', systemId: null, activeResult: null };

function openCloudBrowser(providerId = 'archive', preTitle = '', preSystemId = null) {
  const provider = CLOUD_PROVIDERS[providerId];
  if (!provider) return;
  _cloudState = { providerId, systemId: preSystemId, activeResult: null };

  const overlay = document.getElementById('cloud-overlay');
  document.getElementById('cloud-provider-icon').textContent = provider.icon;
  document.getElementById('cloud-provider-name').textContent = provider.name;
  document.getElementById('cloud-provider-desc').textContent = provider.desc;
  document.getElementById('cloud-close').onclick = () => overlay.classList.remove('active');
  overlay.classList.add('active');
  requestAnimationFrame(() => GamepadManager.applyFocus(0));

  // Link-type providers (e.g. Vimm's Lair) — no API; show a manual search/redirect UI
  if (provider.type === 'link') {
    _openLinkProviderBrowser(provider, preTitle, preSystemId);
    return;
  }

  // ── Archive.org API provider ──────────────────────────────────────────────

  // Build system chips from systems that have a query mapping
  const systemsEl = document.getElementById('cloud-systems');
  const chipSystems = SYSTEMS.filter(s => ARCHIVE_SYS_QUERY[s.id] && !s.sacrificed);
  systemsEl.innerHTML = chipSystems.map(s => `
    <button class="cloud-sys-chip${preSystemId === s.id ? ' active' : ''}"
            data-sys="${s.id}">${s.name.toUpperCase()}</button>`).join('');

  systemsEl.querySelectorAll('.cloud-sys-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      systemsEl.querySelectorAll('.cloud-sys-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      _cloudState.systemId = chip.dataset.sys;
      runCloudSearch();
    });
  });

  // Search bar
  const input = document.getElementById('cloud-search-input');
  input.value = preTitle;
  document.getElementById('cloud-search-btn').onclick = runCloudSearch;
  input.onkeydown = e => { if (e.key === 'Enter') runCloudSearch(); };

  // Reset panes
  document.getElementById('cloud-results-list').innerHTML = '<p class="cloud-empty">SELECT A SYSTEM OR SEARCH.</p>';
  document.getElementById('cloud-files-list').innerHTML   = '<p class="cloud-empty">SELECT A RESULT TO SEE FILES.</p>';

  // Fully reset the download bar so state from a previous session doesn't bleed through
  const _bar  = document.getElementById('cloud-download-bar');
  const _fill = document.getElementById('cloud-progress-fill');
  const _pnb  = document.getElementById('cloud-play-now-btn');
  _bar.classList.add('hidden');
  _fill.style.width = '0%';
  _fill.classList.remove('indeterminate');
  document.getElementById('cloud-download-pct').textContent   = '0%';
  document.getElementById('cloud-download-label').textContent = 'DOWNLOADING...';
  _pnb.hidden      = true;
  _pnb.textContent = '▶ PLAY NOW';
  _pnb.onclick     = null;

  if (preTitle || preSystemId) runCloudSearch();
}

/* Renders the manual search / redirect UI for link-type providers (Vimm's Lair, etc.).
   System chips come from the provider's own sysMap.
   Search button opens the provider's site in a new tab — no API calls made.          */
function _openLinkProviderBrowser(provider, preTitle = '', preSystemId = null) {
  const systemsEl = document.getElementById('cloud-systems');
  const entries   = Object.entries(provider.sysMap || {});

  systemsEl.innerHTML = entries.map(([sysId, sysCode]) => {
    const sys = SYSTEMS.find(s => s.id === sysId);
    const label = sys ? sys.name.toUpperCase() : sysId.toUpperCase();
    return `<button class="cloud-sys-chip${preSystemId === sysId ? ' active' : ''}"
              data-sys="${sysId}" data-syscode="${escHtml(sysCode)}">${label}</button>`;
  }).join('');

  systemsEl.querySelectorAll('.cloud-sys-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      systemsEl.querySelectorAll('.cloud-sys-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      _cloudState.systemId  = chip.dataset.sys;
      _cloudState._sysCode  = chip.dataset.syscode;
    });
  });

  const input = document.getElementById('cloud-search-input');
  input.value = preTitle;

  const openSite = () => {
    const title      = input.value.trim();
    const activeChip = systemsEl.querySelector('.cloud-sys-chip.active');
    const sysCode    = activeChip ? activeChip.dataset.syscode : '';
    const url        = provider.buildSearchUrl(sysCode, title);
    window.open(url, '_blank', 'noopener');
    showToast(`↗ OPENED ${provider.name.toUpperCase()} IN NEW TAB`);
  };

  document.getElementById('cloud-search-btn').onclick = openSite;
  input.onkeydown = e => { if (e.key === 'Enter') openSite(); };

  // Replace the two-pane search layout with a single instruction + open button
  document.getElementById('cloud-results-list').innerHTML = `
    <div style="padding:28px 20px;text-align:center;font-family:var(--font-mono)">
      <div style="color:#2a2a2a;font-size:10px;letter-spacing:0.15em;line-height:2.4;max-width:260px;margin:0 auto 20px">
        SELECT A SYSTEM ABOVE AND ENTER A TITLE,<br>
        THEN CLICK OPEN TO SEARCH ${escHtml(provider.name.toUpperCase())} IN YOUR BROWSER.
      </div>
      <button id="link-provider-open-btn"
        style="width:100%;background:#0a1a0a;border:1px solid #1a3a1a;color:#30d880;
               font-family:var(--font-mono);font-size:10px;letter-spacing:0.2em;
               padding:16px 0;cursor:pointer;margin-bottom:12px">
        ↗ &nbsp;OPEN ON ${escHtml(provider.name.toUpperCase())}
      </button>
      <div style="color:#1a1a1a;font-size:9px;letter-spacing:0.1em;line-height:2.2">
        DOWNLOAD THE ROM FILE FROM THEIR SITE.<br>
        THEN PRESS ✕ EXIT AND USE<br>
        LOAD ROM FILE TO PLAY.
      </div>
    </div>`;

  document.getElementById('cloud-files-list').innerHTML = `
    <div style="padding:28px 20px;text-align:center;font-family:var(--font-mono);
                color:#1e1e1e;font-size:9px;letter-spacing:0.12em;line-height:2.5">
      ${escHtml(provider.name.toUpperCase())} IS A MANUAL DOWNLOAD SITE.<br>
      THEIR LIBRARY IS WELL-CURATED AND FAST.<br>
      NO ACCOUNT REQUIRED FOR MOST TITLES.
    </div>`;

  document.getElementById('cloud-download-bar').classList.add('hidden');
  document.getElementById('link-provider-open-btn').addEventListener('click', openSite);
}

// Monotonically-incrementing counter — lets concurrent searches detect staleness.
// If the user clicks Search twice quickly, the first response is discarded.
let _cloudSearchGen = 0;

async function runCloudSearch() {
  const gen     = ++_cloudSearchGen;
  const input   = document.getElementById('cloud-search-input');
  const resList = document.getElementById('cloud-results-list');
  const query   = input.value.trim();

  if (!query && !_cloudState.systemId) {
    resList.innerHTML = '<p class="cloud-empty">PICK A SYSTEM CHIP ABOVE OR TYPE A TITLE TO SEARCH.</p>';
    return;
  }

  resList.innerHTML = '<p class="cloud-empty">SEARCHING...</p>';
  document.getElementById('cloud-files-list').innerHTML = '<p class="cloud-empty">SELECT A RESULT TO SEE FILES.</p>';

  // ── Archive Pack Collections: direct file results, no two-step flow ──
  if (_cloudState.providerId === 'packs') {
    try {
      if (!KENTE_SERVER_ONLINE) {
        resList.innerHTML = '<p class="cloud-empty">KENTE SERVER REQUIRED FOR PACK SEARCH.</p>'; return;
      }
      const files = await searchPackCollection(query, _cloudState.systemId);
      if (_cloudSearchGen !== gen) return;
      if (!files.length) {
        resList.innerHTML = '<p class="cloud-empty">NO RESULTS IN PACK. NES AND SNES ARE SUPPORTED — TRY ARCHIVE.ORG FOR OTHER SYSTEMS.</p>';
        return;
      }
      resList.innerHTML = files.map(f => `
        <div class="cloud-result-row" data-direct-url="${escHtml(f.url)}" data-fname="${escHtml(f.name)}">
          <div class="cloud-result-title">${escHtml(f.name)}</div>
          <div class="cloud-result-meta">ARCHIVE PACK · DIRECT DOWNLOAD</div>
        </div>`).join('');

      resList.querySelectorAll('.cloud-result-row').forEach(row => {
        row.addEventListener('click', () => {
          resList.querySelectorAll('.cloud-result-row').forEach(r => r.classList.remove('active'));
          row.classList.add('active');
          const url   = row.dataset.directUrl;
          const fname = row.dataset.fname;
          const sid   = _cloudState.systemId || 'nes';
          const filesEl = document.getElementById('cloud-files-list');
          filesEl.innerHTML = `
            <div class="cloud-file-row" data-fname="${escHtml(fname)}" data-direct-url="${escHtml(url)}">
              <span class="cloud-file-name">${escHtml(fname)}</span>
              <span class="cloud-file-size">—</span>
              <button class="cloud-dl-btn">↓ SAVE</button>
            </div>`;
          filesEl.querySelector('.cloud-dl-btn')?.addEventListener('click', () => {
            startCloudDownload(sid, fname, url,
              filesEl.querySelector('.cloud-dl-btn'));
          });
        });
      });
    } catch {
      resList.innerHTML = '<p class="cloud-empty">ARCHIVE PACKS SEARCH FAILED — CHECK CONNECTION.</p>';
    }
    return;
  }

  // ── Archive.org (default) ─────────────────────────────────────
  try {
    const results = await searchArchive(query, _cloudState.systemId);
    if (_cloudSearchGen !== gen) return;
    if (!results.length) {
      resList.innerHTML = '<p class="cloud-empty">NO RESULTS ON ARCHIVE.ORG. TRY THE ARCHIVE PACKS SOURCE (NES/SNES), VIMM\'S LAIR, CDROMANCE, OR ROMHEAVEN.</p>';
      return;
    }
    resList.innerHTML = results.map(r => `
      <div class="cloud-result-row" data-id="${escHtml(r.identifier)}">
        <div class="cloud-result-title">${escHtml(r.title || r.identifier)}</div>
        <div class="cloud-result-meta">${escHtml(r.identifier)}${r.year ? ' · ' + escHtml(r.year) : ''}</div>
      </div>`).join('');

    resList.querySelectorAll('.cloud-result-row').forEach(row => {
      row.addEventListener('click', async () => {
        resList.querySelectorAll('.cloud-result-row').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        _cloudState.activeResult = row.dataset.id;
        await loadCloudFiles(row.dataset.id);
      });
    });
  } catch {
    resList.innerHTML = '<p class="cloud-empty">SEARCH FAILED — CHECK CONNECTION.</p>';
  }
}

async function loadCloudFiles(identifier) {
  const filesEl = document.getElementById('cloud-files-list');
  filesEl.innerHTML = '<p class="cloud-empty">LOADING FILES...</p>';
  try {
    const files = await getArchiveFiles(identifier);
    if (!files.length) {
      filesEl.innerHTML = '<p class="cloud-empty">NO ROM FILES FOUND IN THIS ARCHIVE.</p>';
      return;
    }
    filesEl.innerHTML = files.map(f => {
      const sizeMB = f.size ? (parseInt(f.size) / 1048576).toFixed(1) + ' MB' : '—';
      return `<div class="cloud-file-row" data-fname="${escHtml(f.name)}" data-id="${escHtml(identifier)}">
        <span class="cloud-file-name">${escHtml(f.name)}</span>
        <span class="cloud-file-size">${sizeMB}</span>
        <button class="cloud-dl-btn">↓ SAVE</button>
      </div>`;
    }).join('');

    filesEl.querySelectorAll('.cloud-file-row').forEach(row => {
      row.querySelector('.cloud-dl-btn').addEventListener('click', () => {
        const fname = row.dataset.fname;
        const url   = `https://archive.org/download/${row.dataset.id}/${encodeURIComponent(fname)}`;
        const ext   = '.' + fname.split('.').pop().toLowerCase();
        // Best-guess system from active chip or URL ext match
        const sid   = _cloudState.systemId ||
          Object.entries(ROM_EXT).find(([, exts]) => exts.includes(ext))?.[0] || 'nes';
        startCloudDownload(sid, fname, url, row.querySelector('.cloud-dl-btn'));
      });
    });
  } catch {
    filesEl.innerHTML = '<p class="cloud-empty">COULD NOT LOAD FILES.</p>';
  }
}

/**
 * Fuzzy-match a downloaded filename + systemId to a KenteLibrary game.
 * Returns the game object or null.
 */
function findGameForDownload(systemId, filename) {
  const norm     = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const baseName = norm(filename.replace(/\.[^.]+$/, ''));
  return window.KenteLibrary?.games.find(g => {
    if (g.systemId !== systemId) return false;
    const t = norm(g.title);
    return t === baseName || baseName.includes(t) || t.includes(baseName);
  }) || null;
}

async function startCloudDownload(systemId, filename, url, btn) {
  const bar        = document.getElementById('cloud-download-bar');
  const fill       = document.getElementById('cloud-progress-fill');
  const pct        = document.getElementById('cloud-download-pct');
  const label      = document.getElementById('cloud-download-label');
  const playNowBtn = document.getElementById('cloud-play-now-btn');

  // Reset play button from any previous download
  playNowBtn.hidden  = true;
  playNowBtn.onclick = null;

  btn.classList.add('busy');
  bar.classList.remove('hidden');
  label.textContent = `DOWNLOADING ${filename}`;
  fill.style.width  = '0%';
  pct.textContent   = '0%';

  try {
    const result = await downloadToLibrary(systemId, filename, url, progress => {
      if (progress < 0) {
        // No Content-Length header — show animated indeterminate bar
        fill.classList.add('indeterminate');
        pct.textContent = '···';
      } else {
        fill.classList.remove('indeterminate');
        const p = Math.round(progress * 100);
        fill.style.width = p + '%';
        pct.textContent  = p + '%';
      }
    });

    btn.classList.remove('busy');
    btn.classList.add('success');
    btn.textContent   = '✓ SAVED';
    label.textContent = `✓ ${filename} SAVED`;
    fill.classList.remove('indeterminate');
    fill.style.width  = '100%';
    pct.textContent   = '100%';

    // ── PLAY NOW logic ────────────────────────────────────────
    const game = findGameForDownload(systemId, filename);
    if (game) {
      // Matched catalog entry — use RomDB handle or returned fileHandle, then stream URL as last resort
      playNowBtn.hidden      = false;
      playNowBtn.textContent = '▶ PLAY NOW';
      playNowBtn.onclick     = async () => {
        document.getElementById('cloud-overlay').classList.remove('active');
        playNowBtn.hidden = true;
        // Native mode: ROM was saved to server disk — hand off to Batocera
        if (KENTE_SERVER_ONLINE) { launchNative(game); return; }
        // Browser mode: prefer indexed handle → downloaded fileHandle → cloud stream
        const handle = await RomDB.get(game.id) || result?.fileHandle || null;
        if (handle) {
          launchWithEmulatorJS(game, handle);
        } else {
          launchWithEmulatorJS(game, url, { url, filename, systemId });
        }
      };
    } else if (result?.fileHandle && CORE_MAP[systemId]) {
      // File saved but not in catalog — build a minimal game object and play from handle
      const unlisted = {
        id:       `dl_${Date.now()}`,
        title:    filename.replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').trim(),
        system:   systemId.toUpperCase(),
        systemId,
      };
      playNowBtn.hidden      = false;
      playNowBtn.textContent = '▶ PLAY (UNLISTED)';
      playNowBtn.onclick     = () => {
        document.getElementById('cloud-overlay').classList.remove('active');
        playNowBtn.hidden = true;
        launchWithEmulatorJS(unlisted, result.fileHandle);
      };
    }

    KenteAudio.powerUp?.();
  } catch (err) {
    btn.classList.remove('busy');
    fill.classList.remove('indeterminate');
    playNowBtn.hidden = true;

    if (err.message === 'NO_LIBRARY' || err.message === 'NO_PERMISSION') {
      // No library folder — offer streaming as fallback instead of a dead end
      const game = findGameForDownload(systemId, filename);
      if (game) {
        bar.classList.remove('hidden');
        fill.style.width  = '0%';
        pct.textContent   = '';
        label.textContent = '⚠ NO LIBRARY — CANNOT SAVE TO DISK';
        playNowBtn.hidden      = false;
        playNowBtn.textContent = '▶ STREAM INSTEAD';
        playNowBtn.onclick     = () => {
          document.getElementById('cloud-overlay').classList.remove('active');
          playNowBtn.hidden = true;
          launchWithEmulatorJS(game, url, { url, filename, systemId });
        };
        showToast('⚠ STORAGE UNAVAILABLE — STREAM INSTEAD OR CHECK BROWSER PERMISSIONS');
      } else {
        bar.classList.add('hidden');
        showToast('⚠ DOWNLOAD FAILED — BROWSER STORAGE UNAVAILABLE');
      }
    } else {
      bar.classList.add('hidden');
      showToast(`⚠ DOWNLOAD FAILED — ${err.message.slice(0, 80)}`);
    }
  }
}

/* ── NATIVE SERVER ──
   When running inside Batocera, kente-server.py runs on localhost:7777.
   KENTE_SERVER_ONLINE  — server is reachable (enables CORS proxy, disk-saves, pack search)
   serverIsBatocera     — server is actually on Batocera (enables native emulatorlauncher)
   On Windows dev machines the server is online but NOT Batocera, so browser EmulatorJS is
   used for CORE_MAP systems and native-only systems show the "Add to Batocera" screen. */
const KENTE_SERVER_URL  = 'http://localhost:7777';
let   KENTE_SERVER_ONLINE  = false;
let   serverIsBatocera     = false;  // true only on real Batocera/Linux — from ping batocera field
let   serverIsElectron     = false;  // true when running inside the packaged Electron desktop app
let   serverPlatform       = null;   // 'Windows' | 'Linux' | 'Darwin' — set by detectKenteServer
let   _nativeAppPoll       = null;   // setInterval handle for native-exe process polling

/* ══════════════════════════════════════════
   BIOS REQUIREMENTS MAP
   required:true  = emulator will not boot without it
   required:false = optional but improves compatibility
══════════════════════════════════════════ */
const BIOS_MAP = {
  gba:       { required: false, filename: 'gba_bios.bin',      label: 'GBA BIOS'           },
  gameboy:   { required: false, filename: 'gb_bios.bin',       label: 'Game Boy BIOS'      },
  gbc:       { required: false, filename: 'gbc_bios.bin',      label: 'GBC BIOS'           },
  // NDS BIOS is optional — desmume2015 runs without it, but supplying bios7.bin
  // unlocks the melonDS core which has significantly better accuracy & wifi support.
  // The user imports bios7.bin via the BIOS settings panel; launchWithEmulatorJS
  // automatically promotes the core to melonds when this file is present.
  nds:       { required: false, filename: 'bios7.bin',         label: 'NDS BIOS (unlocks melonDS)' },
  ps1:       { required: false, filename: 'scph1001.bin',      label: 'PlayStation BIOS'   },
  saturn:    { required: true,  filename: 'saturn_bios.bin',   label: 'Saturn BIOS'        },
  dreamcast: { required: true,  filename: 'dc_boot.bin',       label: 'Dreamcast Boot ROM' },
  neogeo:    { required: true,  filename: 'neogeo.zip',        label: 'Neo Geo BIOS'       },
  mastersys: { required: false, filename: 'bios_U.sms',        label: 'Master System BIOS' },
  atari7800: { required: false, filename: '7800 BIOS (U).rom', label: 'Atari 7800 BIOS'   },
};

/* ══════════════════════════════════════════
   ROMDB — IndexedDB file handle persistence
══════════════════════════════════════════ */
// RomDB lives in js/rom_db.js, loaded by index.html before kente.js.  The
// global symbol is available here without redeclaration.

/* ══════════════════════════════════════════
   BIOSDB — IndexedDB BIOS handle persistence
   Keyed by systemId (one BIOS slot per system)
══════════════════════════════════════════ */
const BiosDB = (() => {
  const DB_NAME = 'kente_bios', STORE = 'handles', VER = 1;
  let db = null;

  function open() {
    return new Promise((res, rej) => {
      if (db) return res(db);
      const req = indexedDB.open(DB_NAME, VER);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE, { keyPath: 'systemId' });
      req.onsuccess = e => { db = e.target.result; res(db); };
      req.onerror   = () => rej(req.error);
    });
  }

  async function get(systemId) {
    const db  = await open();
    return new Promise(res => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(systemId);
      req.onsuccess = () => res(req.result?.handle || null);
      req.onerror   = () => res(null);
    });
  }

  async function set(systemId, handle, fileName) {
    try {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = res;
        tx.onerror    = () => rej(tx.error);
        tx.onabort    = () => rej(new Error('IDB transaction aborted'));
        tx.objectStore(STORE).put({ systemId, handle, fileName, savedAt: Date.now() });
      });
    } catch (err) {
      console.warn('[BiosDB] set failed:', err.message);
    }
  }

  async function remove(systemId) {
    try {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(systemId);
    } catch (err) {
      console.warn('[BiosDB] remove failed:', err.message);
    }
  }

  return { get, set, remove };
})();

/* ══════════════════════════════════════════
   LIBRARYDB — IndexedDB ROM library root
   Stores one directory handle (the user's ROM
   library root folder) so it persists across
   sessions. Keyed by the fixed string 'root'.
══════════════════════════════════════════ */
const LibraryDB = (() => {
  const DB_NAME = 'kente_library', STORE = 'root', VER = 1;
  let db = null;

  function open() {
    return new Promise((res, rej) => {
      if (db) return res(db);
      const req = indexedDB.open(DB_NAME, VER);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = e => { db = e.target.result; res(db); };
      req.onerror   = () => rej(req.error);
    });
  }

  async function getRoot() {
    const db = await open();
    return new Promise(res => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('root');
      req.onsuccess = () => res(req.result || null);   // {id,handle,name,setAt}
      req.onerror   = () => res(null);
    });
  }

  async function setRoot(handle) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
      tx.objectStore(STORE).put({ id: 'root', handle, name: handle.name, setAt: Date.now() });
    });
  }

  async function clear() {
    try {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('root');
    } catch(e) {
      console.warn('[LibraryDB.clear]', e);
    }
  }

  return { getRoot, setRoot, clear };
})();

/* ══════════════════════════════════════════
   OPFS AUTO-LIBRARY
   Origin Private File System — the browser's
   built-in private storage. No picker prompt,
   no permission request. ROMs are saved to:
     KenteKorner/roms/{systemId}/{filename}
   and indexed into RomDB automatically.
══════════════════════════════════════════ */

/** Returns the KenteKorner OPFS root directory handle, creating it if needed. */
async function getOPFSLibrary() {
  const storageRoot = await navigator.storage.getDirectory();
  const kenteRoot   = await storageRoot.getDirectoryHandle('KenteKorner', { create: true });
  return await kenteRoot.getDirectoryHandle('roms', { create: true });
}

/**
 * Scans the OPFS ROM library (KenteKorner/roms/{systemId}/{file})
 * and indexes any recognised ROMs into RomDB + ROM_STATUS.
 * Called at boot and after every OPFS download.
 */
async function scanOPFSLibrary() {
  if (!navigator?.storage?.getDirectory) return;
  try {
    const romsRoot   = await getOPFSLibrary();
    const validExts  = new Set(Object.values(ROM_EXT).flat());
    const lib        = window.KenteLibrary;
    if (!lib) return;
    let indexed = 0;

    for await (const [systemId, sysDir] of romsRoot.entries()) {
      if (sysDir.kind !== 'directory') continue;
      const sysExts = new Set(ROM_EXT[systemId] || []);
      const eligible = lib.games.filter(g => g.systemId === systemId);
      if (!eligible.length) continue;

      for await (const [name, handle] of sysDir.entries()) {
        if (handle.kind !== 'file') continue;
        const ext = '.' + name.split('.').pop().toLowerCase();
        if (!validExts.has(ext) || !sysExts.has(ext)) continue;
        // Skip if already indexed in this session
        const matchedGame = matchRomToGame(name, eligible);
        if (matchedGame && !ROM_STATUS[matchedGame.id]) {
          await RomDB.set(matchedGame.id, handle, name);
          ROM_STATUS[matchedGame.id] = true;
          indexed++;
        }
      }
    }
    if (indexed > 0) {
      refreshGameCardDots();
      console.log(`[Kente] OPFS scan indexed ${indexed} ROM${indexed !== 1 ? 's' : ''}`);
    }
  } catch (e) {
    console.warn('[scanOPFSLibrary]', e);
  }
}

/* ══════════════════════════════════════════
   DOWNLOADDB — tracks ROMs saved from Archive.org
   Each record: { id, filename, systemId, systemName,
                  archiveUrl, downloadedAt, sizeBytes }
══════════════════════════════════════════ */
const DownloadDB = (() => {
  const DB_NAME = 'kente_downloads', STORE = 'downloads', VER = 1;
  let db = null;

  function open() {
    return new Promise((res, rej) => {
      if (db) return res(db);
      const req = indexedDB.open(DB_NAME, VER);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = e => { db = e.target.result; res(db); };
      req.onerror   = () => rej(req.error);
    });
  }

  async function add(record) {
    try {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = res;
        tx.onerror    = () => rej(tx.error);
        tx.objectStore(STORE).put(record);
      });
    } catch (err) {
      console.warn('[DownloadDB] add failed:', err.message);
    }
  }

  async function getAll() {
    const db = await open();
    return new Promise(res => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => res([]);
    });
  }

  async function remove(id) {
    try {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
    } catch (err) {
      console.warn('[DownloadDB] remove failed:', err.message);
    }
  }

  return { add, getAll, remove };
})();

/* ══════════════════════════════════════════
   ROM SOURCE LEDGER
   Per-provider success/fail counters in localStorage. Used to bias the order
   in which the DownloadManager tries sources returned by /api/roms/sources.
   Mirrors the theater source-scoring engine.
══════════════════════════════════════════ */
const RomSourceLedger = (() => {
  const KEY = 'kente.roms.sourceScores';
  let _cache = null;
  function _load() {
    if (_cache) return _cache;
    try { _cache = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
    catch { _cache = {}; }
    return _cache;
  }
  function _save() { try { localStorage.setItem(KEY, JSON.stringify(_cache || {})); } catch {} }
  function entry(name) {
    const c = _load();
    if (!c[name]) c[name] = { success: 0, fail: 0 };
    return c[name];
  }
  return {
    onSuccess(name) { if (!name) return; entry(name).success += 1; _save(); },
    onFail(name)    { if (!name) return; entry(name).fail    += 1; _save(); },
    score(name) {
      const e = entry(name);
      // Mild bias: +1 per success, -2 per fail. Capped to ±0.5 to avoid drowning
      // out the per-candidate score from /api/roms/sources.
      const raw = e.success - 2 * e.fail;
      return Math.max(-0.5, Math.min(0.5, raw * 0.05));
    },
    all() { return { ..._load() }; },
  };
})();

/* Resolve ranked source candidates for a (systemId, title) via the new
   /api/roms/sources endpoint. Returns [] on failure so callers can fall back
   to the legacy archive-only search path.                                  */
async function fetchRomSources(systemId, title) {
  if (!KENTE_SERVER_ONLINE || !systemId || !title) return [];
  try {
    const params = new URLSearchParams({ systemId, title, limit: '20' });
    const res = await fetch(`${KENTE_SERVER_URL}/api/roms/sources?${params}`,
                            { signal: _abortTimeout(20000) });
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data?.sources) ? data.sources : [];
    // Blend ledger bias into the server's score so historically-reliable hosts
    // float to the top within the same /api response.
    list.forEach(c => { c._scoreBlended = (c.score || 0) + RomSourceLedger.score(c.provider); });
    list.sort((a, b) => (b._scoreBlended || 0) - (a._scoreBlended || 0));
    return list;
  } catch (e) {
    if (DEBUG) console.warn('[Kente/dl/sources] fetch failed:', e.message);
    return [];
  }
}

/* ══════════════════════════════════════════
   DOWNLOAD MANAGER
   Background download queue — fans out across rom_providers via
   /api/roms/sources, streams each ROM through kente-server's proxy
   (which saves it to disk), and auto-falls-back to the next source on
   any download error. Adaptive ledger learns which hosts are reliable.
   One download at a time; completed items persist to DownloadDB.
══════════════════════════════════════════ */
const DownloadManager = (() => {
  // item shape: { id, game, status, progress, total, filename, archiveUrl, error,
  //              _reader, _attempt, _speedMBs, _etaSec, _lastBytes, _lastTime, _dlAt }
  // status: 'queued' | 'searching' | 'downloading' | 'complete' | 'error'
  let _items      = [];
  let _busy       = false;
  let _rafPending = false;  // throttle panel re-renders to one per animation frame

  const MAX_AUTO_RETRIES = 2;
  const RETRY_DELAY_MS   = 3000;
  const STREAM_CHUNK_TIMEOUT_MS = 45_000;   // 45s no-data → retry
  const PROXY_FETCH_TIMEOUT_MS  = 15 * 60 * 1000;  // 15 min total per file

  function _uid() {
    return 'dl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  }

  function _mkItem(id, game) {
    return { id, game, status: 'queued', progress: 0, total: 0,
             filename: null, archiveUrl: null, sourceName: null, error: null, _reader: null,
             _sources: null, _sourceIdx: null, _activeSource: null,
             _attempt: 0, _speedMBs: 0, _etaSec: null, _lastBytes: 0, _lastTime: 0, _dlAt: null };
  }

  /* ── classify errors into user-readable messages ── */
  function _classifyError(err, httpStatus) {
    if (err.name === 'AbortError') return null;          // caller handles cancelled
    if (httpStatus === 403)  return 'BLOCKED BY ARCHIVE.ORG';
    if (httpStatus === 404)  return 'FILE NOT FOUND ON ARCHIVE.ORG';
    if (httpStatus === 429)  return 'RATE LIMITED — TRY AGAIN LATER';
    if (httpStatus === 502 || httpStatus === 503) return 'PROXY ERROR — ARCHIVE UNREACHABLE';
    if (httpStatus >= 400)   return `SERVER ERROR HTTP ${httpStatus}`;
    const msg = err.message || '';
    if (msg.includes('TIMEOUT') || msg.includes('timeout')) return 'DOWNLOAD STALLED — RETRYING';
    if (msg.includes('NO_STREAM'))   return 'PROXY RETURNED NO DATA STREAM';
    if (msg.includes('INCOMPLETE'))  return `TRANSFER INCOMPLETE — RETRYING`;
    if (msg.includes('HTTP_'))       return `PROXY ERROR — ${msg}`;
    return 'NETWORK ERROR — CHECK CONNECTION';
  }

  /* ── enqueue: add a game to the background download queue ── */
  async function enqueue(game) {
    if (_items.find(i => i.game.id === game.id && i.status !== 'error')) {
      showToast(`⬇ ${game.title.toUpperCase()} IS ALREADY IN THE QUEUE`);
      openDownloadCenter();
      return;
    }
    const id = _uid();
    _items.push(_mkItem(id, game));
    _notify();
    showToast(`⬇ QUEUED — ${game.title.toUpperCase()}`);
    _tick();
    return id;
  }

  /* ── cancel: stop and remove any item ── */
  function cancel(id) {
    const item = _items.find(i => i.id === id);
    if (!item) return;
    if (item._reader) { item._reader.cancel().catch(() => {}); item._reader = null; }
    _items = _items.filter(i => i.id !== id);
    if (['searching','downloading'].includes(item.status)) { _busy = false; _tick(); }
    _notify();
  }

  /* ── remove: delete a completed/errored entry from panel + IndexedDB ── */
  async function remove(id) {
    _items = _items.filter(i => i.id !== id);
    await DownloadDB.remove(id).catch(() => {});
    _notify();
  }

  /* ── retry (manual): re-queue a failed item ── */
  function retry(id) {
    const item = _items.find(i => i.id === id && i.status === 'error');
    if (!item) return;
    Object.assign(item, {
      status: 'queued', progress: 0, total: 0, error: null, _attempt: 0,
      _sources: null, _sourceIdx: null, _activeSource: null, sourceName: null,
    });
    _notify();
    _tick();
  }

  /* ── cycleSource: user pressed the SOURCE pill on an active/errored card ──
     Advances to the next ranked candidate, restarts the download.            */
  function cycleSource(id) {
    const item = _items.find(i => i.id === id);
    if (!item || !item._sources?.length) return;
    item._sourceIdx = ((item._sourceIdx || 0) + 1) % item._sources.length;
    if (item._reader) { item._reader.cancel().catch(() => {}); item._reader = null; }
    Object.assign(item, { status: 'queued', progress: 0, total: 0, error: null });
    _notify();
    if (!_busy) _tick();
    else _download(item);  // resume in-place if currently the active item
  }

  /* ── clearCompleted: remove all READY TO PLAY entries ── */
  async function clearCompleted() {
    const done = _items.filter(i => i.status === 'complete');
    if (!done.length) return;
    _items = _items.filter(i => i.status !== 'complete');
    await Promise.all(done.map(i => DownloadDB.remove(i.id).catch(() => {})));
    _notify();
    try { _refreshRecentDownloadsShelf(); } catch {}
    try { showToast(`✕ CLEARED ${done.length} DOWNLOAD${done.length!==1?'S':''}`); } catch {}
  }

  /* ── _tick: start next queued item ── */
  async function _tick() {
    if (_busy) return;
    const next = _items.find(i => i.status === 'queued');
    if (!next) return;
    _busy = true;
    try {
      await _download(next);
    } finally {
      // Always clear the flag — even if _download() throws an unexpected exception
      // that wasn't caught internally.  Without this the queue freezes permanently.
      _busy = false;
      _tick();
    }
  }

  /* ── Shared helpers for stream + completion (used by both new fast path
        and legacy archive-only path inside _download)                    */
  async function _streamBodyInto(item, resp) {
    item.total   = Number(resp.headers.get('Content-Length')) || item.total || 0;
    item._reader = resp.body.getReader();
    const _timedRead = r => Promise.race([
      r.read(),
      new Promise((_, rej) =>
        setTimeout(() => rej(Object.assign(new Error('STREAM_TIMEOUT'), { name: 'TimeoutError' })),
                   STREAM_CHUNK_TIMEOUT_MS)),
    ]);
    while (true) {
      const { done, value } = await _timedRead(item._reader);
      if (done) break;
      item.progress += value.length;
      const now = Date.now();
      if (now - item._lastTime >= 800) {
        const dt = (now - item._lastTime) / 1000;
        const db = item.progress - item._lastBytes;
        item._speedMBs = db / dt / 1_048_576;
        item._lastBytes = item.progress;
        item._lastTime = now;
        if (item._speedMBs > 0 && item.total)
          item._etaSec = (item.total - item.progress) / (item._speedMBs * 1_048_576);
      }
      _notify();
    }
    item._reader = null;
    if (item.total > 0 && item.progress < item.total * 0.95) {
      throw new Error(`INCOMPLETE (${(item.progress/1_048_576).toFixed(0)}/${(item.total/1_048_576).toFixed(0)} MB)`);
    }
  }

  async function _markDownloadComplete(item) {
    item.status    = 'complete';
    item._speedMBs = 0; item._etaSec = null; item._dlAt = Date.now();
    ROM_STATUS[item.game.id] = true;
    refreshGameCardDots();
    if (item.sourceName) RomSourceLedger.onSuccess(item.sourceName);
    _notify();
    // Live-refresh the Recently Downloaded shelf if the user is on Play/Collections
    try { _refreshRecentDownloadsShelf(); } catch {}
    showToast(`✓ READY TO PLAY — ${item.game.title.toUpperCase()}`);
    await DownloadDB.add({
      id: item.id, gameId: item.game.id, game: item.game,
      filename: item.filename, systemId: item.game.systemId,
      systemName: item.game.system || item.game.systemId.toUpperCase(),
      archiveUrl: item.archiveUrl, downloadedAt: item._dlAt, sizeBytes: item.progress,
      sourceName: item.sourceName || null,
    }).catch(() => {});
  }

  /* ── _download: search + stream with auto-retry + multi-source fallback ── */
  async function _download(item) {
    const RGN_USA  = /\((usa|world|en)\b/i;
    const RGN_EU   = /\((europe|eur|eu)\b/i;
    const RGN_JP   = /\((japan|jpn|jp)\b/i;
    const CONT_EXT = new Set(['.zip', '.rar', '.7z']);
    let   httpStatus = null;

    item._attempt += 1;

    try {
      // ── 1a. Multi-source resolve via /api/roms/sources ─────────────────
      // Cached on the item so a retry / source-cycle reuses the ranked list
      // instead of re-querying the backend.
      if (!item._sources) {
        item.status = 'searching'; _notify();
        item._sources   = await fetchRomSources(item.game.title && item.game.systemId
                                                ? item.game.systemId : null,
                                                item.game.title);
        item._sourceIdx = item._sources?.length ? 0 : null;
      }

      // Fast path — use the picked source's direct URL (no per-item file scan).
      if (item._sources?.length && item._sourceIdx != null && item._sources[item._sourceIdx]) {
        const pick = item._sources[item._sourceIdx];
        item.filename     = pick.filename;
        item.archiveUrl   = pick.url;
        item.sourceName   = pick.provider;
        item._activeSource = pick;

        item.status = 'downloading'; item.progress = 0;
        item.total = pick.size || 0;
        item._speedMBs = 0; item._etaSec = null;
        item._lastBytes = 0; item._lastTime = Date.now();
        _notify();

        const pp = new URLSearchParams({
          url: pick.url, save: '1',
          systemId: item.game.systemId, filename: pick.filename,
        });
        const resp = await fetch(`${KENTE_SERVER_URL}/api/rom-proxy?${pp}`,
                                 { signal: _abortTimeout(PROXY_FETCH_TIMEOUT_MS) });
        httpStatus = resp.status;
        if (!resp.ok)   throw new Error(`HTTP_${resp.status}`);
        if (!resp.body) throw new Error('NO_STREAM');
        await _streamBodyInto(item, resp);
        await _markDownloadComplete(item);
        return;
      }

      // ── 1b. Legacy fallback — Archive.org subject search + pack scan ───
      item.status = 'searching'; _notify();
      let results = await searchArchive(item.game.title, item.game.systemId);

      if (!results.length) {
        const packs = await searchPackCollection(item.game.title, item.game.systemId);
        const vExts = new Set((ROM_EXT[item.game.systemId] || []).map(e => e.toLowerCase()));
        const valid = packs.filter(f => {
          const ext = '.' + f.name.split('.').pop().toLowerCase();
          return !vExts.size || vExts.has(ext);
        });
        const bp = valid.find(f => RGN_USA.test(f.name)) ||
                   valid.find(f => !RGN_EU.test(f.name) && !RGN_JP.test(f.name)) || valid[0];
        if (bp) results = [{ _packUrl: bp.url, _packName: bp.name }];
      }
      if (!results.length) {
        item.status = 'error'; item.error = 'NOT FOUND ON ARCHIVE.ORG'; _notify(); return;
      }

      // ── 2. Pick best ROM file ──────────────────────────────────────────
      const vExts   = new Set((ROM_EXT[item.game.systemId] || []).map(e => e.toLowerCase()));
      const _norm   = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
      const _tWords = new Set(_norm(item.game.title));
      let romUrl = null, romFilename = null;

      for (const result of results.slice(0, 15)) {
        if (result._packUrl) { romUrl = result._packUrl; romFilename = result._packName; break; }
        let files; try { files = await getArchiveFiles(result.identifier, item.game.systemId); } catch { continue; }
        const valid = files.filter(f => {
          const ext = '.' + f.name.split('.').pop().toLowerCase();
          if (!vExts.has(ext)) return false;
          if (CONT_EXT.has(ext)) { const sz = parseInt(f.size || '0'); return sz === 0 || sz >= 10_000_000; }
          return true;
        });
        if (!valid.length) continue;
        const byTitle = valid.filter(f => _norm(f.name).some(w => _tWords.has(w)));
        const pool    = byTitle.length ? byTitle : valid;
        const match   = pool.find(f => RGN_USA.test(f.name)) ||
                        pool.find(f => !RGN_EU.test(f.name) && !RGN_JP.test(f.name)) || pool[0];
        romFilename = match.name;
        romUrl = `https://archive.org/download/${result.identifier}/${encodeURIComponent(match.name)}`;
        break;
      }
      if (!romUrl) { item.status = 'error'; item.error = 'ROM FILE NOT FOUND'; _notify(); return; }
      item.filename = romFilename; item.archiveUrl = romUrl;

      // ── 3. Stream via proxy ────────────────────────────────────────────
      item.status = 'downloading'; item.progress = 0;
      item._speedMBs = 0; item._etaSec = null;
      item._lastBytes = 0; item._lastTime = Date.now();
      _notify();

      const pp   = new URLSearchParams({ url: romUrl, save: '1', systemId: item.game.systemId, filename: romFilename });
      const resp = await fetch(`${KENTE_SERVER_URL}/api/rom-proxy?${pp}`,
                               { signal: _abortTimeout(PROXY_FETCH_TIMEOUT_MS) });
      httpStatus = resp.status;
      if (!resp.ok)   throw new Error(`HTTP_${resp.status}`);
      if (!resp.body) throw new Error('NO_STREAM');

      await _streamBodyInto(item, resp);
      await _markDownloadComplete(item);

    } catch (err) {
      // If item was removed by cancel() while we were awaiting, just exit
      if (!_items.find(i => i.id === item.id)) return;
      item._reader = null;

      const classified = _classifyError(err, httpStatus);
      if (!classified) return;   // AbortError from user cancel — item removed above handles it

      // Penalize the active source so the ledger biases away on next launch.
      if (item.sourceName) RomSourceLedger.onFail(item.sourceName);

      // ── Multi-source fallback: try the next ranked source before giving up ──
      // Doesn't consume an _attempt slot — switching hosts is cheaper than
      // a full network retry, and most failures here are host-specific.
      if (item._sources?.length && item._sourceIdx != null
          && item._sourceIdx + 1 < item._sources.length) {
        item._sourceIdx += 1;
        item.progress   = 0; item.total = 0;
        item.error      = null;
        item.status     = 'queued';
        _notify();
        await new Promise(r => setTimeout(r, 600));
        if (_items.find(i => i.id === item.id)) {
          item._attempt -= 1;  // un-charge the attempt counter for this fallback
          await _download(item);
        }
        return;
      }

      // Transient errors (network / timeout / incomplete) get auto-retried
      const isTransient = !httpStatus || httpStatus >= 500 ||
        err.message?.includes('TIMEOUT') || err.message?.includes('INCOMPLETE') ||
        (!httpStatus && err.name !== 'AbortError');

      if (isTransient && item._attempt < MAX_AUTO_RETRIES) {
        const wait = RETRY_DELAY_MS * item._attempt;
        item.status = 'queued';  // show as queued again while waiting
        item.error  = null;
        _notify();
        await new Promise(r => setTimeout(r, wait));
        if (_items.find(i => i.id === item.id)) await _download(item);
        return;
      }

      item.status = 'error';
      item.error  = classified;
      _notify();
      console.error('[DownloadManager]', err.message, { httpStatus });
    }
  }

  /* ── init: restore completed downloads from IndexedDB at boot ── */
  async function init() {
    const saved = await DownloadDB.getAll().catch(() => []);
    saved.sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0));
    for (const dl of saved) {
      if (_items.find(i => i.id === dl.id)) continue;
      _items.push({
        ...(_mkItem(dl.id, dl.game || { id: dl.gameId || dl.id, title: dl.filename,
                                        systemId: dl.systemId, system: dl.systemName })),
        status: 'complete',
        progress: dl.sizeBytes || 0, total: dl.sizeBytes || 0,
        filename: dl.filename, archiveUrl: dl.archiveUrl || null,
        _dlAt: dl.downloadedAt || null,
        _storage: dl.storage || null,
      });
      if (dl.gameId) ROM_STATUS[dl.gameId] = true;
    }
    _notify();
    // Background: prune OPFS-stored entries whose files have gone missing.
    // Runs after the UI is already painted so boot latency is unaffected.
    _pruneStaleOpfsEntries();
  }

  /* Check every restored 'complete' entry that was saved to OPFS.
   * If the OPFS file is gone and there is no fallback archive URL, the entry
   * is silently removed so the user doesn't see a "READY TO PLAY" card that
   * can never actually play. Items with an archiveUrl are left intact because
   * launchFromDownloadCenter() will stream from archive instead. */
  async function _pruneStaleOpfsEntries() {
    if (!navigator?.storage?.getDirectory) return;
    let opfsRoot;
    try { opfsRoot = await navigator.storage.getDirectory(); }
    catch { return; }  // OPFS unavailable — skip

    let changed = false;
    for (const item of [..._items]) {
      if (item.status !== 'complete' || item._storage === 'library') continue;
      if (!item.game?.systemId || !item.filename) continue;
      try {
        const sysDir = await opfsRoot.getDirectoryHandle(item.game.systemId, { create: false });
        await sysDir.getFileHandle(item.filename, { create: false });
        // File still present — nothing to do
      } catch {
        // File missing
        if (item.archiveUrl) {
          // Can still stream from archive — leave the entry but don't mark stale
          console.info(`[DL] OPFS file gone for ${item.filename} — will re-stream from archive if launched`);
        } else {
          // No fallback — remove the dead entry to prevent ghost "READY TO PLAY" cards
          console.info(`[DL] Pruning stale entry ${item.filename} (OPFS file missing, no archiveUrl)`);
          _items = _items.filter(i => i.id !== item.id);
          if (item.game?.id) ROM_STATUS[item.game.id] = false;
          DownloadDB.remove(item.id).catch(() => {});
          changed = true;
        }
      }
    }
    if (changed) _notify();
  }

  /* ── _notify: immediate HUD badge + subtitle, throttled panel render ── */
  function _notify() {
    const active = _items.filter(i => ['queued','searching','downloading'].includes(i.status));
    const badge  = document.getElementById('hud-dl-count');
    const btn    = document.getElementById('hud-dl-btn');
    if (badge) {
      badge.textContent = active.length;
      badge.classList.toggle('visible', active.length > 0);
      btn?.classList.toggle('active', active.length > 0);
    }
    const sub  = document.getElementById('dl-subtitle');
    const comp = _items.filter(i => i.status === 'complete').length;
    if (sub) {
      sub.textContent = (active.length || comp)
        ? [active.length ? `${active.length} DOWNLOADING` : '', comp ? `${comp} READY` : ''].filter(Boolean).join(' · ')
        : 'Background downloads · Ready to play';
    }
    // Throttle panel re-render to one DOM update per animation frame
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      const panel = document.getElementById('downloads-overlay');
      if (panel?.classList.contains('active')) render();
    });
  }

  /* ── render: three-section panel (active, failed, ready) ── */
  function render() {
    const listEl = document.getElementById('dl-list');
    if (!listEl) return;
    const active    = _items.filter(i => ['queued','searching','downloading'].includes(i.status));
    const errored   = _items.filter(i => i.status === 'error');
    const completed = _items.filter(i => i.status === 'complete');

    if (!_items.length) {
      listEl.innerHTML = `<p class="dl-empty">NO DOWNLOADS YET<br>
        <span style="font-size:9px;opacity:0.5;display:block;margin-top:8px">CLICK ANY GAME TO DOWNLOAD IT IN THE BACKGROUND</span></p>`;
      return;
    }

    const _fmtEta = s => {
      if (!s || !isFinite(s) || s < 0) return '';
      return s < 60 ? `~${Math.round(s)}s` : `~${Math.floor(s/60)}m${String(Math.round(s%60)).padStart(2,'0')}s`;
    };

    const _renderSourcePill = (item) => {
      const total = item._sources?.length || 0;
      if (!total) return '';
      const pos    = (item._sourceIdx || 0) + 1;
      const active = item._sources[item._sourceIdx || 0];
      const label  = (active?.provider || '').replace(/_/g, ' ').toUpperCase() || 'SOURCE';
      const more   = total > 1 ? ` ${pos}/${total} ▾` : '';
      return ` <button class="dl-source-pill" data-dlid="${item.id}" data-dlaction="cycleSource"
                title="Tap to cycle source — ${total} available">SRC: ${escHtml(label)}${more}</button>`;
    };

    let html = '';

    if (active.length) {
      html += `<div class="dl-section-hdr">DOWNLOADING</div>`;
      html += active.map(item => {
        const pct  = item.total ? Math.round(item.progress / item.total * 100) : 0;
        const mb   = (item.progress / 1_048_576).toFixed(1);
        const tot  = item.total ? `${(item.total / 1_048_576).toFixed(0)} MB` : '';
        const spd  = item._speedMBs > 0.05 ? `${item._speedMBs.toFixed(1)} MB/s` : '';
        const eta  = _fmtEta(item._etaSec);
        const col  = DL_SYS_COLORS[item.game.systemId] || 'var(--text-dim)';
        const spin = item.status !== 'downloading';
        const tryBadge = item._attempt > 1 ? ` · RETRY ${item._attempt - 1}` : '';
        const meta = item.status === 'searching' ? 'Scanning sources...' :
                     item.status === 'queued'    ? 'Waiting in queue...' :
                     [`${mb} MB${tot ? ` / ${tot}` : ''}`, spd, eta].filter(Boolean).join(' · ') + tryBadge;
        const srcPill = _renderSourcePill(item);
        return `<div class="dl-card dl-card--active">
          <div class="dl-card-row">
            <span class="dl-sys-pill" style="color:${col};border-color:${col}40">${escHtml((item.game.system||item.game.systemId||'').toUpperCase())}</span>
            <span class="dl-card-title">${escHtml(item.game.title)}</span>
            ${spd && !spin ? `<span class="dl-speed-badge">${spd}</span>` : ''}
            <button class="dl-card-x" data-dlid="${item.id}" data-dlaction="cancel">✕</button>
          </div>
          <div class="dl-prog-track"><div class="dl-prog-fill${spin?' dl-prog-spin':''}" style="width:${spin?30:pct}%"></div></div>
          <div class="dl-card-meta">${escHtml(meta)}${srcPill}</div>
        </div>`;
      }).join('');
    }

    if (errored.length) {
      html += `<div class="dl-section-hdr dl-section-hdr--err">FAILED</div>`;
      html += errored.map(item => {
        const col = DL_SYS_COLORS[item.game.systemId] || 'var(--text-dim)';
        const srcPill = _renderSourcePill(item);
        return `<div class="dl-card dl-card--err">
          <div class="dl-card-row">
            <span class="dl-sys-pill" style="color:${col};border-color:${col}40">${escHtml((item.game.system||item.game.systemId||'').toUpperCase())}</span>
            <span class="dl-card-title">${escHtml(item.game.title)}</span>
            <button class="dl-card-retry" data-dlid="${item.id}" data-dlaction="retry">↺</button>
            <button class="dl-card-x" data-dlid="${item.id}" data-dlaction="cancel">✕</button>
          </div>
          <div class="dl-card-meta" style="color:var(--red)">⚠ ${escHtml(item.error||'ERROR')}${srcPill}</div>
        </div>`;
      }).join('');
    }

    if (completed.length) {
      html += `<div class="dl-section-hdr dl-section-hdr--ok">
        READY TO PLAY · ${completed.length}
        <button class="dl-clear-btn" data-dlaction="clearCompleted">CLEAR ALL</button>
      </div>`;
      html += completed.map(item => {
        const col   = DL_SYS_COLORS[item.game.systemId] || 'var(--text-dim)';
        const szMB  = item.total ? `${(item.total/1_048_576).toFixed(0)} MB` : '';
        const date  = item._dlAt
          ? new Date(item._dlAt).toLocaleDateString('en-US', { month:'short', day:'numeric' })
          : '';
        return `<div class="dl-card dl-card--ok">
          <div class="dl-card-row">
            <span class="dl-sys-pill" style="color:${col};border-color:${col}40">${escHtml((item.game.system||item.game.systemId||'').toUpperCase())}</span>
            <span class="dl-card-title">${escHtml(item.game.title)}</span>
            <span class="dl-card-size">${szMB}</span>
            <button class="dl-launch-btn" data-dlid="${item.id}" data-dlaction="launch">▶ LAUNCH</button>
            <button class="dl-card-x" data-dlid="${item.id}" data-dlaction="remove">✕</button>
          </div>
          <div class="dl-card-meta">${escHtml(item.filename||'')}${date ? ' · '+date : ''}</div>
        </div>`;
      }).join('');
    }

    listEl.innerHTML = html;
  }

  return { enqueue, cancel, remove, retry, cycleSource, clearCompleted, init, getAll: () => [..._items], render };
})();

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

/* ══════════════════════════════════════════
   KENTE AUDIO ENGINE  (Web Audio API — no external files)
══════════════════════════════════════════ */
const KenteAudio = (() => {
  let ctx = null;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Chrome auto-suspends AudioContext even inside user-gesture callbacks;
    // resume() immediately to guarantee audio fires on first call.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  let masterVol = 1;

  function tone(freq, dur, vol = 0.08, type = 'sine', attack = 0.005) {
    if (!ctx) return;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol * masterVol, ctx.currentTime + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + dur + 0.01);
  }

  function click()  { tone(700, 0.04, 0.07, 'square'); }
  function focus()  { tone(520, 0.07, 0.05, 'sine'); }
  function back()   { tone(300, 0.10, 0.06, 'sine'); }
  function select() {
    tone(600, 0.06, 0.09, 'sine');
    setTimeout(() => tone(900, 0.12, 0.07, 'sine'), 55);
  }
  function bootSting() {
    // Rising 4-note chord sequence
    [[220,0],[330,90],[440,180],[660,270],[880,380]].forEach(([f,d]) =>
      setTimeout(() => tone(f, 0.35, 0.055, 'sine'), d)
    );
  }

  /* Low CRT ambient hum — white noise through a narrow bandpass at 120Hz */
  let humGain = null;
  function startHum() {
    if (!ctx || humGain) return;
    const buf  = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const src    = ctx.createBufferSource();
    src.buffer   = buf;
    src.loop     = true;

    const bp     = ctx.createBiquadFilter();
    bp.type      = 'bandpass';
    bp.frequency.value = 120;
    bp.Q.value   = 8;

    humGain      = ctx.createGain();
    humGain.gain.value = 0;          // start silent

    src.connect(bp);
    bp.connect(humGain);
    humGain.connect(ctx.destination);
    src.start();

    // Fade hum in gently
    humGain.gain.linearRampToValueAtTime(0.018, ctx.currentTime + 3);
  }

  function setHumVol(v) {
    if (humGain && ctx)
      humGain.gain.linearRampToValueAtTime(v, ctx.currentTime + 0.5);
  }

  function ritualDrone() {
    // Deep ominous hum that builds
    if (!ctx) return;
    [55, 110, 82.4].forEach((f, i) => {
      setTimeout(() => tone(f, 3.5, 0.06 + i * 0.02, 'sine', 0.8), i * 200);
    });
  }
  function powerDown() {
    // Descending tone — TV shutting off
    if (!ctx) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 1.2);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);
    osc.start(); osc.stop(ctx.currentTime + 1.3);
  }
  function powerUp() {
    // Ascending chord — new system coming online
    if (!ctx) return;
    [[220,0],[330,120],[440,240],[660,360],[880,480]].forEach(([f,d]) =>
      setTimeout(() => tone(f, 0.5, 0.07, 'sine', 0.05), d)
    );
  }
  function staticBurst() {
    tone(Math.random()*2000+200, 0.08, 0.06, 'sawtooth');
  }

  function warp() {
    // Rising filtered sweep — TV tunnel sound
    if (!ctx) return;
    const osc    = ctx.createOscillator();
    const filt   = ctx.createBiquadFilter();
    const gain   = ctx.createGain();
    osc.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(55, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.58);
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(150, ctx.currentTime);
    filt.frequency.exponentialRampToValueAtTime(6000, ctx.currentTime + 0.58);
    gain.gain.setValueAtTime(0.14, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(); osc.stop(ctx.currentTime + 0.62);
  }

  function setMasterVol(v) {
    masterVol = Math.max(0, Math.min(1, v));
    if (humGain && ctx) humGain.gain.linearRampToValueAtTime(masterVol * 0.018, ctx.currentTime + 0.3);
  }

  /* ── Wormhole Transition SFX ─────────────────────────────────
     Three sounds timed to the 3 phases of MatrixTransition.run()  */
  function wormholeWipe() {
    // Phase 1 start: digital downward swoosh 800→120 Hz sawtooth
    if (!ctx) return;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(120, ctx.currentTime + 0.38);
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.065 * masterVol, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.42);
    osc.start(); osc.stop(ctx.currentTime + 0.45);
    staticBurst(0.035);
  }

  function wormholeTunnel() {
    // Phase 2 start: rising electrical hum 60→420 Hz + shimmer overtones
    if (!ctx) return;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(60, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 0.65);
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.05 * masterVol, ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.05 * masterVol, ctx.currentTime + 0.55);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.74);
    osc.start(); osc.stop(ctx.currentTime + 0.78);
    setTimeout(() => tone(1200, 0.35, 0.028, 'sine'), 200);
    setTimeout(() => tone(2400, 0.25, 0.016, 'sine'), 450);
  }

  function wormholeEmerge() {
    // Phase 3 start: shock crackle + bright double-ping
    if (!ctx) return;
    staticBurst(0.06);
    setTimeout(() => { tone(880, 0.18, 0.08, 'sine'); tone(1760, 0.12, 0.04, 'sine'); }, 30);
  }

  return { init, click, focus, select, back, bootSting, startHum, setHumVol, setMasterVol,
           ritualDrone, powerDown, powerUp, staticBurst, warp,
           wormholeWipe, wormholeTunnel, wormholeEmerge };
})();

/* ══════════════════════════════════════════
   MATRIX RAIN
   Custom tape: RSL · NDA · IUI · NHC · GMP · AMOK · NASA8
   • SPEED 1–2 rows/frame per column (feels like real rain)
   • FADE 0.09 → ~13-row trails (crisp, not a smear)
   • Head character ALWAYS near-white regardless of position
   • Per-column speed variation + frequent restarts
══════════════════════════════════════════ */
const MatrixRain = (() => {
  const KANA    = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍｦｲｸｺｿﾁﾄﾉﾌﾔﾖﾙﾛﾝ'.split('');
  const STRINGS = ['RSL', 'NDA', 'IUI', 'NHC', 'GMP', 'AMOK', 'NASA8'];
  const COL_W   = 16;
  const FADE    = 'rgba(10, 6, 0, 0.09)'; // faster fade = shorter, crisper trails
  const LEAD    = '#fffce8';   // near-white gold tip — always the current head character
  const BRIGHT  = '#ffc400';   // bright gold — one step behind the head
  const DIM     = '#b87800';   // dark amber — body of the stream
  const SEP_MIN = 2, SEP_MAX  = 5;

  let _canvas = null, _ctx = null, _raf = null;
  let _drops   = [];   // head row per column
  let _speeds  = [];   // rows-per-frame per column (1 or 2)
  let _tapes   = [];
  let _offsets = [];

  function _randKana() { return KANA[Math.random() * KANA.length | 0]; }

  function _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.random() * (i + 1) | 0;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function _makeTape(minLen) {
    const tape  = [], order = _shuffle([...STRINGS]);
    let   si    = 0;
    while (tape.length < minLen) {
      const str = order[si % order.length]; si++;
      for (const ch of str) {
        const sep = SEP_MIN + (Math.random() * (SEP_MAX - SEP_MIN + 1) | 0);
        for (let k = 0; k < sep; k++) tape.push(_randKana());
        tape.push(ch);
        tape.push(_randKana());
      }
    }
    return tape;
  }

  function _buildColumns(cols) {
    const minLen = Math.ceil((window.innerHeight / COL_W) * 3);
    // Stagger drop starts well above screen so rain arrives at different times
    _drops   = Array.from({ length: cols }, () => (Math.random() * -80 | 0));
    // Alternate speed: roughly half columns fall at 1 row/frame, half at 2
    _speeds  = Array.from({ length: cols }, () => Math.random() > 0.45 ? 2 : 1);
    _tapes   = Array.from({ length: cols }, () => _makeTape(minLen));
    _offsets = Array.from({ length: cols }, (_, i) => Math.random() * _tapes[i].length | 0);
  }

  function _init() {
    _canvas = document.getElementById('matrix-rain');
    if (!_canvas) return false;
    _ctx = _canvas.getContext('2d');
    _resize();
    window.addEventListener('resize', _resize);
    return true;
  }

  function _resize() {
    if (!_canvas) return;
    _canvas.width  = window.innerWidth;
    _canvas.height = window.innerHeight;
    const cols = Math.floor(_canvas.width / COL_W);
    if (_drops.length !== cols) _buildColumns(cols);
  }

  function _draw() {
    if (!_ctx) return;
    // Translucent wash — fades previous characters creating the falling trail
    _ctx.fillStyle = FADE;
    _ctx.fillRect(0, 0, _canvas.width, _canvas.height);
    _ctx.font = `${COL_W - 2}px "Share Tech Mono", monospace`;

    for (let i = 0; i < _drops.length; i++) {
      const sp = _speeds[i];
      // Draw sp characters at the leading edge this frame
      for (let s = 0; s < sp; s++) {
        const row = _drops[i] + s;
        const y   = row * COL_W;
        if (y < 0 || y > _canvas.height + COL_W) continue;
        const tape = _tapes[i];
        const pos  = (((_offsets[i] + row) % tape.length) + tape.length) % tape.length;
        // Very tip = near-white; one behind = bright green; rest handled by FADE
        _ctx.fillStyle = (s === sp - 1) ? LEAD : (s === sp - 2) ? BRIGHT : DIM;
        _ctx.fillText(tape[pos], i * COL_W, y);
      }
      _drops[i] += sp;
      // Reset when fully below screen — more eager (96%) for continuous density
      if (_drops[i] * COL_W > _canvas.height + COL_W) {
        if (Math.random() > 0.04) {
          _drops[i]   = Math.random() * -50 | 0;
          _offsets[i] = Math.random() * _tapes[i].length | 0;
          // Occasionally flip the column speed for variation
          if (Math.random() > 0.65) _speeds[i] = Math.random() > 0.45 ? 2 : 1;
        }
      }
    }
    _raf = requestAnimationFrame(_draw);
  }

  function start() {
    if (_raf) return;
    if (!_canvas && !_init()) return;
    _canvas.hidden = false;
    _draw();
  }

  function stop() {
    if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    if (_canvas) {
      _canvas.hidden = true;
      _ctx?.clearRect(0, 0, _canvas.width, _canvas.height);
    }
  }

  return { start, stop };
})();

/* ══════════════════════════════════════════
   MATRIX TRANSITION  —  3-Phase Wormhole
   Phase 1 WIPE  : fast rain falls top-to-bottom, covering screen (~380 ms)
   Phase 2 TUNNEL: rings of matrix chars converge to center — telephone-line
                   wormhole effect. Core brightens as you rush toward the exit.
   Phase 3 FLASH : expanding ring of light bursts from center → callback → fade
══════════════════════════════════════════ */
const MatrixTransition = (() => {
  const KANA    = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍｦｲｸｺｿﾁﾄﾉﾌﾔﾖﾙﾛﾝ'.split('');
  const STRINGS = ['RSL', 'NDA', 'IUI', 'NHC', 'GMP', 'AMOK', 'NASA8'];
  const COL_W   = 16;
  const T_TUNNEL = 700;   // ms for tunnel phase
  const T_FLASH  = 260;   // ms for flash phase
  const RING_LIFE = 430;  // ms for one ring to travel edge→center
  const RING_GAP  = 52;   // ms between new ring spawns

  let _canvas = null, _ctx = null, _raf = null;
  let _callback = null, _phase = 0, _t0 = 0;
  let _drops = [], _tapes = [], _offsets = [];   // wipe state
  let _rings = [], _lastRing = 0;                 // tunnel state

  function _randKana() { return KANA[Math.random() * KANA.length | 0]; }
  function _randChar() {
    if (Math.random() > 0.65) { const s = STRINGS[Math.random() * STRINGS.length | 0]; return s[Math.random() * s.length | 0]; }
    return _randKana();
  }
  function _makeTape(n) {
    const t = []; let si = 0;
    while (t.length < n) {
      const s = STRINGS[si++ % STRINGS.length];
      for (const ch of s) { for (let k = 2 + (Math.random() * 4 | 0); k--;) t.push(_randKana()); t.push(ch); t.push(_randKana()); }
    }
    return t;
  }

  function _init() {
    _canvas = document.getElementById('matrix-exit-rain');
    if (!_canvas) return false;
    _ctx = _canvas.getContext('2d');
    return true;
  }

  // ── Phase 1: rain wipe ───────────────────────────────────────────
  function _setupWipe() {
    _canvas.width  = window.innerWidth;
    _canvas.height = window.innerHeight;
    const cols = Math.floor(_canvas.width / COL_W);
    const min  = Math.ceil(_canvas.height / COL_W) + 20;
    _drops   = Array.from({ length: cols }, () => -(Math.random() * 5 | 0));
    _tapes   = Array.from({ length: cols }, () => _makeTape(min));
    _offsets = Array.from({ length: cols }, (_, i) => Math.random() * _tapes[i].length | 0);
    _ctx.fillStyle = '#0a0600';
    _ctx.fillRect(0, 0, _canvas.width, _canvas.height);
  }

  function _drawWipe() {
    const SP = 4;
    _ctx.font = `${COL_W - 2}px "Share Tech Mono", monospace`;
    let done = 0;
    for (let i = 0; i < _drops.length; i++) {
      if (_drops[i] * COL_W > _canvas.height + COL_W * SP) { done++; continue; }
      for (let s = 0; s < SP; s++) {
        const row = _drops[i] + s; if (row < 0) continue;
        const y   = (row + 1) * COL_W; if (y > _canvas.height + COL_W) break;
        const tp  = ((_offsets[i] + row) % _tapes[i].length + _tapes[i].length) % _tapes[i].length;
        _ctx.fillStyle = s === SP - 1 ? '#fffce8' : Math.random() > 0.88 ? '#ffc400' : '#b07800';
        _ctx.fillText(_tapes[i][tp], i * COL_W, y);
      }
      _drops[i] += SP;
      if (_drops[i] * COL_W > _canvas.height + COL_W * SP) done++;
    }
    return done >= _drops.length;   // true = screen fully covered
  }

  // ── Phase 2: wormhole tunnel ─────────────────────────────────────
  function _drawTunnel(now) {
    const { width: w, height: h } = _canvas;
    const cx = w / 2, cy = h / 2;
    const overallT = Math.min((now - _t0) / T_TUNNEL, 1);
    const maxR = Math.sqrt(cx * cx + cy * cy) * 1.12;

    // Semi-transparent wash — lets rings accumulate without fully erasing
    _ctx.fillStyle = 'rgba(10, 6, 0, 0.16)';
    _ctx.fillRect(0, 0, w, h);

    // Spawn new rings from the screen edges, converging inward
    if (now - _lastRing > RING_GAP) {
      _rings.push({ birth: now, spin: Math.random() > 0.5 ? 1 : -1, phase: Math.random() * Math.PI * 2 });
      _lastRing = now;
    }

    _rings = _rings.filter(ring => {
      const age  = now - ring.birth;
      const t    = age / RING_LIFE; if (t >= 1) return false;
      // ease-in-quad: rings accelerate as they rush toward center
      const ease = 1 - (1 - t) * (1 - t);
      const radius  = maxR * (1 - ease);
      const charSz  = Math.max(7, 15 * (1 - ease * 0.55));
      const numCh   = Math.max(3, Math.floor(2 * Math.PI * radius / (charSz * 1.6)));
      const alpha   = 0.45 + ease * 0.55;
      const spinAng = ring.phase + ring.spin * ease * Math.PI * 2.8;
      for (let c = 0; c < numCh; c++) {
        const ang = spinAng + (c / numCh) * Math.PI * 2;
        const x   = cx + Math.cos(ang) * radius;
        const y   = cy + Math.sin(ang) * radius;
        const gr  = (200 + (55 * ease)) | 0;   // red:   200 → 255 (warm gold)
        const gg  = (150 + (70 * ease)) | 0;   // green: 150 → 220 (gold, not white)
        _ctx.font      = `${charSz}px "Share Tech Mono", monospace`;
        _ctx.fillStyle = `rgba(${gr},${gg},0,${alpha})`;
        _ctx.fillText(_randChar(), x - charSz * 0.4, y + charSz * 0.4);
      }
      return true;
    });

    // Core glow: grows brighter as we approach the tunnel exit
    if (overallT > 0.25) {
      const ct = (overallT - 0.25) / 0.75;
      const cr = 10 + ct * 135;
      const grd = _ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
      grd.addColorStop(0,    `rgba(255,255,255,${ct * 0.97})`);
      grd.addColorStop(0.35, `rgba(255,200,30,${ct * 0.75})`);
      grd.addColorStop(1,    'rgba(180,100,0,0)');
      _ctx.fillStyle = grd;
      _ctx.beginPath(); _ctx.arc(cx, cy, cr, 0, Math.PI * 2); _ctx.fill();
    }
    return overallT >= 1;
  }

  // ── Phase 3: light emerge ────────────────────────────────────────
  function _drawFlash(now) {
    const { width: w, height: h } = _canvas;
    const cx = w / 2, cy = h / 2;
    const t   = Math.min((now - _t0) / T_FLASH, 1);
    const maxR = Math.sqrt(cx * cx + cy * cy) * 1.5;
    // Expanding ring of light
    const rr = t * maxR, rw = maxR * 0.28 * (1 - t);
    if (rw > 0) {
      const gr = _ctx.createRadialGradient(cx, cy, Math.max(0, rr - rw), cx, cy, rr + rw);
      gr.addColorStop(0,   'rgba(180,100,0,0)');
      gr.addColorStop(0.3, `rgba(255,210,60,${0.75 * (1 - t)})`);
      gr.addColorStop(0.6, `rgba(255,255,255,${0.95 * (1 - t)})`);
      gr.addColorStop(1,   'rgba(180,100,0,0)');
      _ctx.fillStyle = gr;
      _ctx.beginPath(); _ctx.arc(cx, cy, rr + rw, 0, Math.PI * 2); _ctx.fill();
    }
    // Fading central bloom
    const gc = _ctx.createRadialGradient(cx, cy, 0, cx, cy, 80 + t * 60);
    gc.addColorStop(0,   `rgba(255,255,255,${1 - t})`);
    gc.addColorStop(0.5, `rgba(255,200,60,${(1 - t) * 0.5})`);
    gc.addColorStop(1,   'rgba(220,150,0,0)');
    _ctx.fillStyle = gc; _ctx.beginPath(); _ctx.arc(cx, cy, 140 + t * 60, 0, Math.PI * 2); _ctx.fill();
    return t >= 1;
  }

  // ── Main animation loop ──────────────────────────────────────────
  function _loop(now) {
    let done = false;
    if      (_phase === 1) { done = _drawWipe();      if (done) { _phase = 2; _t0 = now; _lastRing = now; _rings = []; KenteAudio.wormholeTunnel(); } }
    else if (_phase === 2) { done = _drawTunnel(now); if (done) { _phase = 3; _t0 = now; KenteAudio.wormholeEmerge(); } }
    else if (_phase === 3) {
      done = _drawFlash(now);
      if (done) {
        if (_callback) { const cb = _callback; _callback = null; cb(); }
        _canvas.style.transition = 'opacity 0.35s ease';
        _canvas.style.opacity    = '0';
        setTimeout(() => {
          _canvas.hidden           = true;
          _canvas.style.opacity    = '1';
          _canvas.style.transition = '';
          _raf = null;
        }, 370);
        return;   // stop the loop
      }
    }
    _raf = requestAnimationFrame(_loop);
  }

  function run(callback) {
    if (!_canvas && !_init()) { callback?.(); return; }
    _canvas.style.transition = 'none';
    _canvas.style.opacity    = '1';
    _canvas.hidden = false;
    _callback = callback;
    _phase = 1;
    _setupWipe();
    KenteAudio.wormholeWipe();
    if (_raf) cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(_loop);
  }

  return { run };
})();

/* ══════════════════════════════════════════
   SETTINGS ENGINE
══════════════════════════════════════════ */
const SETTINGS_CONFIG = [
  { group:'DISPLAY', items:[
    { label:'CRT Scanlines',    key:'crtScanlines', type:'toggle',             default:true  },
    { label:'Vignette Effect',  key:'vignette',     type:'toggle',             default:true  },
    { label:'Room Theme',       key:'roomTheme',    type:'cycle', opts:['DEFAULT','NEON','MIDNIGHT','CRIMSON','MATRIX','VAPOR','AMBER','ICE','COPPER'], default:'DEFAULT' },
  ]},
  { group:'AUDIO', items:[
    { label:'UI Sounds',        key:'uiSounds',     type:'toggle',             default:true  },
    { label:'Ambient Hum',      key:'ambientHum',   type:'toggle',             default:true  },
    { label:'Volume',           key:'volume',       type:'cycle', opts:[20,40,60,80,100],     default:80 },
  ]},
  { group:'CAMERA', items:[
    { label:'VR Parallax',      key:'cameraVR',        type:'toggle', default:false },
    { label:'Wii Pointer',      key:'wiiPointer',      type:'toggle', default:false },
    { label:'Calibrate Controls', key:'calibrate',     type:'action', value:'OPEN ›' },
  ]},
  { group:'THEATER', items:[
    { label:'Sandbox Mode',     key:'theaterSandbox',  type:'cycle',
      opts:['OFF','PERMISSIVE','STRICT','ULTRA'], default:'OFF' },
    { label:'Ad Shield',        key:'theaterAdShield', type:'toggle', default:true },
  ]},
  { group:'SYSTEM', items:[
    { label:'Tier',             key:null,           type:'readonly', value:'LITE'             },
    { label:'Build',            key:null,           type:'readonly', value:'01'               },
    { label:'Sacrifice Chamber',key:'openChamber',  type:'action',   value:'ENTER \u203A'     },
    { label:'Reset Systems',    key:'resetSystems', type:'action',   value:'FACTORY RESET'   },
    { label:'USB Boot Guide',   key:'usbGuide',     type:'action',   value:'VIEW \u203A'      },
    { label:'PS4 Console Mod',  key:'ps4Guide',     type:'action',   value:'VIEW \u203A'      },
  ]},
  { group:'ABOUT', items:[
    { label:'Shell Version',    key:null,           type:'readonly', value:'1.1.0'            },
    { label:'Base OS',          key:null,           type:'readonly', value:'Alpine Linux'     },
    { label:'Library Entries',  key:null,           type:'readonly', value: () => `${(window.KenteLibrary?.games||[]).length} GAMES` },
    { label:'Discord',          key:null,           type:'readonly', value:'artkeys.json \u2192 discordAppId' },
  ]},
];

const SETTINGS_DEFAULTS = { crtScanlines:true, vignette:true, roomTheme:'DEFAULT', uiSounds:true, ambientHum:true, volume:80, cameraVR:false, wiiPointer:false, theaterSandbox:'OFF', theaterAdShield:true };
let appSettings = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem('kente_settings')||'{}');
    // Migrate the boolean strictSandbox flag → theaterSandbox enum.
    if ('strictSandbox' in raw && !('theaterSandbox' in raw)) {
      raw.theaterSandbox = raw.strictSandbox ? 'STRICT' : 'OFF';
      delete raw.strictSandbox;
    }
    return {...SETTINGS_DEFAULTS, ...raw};
  } catch { return {...SETTINGS_DEFAULTS}; }
})();

function saveSettings() {
  try { localStorage.setItem('kente_settings', JSON.stringify(appSettings)); } catch(e) {
    console.warn('[saveSettings]', e);
  }
  // Mirror to Batocera shadow when native server is running
  if (KENTE_SERVER_ONLINE) {
    fetch(`${KENTE_SERVER_URL}/api/settings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(appSettings),
    }).catch(() => {}); // fire-and-forget — never block the UI
  }
}

function applySetting(key) {
  switch(key) {
    case 'crtScanlines': document.body.classList.toggle('crt-off', !appSettings.crtScanlines); break;
    case 'vignette':     document.body.classList.toggle('vignette-off', !appSettings.vignette); break;
    case 'roomTheme': {
      const _t = appSettings.roomTheme === 'DEFAULT' ? '' : appSettings.roomTheme.toLowerCase();
      document.body.dataset.theme = _t;
      _t === 'matrix' ? MatrixRain.start() : MatrixRain.stop();
      break;
    }
    case 'volume':       KenteAudio.setMasterVol(appSettings.volume / 100); break;
    case 'ambientHum':   KenteAudio.setHumVol(appSettings.ambientHum ? 0.018 : 0); break;
    case 'cameraVR':
      // CameraManager may not exist yet during early boot — guard with typeof
      if (typeof CameraManager !== 'undefined') {
        appSettings.cameraVR ? CameraManager.startVR() : CameraManager.stopVR();
      }
      break;
    case 'wiiPointer':
      if (typeof CameraManager !== 'undefined') {
        appSettings.wiiPointer ? CameraManager.startWiiPointer() : CameraManager.stopWiiPointer();
      }
      break;
  }
}
function applyAllSettings() { Object.keys(appSettings).forEach(applySetting); }

/* ── STATE ── */
let state = {
  screen: 'splash',   // splash | room | menu
  activeMenu: null,
  focusedTV: null,
  focusIndex: 0,
  transitioning: false,
  // Restore last-used profile from localStorage
  activeProfile: (() => { try { return localStorage.getItem('kente_profile') || 'player1'; } catch { return 'player1'; } })()
};

/* ══════════════════════════════════════════
   NATIVE SERVER DETECTION
   Pings kente-server.py. If it answers we are
   running inside Batocera — use native emulators.
══════════════════════════════════════════ */
// Update the HUD status dot colour to reflect current server / Batocera state.
//   green  (dot-online)  = Batocera server live
//   amber  (dot-dev)     = server up, not Batocera (dev machine)
//   dim    (dot-offline) = server unreachable
function _updateServerDot() {
  const dot = document.getElementById('hud-status-dot');
  if (!dot) return;
  dot.classList.remove('dot-online', 'dot-dev', 'dot-offline');
  if (!KENTE_SERVER_ONLINE)      dot.classList.add('dot-offline');
  else if (serverIsBatocera)     dot.classList.add('dot-online');
  else                           dot.classList.add('dot-dev');
  dot.title = !KENTE_SERVER_ONLINE ? 'Kente server offline'
            : serverIsBatocera     ? `Batocera · ${serverPlatform || 'Linux'}`
            : serverIsElectron     ? `Desktop App · ${serverPlatform || 'Windows'}`
            :                        `Dev server · ${serverPlatform || 'unknown'}`;
}

async function detectKenteServer(retry = true) {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 1500);
    const res  = await fetch(`${KENTE_SERVER_URL}/api/ping`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (res.ok) {
      const data = await res.json();
      // Server online: enables CORS proxy, disk save, and native launch for
      // systems that have no browser-side emulator core (PS2, GameCube, etc.).
      // Systems with a CORE_MAP entry always use EmulatorJS regardless.
      serverPlatform      = data.platform || null;  // 'Windows', 'Linux', 'Darwin'
      serverIsBatocera    = !!data.batocera;         // true only on real Batocera
      serverIsElectron    = !!data.electron;         // true inside packaged Electron app
      KENTE_SERVER_ONLINE = true;
      console.log(`[Kente] Server online — platform: ${serverPlatform} · batocera: ${serverIsBatocera} · electron: ${serverIsElectron}`);
      _updateServerDot();
      refreshNativeBiosStatus();
    }
  } catch {
    if (retry) {
      // One automatic retry after 3 s — covers the window where Batocera's Python
      // server is still starting up while the browser has already painted the UI.
      console.log('[Kente] Server ping failed — retrying in 3 s…');
      setTimeout(() => detectKenteServer(false), 3000);
      return;
    }
    KENTE_SERVER_ONLINE = false;
    serverIsBatocera    = false;
    serverPlatform      = null;
    _updateServerDot();
  }
}

async function refreshNativeBiosStatus() {
  try {
    const res = await fetch(`${KENTE_SERVER_URL}/api/bios/status`, { signal: _abortTimeout(5000) });
    if (!res.ok) return;
    const status = await res.json();
    // Store for use in settings/sources panels
    window.KENTE_BIOS_STATUS = status;
  } catch { /* non-critical */ }
}

/* ══════════════════════════════════════════
   MOD MANAGER
   Shows available mods for a game in the
   launch-overlay.  Mods are folders of DAT*.ssf
   replacement files placed in workspace/mods/<gameId>/
   by the user.  The server backs up originals and
   swaps the files before launch.
══════════════════════════════════════════ */
async function showModManager(game) {
  const overlay = document.getElementById('launch-overlay');
  const con     = document.getElementById('launch-content');
  if (!overlay || !con) return;

  // Show loading state
  con.innerHTML = `<div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.15em;color:var(--text-dim)">LOADING MODS...</div>`;
  overlay.classList.add('active');

  let modsData = null;
  try {
    const res  = await fetch(`${KENTE_SERVER_URL}/api/mods?game=${game.id}`, { signal: _abortTimeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    modsData   = await res.json();
  } catch {
    con.innerHTML = `<div style="font-family:var(--font-mono);font-size:11px;color:var(--red)">
      ⚠ KENTE SERVER OFFLINE<br>
      <span style="color:var(--text-dim);font-size:10px">Start kente-server.py to manage mods.</span>
      <br><br><button class="launch-dismiss" style="margin-top:12px;padding:8px 20px;
        background:var(--brand);color:#000;font-family:var(--font-mono);font-size:11px;
        letter-spacing:.15em;border:none;cursor:pointer">✕ CLOSE</button></div>`;
    return;
  }

  const { mods = [], status = {} } = modsData;
  const modActive = status.modActive || false;

  function modsFolder() {
    // Open the mods folder in Explorer (Windows) so users can drop mod files in
    fetch(`${KENTE_SERVER_URL}/api/open-folder?path=mods/${game.id}`).catch(() => {});
    showToast(`📂 DROP MOD FOLDERS INTO: workspace/mods/${game.id}/`);
  }

  async function applyMod(modId) {
    con.querySelector(`[data-mod="${modId}"] .mod-apply-btn`).textContent = 'APPLYING...';
    try {
      const res  = await fetch(`${KENTE_SERVER_URL}/api/mods/apply`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ game: game.id, modId }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`✔ MOD APPLIED — ${modId.toUpperCase()} · ${data.applied?.length || 0} FILES SWAPPED`);
        overlay.classList.remove('active');
      } else {
        showToast(`⚠ MOD FAILED — ${(data.error || 'UNKNOWN').toUpperCase()}`);
        await showModManager(game);   // refresh
      }
    } catch {
      showToast('⚠ SERVER ERROR APPLYING MOD');
      await showModManager(game);
    }
  }

  async function restoreMod() {
    try {
      const res  = await fetch(`${KENTE_SERVER_URL}/api/mods/restore`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ game: game.id }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`↺ ORIGINALS RESTORED — ${data.restored?.length || 0} FILES`);
        await showModManager(game);
      } else {
        showToast(`⚠ RESTORE FAILED — ${(data.error || '').toUpperCase()}`);
      }
    } catch {
      showToast('⚠ SERVER ERROR RESTORING ORIGINALS');
    }
  }

  // ── Render ──
  const modCards = mods.length
    ? mods.map(m => `
        <div class="mod-card" data-mod="${escHtml(m.id)}" style="
          border:1px solid var(--border);padding:12px 14px;margin-bottom:8px;
          display:flex;gap:12px;align-items:center;background:var(--bg-secondary,#0a0a18)">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;letter-spacing:.15em;color:var(--text-main);margin-bottom:3px">
              ${escHtml(m.name)}
            </div>
            ${m.author !== 'Unknown' ? `<div style="font-size:10px;color:var(--text-dim)">by ${escHtml(m.author)}</div>` : ''}
            ${m.characters?.length ? `<div style="font-size:10px;color:#888;margin-top:2px">${m.characters.map(c=>escHtml(c)).join(' · ')}</div>` : ''}
            <div style="font-size:9px;color:#555;margin-top:4px">${m.fileCount} FILES</div>
          </div>
          <button class="mod-apply-btn" data-modid="${escHtml(m.id)}" style="
            font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;
            padding:8px 16px;background:var(--brand);color:#000;border:none;
            cursor:pointer;white-space:nowrap;flex-shrink:0">
            ▶ APPLY
          </button>
        </div>`).join('')
    : `<div style="color:var(--text-dim);font-size:10px;line-height:1.9;padding:16px 0">
        NO MODS FOUND.<br>
        Place mod folders inside:<br>
        <span style="color:var(--brand)">workspace/mods/${escHtml(game.id)}/</span><br><br>
        Each mod folder should contain DAT*.ssf replacement files<br>
        and an optional <span style="color:var(--brand)">mod.json</span> with name/author/description.
      </div>`;

  con.innerHTML = `
    <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.15em;
                max-height:80vh;overflow-y:auto;padding:4px">
      <div style="font-size:13px;letter-spacing:.2em;margin-bottom:6px;color:var(--brand)">
        🎨 ${escHtml(game.title.toUpperCase())} — MODS
      </div>
      ${modActive
        ? `<div style="display:flex;align-items:center;gap:10px;
                       border:1px solid #f90;padding:8px 12px;margin-bottom:14px;color:#f90;font-size:10px">
             ⚠ A MOD IS CURRENTLY ACTIVE (${status.backupCount} files backed up)
             <button id="mm-restore" style="margin-left:auto;padding:6px 14px;
               background:none;border:1px solid #f90;color:#f90;
               font-family:var(--font-mono);font-size:10px;cursor:pointer">
               ↺ RESTORE ORIGINALS
             </button>
           </div>`
        : ''
      }
      <div id="mm-mod-list">${modCards}</div>
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        <button id="mm-folder-btn" style="padding:8px 16px;background:none;
          border:1px solid var(--border);color:var(--text-dim);
          font-family:var(--font-mono);font-size:10px;cursor:pointer">
          📂 OPEN MODS FOLDER
        </button>
        <button class="launch-dismiss" style="margin-left:auto;padding:8px 20px;
          background:var(--brand);color:#000;font-family:var(--font-mono);
          font-size:11px;letter-spacing:.15em;border:none;cursor:pointer">
          ✕ CLOSE
        </button>
      </div>
      <div style="margin-top:12px;color:#555;font-size:9px;line-height:1.7">
        MODS SWAP DAT*.SSF FILES IN THE SSF2 DATA DIRECTORY.<br>
        ORIGINALS ARE BACKED UP AUTOMATICALLY — RESTORE ANYTIME.
      </div>
    </div>`;

  // Wire events
  con.querySelectorAll('.mod-apply-btn').forEach(btn =>
    btn.addEventListener('click', () => applyMod(btn.dataset.modid))
  );
  con.querySelector('#mm-restore')?.addEventListener('click', restoreMod);
  con.querySelector('#mm-folder-btn')?.addEventListener('click', modsFolder);
}

/* ══════════════════════════════════════════
   NATIVE EXE LAUNCHER
   Launches an installed desktop application
   (e.g. SSF2.exe) via kente-server.py.
   The app opens in its own OS window; Kente
   returns to the room and polls the server
   every 2.5 s so it can react when the app
   closes (optional — server also restores
   browser focus via PowerShell on exit).
══════════════════════════════════════════ */
async function launchNativeApp(game) {
  const tv     = TV_ZONES.find(t => t.id === state.activeMenu);
  const accent = tv?.accent || 'var(--brand)';
  const overlay = document.getElementById('launch-overlay');
  const con     = document.getElementById('launch-content');
  overlay.style.setProperty('--menu-accent', accent);
  overlay.classList.add('active');
  KenteAudio.warp();
  KenteAudio.setHumVol(0);

  con.innerHTML = `
    <div class="launch-title">LAUNCHING</div>
    <div class="launch-game">${escHtml(game.title)}</div>
    <div class="launch-sys">DESKTOP APP · NATIVE WINDOWS</div>
    <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);
                letter-spacing:0.15em;margin-top:24px">
      OPENING ${escHtml(game.title.toUpperCase())}...
    </div>`;

  try {
    const res  = await fetch(`${KENTE_SERVER_URL}/api/launch-app`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        exePath:  game.nativeExe   || null,   // Windows .exe
        linuxExe: game.nativeExeLinux || null, // Linux run.sh (used on Linux or via WSL)
      }),
    });
    const data = await res.json();

    if (data.success) {
      // App launched — append success note without forcing a full innerHTML reparse.
      const note = document.createElement('div');
      note.style.cssText = 'font-family:var(--font-mono);font-size:10px;color:#4f4;letter-spacing:0.15em;margin-top:8px';
      note.textContent = `✔ ${game.title.toUpperCase()} IS OPEN — ALT+TAB TO SWITCH`;
      con.appendChild(note);
      setTimeout(() => {
        overlay.classList.remove('active');
        KenteAudio.setHumVol(0.018);
        showToast(`⚡ ${escHtml(game.title.toUpperCase())} RUNNING — ALT+TAB TO SWITCH · CLOSE TO RETURN`);
      }, 900);
    } else {
      overlay.classList.remove('active');
      KenteAudio.setHumVol(0.018);
      showToast(`⚠ LAUNCH FAILED — ${(data.error || 'UNKNOWN ERROR').toUpperCase()}`);
    }
  } catch {
    overlay.classList.remove('active');
    KenteAudio.setHumVol(0.018);
    showToast('⚠ KENTE SERVER NOT RUNNING — START kente-server.py FIRST');
  }
}

/* ══════════════════════════════════════════
   LAUNCH WITH INSTALLED EMULATOR
   Called from launchFromDownloadCenter when
   the ROM is already on disk but we are NOT
   on Batocera.  Asks kente-server to find an
   installed emulator (PCSX2, Dolphin, Ryujinx
   etc.), or falls back to the OS file-type
   association, or opens the containing folder.
══════════════════════════════════════════ */
async function launchWithInstalledEmulator(game, dlItem) {
  const EMU_LABEL = {
    dreamcast:'FLYCAST', ps2:'PCSX2', gamecube:'DOLPHIN', wii:'DOLPHIN',
    wiiu:'CEMU', ps3:'RPCS3', xbox:'XEMU', xbox360:'XENIA', switch:'RYUJINX',
  };
  const tv     = TV_ZONES.find(t => t.id === state.activeMenu);
  const accent = tv?.accent || 'var(--brand)';
  const overlay = document.getElementById('launch-overlay');
  const con     = document.getElementById('launch-content');
  overlay.style.setProperty('--menu-accent', accent);
  overlay.classList.add('active');
  KenteAudio.warp();
  KenteAudio.setHumVol(0);

  const emuLabel = EMU_LABEL[game.systemId] || 'NATIVE EMULATOR';
  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'font-family:var(--font-mono);font-size:10px;color:var(--text-dim);letter-spacing:0.15em;margin-top:24px';
  statusEl.textContent   = `SEARCHING FOR ${emuLabel}...`;
  con.innerHTML = `
    <div class="launch-title">LAUNCHING</div>
    <div class="launch-game">${escHtml(game.title)}</div>
    <div class="launch-sys">${escHtml((game.system || game.systemId).toUpperCase())} · ${emuLabel}</div>`;
  con.appendChild(statusEl);

  try {
    const res  = await fetch(`${KENTE_SERVER_URL}/api/launch-rom`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemId: game.systemId, filename: dlItem.filename }),
    });
    const data = await res.json();

    if (data.success) {
      const m = data.method || '';
      if (m.startsWith('emulator:') || m === 'os') {
        // Emulator opened cleanly — show brief success then close overlay
        const methodLabel = m.startsWith('emulator:')
          ? `OPENED WITH ${m.split(':')[1].toUpperCase()}`
          : 'OPENED WITH SYSTEM DEFAULT';
        statusEl.style.color = 'var(--green)';
        statusEl.textContent = `✔ ${methodLabel}`;
        setTimeout(() => {
          overlay.classList.remove('active');
          KenteAudio.setHumVol(0.018);
          showToast(`⚡ ${escHtml(game.title.toUpperCase())} — ${methodLabel}`);
        }, 1100);
      } else {
        // Server opened the folder but no emulator found — retry via launchNative
        // which will use find_rom() + the full NATIVE_EMU_WIN/PATH fallback chain
        overlay.classList.remove('active');
        KenteAudio.setHumVol(0.018);
        launchNative(game, true);
      }
    } else {
      // ROM not found at the given path — try launchNative which uses fuzzy title search
      overlay.classList.remove('active');
      KenteAudio.setHumVol(0.018);
      launchNative(game, true);
    }
  } catch {
    overlay.classList.remove('active');
    KenteAudio.setHumVol(0.018);
    showToast('⚠ KENTE SERVER NOT RUNNING — START kente-server.py FIRST');
  }
}

/* ══════════════════════════════════════════
   NATIVE GAME LAUNCH
   Called instead of launchWithEmulatorJS when
   kente-server is running in Batocera.
══════════════════════════════════════════ */
// Timer tracking for launch-overlay cancel / seamless black hold
let _launchOverlayHoldTimer = null;

function _closeLaunchOverlay() {
  if (_launchOverlayHoldTimer) { clearTimeout(_launchOverlayHoldTimer); _launchOverlayHoldTimer = null; }
  const overlay = document.getElementById('launch-overlay');
  if (overlay) overlay.classList.remove('active');
}

async function launchNative(game, fromCloud = false) {
  const tv     = TV_ZONES.find(t => t.id === state.activeMenu);
  const accent = tv?.accent || 'var(--brand)';
  const overlay = document.getElementById('launch-overlay');
  const con     = document.getElementById('launch-content');
  overlay.style.setProperty('--menu-accent', accent);
  overlay.classList.add('active');
  KenteAudio.warp();
  KenteAudio.setHumVol(0);

  // Cancel button / ESC closes the overlay immediately.
  // The launch is fire-and-forget on the server side so cancelling here only
  // restores the browser UI — the emulator won't start if the API hasn't
  // returned yet, and if it has, emulatorlauncher will finish normally in the
  // background (the user can just ignore it).
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'launch-cancel-btn';
  cancelBtn.textContent = 'CANCEL';
  cancelBtn.onclick = () => { _closeLaunchOverlay(); KenteAudio.setHumVol(0.018); };

  const _launchModeLabel = serverIsBatocera
    ? 'HANDING OFF TO BATOCERA EMULATOR...'
    : 'LAUNCHING WITH NATIVE EMULATOR...';
  con.innerHTML = `
    <div class="launch-title">LAUNCHING</div>
    <div class="launch-game">${escHtml(game.title)}</div>
    <div class="launch-sys">${(game.system || game.systemId || '').toUpperCase()} · TIER ${game.tier}</div>
    <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);
                letter-spacing:0.15em;margin-top:24px">
      ${_launchModeLabel}
    </div>`;
  con.appendChild(cancelBtn);

  // ESC cancels the overlay while the fetch is in flight
  const onEsc = e => { if (e.key === 'Escape') { _closeLaunchOverlay(); KenteAudio.setHumVol(0.018); } };
  document.addEventListener('keydown', onEsc, { once: true });

  try {
    const res = await fetch(`${KENTE_SERVER_URL}/api/launch`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ systemId: game.systemId, title: game.title, gameId: game.id }),
      signal:  _abortTimeout(30_000),
    });
    document.removeEventListener('keydown', onEsc);
    const data = await res.json();

    if (data.success) {
      const isNativeEmulator = (data.message || '').startsWith('emulator:');

      // ── In Electron: hide the window so the emulator owns the full screen ──
      // Wait 400 ms first so the gold launch animation is visible before we vanish.
      if (isNativeEmulator) {
        setTimeout(() => window.electronAPI?.hideWindow?.(), 400);
      }

      // ── Seamless OS handoff: hold a plain black overlay ──────────────────────
      con.innerHTML = '';
      _launchOverlayHoldTimer = setTimeout(() => {
        _closeLaunchOverlay();
        KenteAudio.setHumVol(0);  // keep muted — emulator has audio
      }, isNativeEmulator ? 800 : 1500);

      // Poll /api/app/status so we know when the emulator exits.
      if (_nativeAppPoll) clearInterval(_nativeAppPoll);
      _nativeAppPoll = setInterval(async () => {
        try {
          const sr = await fetch(`${KENTE_SERVER_URL}/api/app/status`, { signal: _abortTimeout(3000) });
          if (!sr.ok) return;
          const sd = await sr.json();
          if (!sd.running) {
            clearInterval(_nativeAppPoll); _nativeAppPoll = null;
            // Game exited — restore audio and status
            KenteAudio.setHumVol(0.018);
            _updateServerDot();
            // Show the KenteCorner window again, then focus it
            window.electronAPI?.showWindow?.();
            window.electronAPI?.focusWindow?.();
          }
        } catch { /* transient — keep polling */ }
      }, 2000);

    } else if (data.error === 'ROM_NOT_FOUND' && !fromCloud) {
      // ROM missing from /userdata/roms/ — try Archive.org
      launchNativeFromCloud(game, overlay, con);
    } else {
      _closeLaunchOverlay();
      KenteAudio.setHumVol(0.018);
      showToast(`⚠ LAUNCH FAILED — ${(data.message || 'UNKNOWN ERROR').toUpperCase()}`);
    }
  } catch {
    document.removeEventListener('keydown', onEsc);
    _closeLaunchOverlay();
    KenteAudio.setHumVol(0.018);
    showToast('⚠ KENTE SERVER CONNECTION LOST — FALLING BACK TO BROWSER MODE');
    KENTE_SERVER_ONLINE = false;
    _updateServerDot();
  }
}

/* ══════════════════════════════════════════
   NATIVE CLOUD DOWNLOAD
   Called when launchNative() gets ROM_NOT_FOUND,
   OR directly from launchGame() for native-only
   systems on non-Batocera hosts (downloadOnly=true).
   Searches Archive.org, streams the ROM through
   the native server proxy (which saves it to
   /userdata/roms/<system>/ on Batocera, or
   roms/<system>/ locally on Windows), then either
   re-launches via Batocera or shows a success screen.
══════════════════════════════════════════ */
async function launchNativeFromCloud(game, overlay, con, downloadOnly = false) {
  // Region preference helpers — same order as launchFromCloud
  const RGN_USA = /\((usa|world|en)\b/i;
  const RGN_EU  = /\((europe|eur|eu)\b/i;
  const RGN_JP  = /\((japan|jpn|jp)\b/i;

  // Update the launch overlay (already open) to show cloud download state
  con.innerHTML = `
    <div class="launch-title">ROM NOT ON DRIVE</div>
    <div class="launch-game">${escHtml(game.title)}</div>
    <div class="launch-sys">${(game.system || game.systemId || '').toUpperCase()} · SEARCHING CLOUD...</div>
    <div id="ncld-status" style="font-family:var(--font-mono);font-size:10px;
         color:var(--text-dim);letter-spacing:0.15em;margin-top:24px">
      SEARCHING ARCHIVE.ORG...
    </div>
    <div id="ncld-bar-wrap" style="width:260px;height:3px;background:#111;margin-top:16px;display:none">
      <div id="ncld-bar" style="height:100%;background:var(--brand);width:0%;transition:width 0.2s"></div>
    </div>`;

  const statusEl  = () => document.getElementById('ncld-status');
  const barWrap   = () => document.getElementById('ncld-bar-wrap');
  const barEl     = () => document.getElementById('ncld-bar');

  const fail = msg => {
    overlay.classList.remove('active');
    KenteAudio.setHumVol(0.018);
    showToast(`⚠ ${msg}`);
  };

  try {
    // 1 — Search Archive.org for the ROM
    let archiveResults = await searchArchive(game.title, game.systemId);

    // 1b — Fallback: Archive.org pack collection search when subject search fails
    if (!archiveResults.length) {
      if (statusEl()) statusEl().textContent = 'ARCHIVE.ORG EMPTY — TRYING PACK COLLECTION...';
      const packHits = await searchPackCollection(game.title, game.systemId);
      if (packHits.length) {
        const validExtsFb = new Set((ROM_EXT[game.systemId] || []).map(e => e.toLowerCase()));
        const validHits = packHits.filter(f => {
          const ext = '.' + f.name.split('.').pop().toLowerCase();
          return validExtsFb.size === 0 || validExtsFb.has(ext);
        });
        const best =
          validHits.find(f => RGN_USA.test(f.name)) ||
          validHits.find(f => !RGN_EU.test(f.name) && !RGN_JP.test(f.name)) ||
          validHits[0];
        if (best) {
          archiveResults = [{ _packUrl: best.url, _packName: best.name }];
        }
      }
    }
    if (!archiveResults.length) {
      fail(`ROM NOT FOUND ON CLOUD — ADD IT TO roms/${game.systemId || ''}/`);
      return;
    }

    if (statusEl()) statusEl().textContent = 'MATCH FOUND — SELECTING FILE...';

    // 2 — Pick the best ROM file
    const validExts = new Set((ROM_EXT[game.systemId] || []).map(e => e.toLowerCase()));
    let romUrl = null, romFilename = null;

    for (const result of archiveResults.slice(0, 15)) {
      // Pack collection result — URL is already a direct archive.org download link
      if (result._packUrl) {
        romUrl      = result._packUrl;
        romFilename = result._packName;
        if (DEBUG) console.log(`[Kente/native] Picked pack ROM: ${romFilename}`);
        break;
      }
      let files;
      try {
        files = await getArchiveFiles(result.identifier, game.systemId);
      } catch (e) {
        console.warn(`[Kente/native] getArchiveFiles failed for ${result.identifier}:`, e.message);
        continue;
      }
      // Container formats must be ≥ CONTAINER_MIN_BYTES — filters out non-ROM
      // downloads (e.g. 3D-model zips that share a game title in the search index).
      const valid = files.filter(f => {
        const ext = '.' + f.name.split('.').pop().toLowerCase();
        if (!validExts.has(ext)) return false;
        if (CONTAINER_FORMATS.has(ext)) {
          const sz = parseInt(f.size || '0');
          return sz === 0 || sz >= CONTAINER_MIN_BYTES;  // 0 = unknown size, let through
        }
        return true;
      });
      if (!valid.length) continue;
      // Title-aware pool: if this item contains many files (pack), narrow by title
      // so we don't accidentally pick the wrong game from a multi-ROM archive.
      const _normWords = s => s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w.length>2);
      const _titleWords = new Set(_normWords(game.title));
      const _byTitle = valid.filter(f => _normWords(f.name).some(w => _titleWords.has(w)));
      const pool = _byTitle.length ? _byTitle : valid;
      const match =
        pool.find(f => RGN_USA.test(f.name))                          ||
        pool.find(f => !RGN_EU.test(f.name) && !RGN_JP.test(f.name)) ||
        pool.find(f => RGN_EU.test(f.name))                           ||
        pool[0];
      romFilename = match.name;
      romUrl = `https://archive.org/download/${result.identifier}/${encodeURIComponent(match.name)}`;
      if (DEBUG) console.log(`[Kente/native] Picked ROM: ${romFilename} from ${result.identifier}`);
      break;
    }
    if (!romUrl) { fail('ROM FILE NOT FOUND ON CLOUD'); return; }

    // 3 — Stream through native proxy (saves to /userdata/roms/<system>/ on Batocera,
    //     or roms/<system>/ locally on Windows / dev machine)
    if (statusEl()) statusEl().textContent = 'DOWNLOADING TO DRIVE...';
    const pp = new URLSearchParams({ url: romUrl, save: '1', systemId: game.systemId, filename: romFilename });
    const resp = await fetch(`${KENTE_SERVER_URL}/api/rom-proxy?${pp}`);
    if (!resp.ok) throw new Error(`HTTP_${resp.status}`);
    if (!resp.body) throw new Error('NO_BODY');

    const total  = Number(resp.headers.get('Content-Length')) || 0;
    const reader = resp.body.getReader();
    let received = 0;
    if (barWrap()) barWrap().style.display = 'block';

    // Read the stream — server writes to disk simultaneously on each chunk
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;  // discard chunks — we only need the server-side copy
      if (statusEl()) {
        const mb  = (received / 1_048_576).toFixed(1);
        const pct = total ? Math.round(received / total * 100) : 0;
        statusEl().textContent = `SAVING TO DRIVE... ${mb} MB${total ? ` · ${pct}%` : ''}`;
        if (barEl() && total) barEl().style.width = `${pct}%`;
      }
    }

    // 4 — Mark ROM as available in the current session's status map
    ROM_STATUS[game.id] = true;
    refreshGameCardDots();
    console.log(`[Kente] ROM saved via cloud: ${romFilename}`);

    // 5a — Download-only mode (non-Batocera host): show success screen
    if (downloadOnly) {
      const sysFolder = `roms/${game.systemId || 'unknown'}/`;
      con.innerHTML = `
        <div class="launch-title">DOWNLOAD COMPLETE</div>
        <div class="launch-game">${escHtml(game.title)}</div>
        <div class="launch-sys">${(game.system || game.systemId || '').toUpperCase()} · SAVED</div>
        <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);
                    letter-spacing:0.12em;line-height:2.2;margin:20px 0 8px;text-align:center;max-width:420px">
          <span style="color:var(--brand)">${escHtml(romFilename)}</span><br>
          SAVED TO <span style="color:var(--white)">${escHtml(sysFolder)}</span><br><br>
          TO PLAY: COPY TO <span style="color:var(--white)">/userdata/${escHtml(sysFolder)}</span> ON YOUR BATOCERA DEVICE<br>
          OR OPEN WITH <span style="color:var(--white)">PCSX2 / NATIVE EMULATOR</span> DIRECTLY.
        </div>
        <button class="launch-dismiss" style="margin-top:18px">✓ DONE</button>`;
      KenteAudio.setHumVol(0.018);
      return;
    }

    // 5b — Re-launch via Batocera — ROM is now on disk
    // Pass fromCloud=true so launchNative won't re-enter launchNativeFromCloud
    // if something goes wrong a second time (avoids infinite recursion).
    if (statusEl()) statusEl().textContent = 'DOWNLOAD COMPLETE — LAUNCHING...';
    overlay.classList.remove('active');
    await launchNative(game, true);

  } catch (err) {
    console.error('[launchNativeFromCloud]', err);
    fail(`CLOUD DOWNLOAD FAILED — ${(err.message || 'UNKNOWN').toUpperCase()}`);
  }
}

/* ══════════════════════════════════════════
   CLOUD DOWNLOAD ENTRY POINT
   Called from launchGame() for native-only
   systems (PS2, Dreamcast, GameCube, etc.)
   when the server is online on a non-Batocera
   host. Queues the ROM in DownloadManager so
   the download runs in the background while
   the user continues browsing.
══════════════════════════════════════════ */
function launchCloudDownloadOnly(game) {
  KenteAudio.click();
  DownloadManager.enqueue(game);
  // Show the Download Center so the user can see progress immediately
  openDownloadCenter();
}

/* ══════════════════════════════════════════
   ROM LIBRARY — Directory-based indexing
   Users point to one root folder once.
   Everything is auto-discovered from there.
══════════════════════════════════════════ */

// gameId → true  (ROM found in library scan)
// gameId → false (game exists but ROM missing)
let ROM_STATUS = {};

/* Called at boot — silently re-indexes the library if we already
   have a stored root handle with valid permission. */
async function initRomLibrary() {
  if (KENTE_SERVER_ONLINE) return; // native: server owns the filesystem

  // 1 — Scan user-set manual library if permission is already granted
  const entry = await LibraryDB.getRoot();
  if (entry?.handle) {
    try {
      const perm = await entry.handle.queryPermission({ mode: 'read' });
      if (perm === 'granted') {
        await silentScanLibrary(entry.handle);
      }
      // If perm !== 'granted' we wait — user gesture needed to re-request
    } catch(e) {
      console.warn('[initRomLibrary] Stale handle — clearing library root:', e);
      await LibraryDB.clear(); // handle is stale — clear it
    }
  }

  // 2 — Always scan the OPFS auto-library (no permission required).
  //     Downloads from the cloud browser land here automatically, so
  //     previously downloaded ROMs are immediately available on reload.
  await scanOPFSLibrary();
}

/* Walks the library root directory, matches ROMs to library games,
   saves all handles to RomDB, and updates ROM_STATUS.
   No overlays, no confirm dialogs — fully automatic. */
async function silentScanLibrary(dirHandle, announce = false) {
  const lib = window.KenteLibrary;
  if (!lib) return;

  const allFiles = [];
  // Precompute a Set of all valid ROM extensions once, outside the walk loop
  const validExtSet = new Set(Object.values(ROM_EXT).flat());
  async function walk(dir, depth = 0) {
    if (depth > 4) {
      console.warn('[Kente] silentScanLibrary: max nesting depth reached — some subdirectories were skipped');
      return;
    }
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        const ext = '.' + name.split('.').pop().toLowerCase();
        if (validExtSet.has(ext))
          allFiles.push({ name, handle, ext });
      } else if (handle.kind === 'directory') {
        await walk(handle, depth + 1);
      }
    }
  }
  try { await walk(dirHandle); } catch { return; }

  // Mark all active games as not-found first, then flip found ones
  lib.games.forEach(g => { ROM_STATUS[g.id] = false; });

  let matched = 0;
  for (const f of allFiles) {
    const eligible = lib.games.filter(g => (ROM_EXT[g.systemId] || []).includes(f.ext));
    const result   = matchRomToGame(f.name, eligible);
    if (result) {
      await RomDB.set(result.game.id, f.handle, f.name);
      ROM_STATUS[result.game.id] = true;
      matched++;
    }
  }

  refreshGameCardDots();
  if (announce) {
    try { localStorage.setItem('kente_scan_ts', Date.now().toString()); } catch {}
    showToast(`✓ LIBRARY SYNCED — ${matched} ROM${matched !== 1 ? 'S' : ''} INDEXED`);
  }
}

/* Re-applies availability dots to all currently visible game cards. */
function refreshGameCardDots() {
  document.querySelectorAll('.game-card[data-id]').forEach(card => {
    const dot = card.querySelector('.game-card-rom-dot');
    if (dot) dot.classList.toggle('found', !!ROM_STATUS[card.dataset.id]);
  });
}

/* Prompts the user to pick their ROM library root, stores the handle,
   and immediately scans it. Called from Sources and rom-options UI. */
async function setRomLibraryRoot() {
  if (!('showDirectoryPicker' in window)) {
    showToast('⚠ DIRECTORY PICKER REQUIRES CHROME OR EDGE');
    return;
  }
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    await LibraryDB.setRoot(dirHandle);
    KenteAudio.powerUp();
    await silentScanLibrary(dirHandle, true);
    // Refresh Sources panel if it's open
    if (state.activeMenu === 'sources') hydrateSourcesMenu();
  } catch { /* user cancelled */ }
}

/* ══════════════════════════════════════════
   BOOT SEQUENCE
══════════════════════════════════════════ */
function boot() {
  applyAllSettings();
  renderTVZones();
  renderAllMenus();
  bindEvents();
  GamepadManager.init();   // controller support — PS4/PS5/Xbox
  AttractMode.init();      // idle attract screen — fires after 30s inactivity in room
  detectKenteServer();     // silent — sets KENTE_SERVER_ONLINE
  initRomLibrary();        // silent — scans library root if permission already granted
  DownloadManager.init();  // restore completed downloads from IndexedDB + seed HUD badge
  document.getElementById('hud-dl-btn')
    ?.addEventListener('click', openDownloadCenter);
  document.getElementById('hud-repo-btn')
    ?.addEventListener('click', openKenteRepo);

  // Discord: when a native emulator exits, main.js sends kente:discord:reset
  // via webContents.send → preload → onDiscordReset callback → revert to browsing
  window.electronAPI?.onDiscordReset?.(() => {
    window.electronAPI?.clearDiscordPresence?.();
  });

  runSplash();
}

function runSplash() {
  function advance() {
    splash.removeEventListener('click', advance);
    document.removeEventListener('keydown', advance);
    try {
      KenteAudio.init();        // must be inside user gesture
      // Re-apply audio settings now that ctx is live
      // (applyAllSettings() in boot() was a no-op because ctx didn't exist yet)
      applySetting('volume');
      applySetting('ambientHum');
      KenteAudio.bootSting();
    } catch(e) {
      console.warn('[KenteAudio] boot failed:', e);
    }
    splash.style.transition = 'opacity 0.6s ease';
    splash.style.opacity = '0';
    setTimeout(enterRoom, 620);
  }

  const splash = document.getElementById('splash');
  splash.addEventListener('click', advance);
  document.addEventListener('keydown', advance);
}

/* ══════════════════════════════════════════
   SCREEN TRANSITIONS
══════════════════════════════════════════ */
// Stagger timer IDs — cancelled on re-entry so a rapid screen-change doesn't
// fire TV animations on the wrong screen.
let _enterRoomTimers = [];

function enterRoom() {
  // Cancel any in-flight stagger from a previous enterRoom() call that was
  // interrupted before all timers fired (e.g. user navigated away quickly).
  _enterRoomTimers.forEach(clearTimeout);
  _enterRoomTimers = [];

  setScreen('room');
  state.screen = 'room';
  KenteAudio.startHum();
  AttractMode.onEnterRoom();  // restart idle timer whenever we land back in the room
  // Animate TVs in with stagger
  const zones = document.querySelectorAll('.tv-zone');
  zones.forEach((z, i) => {
    z.style.opacity = '0';
    z.style.transform = 'scale(0.95)';
    const tid = setTimeout(() => {
      z.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
      z.style.opacity = '1';
      z.style.transform = 'scale(1)';
    }, i * 80 + 200);
    _enterRoomTimers.push(tid);
  });
}

function setScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function flashZoom(color, cb) {
  const fl = document.getElementById('zoom-flash');
  fl.style.background = color || '#ffffff';
  fl.classList.remove('flash');
  void fl.offsetWidth;              // force reflow so animation restarts
  fl.classList.add('flash');
  setTimeout(() => { fl.classList.remove('flash'); if(cb) cb(); }, 280);
}

/* ══════════════════════════════════════════
   TV ZONE PIN SYSTEM
   Pin any game directly to a TV zone.
   Clicking that TV bypasses the menu and opens
   the game detail panel straight from the room.
   Stored in localStorage['kente_zone_pins'].
══════════════════════════════════════════ */
function getZonePins() {
  try { return JSON.parse(localStorage.getItem('kente_zone_pins') || '{}'); } catch { return {}; }
}
function setZonePin(zoneId, gameId) {
  const pins = getZonePins();
  // Remove this gameId from any other zone first (one pin per game)
  for (const z of Object.keys(pins)) { if (pins[z] === gameId) delete pins[z]; }
  pins[zoneId] = gameId;
  localStorage.setItem('kente_zone_pins', JSON.stringify(pins));
  renderTVZones();   // refresh zone labels
}
function clearZonePin(zoneId) {
  const pins = getZonePins();
  delete pins[zoneId];
  localStorage.setItem('kente_zone_pins', JSON.stringify(pins));
  renderTVZones();
}

/** Shows a compact zone-picker dropdown under the button in the game detail panel */
function showZonePinPicker(game, btnEl) {
  // Remove any existing picker
  document.getElementById('zone-pin-picker')?.remove();
  const pins       = getZonePins();
  const isPinned   = Object.values(pins).includes(game.id);
  const myZone     = Object.entries(pins).find(([,gid]) => gid === game.id)?.[0];

  const picker = document.createElement('div');
  picker.id = 'zone-pin-picker';
  picker.style.cssText = `position:absolute;z-index:9999;background:#0d1117;border:1px solid #333;
    border-radius:6px;padding:8px 0;min-width:170px;box-shadow:0 4px 20px rgba(0,0,0,0.7);font-family:inherit`;

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'padding:4px 14px 8px;font-size:10px;color:#666;letter-spacing:.1em;border-bottom:1px solid #222';
  header.textContent = isPinned ? 'MOVE PIN OR UNPIN' : 'PIN TO WHICH TV?';
  picker.appendChild(header);

  // Zone buttons
  TV_ZONES.forEach(zone => {
    const row = document.createElement('button');
    const isThis = myZone === zone.id;
    const otherGame = pins[zone.id] ? window.KenteLibrary?.games.find(g => g.id === pins[zone.id]) : null;
    row.style.cssText = `width:100%;display:flex;align-items:center;gap:8px;padding:7px 14px;
      background:${isThis ? 'rgba(255,255,255,0.07)' : 'none'};border:none;color:#ccc;
      cursor:pointer;font-size:12px;text-align:left;font-family:inherit;letter-spacing:.05em`;
    row.innerHTML = `<span style="color:${zone.accent}">${zone.icon}</span>
      <span style="flex:1">${zone.label}</span>
      ${isThis ? '<span style="color:#4caf50;font-size:10px">PINNED ✓</span>' :
        otherGame ? `<span style="color:#666;font-size:9px">${otherGame.title.substring(0,12)}…</span>` : ''}`;
    row.addEventListener('click', () => {
      if (isThis) { clearZonePin(zone.id); showToast(`📌 Unpinned from ${zone.label}`); }
      else        { setZonePin(zone.id, game.id); showToast(`📌 ${game.title} → ${zone.label} TV`); }
      picker.remove();
      // Refresh pin button label
      const pinBtn = document.getElementById('gdp-pin-btn');
      if (pinBtn) pinBtn.textContent = _getZonePinLabel(game.id);
    });
    picker.appendChild(row);
  });

  // Position below the button
  document.body.appendChild(picker);
  const br = btnEl.getBoundingClientRect();
  picker.style.top  = (br.bottom + window.scrollY + 4) + 'px';
  picker.style.left = Math.max(8, br.left + window.scrollX - picker.offsetWidth + br.width) + 'px';

  // Close on outside click
  setTimeout(() => {
    const close = e => { if (!picker.contains(e.target) && e.target !== btnEl) { picker.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 0);
}

/* ══════════════════════════════════════════
   TV ZONE RENDERING
══════════════════════════════════════════ */
function renderTVZones() {
  // Clear any noise intervals from a previous render before creating new ones
  clearNoiseIntervals();
  const container = document.getElementById('tv-zones');
  container.innerHTML = '';

  // Load any saved debug positions (persisted by the zone editor via Shift+D)
  let _savedZonePos = {};
  try { _savedZonePos = JSON.parse(localStorage.getItem('kente_zone_pos') || '{}'); } catch {}

  TV_ZONES.forEach((tv, i) => {
    const zone = document.createElement('div');
    zone.className = 'tv-zone';
    zone.dataset.tv = tv.id;
    zone.setAttribute('tabindex', '0');
    zone.setAttribute('aria-label', tv.label);

    // Use saved editor position if available, otherwise fall back to hardcoded defaults
    const saved = _savedZonePos[tv.id];
    const pos   = saved || tv.pos;

    zone.dataset.debugPos = `top:${pos.top} left:${pos.left}\n${pos.width} × ${pos.height}`;

    // Stagger flicker + sweep so all TVs don't pulse in sync
    const flickerOffset = -(i * 1.3).toFixed(1) + 's';
    const sweepOffset   = -(i * 0.9).toFixed(1) + 's';
    zone.style.cssText = `
      top:${pos.top}; left:${pos.left};
      width:${pos.width}; height:${pos.height};
      --tv-accent: rgba(${tv.accentRgb},0.12);
      --tv-accent-solid: ${tv.accent};
      --flicker-offset: ${flickerOffset};
      --sweep-offset: ${sweepOffset};
    `;

    // Check if this zone has a pinned game
    const _pins    = getZonePins();
    const pinnedId = _pins[tv.id];
    const pinnedG  = pinnedId ? window.KenteLibrary?.games.find(g => g.id === pinnedId) : null;

    zone.innerHTML = `
      <div class="tv-label">
        <div>
          <div class="tv-label-name">${tv.icon} ${tv.label}</div>
          <div class="tv-label-desc">${pinnedG ? `📌 ${pinnedG.title}` : tv.desc}</div>
        </div>
        <div class="tv-status-dot"></div>
      </div>
    `;

    // Inject live screen effect (canvas noise + tint + sweep)
    addTVScreenEffect(zone, tv);

    zone.addEventListener('click', () => selectTV(tv));
    zone.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' ') selectTV(tv); });
    zone.addEventListener('mouseenter', () => {
      state.focusedTV = tv.id;
      KenteAudio.click();
      updateTickerForTV(tv);
    });
    zone.addEventListener('mouseleave', () => {
      state.focusedTV = null;
      resetTicker();
    });

    container.appendChild(zone);
  });
}

/* ══════════════════════════════════════════
   TV SCREEN LIFE — CANVAS NOISE + TINT + SWEEP
══════════════════════════════════════════ */
function addTVScreenEffect(zoneEl, tv) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tv-screen-effect';

  // Canvas for animated static noise
  const canvas = document.createElement('canvas');
  canvas.className = 'tv-noise-canvas';
  canvas.width  = 80;
  canvas.height = 60;
  wrapper.appendChild(canvas);

  // Colored tint that breathes with the TV's accent
  const tint = document.createElement('div');
  tint.className = 'tv-color-tint';
  tint.style.background = `rgba(${tv.accentRgb}, 1)`;
  wrapper.appendChild(tint);

  // Scanline sweep band
  const sweep = document.createElement('div');
  sweep.className = 'tv-scanline-sweep';
  wrapper.appendChild(sweep);

  // Insert before the label so label sits on top
  zoneEl.insertBefore(wrapper, zoneEl.firstChild);

  // Start drawing noise
  animateNoise(canvas, tv.accentRgb);
}

// Tracks all active noise intervals so they can be cleared before re-rendering zones
const _noiseIntervals = [];

function clearNoiseIntervals() {
  while (_noiseIntervals.length) clearInterval(_noiseIntervals.pop());
}

function animateNoise(canvas, accentRgb) {
  const ctx2d = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const [r, g, b] = accentRgb.split(',').map(Number);

  function drawFrame() {
    const img  = ctx2d.createImageData(w, h);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      const v      = Math.random() * 255;
      const blend  = 0.25;
      data[i]   = v * (1 - blend) + r * blend;
      data[i+1] = v * (1 - blend) + g * blend;
      data[i+2] = v * (1 - blend) + b * blend;
      data[i+3] = Math.floor(Math.random() * 28);   // low opacity for subtlety
    }
    ctx2d.putImageData(img, 0, 0);
  }

  drawFrame();
  _noiseIntervals.push(setInterval(drawFrame, 120));   // ~8 fps — authentic CRT feel
}

/* ══════════════════════════════════════════
   TV SELECTION + ZOOM TRANSITION
══════════════════════════════════════════ */
function selectTV(tv) {
  if (state.screen !== 'room' || state.transitioning) return;

  // ── Pin shortcut: if this zone has a pinned game, open its detail directly ──
  const _pinned = getZonePins()[tv.id];
  if (_pinned) {
    KenteAudio.select();
    // Temporarily set activeMenu so game detail accent color is correct
    state.activeMenu = tv.id;
    openGameDetail(_pinned);
    return;
  }

  state.transitioning = true;

  // ── 1. Aim the zoom at the clicked TV's center ──
  const zoneEl    = document.querySelector(`.tv-zone[data-tv="${tv.id}"]`);
  const container = document.getElementById('tv-zones');
  const cRect     = container.getBoundingClientRect();
  const zRect     = zoneEl.getBoundingClientRect();
  const originX   = (((zRect.left - cRect.left) + zRect.width  / 2) / cRect.width  * 100).toFixed(1) + '%';
  const originY   = (((zRect.top  - cRect.top)  + zRect.height / 2) / cRect.height * 100).toFixed(1) + '%';

  const roomBg  = document.getElementById('room-bg');
  const aberr   = document.getElementById('room-aberration');
  roomBg.style.setProperty('--zoom-x', originX);
  roomBg.style.setProperty('--zoom-y', originY);
  aberr.style.setProperty('--zoom-x', originX);
  aberr.style.setProperty('--zoom-y', originY);

  // ── 2. Fire sound + animation together ──
  KenteAudio.warp();
  KenteAudio.setHumVol(0);

  // Restart animations cleanly
  roomBg.classList.remove('zooming', 'zooming-out');
  aberr.classList.remove('active');
  void roomBg.offsetWidth;

  roomBg.classList.add('zooming');
  aberr.classList.add('active');

  // ── 3. Color flash at peak of warp (~500ms in), then open menu ──
  setTimeout(() => {
    flashZoom(tv.accent, () => {
      try {
        openMenu(tv.id);
      } catch(e) {
        console.error('[Kente] openMenu failed:', e);
      } finally {
        state.transitioning = false;
      }
    });
  }, 490);
}

const CONTENT_FNS = {
  play:        () => contentPlay(),
  collections: () => contentCollections(),
  sources:     () => contentSources(),
  memory:      () => contentMemory(),
  theater:     () => contentTheater(),
  settings:    () => contentSettings()
};

/* Async hydration runs AFTER the sync HTML is painted.
   Each fn fills in placeholder elements with live server data. */
const HYDRATE_FNS = {
  sources:  () => hydrateSourcesMenu(),
  memory:   () => hydrateMemoryMenu(),
  settings: () => hydrateSettingsMenu(),
  theater:  () => hydrateTheaterMenu(),
};

function openMenu(id) {
  GamepadManager.resetFocus();
  document.querySelectorAll('.menu-screen').forEach(m => m.classList.remove('active'));
  const menu = document.getElementById('menu-' + id);
  if (!menu) return;

  // Re-render only this menu's content so library/system state is always fresh
  const contentEl = menu.querySelector(`#content-${id}`);
  if (contentEl && CONTENT_FNS[id]) {
    contentEl.innerHTML = CONTENT_FNS[id]();
    // Fire async hydration after paint (non-blocking)
    if (HYDRATE_FNS[id]) requestAnimationFrame(() => HYDRATE_FNS[id]());
  }

  menu.classList.add('active');
  state.screen     = 'menu';
  state.activeMenu = id;
  AttractMode.onLeaveRoom();  // cancel idle timer while in a menu
  // Auto-focus first item for gamepad users (after DOM paints)
  requestAnimationFrame(() => GamepadManager.applyFocus(0));
}

function closeMenu() {
  if (state.transitioning) return;
  state.transitioning = true;

  // Close any panels or overlays that may still be open
  document.getElementById('game-detail-panel')?.classList.remove('open');
  document.getElementById('source-detail-panel')?.classList.remove('open');
  document.getElementById('launch-overlay')?.classList.remove('active');
  document.getElementById('rom-scan-overlay')?.classList.remove('active');

  KenteAudio.back();

  // Matrix rain wipes across the screen, covers the menu, then the room is revealed
  MatrixTransition.run(() => {
    document.querySelectorAll('.menu-screen').forEach(m => m.classList.remove('active'));

    const roomBg = document.getElementById('room-bg');
    const aberr  = document.getElementById('room-aberration');

    // Room eases in from a slight push while the rain canvas fades out
    roomBg.classList.remove('zooming', 'zooming-out');
    aberr.classList.remove('active');
    void roomBg.offsetWidth;
    roomBg.classList.add('zooming-out');

    KenteAudio.setHumVol(0.018);
    state.screen     = 'room';
    state.activeMenu = null;
    GamepadManager.resetFocus();
    AttractMode.onEnterRoom();

    setTimeout(() => {
      roomBg.classList.remove('zooming-out');
      state.transitioning = false;
    }, 460);
  });
}

/* ══════════════════════════════════════════
   TICKER
══════════════════════════════════════════ */
function updateTickerForTV(tv) {
  const track = document.getElementById('ticker-track');
  if (!track) return;
  // Save default content only once — never overwrite with accent spans
  if (!track.dataset.default) track.dataset.default = track.innerHTML;
  const msg = `● ${tv.label} — ${tv.desc}   ● PRESS ENTER TO ENTER   ● ${tv.label} — ${tv.desc}   ● PRESS ENTER TO ENTER`;
  track.innerHTML = `<span class="tick" style="color:${tv.accent}">${msg}</span>
                     <span class="tick" style="color:${tv.accent}">${msg}</span>`;
  // Restart scroll animation from position 0 so it doesn't jump mid-scroll
  track.style.animation = 'none';
  void track.offsetWidth;
  track.style.animation = '';
}

function resetTicker() {
  const track = document.getElementById('ticker-track');
  if (!track || !track.dataset.default) return;
  track.innerHTML = track.dataset.default;
  track.style.animation = 'none';
  void track.offsetWidth;
  track.style.animation = '';
}

/* ══════════════════════════════════════════
   EVENT BINDING
══════════════════════════════════════════ */
function bindEvents() {
  // Keyboard navigation
  document.addEventListener('keydown', handleKey);
}

function handleKey(e) {
  // OSK has full priority — its own capture-phase listener already handled
  // navigation + close.  Defer everything else.
  if (typeof KenteOSK !== 'undefined' && KenteOSK.active()) return;

  // While a text-entry field is focused, let the browser handle arrow keys,
  // Backspace, Enter etc. so users can edit naturally without the menu
  // navigation hijacking their typing.  Escape still closes via the block
  // below — that's intentional so the user can always bail out.
  const ae = document.activeElement;
  const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
  if (typing && e.key !== 'Escape') return;

  // Shift+D — debug/editor toggle (any screen)
  if (e.shiftKey && e.key === 'D') { toggleDebug(); return; }
  if (document.body.classList.contains('debug-zones')) {
    // C — save + copy current zone positions to clipboard
    if (e.key === 'c') { copyZoneConfig(); return; }
    // R — reset all zones to hardcoded TV_ZONES defaults
    if (e.key === 'r') { resetZonePositions(); return; }
  }

  // D — toggle Download Center (room or menu screens only, not in-game)
  if ((e.key === 'd' || e.key === 'D') && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    if (state.screen === 'room' || state.screen === 'menu') {
      e.preventDefault();
      const dlOv = document.getElementById('downloads-overlay');
      if (dlOv?.classList.contains('active')) {
        dlOv.classList.remove('active');
        GamepadManager.resetFocus();
      } else {
        openDownloadCenter();
      }
      return;
    }
  }

  // R — toggle Kente's Repository panel (room or menu screens only)
  if ((e.key === 'r' || e.key === 'R') && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    if (state.screen === 'room' || state.screen === 'menu') {
      e.preventDefault();
      const rpOv = document.getElementById('repo-overlay');
      if (rpOv?.classList.contains('active')) {
        rpOv.classList.remove('active');
        GamepadManager.resetFocus();
      } else {
        openKenteRepo();
      }
      return;
    }
  }

  // Escape / Backspace — always intercept so Backspace can't navigate the browser away
  if (e.key === 'Escape' || e.key === 'Backspace') {
    e.preventDefault();
    // In-game pause menu — Escape resumes
    if (state.screen === 'paused') { hideIngameMenu(); return; }
    // In-game (no menu open) — Escape opens pause menu
    if (state.screen === 'playing') { showIngameMenu(); return; }
    const launchOv = document.getElementById('launch-overlay');
    const scanOv   = document.getElementById('rom-scan-overlay');
    const dlOv     = document.getElementById('downloads-overlay');
    if (launchOv?.classList.contains('active')) { launchOv.classList.remove('active'); return; }
    if (scanOv?.classList.contains('active'))   { scanOv.classList.remove('active');   return; }
    if (dlOv?.classList.contains('active'))     { dlOv.classList.remove('active'); GamepadManager.resetFocus(); return; }
    const tdOv = document.getElementById('theater-detail-overlay');
    if (tdOv?.classList.contains('active'))     { closeTheaterDetail(); GamepadManager.resetFocus(); return; }
    if (state.screen === 'menu') { closeMenu(); return; }
    return;
  }

  // ── In-game pause menu keyboard navigation ──
  if (state.screen === 'paused') {
    const btns = [...document.querySelectorAll('.ingame-btn')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      _igmFocus = (_igmFocus + 1) % btns.length; updateIgmFocus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      _igmFocus = (_igmFocus - 1 + btns.length) % btns.length; updateIgmFocus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); btns[_igmFocus]?.click();
    }
    return;
  }

  // ── Menu keyboard navigation (delegates to GamepadManager focus system) ──
  if (state.screen === 'menu') {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault(); GamepadManager.navigate('down');
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault(); GamepadManager.navigate('up');
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); GamepadManager.confirm();
    }
    return;
  }

  // ── Room keyboard navigation ──
  if (state.screen === 'room') {
    const zones = TV_ZONES;
    if (e.key === 'ArrowRight' || e.key === 'Tab') {
      e.preventDefault();
      state.focusIndex = (state.focusIndex + 1) % zones.length;
      focusZone(zones[state.focusIndex]);
    } else if (e.key === 'ArrowLeft') {
      state.focusIndex = (state.focusIndex - 1 + zones.length) % zones.length;
      focusZone(zones[state.focusIndex]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      const tv = zones[state.focusIndex];
      if (tv) selectTV(tv);
    }
  }
}

/* ══════════════════════════════════════════
   DEBUG / ZONE EDITOR
   Shift+D  → toggle editor
   Drag zones to reposition, grab SE corner to resize
   C (while editor open) → copy updated config to clipboard
══════════════════════════════════════════ */
function toggleDebug() {
  const on = document.body.classList.toggle('debug-zones');
  if (on) enableZoneEditor(); else disableZoneEditor();
}

function enableZoneEditor() {
  document.querySelectorAll('.tv-zone').forEach(zone => {
    zone.style.cursor = 'move';
    zone.style.userSelect = 'none';

    // Resize handle
    let handle = zone.querySelector('.resize-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'resize-handle';
      zone.appendChild(handle);
    }

    makeDraggable(zone);
    makeResizable(zone, handle);
  });
}

function disableZoneEditor() {
  document.querySelectorAll('.tv-zone').forEach(zone => {
    zone.style.cursor = '';
    zone.onmousedown = null;
    const h = zone.querySelector('.resize-handle');
    if (h) h.onmousedown = null;
  });
}

function makeDraggable(zone) {
  zone.addEventListener('mousedown', function(e) {
    if (e.target.classList.contains('resize-handle')) return;
    e.preventDefault();
    const container = document.getElementById('tv-zones');
    const rect  = container.getBoundingClientRect();
    const zRect = zone.getBoundingClientRect();
    const offX  = e.clientX - zRect.left;
    const offY  = e.clientY - zRect.top;

    function onMove(ev) {
      const newLeft = ((ev.clientX - offX - rect.left) / rect.width  * 100).toFixed(2);
      const newTop  = ((ev.clientY - offY - rect.top)  / rect.height * 100).toFixed(2);
      zone.style.left = newLeft + '%';
      zone.style.top  = newTop  + '%';
      syncDebugLabel(zone);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

function makeResizable(zone, handle) {
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    e.stopPropagation();
    const container = document.getElementById('tv-zones');
    const rect  = container.getBoundingClientRect();
    const zRect = zone.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startW = zRect.width, startH = zRect.height;

    function onMove(ev) {
      const newW = Math.max(40, startW + (ev.clientX - startX));
      const newH = Math.max(30, startH + (ev.clientY - startY));
      zone.style.width  = (newW / rect.width  * 100).toFixed(2) + '%';
      zone.style.height = (newH / rect.height * 100).toFixed(2) + '%';
      syncDebugLabel(zone);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

function syncDebugLabel(zone) {
  const t = parseFloat(zone.style.top).toFixed(1)  + '%';
  const l = parseFloat(zone.style.left).toFixed(1) + '%';
  const w = parseFloat(zone.style.width).toFixed(1) + '%';
  const h = parseFloat(zone.style.height).toFixed(1) + '%';
  zone.dataset.debugPos = `top:${t} left:${l}\n${w} × ${h}`;
  // Auto-persist position to localStorage so it survives page reload
  saveZonePositions();
}

/** Persist all current zone positions to localStorage. */
function saveZonePositions() {
  const pos = {};
  document.querySelectorAll('.tv-zone').forEach(zone => {
    const id = zone.dataset.tv;
    if (!id) return;
    pos[id] = {
      top:    parseFloat(zone.style.top).toFixed(1)    + '%',
      left:   parseFloat(zone.style.left).toFixed(1)   + '%',
      width:  parseFloat(zone.style.width).toFixed(1)  + '%',
      height: parseFloat(zone.style.height).toFixed(1) + '%',
    };
  });
  try { localStorage.setItem('kente_zone_pos', JSON.stringify(pos)); } catch {}
}

function copyZoneConfig() {
  if (!document.body.classList.contains('debug-zones')) return;
  const lines = [];
  document.querySelectorAll('.tv-zone').forEach(zone => {
    const id = zone.dataset.tv;
    const t  = parseFloat(zone.style.top).toFixed(1)   + '%';
    const l  = parseFloat(zone.style.left).toFixed(1)  + '%';
    const w  = parseFloat(zone.style.width).toFixed(1) + '%';
    const h  = parseFloat(zone.style.height).toFixed(1)+ '%';
    lines.push(`  // ${id.toUpperCase()}\n  pos: { top:'${t}', left:'${l}', width:'${w}', height:'${h}' }`);
  });
  const out = '// ── PASTE INTO TV_ZONES pos: fields ──\n' + lines.join(',\n\n');
  // Save to localStorage AND copy to clipboard
  saveZonePositions();
  navigator.clipboard.writeText(out).then(() => {
    showToast('📋 POSITIONS SAVED + COPIED TO CLIPBOARD\nPASTE INTO TV_ZONES IN kente.js TO MAKE PERMANENT');
  });
}

/** Reset all zone positions to the hardcoded TV_ZONES defaults and clear localStorage. */
function resetZonePositions() {
  document.querySelectorAll('.tv-zone').forEach(zone => {
    const tv = TV_ZONES.find(t => t.id === zone.dataset.tv);
    if (!tv) return;
    zone.style.top    = tv.pos.top;
    zone.style.left   = tv.pos.left;
    zone.style.width  = tv.pos.width;
    zone.style.height = tv.pos.height;
    // Update label directly — skip saveZonePositions so localStorage stays clear
    zone.dataset.debugPos = `top:${tv.pos.top} left:${tv.pos.left}\n${tv.pos.width} × ${tv.pos.height}`;
  });
  try { localStorage.removeItem('kente_zone_pos'); } catch {}
  showToast('↺ ZONE POSITIONS RESET TO DEFAULTS');
}

let _toastTimer = null;
function showToast(msg) {
  let t = document.getElementById('kente-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'kente-toast';
    document.getElementById('kente-app').appendChild(t);
  }
  // Cancel any in-flight dismiss so rapid toasts don't cut each other short
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  t.textContent = msg;
  t.classList.add('show');
  _toastTimer = setTimeout(() => { t.classList.remove('show'); _toastTimer = null; }, 2800);
}

function focusZone(tv) {
  document.querySelectorAll('.tv-zone').forEach(z => z.classList.remove('focused'));
  const el = document.querySelector(`.tv-zone[data-tv="${tv.id}"]`);
  if (el) { el.classList.add('focused'); el.focus(); }
  KenteAudio.focus();
  updateTickerForTV(tv);
}



/* ══════════════════════════════════════════
   MENU CONTENT RENDERING
══════════════════════════════════════════ */
function renderAllMenus() {
  TV_ZONES.forEach(tv => {
    const el = document.getElementById('menu-' + tv.id);
    if (!el) return;
    el.style.setProperty('--menu-accent', tv.accent);
    el.innerHTML = buildMenuShell(tv) + buildMenuContent(tv);
    el.querySelector('.menu-back-btn')?.addEventListener('click', closeMenu);
    el.appendChild(buildCRTOverlay());
  });
}

function buildCRTOverlay() {
  const d = document.createElement('div');
  d.className = 'crt-overlay';
  return d;
}

function buildMenuShell(tv) {
  return `
    <div class="menu-header">
      <button class="menu-back-btn">◀ BACK</button>
      <div class="menu-title">${tv.icon} ${tv.label}</div>
      <div class="menu-subtitle">${tv.desc.toUpperCase()}</div>
    </div>
    <div class="menu-content" id="content-${tv.id}">
  `;
}

function buildMenuContent(tv) {
  const fn = CONTENT_FNS[tv.id];
  return (fn ? fn() : '') + '</div>';
}

/* ── PLAY MENU ── */
function getActiveGames() {
  const lib = window.KenteLibrary;
  if (!lib) return [];
  const activeSysIds = new Set(SYSTEMS.filter(s => s.active && !s.sacrificed).map(s => s.id));
  // Flash games always included — stream via Ruffle, no ROM or system unlock required.
  // Native games (nativeExe / nativeExeLinux) always included — launched directly by the OS,
  // not gated behind a SYSTEMS tier; launchGame() handles the exe/platform check first.
  return lib.games.filter(g => g.systemId === 'flash' || g.systemId === 'native' || activeSysIds.has(g.systemId));
}

function gameCard(g, extraStyle = '', extraAttrs = '') {
  const colors      = (window.KenteLibrary?.systemColors || {})[g.systemId] || ['#1a1a2e','#0a0a18'];
  const isFlash     = g.systemId === 'flash';

  // A game needs native mode when it has no confirmed EmulatorJS CDN core.
  const needsNative = !isFlash && !CORE_MAP[g.systemId];

  // ROM availability dot — green when the user can play, grey when ROM is missing
  const hasRom    = isFlash || KENTE_SERVER_ONLINE || !!ROM_STATUS[g.id];
  const dotActive = isFlash || KENTE_SERVER_ONLINE || Object.keys(ROM_STATUS).length > 0;
  const dotClass  = dotActive ? (hasRom ? 'game-card-rom-dot found' : 'game-card-rom-dot') : 'game-card-rom-dot hidden';

  // NATIVE badge — shown on cards that can't run in browser mode
  const nativeBadge = needsNative
    ? `<div class="game-card-native-badge" title="REQUIRES NATIVE MODE (KENTE SERVER)">⚙ NATIVE</div>`
    : '';

  // Favorite star — gold when the game is in the favorites list
  const isFav   = getFavorites().includes(g.id);
  const favStar = `<div class="game-card-fav-star${isFav ? ' active' : ''}" title="${isFav ? 'FAVORITED' : 'ADD TO FAVORITES'}">★</div>`;

  // Box art — priority: server URL (auto-fetches online if needed) → local file → gradient
  // When server is online the /boxart/<id> endpoint serves cached files instantly
  // OR fetches from SteamGridDB/TheGamesDB on first request and caches to disk.
  // onerror cascades: server fail → local file → hide (show gradient fallback).
  const _artLocal  = `boxart/${g.id}.jpg`;
  const _artServer = `${KENTE_SERVER_URL}/boxart/${g.id}?title=${encodeURIComponent(g.title)}&sys=${g.systemId}`;
  const _artSrc    = KENTE_SERVER_ONLINE ? _artServer : _artLocal;
  const _artFallback = KENTE_SERVER_ONLINE
    ? `if(this.src.indexOf('localhost')>-1){this.src='${_artLocal}'}else{this.style.display='none'}`
    : `this.style.display='none'`;
  const artImg = `<img class="game-card-boxart" src="${_artSrc}" alt="${escHtml(g.title)}"
        loading="lazy"
        onerror="${_artFallback}"
        onload="this.style.display='block';this.closest('.game-card-art').classList.add('has-boxart')"
        style="display:none">`;

  return `
    <div class="game-card${needsNative ? ' native-only' : ''}" data-id="${g.id}" data-system="${g.systemId}" ${extraAttrs} style="${extraStyle}">
      <div class="game-card-art" style="background:linear-gradient(135deg,${colors[0]},${colors[1]})">
        ${artImg}
        <div class="game-card-cover">
          <div class="game-card-cover-sys">${g.system}</div>
          <div class="game-card-cover-title">${escHtml(g.title)}</div>
          <div class="game-card-cover-year">${g.year}</div>
        </div>
        ${nativeBadge}
        <div class="${dotClass}" title="${hasRom ? 'ROM IN LIBRARY' : 'ROM NOT FOUND'}"></div>
        ${favStar}
      </div>
      <div class="game-card-info">
        <div class="game-card-title">${escHtml(g.title)}</div>
        <div class="game-card-system">${escHtml(g.system)} · ${escHtml(g.year)}</div>
      </div>
    </div>`;
}

function contentPlay() {
  const games = getActiveGames();
  if (!games.length) return `
    <div class="section-label">GAME LIBRARY — 0 TITLES</div>
    <p class="menu-empty">NO ACTIVE SYSTEMS. USE THE SACRIFICE CHAMBER TO UNLOCK MORE SYSTEMS.</p>`;

  const uniqueSystems = [...new Set(games.map(g => g.system))];
  const chips = ['ALL', ...uniqueSystems].map((s, i) => {
    const sid = i === 0 ? 'all' : games.find(g => g.system === s)?.systemId || '';
    return `<button class="filter-chip${i===0?' active':''}" data-system="${sid}">${s}</button>`;
  }).join('');

  // Recently Played shelf
  const recentIds   = getRecents();
  const recentGames = recentIds.map(id => games.find(g => g.id === id)).filter(Boolean);
  const recentShelf = recentGames.length ? `
    <div class="section-label">RECENTLY PLAYED</div>
    <div class="play-shelf-row" id="recents-shelf">
      ${recentGames.map(g => gameCard(g, 'width:120px;flex-shrink:0;aspect-ratio:3/4')).join('')}
    </div>` : '';

  // Recently Downloaded shelf — sourced from DownloadManager completions
  const dlGames = getRecentDownloads(8);
  const dlShelf = dlGames.length ? `
    <div class="section-label" style="display:flex;align-items:center">
      <span>RECENTLY DOWNLOADED</span>
      <button class="dl-clear-btn" data-dlaction="clearCompleted" title="Clear download history">CLEAR</button>
    </div>
    <div class="play-shelf-row" id="recent-dl-shelf">
      ${dlGames.map(g => gameCard(g, 'width:120px;flex-shrink:0;aspect-ratio:3/4')).join('')}
    </div>` : '';

  // Favorites shelf
  const favIds   = getFavorites();
  const favGames = favIds.map(id => games.find(g => g.id === id)).filter(Boolean);
  const favShelf = favGames.length ? `
    <div class="section-label">FAVORITES</div>
    <div class="play-shelf-row" id="favs-shelf">
      ${favGames.map(g => gameCard(g, 'width:120px;flex-shrink:0;aspect-ratio:3/4')).join('')}
    </div>` : '';

  return `
    ${recentShelf}${dlShelf}${favShelf}
    <div class="section-label">GAME LIBRARY — ${games.length} TITLE${games.length!==1?'S':''} ACTIVE</div>
    <div class="filter-bar" id="play-filter-bar">${chips}</div>
    <div class="game-grid" id="play-grid">${games.map(g => gameCard(g)).join('')}</div>`;
}

/* ── COLLECTIONS MENU ── */
function contentCollections() {
  const lib = window.KenteLibrary;
  if (!lib) return '<p class="menu-empty">LIBRARY NOT LOADED.</p>';
  const games = getActiveGames();
  if (!games.length) return `
    <div class="section-label">COLLECTIONS — 0 TITLES</div>
    <p class="menu-empty">NO ACTIVE SYSTEMS. UNLOCK MORE IN THE SACRIFICE CHAMBER.</p>`;

  // Only include collections that have at least one game
  const cols = lib.collections.filter(col => games.some(g => g.tags.includes(col.id)));

  // Filter chips — ALL GAMES, A–Z, ★ FAVORITES, then each collection
  const chips = [
    `<button class="filter-chip active" data-col="all">ALL GAMES</button>`,
    `<button class="filter-chip" data-col="az">A–Z</button>`,
    `<button class="filter-chip" data-col="favorites">★ FAVORITES</button>`,
    ...cols.map(col => {
      const count = games.filter(g => g.tags.includes(col.id)).length;
      // Escape all library-sourced values that end up in attribute values or
      // innerHTML so a collection name/desc containing " or < can't break the
      // attribute or inject markup when the strip reads from dataset.
      return `<button class="filter-chip"
        data-col="${escHtml(col.id)}"
        data-col-icon="${escHtml(col.icon)}"
        data-col-name="${escHtml(col.name)}"
        data-col-desc="${escHtml(col.desc)}"
        data-col-count="${escHtml(String(count))}">${escHtml(col.icon)} ${escHtml(col.name)}</button>`;
    }),
  ].join('');

  // Game cards — data-title and data-orig-idx allow A-Z sort + restore
  const cards = games.map((g, i) =>
    gameCard(g, '', `data-col="${g.tags.join(' ')}" data-title="${escHtml(g.title)}" data-orig-idx="${i}"`)
  ).join('');

  // Recently Downloaded shelf — sourced from DownloadManager completions
  const dlGames = getRecentDownloads(8);
  const dlShelf = dlGames.length ? `
    <div class="section-label" style="display:flex;align-items:center">
      <span>RECENTLY DOWNLOADED</span>
      <button class="dl-clear-btn" data-dlaction="clearCompleted" title="Clear download history">CLEAR</button>
    </div>
    <div class="play-shelf-row" id="col-recent-dl-shelf">
      ${dlGames.map(g => gameCard(g, 'width:120px;flex-shrink:0;aspect-ratio:3/4')).join('')}
    </div>` : '';

  return `
    ${dlShelf}
    <div class="section-label">COLLECTIONS — ${games.length} TITLE${games.length!==1?'S':''} · ${cols.length} COLLECTION${cols.length!==1?'S':''}</div>
    <div class="filter-bar" id="col-filter-bar">${chips}</div>
    <div id="col-info-strip" class="col-info-strip" hidden></div>
    <div class="game-grid" id="col-grid">${cards}</div>`;
}

/* ── SOURCES MENU ── */
function contentSources() {
  const totalGames   = getActiveGames().length;
  const totalSystems = SYSTEMS.filter(s => s.active && !s.sacrificed).length;

  // ── ROM count from library scan ──
  const romCount   = Object.values(ROM_STATUS).filter(Boolean).length;
  const romTotal   = Object.keys(ROM_STATUS).length;
  const librarySet = romTotal > 0;

  // ── Built-in metadata catalog card (always present) ──
  const builtinCard = `
    <div class="source-card" data-src="1" data-name="BUILT-IN CATALOG" data-icon="📖" data-status="local" data-count="${totalGames}" style="cursor:pointer">
      <span class="source-card-icon">📖</span>
      <div class="source-card-name">BUILT-IN CATALOG</div>
      <div class="source-card-path">Metadata · ${totalGames} titles · ${totalSystems} systems</div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
        <div class="source-status local"><div class="source-status-dot"></div>INTERNAL</div>
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim)">${totalGames} TITLES</span>
      </div>
    </div>`;

  // ── ROM Library directory card (browser mode) ──
  const romLibCard = !KENTE_SERVER_ONLINE ? `
    <div class="source-card" id="rom-lib-card" style="cursor:pointer" data-action="setLibrary">
      <span class="source-card-icon">📂</span>
      <div class="source-card-name">ROM LIBRARY</div>
      <div class="source-card-path" id="rom-lib-path">
        ${librarySet ? `${romCount} / ${romTotal} ROMs INDEXED` : 'NOT CONFIGURED'}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
        <div class="source-status ${librarySet ? 'local' : 'offline'}">
          <div class="source-status-dot"></div>
          ${librarySet ? 'ACTIVE' : 'NOT SET'}
        </div>
        ${librarySet ? `<button class="sdp-action-btn" id="rom-lib-rescan"
          style="margin:0;padding:4px 10px;font-size:9px">↺ RESCAN</button>` : ''}
      </div>
    </div>` : '';

  // ── Physical drives section (native: hydrated; browser: stub) ──
  const liveSection = KENTE_SERVER_ONLINE
    ? `<div class="section-label">PHYSICAL DRIVES
         <span id="sources-scan-status" style="font-size:9px;color:var(--text-dim);margin-left:8px;letter-spacing:0.1em">SCANNING...</span>
       </div>
       <div class="source-grid" id="sources-live-grid">
         <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);letter-spacing:0.15em;padding:16px 0">READING DRIVES...</div>
       </div>`
    : '';

  return `
    <div class="section-label">CONNECTED SOURCES — ${totalSystems} SYSTEM${totalSystems!==1?'S':''} · ${totalGames} TITLES</div>
    <div class="source-grid">${builtinCard}${romLibCard}</div>
    ${liveSection}

    <div class="section-label">KENTE'S REPOSITORY</div>
    <div class="source-grid">
      <div class="source-card" data-action="openKenteRepo" style="cursor:pointer">
        <span class="source-card-icon">⭐</span>
        <div class="source-card-name">KENTE'S REPO</div>
        <div class="source-card-path">n-13thehat/KentesKorner</div>
        <div style="margin-top:8px">
          <div class="source-status local"><div class="source-status-dot" style="background:var(--brand)"></div>GITHUB · ROMS · EMULATORS</div>
        </div>
        <div class="source-card-repo-badge">PRESS R TO OPEN</div>
      </div>
    </div>

    <div class="section-label">ARCHIVE DOWNLOADS</div>
    <div class="source-grid">
      <div class="source-card" id="dl-count-card" data-action="openDownloads" style="cursor:pointer">
        <span class="source-card-icon">⬇</span>
        <div class="source-card-name">DOWNLOADED ROMS</div>
        <div class="source-card-path" id="dl-count-path">LOADING...</div>
        <div style="margin-top:8px">
          <div class="source-status local"><div class="source-status-dot"></div>ARCHIVE.ORG</div>
        </div>
      </div>
    </div>

    <div class="section-label">CLOUD PROVIDERS</div>
    <div class="source-grid">
      ${Object.values(CLOUD_PROVIDERS).map(p => `
        <div class="source-card" data-action="openCloud" data-provider="${p.id}" style="cursor:pointer">
          <span class="source-card-icon">${p.icon}</span>
          <div class="source-card-name">${p.name}</div>
          <div class="source-card-path">${p.desc}</div>
          <div style="margin-top:8px">
            <div class="source-status local"><div class="source-status-dot"></div>AVAILABLE</div>
          </div>
        </div>`).join('')}
      <div class="source-card" style="opacity:0.4;cursor:default">
        <span class="source-card-icon">☁️</span>
        <div class="source-card-name">KENTE CLOUD</div>
        <div class="source-card-path">Self-hosted cloud server</div>
        <div style="margin-top:8px">
          <div class="source-status offline"><div class="source-status-dot"></div>COMING SOON</div>
        </div>
      </div>
    </div>

    <div class="section-label">ADD SOURCE</div>
    <div class="source-grid">
      <div class="source-card" data-action="addSource" style="border-style:dashed;display:flex;align-items:center;justify-content:center;gap:10px;aspect-ratio:unset;padding:24px;cursor:pointer">
        <span style="font-size:20px;opacity:0.4">＋</span>
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);letter-spacing:0.15em">ADD NEW SOURCE</span>
      </div>
    </div>`;
}

async function hydrateSourcesMenu() {
  // ── Always: populate download count card ──
  const downloads  = await DownloadDB.getAll();
  const dlCountEl  = document.getElementById('dl-count-path');
  if (dlCountEl) {
    if (downloads.length === 0) {
      dlCountEl.textContent = 'NO ROMS DOWNLOADED YET';
    } else {
      const sysSet = new Set(downloads.map(d => d.systemId));
      dlCountEl.textContent = `${downloads.length} ROM${downloads.length !== 1 ? 'S' : ''} · ${sysSet.size} SYSTEM${sysSet.size !== 1 ? 'S' : ''}`;
    }
  }

  // ── Browser mode: populate ROM library card name + wire rescan ──
  if (!KENTE_SERVER_ONLINE) {
    const entry = await LibraryDB.getRoot();
    const pathEl = document.getElementById('rom-lib-path');
    if (pathEl && entry?.name) {
      const romCount = Object.values(ROM_STATUS).filter(Boolean).length;
      const romTotal = Object.keys(ROM_STATUS).length;
      pathEl.textContent = `📁 ${entry.name}  ·  ${romCount} / ${romTotal} ROMs INDEXED`;
    }
    document.getElementById('rom-lib-rescan')?.addEventListener('click', async e => {
      e.stopPropagation();
      const ent = await LibraryDB.getRoot();
      if (!ent?.handle) { await setRomLibraryRoot(); return; }
      try {
        const perm = await ent.handle.requestPermission({ mode: 'read' });
        if (perm === 'granted') {
          showToast('⚙ RESCANNING LIBRARY...');
          await silentScanLibrary(ent.handle, true);
          hydrateSourcesMenu(); // refresh the card
        }
      } catch(e) {
        console.warn('[hydrateSourcesMenu rescan]', e);
      }
    });
    return;
  }

  // ── Native mode: read physical drives from server ──
  const grid   = document.getElementById('sources-live-grid');
  const status = document.getElementById('sources-scan-status');
  if (!grid) return;
  try {
    const res      = await fetch(`${KENTE_SERVER_URL}/api/sources`, { signal: _abortTimeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sources  = await res.json();
    const external = sources.filter(s => s.type === 'external');
    if (status) status.textContent = external.length
      ? `${external.length} DRIVE${external.length !== 1 ? 'S' : ''} FOUND`
      : 'NO EXTERNAL DRIVES';
    if (!external.length) {
      grid.innerHTML = `<p class="menu-empty">NO EXTERNAL DRIVES DETECTED.<br>INSERT A USB DRIVE AND RESCAN.</p>`;
      return;
    }
    grid.innerHTML = external.map(s => {
      const eName = escHtml(s.name);
      const eIcon = escHtml(s.icon || '🔌');
      const ePath = escHtml(s.path) + (s.free ? ' · ' + escHtml(s.free) : '');
      return `
      <div class="source-card" data-src="1" data-name="${eName}" data-icon="${eIcon}" data-status="local" data-count="0" style="cursor:pointer">
        <span class="source-card-icon">${eIcon}</span>
        <div class="source-card-name">${eName}</div>
        <div class="source-card-path">${ePath}</div>
        <div style="margin-top:8px"><div class="source-status local"><div class="source-status-dot"></div>MOUNTED</div></div>
      </div>`;
    }).join('');
  } catch {
    if (status) status.textContent = 'SCAN FAILED';
    grid.innerHTML = `<p class="menu-empty">COULD NOT READ DRIVES — SERVER UNREACHABLE.</p>`;
  }
}


/* ── MEMORY CARD MENU ── */
function contentMemory() {
  const games          = getActiveGames();
  const activeSystems  = SYSTEMS.filter(s => s.active && !s.sacrificed);
  const sacrificed     = SYSTEMS.filter(s => s.sacrificed);
  const unlocked       = SYSTEMS.filter(s => s.active && s.tier > 1);

  const profiles = [
    { id:'player1', name:'PLAYER 1', avatar:'🎮' },
    { id:'player2', name:'PLAYER 2', avatar:'🕹️' },
    { id:'guest',   name:'GUEST',    avatar:'👤' },
  ];
  const profileCards = profiles.map(p => `
    <div class="profile-card${p.id===state.activeProfile?' active':''}" data-profile="${p.id}" style="cursor:pointer">
      <div class="profile-avatar">${p.avatar}</div>
      <div class="profile-name">${p.name}</div>
    </div>`).join('');

  const stats = [
    { val: games.length,                      label:'TITLES IN LIBRARY'  },
    { val: activeSystems.length,              label:'ACTIVE SYSTEMS'     },
    { val: sacrificed.length,                 label:'SYSTEMS SACRIFICED' },
    { val: unlocked.length,                   label:'SYSTEMS UNLOCKED'   },
  ];
  const statBoxes = stats.map(s => `
    <div class="stat-box">
      <div class="stat-value">${s.val}</div>
      <div class="stat-label">${s.label}</div>
    </div>`).join('');

  const sacrificedList = sacrificed.length
    ? sacrificed.map(s => `
        <div class="settings-item" style="opacity:0.4;cursor:default">
          <span class="settings-item-label" style="text-decoration:line-through">${s.name}</span>
          <span class="settings-item-value" style="color:#553333">SACRIFICED · TIER ${s.tier}</span>
        </div>`).join('')
    : `<p class="menu-empty">NO SACRIFICES MADE.</p>`;

  const storageStats = KENTE_SERVER_ONLINE ? `
    <div class="section-label">STORAGE &amp; HARDWARE</div>
    <div class="stats-grid" id="mem-storage-grid">
      <div class="stat-box"><div class="stat-value" id="mem-disk-free">…</div><div class="stat-label">STORAGE FREE</div></div>
      <div class="stat-box"><div class="stat-value" id="mem-saves-count">…</div><div class="stat-label">SAVE FILES</div></div>
      <div class="stat-box"><div class="stat-value" id="mem-controllers">…</div><div class="stat-label">CONTROLLERS</div></div>
      <div class="stat-box"><div class="stat-value" id="mem-batocera-ver">…</div><div class="stat-label">BATOCERA VER</div></div>
    </div>
    <div class="section-label">SAVE DATA</div>
    <div class="settings-list" id="mem-saves-list">
      <p class="menu-empty" style="padding:12px 0">LOADING SAVE DATA...</p>
    </div>` : '';

  return `
    <div class="section-label">PROFILES</div>
    <div class="profile-bar">${profileCards}</div>
    <div class="section-label">LIBRARY STATISTICS</div>
    <div class="stats-grid">${statBoxes}</div>
    ${storageStats}
    <div class="section-label">SACRIFICE HISTORY</div>
    <div class="settings-list">${sacrificedList}</div>`;
}

async function hydrateMemoryMenu() {
  if (!KENTE_SERVER_ONLINE) return;
  try {
    const [sysRes, savesRes] = await Promise.all([
      fetch(`${KENTE_SERVER_URL}/api/system/info`, { signal: _abortTimeout(8000) }),
      fetch(`${KENTE_SERVER_URL}/api/saves`,       { signal: _abortTimeout(8000) }),
    ]);
    const info  = await sysRes.json();
    const saves = await savesRes.json();

    const el = id => document.getElementById(id);
    if (el('mem-disk-free'))     el('mem-disk-free').textContent     = info.disk_free     || '—';
    if (el('mem-controllers'))   el('mem-controllers').textContent   = info.controllers ?? '—';
    if (el('mem-batocera-ver'))  el('mem-batocera-ver').textContent  = info.batocera_version || '—';
    if (el('mem-saves-count'))   el('mem-saves-count').textContent   = saves.length;

    const savesList = el('mem-saves-list');
    if (!savesList) return;
    if (!saves.length) {
      savesList.innerHTML = `<p class="menu-empty">NO SAVE FILES FOUND IN /userdata/saves/</p>`;
      return;
    }
    // s.file comes from the real filesystem — filenames can contain < > &
    savesList.innerHTML = saves.map(s => `
      <div class="settings-item" style="cursor:default">
        <span class="settings-item-label">
          <span style="opacity:0.5;margin-right:6px">${escHtml(s.systemName)}</span>${escHtml(s.file)}
        </span>
        <span class="settings-item-value" style="font-size:9px">${escHtml(s.size)} · ${escHtml(s.modified)}</span>
      </div>`).join('');
  } catch {
    const el = document.getElementById('mem-saves-list');
    if (el) el.innerHTML = `<p class="menu-empty">COULD NOT LOAD SAVE DATA — SERVER UNREACHABLE.</p>`;
  }
}

/* ── THEATER MENU ──
   Netflix-style browser backed by /api/theater/*.  contentTheater() returns
   the static scaffold (toolbar + skeleton rows); hydrateTheaterMenu() runs
   right after paint and fills each row from the kente-server endpoints.    */
const THEATER_ROWS = [
  // Each row pulls one /api/theater/browse, /search, or /curated request.
  // local: rows are populated from TheaterDB (My List + Continue Watching)
  // and stay hidden until the store has at least one entry.
  // curated rows ignore the movies/shows tab filter — they show in both.
  // Landing rows are anime + game-adaptation focused; universal media is
  // still reachable via the search fan-out.
  { id:'continue',    title:'CONTINUE WATCHING',  sub:'PICK UP WHERE YOU LEFT OFF', local:'continue' },
  { id:'mylist',      title:'MY LIST',            sub:'YOUR SAVED TITLES',          local:'mylist'   },
  // baddieseast.pro is search-only — Baddies USA / Zeus reality shows are
  // surfaced by typing the title into the search bar (provider joins the
  // SEARCH_PROVIDERS fan-out below). No home rows on purpose.
  // Anime — Miruro scrapes direct MP4; embed providers (vidsrc/2embed) carry
  // the films and series via IMDB iframe.
  { id:'miruro-trending',  title:'MIRURO TRENDING',  sub:'LATEST ANIME FROM MIRURO.RO',           provider:'miruro',   curated:'trending' },
  { id:'anime-films',      title:'ANIME FILMS',      sub:'STUDIO GHIBLI · AKIRA · YOUR NAME',      provider:'vidsrc',   curated:'anime-films'  },
  { id:'anime-series',     title:'ANIME SERIES',     sub:'AOT · DEMON SLAYER · JJK · ONE PIECE',   provider:'2embed',   curated:'anime-series' },
  // Game adaptations — live-action films on vidsrc, prestige TV on 2embed.
  { id:'game-movies',      title:'GAME ADAPTATIONS · FILMS', sub:'SONIC · MARIO · TOMB RAIDER · MORTAL KOMBAT', provider:'vidsrc', curated:'game-movies' },
  { id:'game-shows',       title:'GAME ADAPTATIONS · SHOWS', sub:'LAST OF US · ARCANE · CASTLEVANIA · HALO',    provider:'2embed', curated:'game-shows'  },
  // Game walkthroughs — YouTube-sourced, plays inside the embed iframe.
  { id:'walkthroughs',     title:'GAME WALKTHROUGHS', sub:'YOUTUBE · PART 1 GUIDES',               provider:'youtube',  curated:'walkthroughs' },
  // Catalog rows kept for synopsis quality / archive coverage.
  { id:'top-anime',        title:'TOP ANIME',        sub:'GREATEST HITS',                          provider:'lookmovie', curated:'top-anime' },
  { id:'classics',         title:'ANIME CLASSICS',   sub:'INUYASHA · GHOST IN THE SHELL · AKIRA',  provider:'lookmovie', curated:'classics' },
  { id:'franchises',       title:'ACTION FRANCHISES', sub:'NARUTO · DBZ · POKÉMON · BEYBLADE',     provider:'lookmovie', curated:'action-franchises' },
  { id:'archive',          title:'PUBLIC DOMAIN',    sub:'ARCHIVE.ORG',           provider:'archive', kind:'movies', page:1 },
];

function contentTheater() {
  const skeletons = Array.from({ length: 8 }, () => '<div class="theater-skel"></div>').join('');
  const rows = THEATER_ROWS.map(r => `
    <div class="theater-row" data-row="${r.id}">
      <div class="theater-row-header">
        <div class="theater-row-title">${escHtml(r.title)}</div>
        <div class="theater-row-sub">${escHtml(r.sub)}</div>
      </div>
      <div class="theater-row-scroller" id="theater-row-${r.id}">${skeletons}</div>
    </div>`).join('');

  return `
    <div class="theater-hero" id="theater-hero">
      <div class="theater-hero-slide active" style="background:linear-gradient(135deg,#0a0820,#1a1040)"></div>
      <div class="theater-hero-info">
        <h2 class="theater-hero-title">LOADING THEATER&hellip;</h2>
        <div class="theater-hero-meta">FETCHING TODAY&apos;S HIGHLIGHTS</div>
        <div class="theater-hero-synopsis">Streaming library is warming up.</div>
      </div>
      <div class="theater-hero-actions"></div>
      <div class="theater-hero-dots"></div>
    </div>
    <div class="theater-toolbar">
      <button class="filter-chip active" data-theater-tab="movies">MOVIES</button>
      <button class="filter-chip"        data-theater-tab="shows">SHOWS</button>
      <div class="theater-search">
        <span class="theater-search-icon">⌕</span>
        <input type="search" id="theater-search-input" placeholder="SEARCH TITLES…" autocomplete="off">
      </div>
    </div>
    <div id="theater-rows">${rows}</div>`;
}

/* ── Theater state + helpers ── */
const TheaterState = {
  rowItems: {},     // rowId -> [items]
  hero:     [],     // up to 5 hero items
  heroIdx:  0,
  heroTimer: null,
  searchTimer: null,
  activeTab: 'movies',
  currentItem: null,    // last item opened in the detail overlay (used by player)
};

/* ── TheaterDB ──
   IndexedDB-backed persistence for "My List" (favourites) and
   "Continue Watching" (resume positions).  All methods return
   Promises and degrade gracefully if IDB is unavailable.        */
const TheaterDB = (() => {
  const DB_NAME = 'kente_theater';
  const DB_VER  = 1;
  let _dbP = null;

  function _open() {
    if (_dbP) return _dbP;
    if (!('indexedDB' in window)) return Promise.reject(new Error('NO_IDB'));
    _dbP = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('mylist'))
          db.createObjectStore('mylist',   { keyPath: 'key' });
        if (!db.objectStoreNames.contains('progress')) {
          const s = db.createObjectStore('progress', { keyPath: 'key' });
          s.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return _dbP;
  }

  async function _txn(store, mode, fn) {
    try {
      const db = await _open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const os = tx.objectStore(store);
        const out = fn(os);
        tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error);
      });
    } catch (_e) { return null; }
  }

  function keyOf(item) {
    return `${item.provider || 'lookmovie'}:${item.kind || item.type || 'movie'}:${item.slug || item.id}`;
  }

  // Strip an item down to the fields needed to re-render a poster card.
  function _capture(item) {
    return {
      provider: item.provider || 'lookmovie',
      kind:     item.kind || item.type || 'movie',
      type:     item.type || item.kind || 'movie',
      slug:     item.slug || item.id || '',
      id:       item.id   || item.slug || '',
      title:    item.title    || '',
      poster:   item.poster   || '',
      backdrop: item.backdrop || '',
      year:     item.year     || '',
      rating:   item.rating   != null ? item.rating : null,
      quality:  item.quality  || '',
      synopsis: item.synopsis || '',
    };
  }

  // ── My List ───────────────────────────────────────────────
  async function addToList(item) {
    const rec = { ..._capture(item), key: keyOf(item), addedAt: Date.now() };
    await _txn('mylist', 'readwrite', s => s.put(rec));
    document.dispatchEvent(new CustomEvent('theater-mylist-changed'));
    return rec;
  }
  async function removeFromList(item) {
    await _txn('mylist', 'readwrite', s => s.delete(keyOf(item)));
    document.dispatchEvent(new CustomEvent('theater-mylist-changed'));
  }
  async function inList(item) {
    const r = await _txn('mylist', 'readonly', s => s.get(keyOf(item)));
    return !!r;
  }
  async function getList() {
    const out = await _txn('mylist', 'readonly', s => s.getAll());
    if (!out) return [];
    return out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  // ── Continue Watching ─────────────────────────────────────
  // ctx: { provider, kind, slug, title, poster, year, rating,
  //        episodeId?, episodeTitle? }
  // Smart Resume: treat as completed when we're inside the last 90 s (so the
  // 'ended' handler / Up Next card can take over) or past the 95% mark.
  // Both rules clear the saved record so the next launch starts fresh.
  async function saveProgress(ctx, position, duration) {
    if (!ctx || !(position > 0)) return;
    if (duration && (position > 0.95 * duration || (duration - position) <= 90)) {
      return clearProgress(ctx);
    }
    const rec = {
      ..._capture(ctx),
      key: keyOf(ctx),
      episodeId:    ctx.episodeId    || null,
      episodeTitle: ctx.episodeTitle || null,
      position,
      duration: duration || 0,
      updatedAt: Date.now(),
    };
    await _txn('progress', 'readwrite', s => s.put(rec));
    document.dispatchEvent(new CustomEvent('theater-progress-changed'));
  }
  async function getProgress(ctx) {
    if (!ctx) return null;
    return _txn('progress', 'readonly', s => s.get(keyOf(ctx)));
  }
  async function clearProgress(ctx) {
    if (!ctx) return;
    await _txn('progress', 'readwrite', s => s.delete(keyOf(ctx)));
    document.dispatchEvent(new CustomEvent('theater-progress-changed'));
  }
  async function getRecent(limit = 20) {
    const out = await _txn('progress', 'readonly', s => s.getAll());
    if (!out) return [];
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit);
  }

  return { keyOf, addToList, removeFromList, inList, getList,
           saveProgress, getProgress, clearProgress, getRecent };
})();

function _theaterUrl(path, qs) {
  const p = new URLSearchParams(qs || {});
  return `${KENTE_SERVER_URL}${path}?${p}`;
}

async function _theaterFetch(path, qs, timeout = 15000) {
  const res = await fetch(_theaterUrl(path, qs), { signal: _abortTimeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Render integer minutes as a compact, all-caps chip:
//   < 60  -> "25 MIN"
//   ≥ 60  -> "2H 5M" (omits trailing minutes when zero -> "2H")
function _fmtRuntime(min) {
  const n = Number(min);
  if (!n || !isFinite(n) || n <= 0) return '';
  if (n < 60) return `${Math.round(n)} MIN`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return m ? `${h}H ${m}M` : `${h}H`;
}

// Populate / clear the player header meta chip (runtime / source / etc.).
// Hides the chip when there's nothing to show so the layout collapses cleanly.
function _tvpSetHeaderMeta(parts) {
  const el = document.getElementById('theater-video-meta');
  if (!el) return;
  const text = (parts || []).filter(Boolean).join('  ·  ');
  el.textContent = text;
  el.hidden = !text;
}

function _theaterPosterCard(it, provider) {
  const poster  = it.poster ? escHtml(it.poster) : '';
  const title   = escHtml(it.title || '');
  const year    = it.year   ? escHtml(String(it.year))    : '';
  const quality = it.quality ? escHtml(it.quality)        : '';
  const rating  = it.rating != null ? escHtml(String(it.rating)) : '';
  const sub     = [year, rating ? '★ ' + rating : ''].filter(Boolean).join(' · ');
  const badge   = quality ? `<div class="theater-poster-badge">${quality}</div>` : '';
  const img     = poster
    ? `<img src="${poster}" alt="${title}" loading="lazy" onerror="this.style.display='none'">`
    : '';
  // Resume progress bar — only rendered for Continue Watching cards
  // where _progressPct is set by the local-row loader (0–100).
  const progressBar = (it._progressPct != null)
    ? `<div class="theater-poster-progress"><div class="theater-poster-progress-fill"
        style="width:${Math.max(2, Math.min(100, it._progressPct)).toFixed(1)}%"></div></div>`
    : '';
  const prov = it.provider || provider || 'lookmovie';
  const kind = it.kind || it.type || 'movie';
  return `<div class="theater-poster" tabindex="0"
              data-provider="${escHtml(prov)}"
              data-kind="${escHtml(kind)}"
              data-slug="${escHtml(it.slug || it.id || '')}"
              data-title="${title}">
            ${img}${badge}${progressBar}
            <div class="theater-poster-meta">
              <div class="theater-poster-title">${title}</div>
              <div class="theater-poster-sub">${sub}</div>
            </div>
          </div>`;
}

async function hydrateTheaterMenu() {
  if (!KENTE_SERVER_ONLINE) {
    const wrap = document.getElementById('theater-rows');
    if (wrap) wrap.innerHTML =
      '<p class="theater-empty">⚠ KENTE SERVER OFFLINE — START kente-server.py TO BROWSE THE THEATER.</p>';
    return;
  }
  // Wire toolbar (search + tabs).  Tabs filter the visible rows by kind.
  const tabs = document.querySelectorAll('[data-theater-tab]');
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    TheaterState.activeTab = t.dataset.theaterTab;
    document.querySelectorAll('#theater-rows .theater-row').forEach(rowEl => {
      const cfg = THEATER_ROWS.find(r => r.id === rowEl.dataset.row);
      if (!cfg) return;
      // Local rows (mylist/continue) only show when populated — preserve
      // whatever state the loader picked.  Curated + archive rows show in
      // both tabs (mixed-kind content).  Single-kind rows are filtered.
      if (cfg.local) {
        const items = TheaterState.rowItems[cfg.id] || [];
        rowEl.style.display = items.length ? '' : 'none';
        return;
      }
      const visible = cfg.curated || cfg.provider === 'archive'
                   || cfg.kind === TheaterState.activeTab;
      rowEl.style.display = visible ? '' : 'none';
    });
  }));

  // Live-refresh the local rows whenever a write to TheaterDB occurs.
  if (!hydrateTheaterMenu._idbBound) {
    hydrateTheaterMenu._idbBound = true;
    document.addEventListener('theater-mylist-changed',  _theaterRefreshLocalRows);
    document.addEventListener('theater-progress-changed', _theaterRefreshLocalRows);
  }

  const input = document.getElementById('theater-search-input');
  if (input) {
    input.addEventListener('input', e => {
      clearTimeout(TheaterState.searchTimer);
      const q = e.target.value.trim();
      TheaterState.searchTimer = setTimeout(() => _theaterRunSearch(q), 320);
    });
    // Open the themed virtual keyboard whenever the search box is engaged.
    // While open, KenteOSK gates global keyboard / gamepad menu nav so arrow
    // keys, A/B, etc. drive the OSK instead of the surrounding rows.
    const launchOSK = () => {
      if (!KenteOSK.active()) KenteOSK.open(input);
    };
    input.addEventListener('focus', launchOSK);
    input.addEventListener('click', launchOSK);
  }

  // Fire all rows in parallel — first one back also seeds the hero rotator.
  await Promise.all(THEATER_ROWS.map(_theaterLoadRow));
  _theaterBuildHero();
}

async function _theaterLoadRow(cfg) {
  const el = document.getElementById('theater-row-' + cfg.id);
  if (!el) return;
  // Local rows (My List / Continue Watching) read from IndexedDB and
  // hide their containing .theater-row when the store is empty.
  if (cfg.local) return _theaterLoadLocalRow(cfg, el);
  try {
    let data;
    if (cfg.curated) {
      // Curated slates: server resolves a hand-picked title list to listings.
      // First call may take ~5–10 s while individual searches warm the cache;
      // subsequent loads are instant (24 h cached).
      data = await _theaterFetch('/api/theater/curated',
        { provider: cfg.provider, slate: cfg.curated }, 30000);
    } else {
      const qs = { provider: cfg.provider, kind: cfg.kind, page: cfg.page };
      if (cfg.genre) qs.genre = cfg.genre;
      data = await _theaterFetch('/api/theater/browse', qs);
    }
    const items = (data && data.items) || [];
    TheaterState.rowItems[cfg.id] = items;
    if (!items.length) { el.innerHTML = '<div class="theater-empty">— EMPTY —</div>'; return; }
    el.innerHTML = items.map(it => _theaterPosterCard(it, cfg.provider)).join('');
  } catch (e) {
    console.warn('[Kente/theater] row load failed:', cfg.id, e);
    el.innerHTML = `<div class="theater-error">⚠ ${escHtml(cfg.title)} UNAVAILABLE</div>`;
  }
}

async function _theaterLoadLocalRow(cfg, el) {
  const rowEl = el.closest('.theater-row');
  let items = [];
  try {
    if (cfg.local === 'mylist') {
      items = await TheaterDB.getList();
    } else if (cfg.local === 'continue') {
      const recent = await TheaterDB.getRecent(20);
      items = recent.map(r => {
        const dur = r.duration || 0;
        const pct = dur > 0 ? (r.position / dur) * 100 : 0;
        return { ...r, _progressPct: pct };
      });
    }
  } catch (e) {
    console.warn('[Kente/theater] local row failed:', cfg.id, e);
  }
  TheaterState.rowItems[cfg.id] = items;
  if (!items.length) {
    // Hide the entire row container when the store is empty —
    // these rows only appear once the user has interacted.
    if (rowEl) rowEl.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  if (rowEl) {
    // Curated/local rows ignore the movies/shows tab filter.
    const visible = true;
    rowEl.style.display = visible ? '' : 'none';
  }
  el.innerHTML = items.map(it => _theaterPosterCard(it, it.provider || 'lookmovie')).join('');
}

// Refresh just the My List + Continue Watching rows.  Called after
// IDB writes (toggle MY LIST, save/clear progress) so the landing
// reflects new state without a full re-hydrate.
async function _theaterRefreshLocalRows() {
  await Promise.all(THEATER_ROWS
    .filter(r => r.local)
    .map(cfg => {
      const el = document.getElementById('theater-row-' + cfg.id);
      if (el) return _theaterLoadLocalRow(cfg, el);
    }));
}

async function _theaterRunSearch(query) {
  const wrap = document.getElementById('theater-rows');
  if (!wrap) return;
  if (!query) {
    // Restore the standard rows scaffold.
    const skel = Array.from({ length: 8 }, () => '<div class="theater-skel"></div>').join('');
    wrap.innerHTML = THEATER_ROWS.map(r => `
      <div class="theater-row" data-row="${r.id}">
        <div class="theater-row-header">
          <div class="theater-row-title">${escHtml(r.title)}</div>
          <div class="theater-row-sub">${escHtml(r.sub)}</div>
        </div>
        <div class="theater-row-scroller" id="theater-row-${r.id}">${skel}</div>
      </div>`).join('');
    THEATER_ROWS.forEach(_theaterLoadRow);
    return;
  }
  wrap.innerHTML = `
    <div class="theater-row">
      <div class="theater-row-header">
        <div class="theater-row-title">SEARCH RESULTS</div>
        <div class="theater-row-sub">"${escHtml(query)}"</div>
      </div>
      <div class="theater-row-scroller" id="theater-row-search">
        ${Array.from({length:6}, () => '<div class="theater-skel"></div>').join('')}
      </div>
    </div>`;
  // Fan out across all live providers in parallel.  De-duped by lower-cased
  // title + provider + slug so identical titles from different sources can
  // both appear (the user picks which embed to use). Lookmovie is included
  // for completeness even though its streams are gated.
  const opts = { q: query, kind: TheaterState.activeTab };
  // youtube returns walkthroughs; included so search results surface
  // walkthrough videos for any game title typed into the OSK.
  // baddies covers Zeus reality TV (Baddies USA et al.) — search-only.
  const SEARCH_PROVIDERS = ['miruro', 'vidsrc', '2embed', 'vidsrcpm', 'multiembed', 'youtube', 'lookmovie', 'baddies'];
  const results = await Promise.allSettled(SEARCH_PROVIDERS.map(p =>
    _theaterFetch('/api/theater/search', { provider: p, ...opts })));
  const merged = [];
  const seen = new Set();
  results.forEach((r, idx) => {
    const prov = SEARCH_PROVIDERS[idx];
    if (r.status !== 'fulfilled') return;
    for (const it of (r.value && r.value.items) || []) {
      const key = `${it.provider || prov}|${(it.title || '').toLowerCase()}|${it.slug || it.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...it, provider: it.provider || prov });
    }
  });
  const el = document.getElementById('theater-row-search');
  if (!el) return;
  if (!merged.length) {
    const allFailed = results.every(r => r.status === 'rejected');
    el.innerHTML = allFailed
      ? '<div class="theater-error">⚠ SEARCH FAILED</div>'
      : '<div class="theater-empty">NO MATCHES</div>';
    return;
  }
  el.innerHTML = merged.map(it => _theaterPosterCard(it, it.provider)).join('');
}

function _theaterBuildHero() {
  // Pick up to 5 highlights from "trending" first, fall back to any other row.
  const pool = (TheaterState.rowItems.trending || []).slice(0, 5);
  if (!pool.length) return;
  TheaterState.hero = pool;
  TheaterState.heroIdx = 0;

  const hero = document.getElementById('theater-hero');
  if (!hero) return;
  // One slide div per highlight, all stacked. _theaterShowHero toggles .active.
  hero.querySelectorAll('.theater-hero-slide').forEach(n => n.remove());
  pool.forEach((it, i) => {
    const s = document.createElement('div');
    s.className = 'theater-hero-slide' + (i === 0 ? ' active' : '');
    if (it.backdrop || it.poster) s.style.backgroundImage = `url("${it.backdrop || it.poster}")`;
    hero.insertBefore(s, hero.firstChild);
  });
  const dotsEl = hero.querySelector('.theater-hero-dots');
  if (dotsEl) {
    dotsEl.innerHTML = pool.map((_, i) =>
      `<div class="theater-hero-dot${i===0?' active':''}" data-hero-idx="${i}"></div>`).join('');
    dotsEl.querySelectorAll('[data-hero-idx]').forEach(d => d.addEventListener('click', e => {
      _theaterShowHero(parseInt(e.target.dataset.heroIdx, 10));
      _theaterRestartHeroTimer();
    }));
  }
  _theaterShowHero(0);
  _theaterRestartHeroTimer();
}

function _theaterShowHero(idx) {
  const hero = document.getElementById('theater-hero');
  if (!hero || !TheaterState.hero.length) return;
  const i = (idx + TheaterState.hero.length) % TheaterState.hero.length;
  TheaterState.heroIdx = i;
  const it = TheaterState.hero[i];
  const slides = hero.querySelectorAll('.theater-hero-slide');
  slides.forEach((s, k) => s.classList.toggle('active', k === i));
  const dots = hero.querySelectorAll('.theater-hero-dot');
  dots.forEach((d, k) => d.classList.toggle('active', k === i));

  const info = hero.querySelector('.theater-hero-info');
  if (info) {
    const meta = [it.year, it.quality, it.rating != null ? '★ ' + it.rating : '']
      .filter(Boolean).map(escHtml).join('  ·  ');
    info.innerHTML = `
      <h2 class="theater-hero-title">${escHtml(it.title || '')}</h2>
      <div class="theater-hero-meta">${meta}</div>
      <div class="theater-hero-synopsis">${escHtml(it.synopsis || '')}</div>`;
  }
  const actions = hero.querySelector('.theater-hero-actions');
  if (actions) {
    actions.innerHTML = `
      <button class="theater-hero-btn" type="button" data-hero-action="open">▶ DETAILS</button>`;
    actions.querySelector('[data-hero-action="open"]').onclick = () => {
      openTheaterDetail(
        it.provider || 'lookmovie',
        it.kind || it.type || 'movie',
        it.slug || it.id,
        it.title);
    };
  }
}

function _theaterRestartHeroTimer() {
  clearInterval(TheaterState.heroTimer);
  TheaterState.heroTimer = setInterval(() => {
    // Pause rotation if Theater menu is no longer the active screen.
    const menu = document.getElementById('menu-theater');
    if (!menu || !menu.classList.contains('active')) {
      clearInterval(TheaterState.heroTimer); TheaterState.heroTimer = null; return;
    }
    _theaterShowHero(TheaterState.heroIdx + 1);
  }, 7000);
}

/* ══════════════════════════════════════════
   KENTE ON-SCREEN KEYBOARD (OSK)
   Themed pop-up keyboard for search inputs.
   While open: global keyboard/gamepad menu
   navigation is gated; only OSK keys move
   focus.  Esc / East button closes.
══════════════════════════════════════════ */
const KenteOSK = (() => {
  const KEY_ROW_DIGITS = '1234567890'.split('');
  const KEY_ROW_TOP    = 'qwertyuiop'.split('');
  const KEY_ROW_MID    = 'asdfghjkl'.split('');
  const KEY_ROW_BOT    = 'zxcvbnm'.split('');

  let _overlay = null;
  let _target  = null;        // <input> being driven
  let _shift   = false;
  let _focus   = { r: 1, c: 0 }; // start on QWERTY row first key
  let _onChangeTimer = null;

  function active() { return !!_overlay; }

  function _commit() {
    // Trigger an "input" event so the search debouncer in hydrateTheaterMenu
    // (and any other listener bound to the input) picks up the change.
    if (!_target) return;
    _target.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function _setValue(val) {
    if (!_target) return;
    _target.value = val;
    _renderDisplay();
    _commit();
  }

  function _renderDisplay() {
    if (!_overlay) return;
    const disp = _overlay.querySelector('.osk-display');
    if (!disp) return;
    const v = _target?.value || '';
    disp.innerHTML = v
      ? escHtml(v) + '<span class="osk-caret">▎</span>'
      : '<span class="osk-placeholder">SEARCH TITLES…</span>';
  }

  // Build the 5-row grid of {char?, action?, label, span} cells.
  function _grid() {
    const cap = c => _shift ? c.toUpperCase() : c;
    return [
      KEY_ROW_DIGITS.map(c => ({ char: c, label: c })),
      KEY_ROW_TOP   .map(c => ({ char: cap(c), label: cap(c) })),
      KEY_ROW_MID   .map(c => ({ char: cap(c), label: cap(c) })),
      [
        { action:'shift', label: _shift ? 'SHIFT●' : 'SHIFT' },
        ...KEY_ROW_BOT.map(c => ({ char: cap(c), label: cap(c) })),
        { action:'backspace', label: '⌫' },
      ],
      [
        { action:'char', char: ' ', label:'SPACE', span: 6 },
        { action:'char', char: '-', label:'-' },
        { action:'char', char: '.', label:'.' },
        { action:'clear', label:'CLEAR', span: 2 },
        { action:'close', label:'DONE',  span: 2 },
      ],
    ];
  }

  function _press(cell) {
    if (!cell) return;
    if (cell.action === 'shift') {
      _shift = !_shift; _renderKeys(); KenteAudio?.click?.(); return;
    }
    if (cell.action === 'backspace') {
      const v = _target.value || '';
      _setValue(v.slice(0, -1));
      KenteAudio?.click?.(); return;
    }
    if (cell.action === 'clear') {
      _setValue(''); KenteAudio?.click?.(); return;
    }
    if (cell.action === 'close') { close(); return; }
    // Character key
    const ch = cell.char;
    if (typeof ch === 'string') {
      _setValue((_target.value || '') + ch);
      KenteAudio?.click?.();
      // Auto-revert one-shot shift after a single capital letter.
      if (_shift && /[A-Z]/.test(ch)) { _shift = false; _renderKeys(); }
    }
  }

  function _renderKeys() {
    if (!_overlay) return;
    const wrap = _overlay.querySelector('.osk-grid');
    if (!wrap) return;
    const grid = _grid();
    wrap.innerHTML = grid.map((row, ri) => `
      <div class="osk-row">
        ${row.map((cell, ci) => {
          const isFocus = ri === _focus.r && ci === _focus.c;
          const cls = ['osk-key',
            cell.action === 'shift'     ? 'osk-key-mod'   : '',
            cell.action === 'backspace' ? 'osk-key-mod'   : '',
            cell.action === 'shift' && _shift ? 'osk-key-on' : '',
            cell.action === 'close'     ? 'osk-key-go'    : '',
            cell.action === 'clear'     ? 'osk-key-mod'   : '',
            cell.span                   ? 'osk-key-wide'  : '',
            isFocus                     ? 'osk-key-focus' : ''].filter(Boolean).join(' ');
          const span = cell.span ? `style="flex:${cell.span}"` : '';
          return `<button type="button" class="${cls}" ${span}
                          data-r="${ri}" data-c="${ci}">${escHtml(cell.label)}</button>`;
        }).join('')}
      </div>`).join('');
  }

  function _focusCell(r, c) {
    const grid = _grid();
    if (r < 0) r = grid.length - 1;
    if (r >= grid.length) r = 0;
    const row = grid[r];
    if (c < 0) c = row.length - 1;
    if (c >= row.length) c = 0;
    _focus = { r, c };
    _renderKeys();
  }

  function navigate(dir) {
    if (!_overlay) return;
    const grid = _grid();
    let { r, c } = _focus;
    if (dir === 'left')      c -= 1;
    else if (dir === 'right') c += 1;
    else if (dir === 'up')    r -= 1;
    else if (dir === 'down')  r += 1;
    // Wrap rows; clamp column to new row's length.
    if (r < 0) r = grid.length - 1;
    if (r >= grid.length) r = 0;
    const row = grid[r];
    if (c < 0) c = row.length - 1;
    if (c >= row.length) c = 0;
    _focusCell(r, c);
    KenteAudio?.click?.();
  }

  function confirm() {
    if (!_overlay) return;
    const cell = _grid()[_focus.r]?.[_focus.c];
    _press(cell);
  }

  function backspace() {
    if (!_overlay) return;
    _press({ action:'backspace' });
  }

  function shift() {
    if (!_overlay) return;
    _press({ action:'shift' });
  }

  function open(input) {
    if (!input) return;
    if (_overlay) { close(); }
    _target = input;
    _shift  = false;
    _focus  = { r: 1, c: 0 };

    _overlay = document.createElement('div');
    _overlay.id = 'kente-osk';
    _overlay.className = 'osk-overlay';
    _overlay.innerHTML = `
      <div class="osk-card">
        <div class="osk-header">
          <div class="osk-title">VIRTUAL KEYBOARD</div>
          <div class="osk-sub">PRESS <b>ESC</b> OR <b>B</b> TO CLOSE</div>
        </div>
        <div class="osk-display"></div>
        <div class="osk-grid"></div>
        <div class="osk-legend">
          <span><b>↑↓←→</b> MOVE</span>
          <span><b>A / ENTER</b> PRESS</span>
          <span><b>X</b> ⌫</span>
          <span><b>Y</b> SHIFT</span>
          <span><b>B / ESC</b> CLOSE</span>
        </div>
      </div>`;
    document.body.appendChild(_overlay);
    _renderDisplay();
    _renderKeys();

    // Click delegation for mouse / touch users.
    _overlay.addEventListener('click', e => {
      const btn = e.target.closest('button.osk-key');
      if (!btn) {
        // Click on backdrop closes.
        if (e.target === _overlay) close();
        return;
      }
      const r = +btn.dataset.r, c = +btn.dataset.c;
      _focus = { r, c };
      _press(_grid()[r][c]);
    });

    // Capture keydown so menu nav handlers don't fire while typing.
    _overlay._keyHandler = e => _onKey(e);
    document.addEventListener('keydown', _overlay._keyHandler, true);

    // Keep the input focused (caret visible to users that prefer typing).
    requestAnimationFrame(() => _target?.focus({ preventScroll: true }));
  }

  function close() {
    if (!_overlay) return;
    document.removeEventListener('keydown', _overlay._keyHandler, true);
    _overlay.remove();
    _overlay = null;
    if (_target) {
      _target.blur();
      _target = null;
    }
    GamepadManager?.resetFocus?.();
  }

  function _onKey(e) {
    // Letters / digits / symbols typed on a real keyboard pass through to the
    // focused <input> naturally (we don't preventDefault).  We only intercept
    // navigation, backspace echo, and close keys here.
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault(); e.stopPropagation(); close(); return;
    }
    if (k === 'ArrowUp')    { e.preventDefault(); e.stopPropagation(); navigate('up');    return; }
    if (k === 'ArrowDown')  { e.preventDefault(); e.stopPropagation(); navigate('down');  return; }
    if (k === 'ArrowLeft')  { e.preventDefault(); e.stopPropagation(); navigate('left');  return; }
    if (k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); navigate('right'); return; }
    if (k === 'Enter')      { e.preventDefault(); e.stopPropagation(); confirm();         return; }
    if (k === 'Backspace') {
      // Let the input handle Backspace itself; just refresh our display.
      requestAnimationFrame(_renderDisplay);
      e.stopPropagation();
      return;
    }
    // Any other key: refresh display after the input updates, and stop the
    // event bubbling so the global handleKey() can't consume it.
    requestAnimationFrame(() => { _renderDisplay(); _commit(); });
    e.stopPropagation();
  }

  return { open, close, active, navigate, confirm, backspace, shift };
})();


/* ── Detail overlay ──────────────────────────────────────────────────────
   `title` is an optional hint passed by the caller (e.g. from a saved
   My-List entry).  Embed providers (vidsrc / 2embed / vidsrcpm /
   multiembed) use it to resolve metadata when their in-memory reverse-
   lookup cache is cold (server restart, fresh worker, etc).             */
async function openTheaterDetail(provider, kind, slug, title) {
  if (!provider || !slug) return;
  const overlay = document.getElementById('theater-detail-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  overlay.innerHTML = `
    <button type="button" class="theater-detail-close" id="theater-detail-close">✕ CLOSE</button>
    <div class="theater-detail-backdrop"></div>
    <div class="theater-detail-scrim"></div>
    <div class="theater-detail-panel">
      <div class="theater-detail-poster"></div>
      <div class="theater-detail-body">
        <div class="theater-empty">LOADING DETAILS…</div>
      </div>
    </div>`;
  requestAnimationFrame(() => overlay.classList.add('active'));
  overlay.querySelector('#theater-detail-close')
    .addEventListener('click', closeTheaterDetail);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeTheaterDetail();
  });
  KenteAudio.click();

  try {
    const detailQs = { provider, kind, slug };
    if (title) detailQs.title = title;
    const d = await _theaterFetch('/api/theater/details', detailQs, 18000);
    _renderTheaterDetail(provider, d);
  } catch (e) {
    console.warn('[Kente/theater] details failed:', e);
    const body = overlay.querySelector('.theater-detail-body');
    if (body) body.innerHTML = '<div class="theater-error">⚠ COULD NOT LOAD DETAILS</div>';
  }
}

function closeTheaterDetail() {
  const overlay = document.getElementById('theater-detail-overlay');
  if (!overlay) return;
  overlay.classList.remove('active');
  setTimeout(() => { overlay.hidden = true; overlay.innerHTML = ''; }, 280);
  // Hand focus back to the underlying theater rows so controller nav resumes there.
  requestAnimationFrame(() => GamepadManager.resetFocus());
}

function _renderTheaterDetail(provider, d) {
  const overlay = document.getElementById('theater-detail-overlay');
  if (!overlay || !d) return;
  const bd = overlay.querySelector('.theater-detail-backdrop');
  if (bd && (d.backdrop || d.poster)) bd.style.backgroundImage = `url("${d.backdrop || d.poster}")`;
  const posterEl = overlay.querySelector('.theater-detail-poster');
  if (posterEl && d.poster) posterEl.style.backgroundImage = `url("${d.poster}")`;

  const meta = [d.year, _fmtRuntime(d.runtime), d.quality,
                d.rating != null ? '★ ' + d.rating : '']
                  .filter(Boolean).map(escHtml).join('  ·  ');
  const genres = (d.genres || []).map(g =>
    `<span class="theater-detail-genre">${escHtml(g)}</span>`).join('');
  // Treat backend kind=='show' as show even when seasons is null (offline fallback).
  const isShow = d.type === 'show' || d.kind === 'show' || Array.isArray(d.seasons);
  const offline = !!d.unavailable;
  // Backend may redirect (e.g. lookmovie -> vidsrc when upstream is down). Use
  // the response-provided provider/slug so PLAY and episode clicks hit the new
  // route. Falls back to the closure-captured provider for legacy responses.
  const effProvider = d.provider || provider;
  const slug = d.slug || d.id;

  // Stash the canonical item for the player (used by resume + My List).
  const item = {
    provider: effProvider, kind: isShow ? 'show' : 'movie', type: isShow ? 'show' : 'movie',
    slug, id: slug, title: d.title || '', poster: d.poster || '',
    backdrop: d.backdrop || '', year: d.year || '', rating: d.rating ?? null,
    quality: d.quality || '', synopsis: d.synopsis || '',
    runtime: (typeof d.runtime === 'number' ? d.runtime : null),
  };
  TheaterState.currentItem = item;

  // ▶ PLAY for movies; both branches get a "+ MY LIST" toggle.
  // When the upstream is down (offline), suppress play and show a banner.
  const playBtn = (isShow || offline) ? '' :
    `<button class="theater-detail-btn primary" type="button" id="theater-play-btn">▶ PLAY</button>`;
  const offlineBanner = offline
    ? `<div class="theater-unavailable">⚠ STREAMING SOURCE TEMPORARILY UNAVAILABLE — SHOWING SUMMARY ONLY</div>`
    : '';
  const actionsHtml = `
    <div class="theater-detail-actions">
      ${playBtn}
      <button class="theater-detail-btn" type="button" id="theater-mylist-btn">+ MY LIST</button>
    </div>`;

  const epsHtml = (isShow && !offline) ? `
    <div class="theater-eps-section" id="theater-eps-section">
      <div class="theater-eps-tabs" id="theater-eps-tabs">
        ${(d.seasons || []).map((s, i) =>
          `<button class="theater-eps-tab${i===0?' active':''}" data-season="${i}">SEASON ${escHtml(String(s.number || i+1))}</button>`).join('')}
      </div>
      <div class="theater-eps-list" id="theater-eps-list"></div>
    </div>` : '';

  overlay.querySelector('.theater-detail-body').innerHTML = `
    <h2 class="theater-detail-title">${escHtml(d.title || '')}</h2>
    <div class="theater-detail-meta">${meta}</div>
    <div class="theater-detail-genres">${genres}</div>
    ${offlineBanner}
    <div class="theater-detail-synopsis">${escHtml(d.synopsis || '')}</div>
    ${actionsHtml}${epsHtml}`;

  // Wire the My List toggle and reflect current state.
  const myBtn = overlay.querySelector('#theater-mylist-btn');
  const setMyBtn = on => {
    if (!myBtn) return;
    myBtn.textContent = on ? '✓ IN MY LIST' : '+ MY LIST';
    myBtn.classList.toggle('active', !!on);
  };
  TheaterDB.inList(item).then(setMyBtn);
  myBtn?.addEventListener('click', async () => {
    const on = await TheaterDB.inList(item);
    if (on) { await TheaterDB.removeFromList(item); setMyBtn(false); showToast('REMOVED FROM MY LIST'); }
    else    { await TheaterDB.addToList(item);      setMyBtn(true);  showToast('+ ADDED TO MY LIST'); }
    KenteAudio.click();
  });

  if (!isShow && !offline) {
    overlay.querySelector('#theater-play-btn').addEventListener('click', () =>
      _theaterStartStream(effProvider, 'movie', slug, null, d.title, item));
  } else if (isShow && !offline) {
    const seasons = d.seasons || [];
    // Flatten seasons -> single episode list once; attached to ctx so the
    // player can drive prev/next without re-fetching the detail payload.
    const epsFlat = [];
    seasons.forEach((s, si) => {
      (s.episodes || []).forEach((ep, ei) => {
        epsFlat.push({
          id:     ep.id || ep.slug || '',
          season: s.number || si + 1,
          number: ep.number || ei + 1,
          title:  ep.title  || ('Episode ' + (ei + 1)),
        });
      });
    });
    item._episodes = epsFlat;
    const showSeason = (idx) => {
      const list = document.getElementById('theater-eps-list');
      if (!list) return;
      const eps = (seasons[idx] && seasons[idx].episodes) || [];
      list.innerHTML = eps.map((ep, i) => `
        <div class="theater-ep-row" tabindex="0"
             data-ep-id="${escHtml(ep.id || ep.slug || '')}">
          <div class="theater-ep-num">${escHtml(String(ep.number || i+1))}</div>
          <div class="theater-ep-title">${escHtml(ep.title || ('Episode ' + (i+1)))}</div>
        </div>`).join('') || '<div class="theater-empty">NO EPISODES</div>';
      list.querySelectorAll('.theater-ep-row').forEach(row => {
        row.addEventListener('click', () => {
          const epId = row.dataset.epId;
          const epTitle = row.querySelector('.theater-ep-title')?.textContent || d.title;
          _theaterStartStream(effProvider, 'show', slug, epId,
            `${d.title} — ${epTitle}`,
            { ...item, episodeId: epId, episodeTitle: epTitle, _episodes: epsFlat });
        });
      });
    };
    overlay.querySelectorAll('#theater-eps-tabs .theater-eps-tab').forEach(t =>
      t.addEventListener('click', e => {
        overlay.querySelectorAll('#theater-eps-tabs .theater-eps-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        showSeason(parseInt(t.dataset.season, 10));
      }));
    if (seasons.length) showSeason(0);
  }
  // Seed gamepad focus on the first action so controllers can drive the panel.
  requestAnimationFrame(() => GamepadManager.applyFocus(0));
}

async function _theaterStartStream(provider, kind, slug, episodeId, title, ctx) {
  showToast('▶ RESOLVING STREAM…');
  try {
    const qs = { provider, kind, slug };
    if (episodeId) qs.episode_id = episodeId;
    // Title hint lets embed providers prime their reverse-lookup cache for
    // deep-linked / cold-cache calls (drives the anime source-switcher pill).
    if (title) qs.title = title;
    const data = await _theaterFetch('/api/theater/stream', qs, 20000);
    // Embed providers (vidsrc / 2embed / vidsrcpm / multiembed) return a
    // top-level `embed` URL instead of decoded streams. The browser loads
    // it directly inside an <iframe>; CORS-restricted assets resolve client-
    // side without our proxy.
    if (data && data.embed) {
      openTheaterEmbed({ embed: data.embed, source: data, provider },
                       title || 'PLAYBACK',
                       ctx || TheaterState.currentItem);
      return;
    }
    const streams = data && data.streams || {};
    const qualities = Object.keys(streams);
    if (!qualities.length) throw new Error('NO_STREAMS');
    // ctx is the canonical item (with optional episodeId/episodeTitle) so the
    // player can resume / persist progress against the right TheaterDB key.
    openTheaterVideo({ streams, qualities, source: data }, title || 'PLAYBACK',
                     ctx || TheaterState.currentItem);
  } catch (e) {
    console.warn('[Kente/theater] stream failed:', e);
    showToast('⚠ COULD NOT RESOLVE STREAM');
  }
}



/* ── SETTINGS MENU ── */
function contentSettings() {
  const hwSection = KENTE_SERVER_ONLINE
    ? `<div id="settings-hardware-section">
         <div class="settings-group-label">HARDWARE</div>
         <div class="settings-list" id="settings-hw-list">
           ${['BATOCERA VERSION','STORAGE FREE','STORAGE USED','CONTROLLERS','UPTIME','HOSTNAME'].map(l =>
             `<div class="settings-item" style="cursor:default">
               <span class="settings-item-label">${l}</span>
               <span class="settings-item-value settings-hw-val" data-hw="${l.toLowerCase().replace(/ /g,'-')}">…</span>
             </div>`).join('')}
         </div>
       </div>` : '';

  const networkSection = KENTE_SERVER_ONLINE ? `
    <div class="settings-group-label">NETWORK</div>
    <div class="settings-list" id="settings-network-section">
      <div class="settings-item" style="cursor:default">
        <span class="settings-item-label">CONNECTION</span>
        <span class="settings-item-value net-status-val" id="net-status-ssid">CHECKING&hellip;</span>
      </div>
      <div class="settings-item" style="cursor:default">
        <span class="settings-item-label">IP ADDRESS</span>
        <span class="settings-item-value net-status-val" id="net-status-ip">CHECKING&hellip;</span>
      </div>
      <div class="settings-item" style="cursor:default">
        <span class="settings-item-label">SIGNAL STRENGTH</span>
        <span class="settings-item-value net-status-val" id="net-status-signal">CHECKING&hellip;</span>
      </div>
      <div class="settings-item interactive settings-item--net-action" data-net-action="refresh">
        <span class="settings-item-label">REFRESH STATUS</span>
        <span class="settings-item-value net-scan-value">&#8635; REFRESH</span>
      </div>
      <div class="settings-item interactive settings-item--net-action" data-net-action="scan">
        <span class="settings-item-label">SCAN FOR NETWORKS</span>
        <span class="settings-item-value net-scan-value">SCAN &#9654;</span>
      </div>
      <div class="settings-item interactive settings-item--net-action" data-net-action="disconnect"
           id="net-disconnect-row" style="display:none">
        <span class="settings-item-label">DISCONNECT</span>
        <span class="settings-item-value" style="color:var(--red)">DISCONNECT</span>
      </div>
    </div>
    <div id="wifi-scan-panel" class="wifi-scan-panel"></div>` : '';

  const configSections = SETTINGS_CONFIG.map(g => {
    const rows = g.items.map(item => {
      let displayVal = '';
      let classes    = 'settings-item';
      let dataAttrs  = '';

      if (item.type === 'readonly') {
        displayVal = typeof item.value === 'function' ? item.value() : item.value;
      } else if (item.type === 'toggle') {
        const val  = appSettings[item.key] ?? item.default;
        displayVal = val ? 'ON' : 'OFF';
        classes   += ' interactive';
        dataAttrs  = `data-setting="${item.key}" data-type="toggle"`;
      } else if (item.type === 'cycle') {
        const val  = appSettings[item.key] ?? item.default;
        displayVal = typeof val === 'number' ? val + '%' : val;
        classes   += ' interactive';
        // Use double-quote delimiter + escHtml so option labels containing ' or " never
        // break the attribute.  The browser decodes &quot; → " before JS reads dataset.opts,
        // so JSON.parse(el.dataset.opts) always receives valid JSON.
        dataAttrs  = `data-setting="${item.key}" data-type="cycle" data-opts="${escHtml(JSON.stringify(item.opts))}"`;

      } else if (item.type === 'action') {
        displayVal = item.value;
        classes   += ' settings-item--action interactive';
        dataAttrs  = `data-action="${item.key}"`;
      }

      return `<div class="${classes}" ${dataAttrs}>
        <span class="settings-item-label">${item.label}</span>
        <span class="settings-item-value">${displayVal}</span>
      </div>`;
    }).join('');

    return `<div class="settings-group-label">${g.group}</div>
    <div class="settings-list">${rows}</div>`;
  }).join('') + hwSection;
  // NETWORK is pinned to the top so connection status is visible immediately
  return networkSection + configSections;
}

async function hydrateSettingsMenu() {
  if (!KENTE_SERVER_ONLINE) return;
  // Run hardware info + network status in parallel
  await Promise.all([hydrateHardwareInfo(), hydrateNetworkStatus()]);
}

async function hydrateHardwareInfo() {
  try {
    const res  = await fetch(`${KENTE_SERVER_URL}/api/system/info`, { signal: _abortTimeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const MAP = {
      'batocera-version': info.batocera_version || '\u2014',
      'storage-free':     info.disk_free        || '\u2014',
      'storage-used':     info.disk_used_pct != null ? `${info.disk_used_pct}%` : '\u2014',
      'controllers':      info.controllers != null ? `${info.controllers} CONNECTED` : '\u2014',
      'uptime':           info.uptime           || '\u2014',
      'hostname':         info.hostname         || '\u2014',
    };
    document.querySelectorAll('.settings-hw-val[data-hw]').forEach(el => {
      const val = MAP[el.dataset.hw];
      if (val !== undefined) el.textContent = val;
    });
  } catch {
    document.querySelectorAll('.settings-hw-val').forEach(el => el.textContent = '\u2014');
  }
}

async function hydrateNetworkStatus() {
  if (!KENTE_SERVER_ONLINE) return;
  try {
    const res = await fetch(`${KENTE_SERVER_URL}/api/network/status`, { signal: _abortTimeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    const ssidEl  = document.getElementById('net-status-ssid');
    const ipEl    = document.getElementById('net-status-ip');
    const sigEl   = document.getElementById('net-status-signal');
    const discRow = document.getElementById('net-disconnect-row');
    if (ssidEl)  ssidEl.textContent  = s.connected ? (s.ssid || 'CONNECTED') : 'NOT CONNECTED';
    if (ipEl)    ipEl.textContent    = s.ip || (s.connected ? 'ACQUIRING...' : '--');
    if (sigEl)   sigEl.textContent   = s.signal != null ? `${s.signal}%` : '--';
    if (discRow) discRow.style.display = s.connected ? '' : 'none';
  } catch {
    const el = document.getElementById('net-status-ssid');
    if (el) el.textContent = 'UNAVAILABLE';
  }
}

/* ── WiFi scan panel ─────────────────────────────────────────────────────── */
function _sigBars(pct) {
  // Returns 0-4 filled bars based on signal percentage
  const n = pct >= 80 ? 4 : pct >= 60 ? 3 : pct >= 35 ? 2 : pct >= 10 ? 1 : 0;
  return [1,2,3,4].map(i =>
    `<span class="sig-bar${i <= n ? ' sig-bar--on' : ''}"></span>`).join('');
}

async function wifiScanAndShow() {
  const panel = document.getElementById('wifi-scan-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="wifi-scanning">SCANNING...</div>';
  try {
    const res = await fetch(`${KENTE_SERVER_URL}/api/network/scan`, { signal: _abortTimeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { networks } = await res.json();
    if (!networks || !networks.length) {
      panel.innerHTML = '<div class="wifi-scanning">NO NETWORKS FOUND</div>';
      return;
    }
    panel.innerHTML = networks.map(n => `
      <div class="wifi-item interactive" data-ssid="${escHtml(n.ssid)}"
           data-secured="${n.secured ? '1' : '0'}">
        <span class="wifi-item-name">${escHtml(n.ssid)}</span>
        <span class="wifi-item-meta">
          <span class="sig-bars">${_sigBars(n.signal || 0)}</span>
          ${n.secured ? '<span class="wifi-lock">&#128274;</span>' : ''}
        </span>
      </div>`).join('');
  } catch(e) {
    panel.innerHTML = `<div class="wifi-scanning">SCAN FAILED: ${escHtml(String(e))}</div>`;
  }
}

async function wifiConnect(ssid, secured) {
  let password = '';
  if (secured) {
    // Show inline password modal
    const existing = document.getElementById('wifi-pw-modal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'wifi-pw-modal';
    modal.className = 'wifi-pw-modal';
    modal.innerHTML = `
      <div class="wifi-pw-box">
        <div class="wifi-pw-title">CONNECT TO ${escHtml(ssid)}</div>
        <input id="wifi-pw-input" class="wifi-pw-input" type="password"
               placeholder="Enter password..." autocomplete="off" maxlength="63">
        <div class="wifi-pw-actions">
          <button class="wifi-pw-btn wifi-pw-btn--ok"  id="wifi-pw-ok">CONNECT</button>
          <button class="wifi-pw-btn wifi-pw-btn--cancel" id="wifi-pw-cancel">CANCEL</button>
        </div>
        <div class="wifi-pw-status" id="wifi-pw-status"></div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('wifi-pw-input').focus();

    password = await new Promise(resolve => {
      document.getElementById('wifi-pw-ok').onclick     = () => resolve(document.getElementById('wifi-pw-input').value);
      document.getElementById('wifi-pw-cancel').onclick = () => resolve(null);
      document.getElementById('wifi-pw-input').addEventListener('keydown', ev => {
        if (ev.key === 'Enter') resolve(document.getElementById('wifi-pw-input').value);
        if (ev.key === 'Escape') resolve(null);
      });
    });
    if (password === null) { modal.remove(); return; }
    document.getElementById('wifi-pw-status').textContent = 'CONNECTING...';
  }

  try {
    const res  = await fetch(`${KENTE_SERVER_URL}/api/network/connect`,
      { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ ssid, password }) });
    const data = await res.json();
    document.getElementById('wifi-pw-modal')?.remove();
    if (data.success) {
      showToast(`CONNECTED TO ${ssid}`);
      setTimeout(hydrateNetworkStatus, 2500);
    } else {
      showToast(`CONNECT FAILED: ${data.message || 'Unknown error'}`);
    }
  } catch(e) {
    document.getElementById('wifi-pw-modal')?.remove();
    showToast('NETWORK ERROR');
  }
}

async function wifiDisconnect() {
  try {
    const res  = await fetch(`${KENTE_SERVER_URL}/api/network/disconnect`, { method: 'POST',
      headers: {'Content-Type':'application/json'}, body: '{}' });
    const data = await res.json();
    showToast(data.success ? 'DISCONNECTED' : `DISCONNECT FAILED: ${data.message}`);
    if (data.success) setTimeout(hydrateNetworkStatus, 1500);
  } catch { showToast('NETWORK ERROR'); }
}

/* ══════════════════════════════════════════
   SACRIFICE CHAMBER
══════════════════════════════════════════ */
const sacState = {
  selectedSacrifice: null,
  selectedUnlock: null,
  phase: 'select'   // select | confirm | ritual | result
};

function openChamber() {
  sacState.selectedSacrifice = null;
  sacState.selectedUnlock    = null;
  sacState.phase = 'select';
  document.querySelectorAll('.menu-screen').forEach(m => m.classList.remove('active'));
  KenteAudio.ritualDrone();
  setScreen('sacrifice-screen');
  state.screen = 'sacrifice';   // keep state machine consistent with closeChamber()
  renderChamberSelect();
}

function closeChamber() {
  KenteAudio.back();
  document.getElementById('sacrifice-screen').classList.remove('active');
  setScreen('room');
  state.screen = 'room';
  KenteAudio.setHumVol(0.018);
}

/* ── SELECT SCREEN ── */
function renderChamberSelect() {
  const activeSystems    = SYSTEMS.filter(s => s.active && !s.sacrificed);
  const sacrificeable    = sacState.selectedSacrifice
    ? SYSTEMS.filter(s => !s.active && !s.sacrificed && s.tier === sacState.selectedSacrifice.tier + 1)
    : [];

  const leftCards = activeSystems.map(s => {
    const sel = sacState.selectedSacrifice?.id === s.id ? ' selected' : '';
    return `<div class="sys-card sacrifice-candidate${sel}" data-id="${s.id}">
      <div class="sys-card-tier">TIER ${s.tier}</div>
      <div class="sys-card-icon">${s.icon}</div>
      <div class="sys-card-name">${s.name}</div>
      <div class="sys-card-tag">ACTIVE</div>
    </div>`;
  }).join('');

  const rightCards = sacState.selectedSacrifice
    ? (sacrificeable.length
        ? sacrificeable.map(s => {
            const sel = sacState.selectedUnlock?.id === s.id ? ' selected' : '';
            return `<div class="sys-card unlock-candidate${sel}" data-id="${s.id}">
              <div class="sys-card-tier">TIER ${s.tier}</div>
              <div class="sys-card-icon">${s.icon}</div>
              <div class="sys-card-name">${s.name}</div>
              <div class="sys-card-tag unlock">UNLOCKABLE</div>
            </div>`;
          }).join('')
        : '<p class="sac-empty">NO SYSTEMS AVAILABLE AT THE NEXT TIER.<br>ALL HAVE BEEN UNLOCKED OR SACRIFICED.</p>'
      )
    : '<p class="sac-empty">← SELECT A SYSTEM TO SACRIFICE<br>TO SEE WHAT YOU CAN UNLOCK</p>';

  const canProceed = sacState.selectedSacrifice && sacState.selectedUnlock;

  document.getElementById('sac-content').innerHTML = `
    <div class="sac-header">
      <button class="sac-back-btn" id="sac-back">◀ BACK</button>
      <div class="sac-title">⚠ SACRIFICE CHAMBER</div>
      <div class="sac-warning">ACTIONS TAKEN HERE ARE PERMANENT AND CANNOT BE UNDONE</div>
    </div>
    <div class="sac-columns">
      <div class="sac-panel">
        <div class="sac-panel-title red">SACRIFICE</div>
        <div class="sac-panel-sub">Choose a system to permanently disable</div>
        <div class="sys-grid" id="sac-left">${leftCards}</div>
      </div>
      <div class="sac-divider">
        <div class="sac-arrow">→</div>
      </div>
      <div class="sac-panel">
        <div class="sac-panel-title gold">UNLOCK</div>
        <div class="sac-panel-sub">Choose a system to bring online</div>
        <div class="sys-grid" id="sac-right">${rightCards}</div>
      </div>
    </div>
    <div class="sac-footer">
      <button class="sac-proceed-btn${canProceed ? ' ready' : ''}" id="sac-proceed" ${canProceed?'':' disabled'}>
        PROCEED TO RITUAL
      </button>
    </div>
  `;

  document.getElementById('sac-back').addEventListener('click', closeChamber);
  document.getElementById('sac-left').addEventListener('click', e => {
    const card = e.target.closest('.sys-card');
    if (!card) return;
    sacState.selectedSacrifice = SYSTEMS.find(s => s.id === card.dataset.id) || null;
    sacState.selectedUnlock = null;
    KenteAudio.click();
    renderChamberSelect();
  });
  document.getElementById('sac-right').addEventListener('click', e => {
    const card = e.target.closest('.sys-card');
    if (!card) return;
    sacState.selectedUnlock = SYSTEMS.find(s => s.id === card.dataset.id) || null;
    KenteAudio.click();
    renderChamberSelect();
  });
  document.getElementById('sac-proceed').addEventListener('click', () => {
    if (canProceed) renderChamberConfirm();
  });
}

/* ── CONFIRM SCREEN ── */
function renderChamberConfirm() {
  const sac = sacState.selectedSacrifice;
  const unl = sacState.selectedUnlock;
  let countdown = 3;

  document.getElementById('sac-content').innerHTML = `
    <div class="sac-header">
      <button class="sac-back-btn" id="sac-back-confirm">◀ RECONSIDER</button>
      <div class="sac-title">⚠ CONFIRM THE RITUAL</div>
      <div class="sac-warning">THIS CANNOT BE UNDONE — ONLY A FACTORY RESET WILL RESTORE SACRIFICED SYSTEMS</div>
    </div>
    <div class="sac-confirm-panel">
      <div class="confirm-exchange">
        <div class="confirm-sys sacrifice">
          <div class="confirm-sys-label">YOU SACRIFICE</div>
          <div class="confirm-sys-icon">${sac.icon}</div>
          <div class="confirm-sys-name">${sac.name}</div>
          <div class="confirm-sys-tier">TIER ${sac.tier}</div>
        </div>
        <div class="confirm-arrow">⟶</div>
        <div class="confirm-sys unlock">
          <div class="confirm-sys-label">YOU UNLOCK</div>
          <div class="confirm-sys-icon">${unl.icon}</div>
          <div class="confirm-sys-name">${unl.name}</div>
          <div class="confirm-sys-tier">TIER ${unl.tier}</div>
        </div>
      </div>
      <div class="confirm-notice">
        <span class="confirm-skull">☠</span>
        ALL GAMES ASSOCIATED WITH <strong>${sac.name.toUpperCase()}</strong>
        WILL BE PERMANENTLY REMOVED FROM YOUR LIBRARY.
      </div>
      <button class="sac-commit-btn" id="sac-commit" disabled>
        INITIATING RITUAL IN <span id="commit-countdown">3</span>...
      </button>
    </div>
  `;

  const btn     = document.getElementById('sac-commit');
  const countEl = document.getElementById('commit-countdown');
  // Keep interval ID in a var that both the RECONSIDER handler and the
  // interval itself can reach, so whichever fires first cleans up properly.
  let interval = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(interval);
      interval = null;
      btn.disabled = false;
      btn.textContent = '☠  CONFIRM SACRIFICE  ☠';
      btn.classList.add('ready');
    } else {
      countEl.textContent = countdown;
    }
  }, 1000);

  document.getElementById('sac-back-confirm').addEventListener('click', () => {
    // Always kill the running countdown before navigating away so there is
    // never more than one active interval when the user reopens this screen.
    if (interval) { clearInterval(interval); interval = null; }
    KenteAudio.back(); renderChamberSelect();
  });

  btn.addEventListener('click', () => {
    if (!btn.disabled) startRitual();
  });
}

/* ── RITUAL ANIMATION ── */
function startRitual() {
  const sac = sacState.selectedSacrifice;
  const unl = sacState.selectedUnlock;

  document.getElementById('sac-content').innerHTML = `
    <div class="ritual-stage">
      <div class="ritual-red-pulse"></div>
      <div class="ritual-text" id="ritual-text">SACRIFICE PROTOCOL INITIATED</div>
      <div class="ritual-exchange">
        <div class="ritual-sys dying" id="ritual-sac">
          <div class="ritual-sys-icon">${sac.icon}</div>
          <div class="ritual-sys-name">${sac.name}</div>
        </div>
        <div class="ritual-bolt" id="ritual-bolt">⚡</div>
        <div class="ritual-sys incoming" id="ritual-unl">
          <div class="ritual-sys-icon">${unl.icon}</div>
          <div class="ritual-sys-name">${unl.name}</div>
        </div>
      </div>
      <div class="ritual-bar-wrap">
        <div class="ritual-bar" id="ritual-bar"></div>
      </div>
      <div class="ritual-status" id="ritual-status">PROCESSING...</div>
    </div>
  `;

  KenteAudio.ritualDrone();

  let progress = 0;
  const bar = document.getElementById('ritual-bar');
  const statusEl = document.getElementById('ritual-status');
  const textEl  = document.getElementById('ritual-text');

  const statuses = [
    [20,  'SEVERING SYSTEM BINDINGS...'],
    [45,  'ERASING EMULATOR CORE...'],
    [65,  'PURGING LIBRARY ENTRIES...'],
    [80,  'CHANNELING RESOURCES...'],
    [95,  'FINALIZING TRANSFER...'],
  ];
  const firedStatuses = new Set();

  const fill = setInterval(() => {
    progress = Math.min(100, progress + 0.6);
    bar.style.width = progress + '%';
    const pct = Math.floor(progress);
    const hit = statuses.find(([p]) => p === pct);
    if (hit && !firedStatuses.has(pct)) {
      firedStatuses.add(pct);
      statusEl.textContent = hit[1];
      KenteAudio.staticBurst();
    }
    if (progress >= 100) {
      clearInterval(fill);
      completeRitual(sac, unl, textEl, statusEl);
    }
  }, 18);
}

function completeRitual(sac, unl, textEl, statusEl) {
  KenteAudio.powerDown();

  // Apply state change
  const sacSys = SYSTEMS.find(s => s.id === sac.id);
  const unlSys = SYSTEMS.find(s => s.id === unl.id);
  if (sacSys) { sacSys.active = false; sacSys.sacrificed = true; }
  if (unlSys) { unlSys.active = true; }
  saveSystemState();

  // Kill the dying card
  const sacEl = document.getElementById('ritual-sac');
  if (sacEl) sacEl.classList.add('dead');

  setTimeout(() => {
    textEl.textContent  = `${sac.name.toUpperCase()} HAS BEEN SACRIFICED`;
    statusEl.textContent = 'SYSTEM OFFLINE — PERMANENTLY';
    textEl.style.color   = '#cc2222';

    setTimeout(() => {
      KenteAudio.powerUp();
      const unlEl = document.getElementById('ritual-unl');
      if (unlEl) unlEl.classList.add('online');
      textEl.textContent   = `${unl.name.toUpperCase()} IS NOW ONLINE`;
      statusEl.textContent = 'TRANSFER COMPLETE';
      textEl.style.color   = '#e8a000';

      setTimeout(() => renderChamberResult(sac, unl), 1800);
    }, 1600);
  }, 800);
}

/* ── RESULT SCREEN ── */
function renderChamberResult(sac, unl) {
  document.getElementById('sac-content').innerHTML = `
    <div class="sac-result">
      <div class="result-title">RITUAL COMPLETE</div>
      <div class="result-row">
        <div class="result-dead">
          <div class="result-label">SACRIFICED</div>
          <div class="result-name struck">${sac.name}</div>
          <div class="result-badge offline">OFFLINE FOREVER</div>
        </div>
        <div class="result-arrow">⟶</div>
        <div class="result-live">
          <div class="result-label">UNLOCKED</div>
          <div class="result-name glow">${unl.name}</div>
          <div class="result-badge online">NOW AVAILABLE</div>
        </div>
      </div>
      <div class="result-note">
        Find <strong>${unl.name}</strong> in your PLAY library.<br>
        <strong>${sac.name}</strong> has been removed permanently.
      </div>
      <button class="sac-back-btn" id="result-done" style="margin-top:32px;padding:12px 32px">
        ◀ RETURN TO THE ROOM
      </button>
    </div>
  `;
  document.getElementById('result-done').addEventListener('click', () => {
    document.getElementById('sacrifice-screen').classList.remove('active');
    setScreen('room');
    state.screen = 'room';
    KenteAudio.setHumVol(0.018);
  });
}

/* ══════════════════════════════════════════
   GAME DETAIL PANEL
══════════════════════════════════════════ */
function getFavorites() { try { return JSON.parse(localStorage.getItem('kente_favs')||'[]'); } catch{ return []; } }
function saveFavorites(favs) { localStorage.setItem('kente_favs', JSON.stringify(favs)); }

/* Recently-played ring — capped at 12 entries, most-recent first */
function getRecents() { try { return JSON.parse(localStorage.getItem('kente_recents')||'[]'); } catch{ return []; } }
function addRecentPlay(gameId) {
  const r = [gameId, ...getRecents().filter(id => id !== gameId)].slice(0, 12);
  try { localStorage.setItem('kente_recents', JSON.stringify(r)); } catch {}
}

/* Recently-downloaded shelf — sourced from DownloadManager.
   Returns up to `limit` library game objects, most-recent completion first,
   deduped by gameId. Falls back to a minimal shim when the download's game
   isn't in the active library (e.g. a system was re-sacrificed). */
function getRecentDownloads(limit = 8) {
  if (typeof DownloadManager === 'undefined') return [];
  const items = DownloadManager.getAll()
    .filter(i => i.status === 'complete' && i.game && i._dlAt)
    .sort((a, b) => (b._dlAt || 0) - (a._dlAt || 0));
  const lib = window.KenteLibrary?.games || [];
  const out = []; const seen = new Set();
  for (const it of items) {
    const gid = it.game.id;
    if (!gid || seen.has(gid)) continue;
    seen.add(gid);
    const g = lib.find(x => x.id === gid) || {
      id: gid, title: it.game.title || it.filename || gid,
      systemId: it.game.systemId || 'unknown',
      system:   it.game.system   || (it.game.systemId || '').toUpperCase(),
      year: it.game.year || '', tags: [],
    };
    out.push(g);
    if (out.length >= limit) break;
  }
  return out;
}

/* Re-render the Recently Downloaded shelf in-place when a download completes
   while the user is browsing Play or Collections. If the menu isn't open or
   the shelf section doesn't exist yet, full-rebuild via openMenu() on next
   navigation will pick it up — so this is a best-effort live update. */
function _refreshRecentDownloadsShelf() {
  if (state.screen !== 'menu') return;
  const id = state.activeMenu;
  if (id !== 'play' && id !== 'collections') return;
  const contentEl = document.querySelector(`#menu-${id} #content-${id}`);
  if (!contentEl || !CONTENT_FNS[id]) return;
  contentEl.innerHTML = CONTENT_FNS[id]();
  refreshGameCardDots();
  requestAnimationFrame(() => GamepadManager.applyFocus(0));
}

function toggleFavorite(gameId) {
  const favs   = getFavorites();
  const idx    = favs.indexOf(gameId);
  if (idx >= 0) favs.splice(idx, 1); else favs.push(gameId);
  saveFavorites(favs);
  KenteAudio.click();
  const nowFav = idx < 0;
  // Refresh detail panel button
  const btn = document.querySelector('.gdp-fav-btn');
  if (btn) { btn.classList.toggle('active', nowFav); btn.textContent = nowFav ? '★ FAVORITED' : '☆ FAVORITE'; }
  // Refresh favorite star on every visible game card that matches
  document.querySelectorAll(`.game-card[data-id="${gameId}"] .game-card-fav-star`).forEach(star => {
    star.classList.toggle('active', nowFav);
    star.title = nowFav ? 'FAVORITED' : 'ADD TO FAVORITES';
  });
}

// Monotonic token bumped every open/close so async ROM lookups can detect
// they've been superseded and skip mutating a row that no longer matches.
let _gdpOpenToken = 0;

function openGameDetail(gameId) {
  const lib = window.KenteLibrary;
  const g   = lib?.games.find(g => g.id === gameId);
  if (!g) return;
  _gdpOpenToken++;
  KenteAudio.click();

  const colors = (lib.systemColors || {})[g.systemId] || ['#1a1a2e','#0a0a18'];
  const isFav  = getFavorites().includes(g.id);
  const tv     = TV_ZONES.find(t => t.id === state.activeMenu);
  const accent = tv?.accent || 'var(--brand)';

  // ROM status for the detail panel
  const isFlashGdp  = g.systemId === 'flash';
  const romFound    = isFlashGdp || KENTE_SERVER_ONLINE || !!ROM_STATUS[g.id];
  const romStatus   = isFlashGdp ? 'STREAMING (FLASH)' : (romFound ? 'ROM IN LIBRARY' : 'NOT IN LIBRARY');
  const romColor    = (isFlashGdp || romFound) ? 'var(--green)' : 'var(--text-dim)';

  document.getElementById('gdp-inner').innerHTML = `
    <div class="gdp-cover" style="background:linear-gradient(135deg,${colors[0]},${colors[1]})">
      <img class="gdp-cover-art" src="boxart/${g.id}.jpg" alt="${escHtml(g.title)}"
        onerror="this.style.display='none'"
        onload="this.style.display='block';this.closest('.gdp-cover').classList.add('has-boxart')"
        style="display:none">
      <div class="gdp-cover-overlay"></div>
      <div class="gdp-cover-text">
        <div class="gdp-cover-sys">${escHtml(g.system)} · TIER ${g.tier}</div>
        <div class="gdp-cover-title">${escHtml(g.title)}</div>
        <div class="gdp-cover-year">${escHtml(g.year)} · ${escHtml(g.developer)}</div>
      </div>
      <button class="gdp-close" id="gdp-close">✕</button>
    </div>
    <div class="gdp-body">
      <div class="gdp-meta">
        <div class="gdp-meta-row"><span>DEVELOPER</span><span>${escHtml(g.developer)}</span></div>
        <div class="gdp-meta-row"><span>YEAR</span><span>${escHtml(g.year)}</span></div>
        <div class="gdp-meta-row"><span>PLAYERS</span><span>${escHtml(String(g.players))}</span></div>
        <div class="gdp-meta-row"><span>GENRE</span><span>${g.genre.map(escHtml).join(' · ')}</span></div>
        <div class="gdp-meta-row"><span>ROM</span><span style="color:${romColor}">${romStatus}</span></div>
      </div>
      <div class="gdp-desc">${escHtml(g.desc)}</div>
      <div class="gdp-tags">${g.tags.map(t=>`<span class="gdp-tag">${escHtml(t)}</span>`).join('')}</div>
      <div class="gdp-actions">
        <button class="gdp-launch-btn" style="background:${accent}" data-gameid="${g.id}">▶  LAUNCH GAME</button>
        <div class="gdp-secondary-actions">
          <button class="gdp-fav-btn ${isFav?'active':''}" data-gameid="${g.id}">${isFav?'★ FAVORITED':'☆ FAVORITE'}</button>
          <button class="gdp-secondary-btn" id="gdp-preview-btn">▶ PREVIEW</button>
          <button class="gdp-secondary-btn" id="gdp-manual-btn">📖 MANUAL</button>
          ${g.hasMods ? `<button class="gdp-secondary-btn" id="gdp-mods-btn" style="border-color:var(--brand);color:var(--brand)">🎨 MODS</button>` : ''}
          <button class="gdp-secondary-btn" id="gdp-pin-btn">${_getZonePinLabel(g.id)}</button>
        </div>
      </div>
      ${!isFlashGdp ? `
      <div class="gdp-rom-mgmt">
        <div class="gdp-rom-mgmt-title">ROM MANAGEMENT</div>
        <div id="gdp-rom-status-row" class="gdp-rom-status-row">
          <span style="color:var(--text-dim);font-size:11px">Checking library…</span>
        </div>
      </div>` : ''}
    </div>`;

  const panel = document.getElementById('game-detail-panel');
  panel.style.setProperty('--menu-accent', accent);
  panel.classList.add('open');
  panel.querySelector('#gdp-close').addEventListener('click', closeGameDetail);
  panel.querySelector('.gdp-launch-btn').addEventListener('click', () => launchGame(g));
  panel.querySelector('.gdp-fav-btn').addEventListener('click', () => toggleFavorite(g.id));
  // Preview — opens YouTube search for a trailer
  panel.querySelector('#gdp-preview-btn').addEventListener('click', () => {
    const q = encodeURIComponent(`${g.title} ${g.system} trailer gameplay`);
    window.open(`https://www.youtube.com/results?search_query=${q}`, '_blank', 'noopener');
  });
  // Manual — opens GameFAQs search
  panel.querySelector('#gdp-manual-btn').addEventListener('click', () => {
    const q = encodeURIComponent(g.title);
    window.open(`https://gamefaqs.gamespot.com/search?game=${q}`, '_blank', 'noopener');
  });
  // Mods — opens the mod manager (only present for hasMods games)
  panel.querySelector('#gdp-mods-btn')?.addEventListener('click', () => showModManager(g));
  // Pin to TV zone
  panel.querySelector('#gdp-pin-btn')?.addEventListener('click', () => showZonePinPicker(g, panel.querySelector('#gdp-pin-btn')));
  // Async: populate ROM management section
  if (!isFlashGdp) _loadGdpRomSection(g.id);
  requestAnimationFrame(() => GamepadManager.applyFocus(0));
}

/** Returns the correct label for the pin button based on current pin state */
function _getZonePinLabel(gameId) {
  const pins = getZonePins();
  const pinned = Object.entries(pins).find(([, gid]) => gid === gameId);
  if (pinned) {
    const zone = TV_ZONES.find(z => z.id === pinned[0]);
    return `📌 PINNED TO ${zone?.label || pinned[0].toUpperCase()}`;
  }
  return '📌 PIN TO TV';
}

/** Async: populates the #gdp-rom-status-row with stored ROM info + controls */
async function _loadGdpRomSection(gameId) {
  const row = document.getElementById('gdp-rom-status-row');
  if (!row) return;
  const token = _gdpOpenToken;
  const meta = await RomDB.getMeta(gameId);
  // Bail if the panel was closed or re-opened for a different game while
  // RomDB.getMeta was in flight — otherwise we'd write into a stale row.
  if (token !== _gdpOpenToken) return;
  if (meta?.handle) {
    const date = meta.savedAt ? new Date(meta.savedAt).toLocaleDateString() : '—';
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="color:var(--green);font-size:11px">✓ ${meta.fileName || 'ROM'}</span>
        <span style="color:var(--text-dim);font-size:10px">saved ${date}</span>
        <button id="gdp-rom-remove" style="margin-left:auto;padding:3px 10px;font-size:10px;
          background:none;border:1px solid #c0392b;color:#c0392b;border-radius:3px;cursor:pointer">
          ✕ REMOVE
        </button>
      </div>`;
    row.querySelector('#gdp-rom-remove').addEventListener('click', async () => {
      await RomDB.remove(gameId);
      ROM_STATUS[gameId] = false;
      refreshGameCardDots();
      showToast('ROM removed from library');
      row.innerHTML = `<span style="color:var(--text-dim);font-size:11px">Not in library</span>`;
    });
  } else {
    row.innerHTML = `<span style="color:var(--text-dim);font-size:11px">Not in library — use SOURCES to download</span>`;
  }
}

function closeGameDetail() {
  document.getElementById('game-detail-panel').classList.remove('open');
  // Bump the token so any in-flight _loadGdpRomSection bails before mutating
  // a row that's about to be torn down.
  _gdpOpenToken++;
  // Drop child nodes (and their event listeners) from the inner panel so the
  // browser can reclaim them promptly instead of waiting for the next open.
  const inner = document.getElementById('gdp-inner');
  if (inner) inner.innerHTML = '';
  GamepadManager.resetFocus();
}

/* ── LAUNCH SEQUENCE ── */
// Flag that blocks re-entrant launches (rapid double-click / gamepad double-press).
// Always reset in the `finally` block so an error never permanently locks the UI.
let _launchInProgress = false;

async function launchGame(g) {
  // Prevent launching a second game while one is already loading or playing.
  // state.screen === 'playing' / 'paused' = emulator is live;
  // _launchInProgress = true             = async launch sequence is in flight.
  if (state.screen === 'playing' || state.screen === 'paused') return;
  if (_launchInProgress) return;
  _launchInProgress = true;
  try {

  closeGameDetail();
  KenteAudio.click();
  addRecentPlay(g.id);  // track for Recently Played shelf

  // Theater audio collision — pause anything currently playing so the
  // emulator's audio isn't fighting an active stream / iframe in the
  // background. The user can re-open the title from Continue Watching.
  _silenceTheaterForLaunch();

  // ── Discord Rich Presence: set "Playing <game>" ─────────────────────────
  window.electronAPI?.setDiscordPresence?.({
    details:        g.title,
    state:          `${g.system} \u00B7 TIER ${g.tier}`,
    startTimestamp: Date.now(),
    largeImageKey:  'kente-icon',
    largeImageText: "Kente's Korner",
    smallImageKey:  g.systemId,
    smallImageText: g.system,
    instance:       false,
  });

  // ── Native desktop exe (Windows) or Linux run.sh (Linux / WSL) ──
  // Preferred over the Ruffle iframe when the server is reachable.
  // Windows  → nativeExe (.exe)       | Linux → nativeExeLinux (run.sh via bash)
  // Windows + no .exe but has Linux   → WSL launch
  const canNativeWin   = g.nativeExe      && serverPlatform === 'Windows';
  const canNativeLin   = g.nativeExeLinux && serverPlatform === 'Linux';
  const canWSL         = g.nativeExeLinux && serverPlatform === 'Windows' && !g.nativeExe;
  if (canNativeWin || canNativeLin || canWSL) { launchNativeApp(g); return; }

  // ── Flash games: Ruffle iframe — no ROM or server needed ──
  if (g.systemId === 'flash') { launchFlashGame(g); return; }

  // ── Routing decision ──────────────────────────────────────────────────────────
  // On real Batocera (serverIsBatocera=true): ALL systems use the native emulator
  // launcher for best performance and compatibility — Batocera manages everything.
  //
  // On a dev machine (serverIsBatocera=false): CORE_MAP systems use EmulatorJS so
  // the developer can test them without real hardware. For native-only systems
  // (PS2, GameCube, etc.) with no CDN core — Dreamcast now plays via flycast-wasm:
  //   • Server reachable  → search Archive.org and download the ROM locally
  //   • Server offline    → show "NATIVE MODE REQUIRED" dead-end screen
  if (serverIsBatocera) { launchNative(g); return; }

  // Not on real Batocera — systems with no WebAssembly core cannot run in browser
  if (!CORE_MAP[g.systemId]) {
    // If the ROM was already downloaded, hand off to launchFromDownloadCenter so
    // the correct Batocera / OPFS / archive chain runs — same as clicking ▶ LAUNCH.
    const dlItem = DownloadManager.getAll().find(i => i.game?.id === g.id && i.status === 'complete');
    if (dlItem) { launchFromDownloadCenter(dlItem.id); return; }

    if (KENTE_SERVER_ONLINE) {
      // Server is reachable on this (non-Batocera) machine.
      // launchNative() → /api/launch → find_rom() checks the local roms/ folder
      // first and opens with the installed emulator (Dolphin, PCSX2, etc.).
      // If the ROM isn't on disk yet it gets ROM_NOT_FOUND and falls back to
      // launchNativeFromCloud() which searches Archive.org and downloads it.
      launchNative(g);
    } else {
      showNativeModeRequired(g);
    }
    return;
  }

  // ── Browser path — EmulatorJS with File System Access ──
  // Check if we have a stored ROM handle for this game
  const handle = await RomDB.get(g.id);
  if (handle) {
    // Verify the handle still has read permission
    try {
      const perm = await handle.queryPermission?.({ mode: 'read' });
      if (perm === 'granted' || perm === undefined) {
        launchWithEmulatorJS(g, handle);
        return;
      }
      // Permission expired — request again
      const newPerm = await handle.requestPermission?.({ mode: 'read' });
      if (newPerm === 'granted') { launchWithEmulatorJS(g, handle); return; }
    } catch {
      await RomDB.remove(g.id);
    }
  }

  // No local ROM — check connectivity and decide
  const online = await checkOnline();
  if (online) {
    // Internet available → stream from cloud
    launchFromCloud(g);
  } else {
    // Offline and no local ROM → inform the user
    showToast('📡 NO NETWORK — ADD ROM TO LOCAL LIBRARY TO PLAY OFFLINE');
    showRomOptions(g);
  }
  // Note: _launchInProgress is cleared in the finally block below.
  // launchWithEmulatorJS / launchNative take over the overlay so
  // clearing on their completion (EJS_onGameStart, ROM_NOT_FOUND, etc.) is handled
  // by those functions; we just need to unblock the guard after dispatch.
  } finally {
    _launchInProgress = false;
  }
}

/* ── SOURCE DETAIL PANEL ── */

/** Format a stored epoch-ms timestamp into a human-readable relative string. */
function _formatScanTs(tsStr) {
  if (!tsStr) return 'NEVER';
  const elapsed = Date.now() - Number(tsStr);
  if (elapsed < 60_000)        return 'JUST NOW';
  if (elapsed < 3_600_000)     return `${Math.round(elapsed / 60_000)}M AGO`;
  if (elapsed < 86_400_000)    return `${Math.round(elapsed / 3_600_000)}H AGO`;
  return `${Math.round(elapsed / 86_400_000)}D AGO`;
}

function openSourceDetail(sourceName, icon, status, count) {
  KenteAudio.click();
  const lastScanned = status === 'local'
    ? _formatScanTs(localStorage.getItem('kente_scan_ts'))
    : '—';
  const isLocal = status === 'local';
  document.getElementById('sdp-inner').innerHTML = `
    <div class="sdp-header">
      <span class="sdp-icon">${icon}</span>
      <span class="sdp-title">${escHtml(sourceName)}</span>
      <button class="sdp-close" id="sdp-close">✕</button>
    </div>
    <div class="sdp-body">
      <div class="sdp-stat-row"><span>STATUS</span><span>${escHtml(status.toUpperCase())}</span></div>
      <div class="sdp-stat-row"><span>TITLES INDEXED</span><span>${count}</span></div>
      <div class="sdp-stat-row"><span>LAST SCANNED</span><span>${lastScanned}</span></div>
      ${isLocal ? `<div class="sdp-stat-row"><span>AUTO-SCAN</span><span>OFF</span></div>
      <button class="sdp-action-btn" id="sdp-action-btn" style="margin-top:8px">↺ SCAN ROM FOLDER</button>`
      : `<p style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);
           letter-spacing:0.1em;line-height:1.8;margin-top:14px">
           EXTERNAL SOURCE DETECTED.<br>
           BROWSE ITS FILES THROUGH YOUR OS<br>
           OR USE THE ⚡ CLOUD BROWSER TO<br>
           STREAM AND SAVE ROMS DIRECTLY.</p>`}
    </div>`;
  const panel = document.getElementById('source-detail-panel');
  panel.classList.add('open');
  document.getElementById('sdp-close').addEventListener('click', () => panel.classList.remove('open'));

  document.getElementById('sdp-action-btn')?.addEventListener('click', () => {
    panel.classList.remove('open');
    if ('showDirectoryPicker' in window) {
      scanRomFolder();
    } else {
      showToast('⚠ FOLDER SCANNING REQUIRES CHROME OR EDGE');
    }
  });
}

/* ══════════════════════════════════════════
   ROM FUZZY MATCHER
══════════════════════════════════════════ */
function normalizeTitle(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^the\s/, '')
    .trim();
}

function matchRomToGame(fileName, games) {
  const fileBase = normalizeTitle(fileName.replace(/\.[^.]+$/, ''));
  let best = null, bestScore = 0;
  for (const g of games) {
    const titleNorm = normalizeTitle(g.title);
    // Exact match
    if (fileBase === titleNorm) return { game: g, score: 100 };
    // Title words all present in filename
    const titleWords = titleNorm.split(' ').filter(w => w.length > 2);
    const hits = titleWords.filter(w => fileBase.includes(w)).length;
    const score = titleWords.length ? (hits / titleWords.length) * 90 : 0;
    if (score > bestScore && score >= 50) { best = g; bestScore = score; }
  }
  return best ? { game: best, score: bestScore } : null;
}

/* ══════════════════════════════════════════
   ROM FOLDER SCANNER
══════════════════════════════════════════ */
async function scanRomFolder(targetGame = null) {
  // Show scanning message in launch overlay
  const launch = document.getElementById('launch-overlay');
  const con    = document.getElementById('launch-content');
  if (!launch.classList.contains('active')) launch.classList.add('active');
  con.innerHTML = `
    <div class="launch-title">SCANNING ROM FOLDER</div>
    <div class="launch-game">SELECT YOUR ROMS FOLDER</div>
    <div class="launch-sys">ALL SUBFOLDERS WILL BE SEARCHED</div>
    <div class="launch-status" id="scan-status">WAITING FOR FOLDER SELECTION...</div>`;

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'read' });
  } catch {
    launch.classList.remove('active');
    return;
  }

  document.getElementById('scan-status').textContent = 'SCANNING...';

  // Collect all files recursively
  const allFiles = [];
  // Precompute once — avoids rebuilding the full extensions array for every file
  const validExtSet = new Set(Object.values(ROM_EXT).flat());
  async function walk(dir, depth = 0) {
    if (depth > 4) return;
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        const ext = '.' + name.split('.').pop().toLowerCase();
        if (validExtSet.has(ext)) allFiles.push({ name, handle, ext });
      } else if (handle.kind === 'directory') {
        await walk(handle, depth + 1);
      }
    }
  }
  await walk(dirHandle);
  document.getElementById('scan-status').textContent = `FOUND ${allFiles.length} ROM FILES — MATCHING...`;

  // Match files to library games
  const lib = window.KenteLibrary;
  const matched   = [];
  const unmatched = [];

  for (const f of allFiles) {
    // Filter to games whose system extension matches
    const eligibleGames = lib.games.filter(g => (ROM_EXT[g.systemId] || []).includes(f.ext));
    const result = matchRomToGame(f.name, eligibleGames);
    if (result) matched.push({ file: f, game: result.game, score: result.score });
    else        unmatched.push(f);
  }

  launch.classList.remove('active');
  showScanResults(matched, unmatched, targetGame);
}

function showScanResults(matched, unmatched, targetGame) {
  const overlay = document.getElementById('rom-scan-overlay');
  const total   = matched.length + unmatched.length;

  const matchedRows = matched.map(m => `
    <div class="scan-row matched">
      <span class="scan-row-icon">✓</span>
      <span class="scan-row-file">${escHtml(m.file.name)}</span>
      <span class="scan-row-arrow">→</span>
      <span class="scan-row-game">${escHtml(m.game.title)}</span>
    </div>`).join('');

  const unmatchedRows = unmatched.map(f => `
    <div class="scan-row unmatched">
      <span class="scan-row-icon">?</span>
      <span class="scan-row-file">${escHtml(f.name)}</span>
      <span class="scan-row-arrow">—</span>
      <span class="scan-row-game" style="color:var(--text-dim)">NO MATCH IN LIBRARY</span>
    </div>`).join('');

  document.getElementById('rom-scan-content').innerHTML = `
    <div class="scan-header">
      <div class="scan-title">SCAN COMPLETE</div>
      <div class="scan-summary">${total} FILES FOUND · ${matched.length} MATCHED · ${unmatched.length} UNMATCHED</div>
    </div>
    <div class="scan-list">${matchedRows}${unmatchedRows}</div>
    <div class="scan-footer">
      <button class="scan-confirm-btn" id="scan-confirm">✓ SAVE ${matched.length} MATCHES</button>
      <button class="scan-cancel-btn" id="scan-cancel">CANCEL</button>
    </div>`;

  overlay.classList.add('active');

  document.getElementById('scan-cancel').addEventListener('click', () => {
    overlay.classList.remove('active');
    if (targetGame) showRomOptions(targetGame);
  });

  document.getElementById('scan-confirm').addEventListener('click', async () => {
    for (const m of matched) await RomDB.set(m.game.id, m.file.handle, m.file.name);
    try { localStorage.setItem('kente_scan_ts', Date.now().toString()); } catch {}
    overlay.classList.remove('active');
    showToast(`✓ ${matched.length} ROMS LINKED TO LIBRARY`);
    KenteAudio.powerUp();
    if (targetGame) {
      const handle = await RomDB.get(targetGame.id);
      if (handle) launchWithEmulatorJS(targetGame, handle);
    }
  });
}

/* ══════════════════════════════════════════
   ROM OPTIONS SCREEN
══════════════════════════════════════════ */
async function showRomOptions(game) {
  const tv     = TV_ZONES.find(t => t.id === state.activeMenu);
  const accent = tv?.accent || 'var(--brand)';
  const hasFSA = 'showDirectoryPicker' in window;

  const overlay = document.getElementById('launch-overlay');
  const con     = document.getElementById('launch-content');
  overlay.style.setProperty('--menu-accent', accent);
  overlay.classList.add('active');

  // Check library state
  const libEntry    = await LibraryDB.getRoot();
  const hasLibrary  = !!libEntry?.handle;
  const exts        = ROM_EXT[game.systemId] || [];
  const expectedExt = exts[0] || '';
  const expectedDir = game.systemId;

  // Message adapts based on whether the library is configured
  const hintHtml = hasLibrary
    ? `<div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);letter-spacing:0.1em;line-height:2;margin:14px 0 6px">
         ROM NOT FOUND IN YOUR LIBRARY.<br>
         PLACE THE FILE IN:<br>
         <span style="color:var(--brand)">${escHtml(libEntry.name)}/${escHtml(expectedDir)}/${escHtml(game.title)}${escHtml(expectedExt)}</span><br>
         THEN RESCAN YOUR LIBRARY.
       </div>`
    : `<div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);letter-spacing:0.1em;line-height:2;margin:14px 0 6px">
         SET UP A ROM LIBRARY DIRECTORY TO MANAGE<br>
         ALL YOUR GAMES IN ONE PLACE.<br>
         STRUCTURE: <span style="color:var(--brand)">library/${escHtml(expectedDir)}/*.${escHtml(expectedExt.replace('.',''))}</span>
       </div>`;

  con.innerHTML = `
    <div class="launch-title">ROM NOT IN LIBRARY</div>
    <div class="launch-game">${escHtml(game.title)}</div>
    <div class="launch-sys">${(game.system || game.systemId || '').toUpperCase()} · TIER ${game.tier}</div>
    ${hintHtml}
    <div class="rom-options">
      ${!hasLibrary && hasFSA ? `
      <button class="rom-option-btn" id="rom-set-library">
        <span class="rom-option-icon">📂</span>
        <span class="rom-option-text">
          <span class="rom-option-title">SET UP ROM LIBRARY</span>
          <span class="rom-option-desc">POINT TO YOUR ROMS FOLDER — ALL GAMES AUTO-INDEXED</span>
        </span>
      </button>` : ''}
      ${hasLibrary ? `
      <button class="rom-option-btn" id="rom-rescan-lib">
        <span class="rom-option-icon">↺</span>
        <span class="rom-option-text">
          <span class="rom-option-title">RESCAN LIBRARY</span>
          <span class="rom-option-desc">RE-INDEX ALL ROMS IN: ${libEntry.name}</span>
        </span>
      </button>` : ''}
      <button class="rom-option-btn" id="rom-search-cloud">
        <span class="rom-option-icon">🌐</span>
        <span class="rom-option-text">
          <span class="rom-option-title">SEARCH CLOUD</span>
          <span class="rom-option-desc">BROWSE INTERNET ARCHIVE — DOWNLOAD TO LIBRARY</span>
        </span>
      </button>
      <button class="rom-option-btn" id="rom-pick-file" style="opacity:0.55">
        <span class="rom-option-icon">🗂</span>
        <span class="rom-option-text">
          <span class="rom-option-title">PICK FILE MANUALLY</span>
          <span class="rom-option-desc">ONE-TIME — NOT SAVED TO LIBRARY</span>
        </span>
      </button>
    </div>
    <button class="launch-dismiss" id="rom-back" style="margin-top:16px">◀ BACK</button>`;

  document.getElementById('rom-back').addEventListener('click', () => {
    overlay.classList.remove('active');
  });

  document.getElementById('rom-set-library')?.addEventListener('click', async () => {
    overlay.classList.remove('active');
    await setRomLibraryRoot();
    const h = await RomDB.get(game.id);
    if (h) launchWithEmulatorJS(game, h);
  });

  document.getElementById('rom-rescan-lib')?.addEventListener('click', async () => {
    overlay.classList.remove('active');
    try {
      const perm = await libEntry.handle.requestPermission({ mode: 'read' });
      if (perm === 'granted') {
        showToast('⚙ RESCANNING LIBRARY...');
        await silentScanLibrary(libEntry.handle, true);
        const h = await RomDB.get(game.id);
        if (h) launchWithEmulatorJS(game, h);
        else showToast(`⚠ ${game.title} STILL NOT FOUND IN LIBRARY`);
      }
    } catch(e) {
      console.warn('[rom-rescan-lib]', e);
    }
  });

  document.getElementById('rom-search-cloud').addEventListener('click', () => {
    overlay.classList.remove('active');
    openCloudBrowser('archive', game.title, game.systemId);
  });

  document.getElementById('rom-pick-file').addEventListener('click', () => {
    overlay.classList.remove('active');
    openRomPickerForGame(game);
  });
}

function openRomPickerForGame(game) {
  const exts = ROM_EXT[game.systemId] || [];
  const input = document.getElementById('rom-file-input');
  input.accept = exts.join(',') || '*';
  // NOTE: File objects and closures are NOT structured-cloneable,
  // so we cannot store them in IndexedDB. We launch directly instead.
  // The user will need to re-pick on next visit (unlike FSA handles which persist).
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    const handle = { getFile: async () => file, kind: 'file' };
    launchWithEmulatorJS(game, handle);
  };
  input.click();
}

/* ══════════════════════════════════════════
   BIOS PICKER
   Shown when a required BIOS is missing.
   romHandle is saved so launch can continue
   automatically once the BIOS is picked.
══════════════════════════════════════════ */
function showBiosPicker(game, romHandle, biosReq) {
  const tv     = TV_ZONES.find(t => t.id === state.activeMenu);
  const accent = tv?.accent || 'var(--brand)';

  const overlay = document.getElementById('launch-overlay');
  const con     = document.getElementById('launch-content');
  overlay.style.setProperty('--menu-accent', accent);
  overlay.classList.add('active');

  con.innerHTML = `
    <div class="launch-title">BIOS REQUIRED</div>
    <div class="launch-game">${escHtml(game.title)}</div>
    <div class="launch-sys">${escHtml((game.system || game.systemId || '').toUpperCase())} — ${escHtml(biosReq.label.toUpperCase())}</div>
    <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);
                letter-spacing:0.12em;line-height:1.9;margin:18px 0 10px">
      THIS SYSTEM REQUIRES A BIOS FILE TO RUN.<br>
      EXPECTED FILE: <span style="color:var(--brand)">${escHtml(biosReq.filename)}</span>
    </div>
    <div class="rom-options">
      <button class="rom-option-btn" id="bios-pick-btn">
        <span class="rom-option-icon">🔧</span>
        <span class="rom-option-text">
          <span class="rom-option-title">SELECT BIOS FILE</span>
          <span class="rom-option-desc">LOCATE ${escHtml(biosReq.filename.toUpperCase())} ON YOUR DEVICE</span>
        </span>
      </button>
    </div>
    <button class="launch-dismiss" id="bios-back" style="margin-top:16px">◀ BACK</button>`;

  document.getElementById('bios-back').addEventListener('click', () => {
    overlay.classList.remove('active');
  });

  document.getElementById('bios-pick-btn').addEventListener('click', () => {
    overlay.classList.remove('active');
    const input = document.getElementById('rom-file-input');
    input.accept = '';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      input.value = '';
      // Use FSA handle if available so it persists across sessions
      if ('showOpenFilePicker' in window) {
        try {
          const [fh] = await window.showOpenFilePicker({ multiple: false });
          await BiosDB.set(game.systemId, fh, biosReq.filename);
          showToast(`✓ ${biosReq.label.toUpperCase()} SAVED`);
          launchWithEmulatorJS(game, romHandle);
          return;
        } catch { /* user cancelled FSA — fall through to plain File */ }
      }
      // Fallback: no persistence, launch directly
      const tempHandle = { getFile: async () => file, kind: 'file' };
      await BiosDB.set(game.systemId, tempHandle, biosReq.filename).catch(() => {});
      showToast(`✓ ${biosReq.label.toUpperCase()} LOADED`);
      launchWithEmulatorJS(game, romHandle);
    };
    input.click();
  });
}

/* ══════════════════════════════════════════
   NATIVE MODE REQUIRED SCREEN
   Shown when the user tries to launch a
   PS2 / GameCube / PS3 etc. game in browser
   mode — no WASM core available for these.
   (Dreamcast now plays via flycast-wasm when
   kente-server is online.)
══════════════════════════════════════════ */
function showNativeModeRequired(game) {
  const EMU = {
    dreamcast: 'FLYCAST', ps2: 'PCSX2',
    gamecube: 'DOLPHIN', wii: 'DOLPHIN', wiiu: 'CEMU',
    ps3: 'RPCS3', xbox: 'XEMU', xbox360: 'XENIA',
    switch: 'RYUJINX',
  };
  const emu    = EMU[game.systemId] || 'NATIVE EMULATOR';
  const tv     = TV_ZONES.find(t => t.id === state.activeMenu);
  const accent = tv?.accent || 'var(--brand)';
  const overlay = document.getElementById('launch-overlay');
  const con     = document.getElementById('launch-content');
  overlay.style.setProperty('--menu-accent', accent);
  overlay.classList.add('active');

  con.innerHTML = `
    <div class="launch-title">NATIVE MODE REQUIRED</div>
    <div class="launch-game">${escHtml(game.title)}</div>
    <div class="launch-sys">${(game.system || game.systemId || '').toUpperCase()} · POWERED BY ${emu}</div>
    <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);
                letter-spacing:0.12em;line-height:2;margin:20px 0 8px;text-align:center;
                max-width:400px">
      <strong style="color:var(--white)">${(game.system || game.systemId || '').toUpperCase()}</strong> CANNOT RUN IN BROWSER MODE.<br>
      NO WEBASSEMBLY CORE IS AVAILABLE FOR THIS SYSTEM.<br><br>
      TO PLAY, RUN THE KENTE SERVER ON YOUR BATOCERA DEVICE:<br>
      <span style="color:var(--brand)">python batocera/kente-server.py</span><br>
      IT WILL BE DETECTED AUTOMATICALLY ON THE NEXT PAGE LOAD.
    </div>
    <button class="launch-dismiss" style="margin-top:18px">✕ CLOSE</button>`;
}

/* ══════════════════════════════════════════
   CONNECTIVITY CHECK
══════════════════════════════════════════ */

/** Returns true if we have a real internet connection (not just LAN). */
async function checkOnline() {
  if (!navigator.onLine) return false;
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 4000);
    const res  = await fetch(
      'https://archive.org/favicon.ico',
      { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal }
    );
    clearTimeout(t);
    return true; // no-cors always "succeeds" if we reach the server
  } catch {
    return false;
  }
}

/* ══════════════════════════════════════════
   CLOUD LAUNCH — stream directly from Archive.org
══════════════════════════════════════════ */

// _currentCloudRomData removed — cloud ROM metadata is now passed explicitly
// as the optional third argument cloudRomData to launchWithEmulatorJS.

async function launchFromCloud(game) {
  const core = CORE_MAP[game.systemId];
  if (!core) {
    showToast(`⚠ ${game.system} NOT SUPPORTED IN BROWSER MODE`);
    return;
  }

  // Cloud ROM metadata accumulated during this launch — passed explicitly to
  // launchWithEmulatorJS and the save button instead of through a global variable.
  let _cloudRomData = null;

  // Show overlay immediately with search status
  const overlay   = document.getElementById('emulator-overlay');
  const container = document.getElementById('ejs-container');
  document.getElementById('ejs-game-title').textContent   = game.title;
  document.getElementById('ejs-system-badge').textContent = game.system.toUpperCase();
  document.getElementById('ejs-loader')?.remove();
  container.innerHTML = `
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
                justify-content:center;gap:16px;color:#555;font-family:var(--font-mono);font-size:12px;
                letter-spacing:0.2em">
      <div id="ejs-load-spinner" style="width:36px;height:36px;border:2px solid #222;border-top-color:#e8a000;
           border-radius:50%;animation:ejs-spin 0.8s linear infinite"></div>
      <div id="ejs-load-status">SEARCHING CLOUD...</div>
    </div>
    <style>@keyframes ejs-spin{to{transform:rotate(360deg)}}</style>`;
  overlay.classList.add('active');
  state.screen = 'playing';
  KenteAudio.setHumVol(0);
  document.getElementById('ejs-exit').onclick = showIngameMenu;

  const statusEl = () => document.getElementById('ejs-load-status');

  try {
    // 1 — Search Archive.org
    let results = await searchArchive(game.title, game.systemId);

    // Region-preference patterns — prefer English/USA releases automatically
    const RGN_USA = /\((usa|world|en)\b/i;
    const RGN_EU  = /\((europe|eur|eu)\b/i;
    const RGN_JP  = /\((japan|jpn|jp)\b/i;

    // 1b — Fallback: Archive.org pack collection search when subject search fails
    if (!results.length) {
      if (statusEl()) statusEl().textContent = 'ARCHIVE.ORG EMPTY — TRYING PACK COLLECTION...';
      const packHits = await searchPackCollection(game.title, game.systemId);
      if (packHits.length) {
        const validExtsFb = new Set((ROM_EXT[game.systemId] || []).map(e => e.toLowerCase()));
        const validHits = packHits.filter(f => {
          const ext = '.' + f.name.split('.').pop().toLowerCase();
          return validExtsFb.size === 0 || validExtsFb.has(ext);
        });
        const best =
          validHits.find(f => RGN_USA.test(f.name)) ||
          validHits.find(f => !RGN_EU.test(f.name) && !RGN_JP.test(f.name)) ||
          validHits[0];
        if (best) results = [{ _packUrl: best.url, _packName: best.name }];
      }
    }
    if (!results.length) throw new Error('NO_RESULTS');

    if (statusEl()) statusEl().textContent = 'FOUND MATCH — LOADING FILES...';

    // 2 — Try up to 15 results until we find one with a valid ROM file.
    const validExts = new Set((ROM_EXT[game.systemId] || []).map(e => e.toLowerCase()));
    let romUrl = null, romFilename = null, romSizeBytes = 0;

    for (const result of results.slice(0, 15)) {
      // Pack collection result — URL is already a direct archive.org download link
      if (result._packUrl) {
        romUrl      = result._packUrl;
        romFilename = result._packName;
        if (DEBUG) console.log(`[Kente/cloud] Picked pack ROM: ${romFilename}`);
        break;
      }
      let files;
      try {
        files = await getArchiveFiles(result.identifier, game.systemId);
      } catch (e) {
        // Metadata endpoint can return 429/503 for individual items — skip and try the next result
        console.warn(`[Kente/cloud] getArchiveFiles failed for ${result.identifier}:`, e.message);
        continue;
      }
      // Container formats must be ≥ CONTAINER_MIN_BYTES — see module constant.
      const valid = files.filter(f => {
        const ext = '.' + f.name.split('.').pop().toLowerCase();
        if (!validExts.has(ext)) return false;
        if (CONTAINER_FORMATS.has(ext)) {
          const sz = parseInt(f.size || '0');
          return sz === 0 || sz >= CONTAINER_MIN_BYTES;  // 0 = unknown size, let through
        }
        return true;
      });
      if (!valid.length) continue;

      // Title-aware pool: if this item contains many files (pack), narrow by title
      // so we don't accidentally pick the wrong game from a multi-ROM archive.
      // Fall back to all valid files if no title match is found.
      const _normWords = s => s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w.length>2);
      const _titleWords = new Set(_normWords(game.title));
      const _byTitle = valid.filter(f => _normWords(f.name).some(w => _titleWords.has(w)));
      const pool = _byTitle.length ? _byTitle : valid;

      // Priority: USA/World → no region tag (likely multi-region) → Europe → Japan → anything
      const match =
        pool.find(f => RGN_USA.test(f.name))                              ||
        pool.find(f => !RGN_EU.test(f.name) && !RGN_JP.test(f.name))     ||
        pool.find(f => RGN_EU.test(f.name))                               ||
        pool[0];

      romFilename  = match.name;
      romSizeBytes = Number(match.size) || 0;
      romUrl = `https://archive.org/download/${result.identifier}/${encodeURIComponent(match.name)}`;
      if (DEBUG) console.log(`[Kente/cloud] Picked ROM: ${romFilename} (${(romSizeBytes/1_048_576).toFixed(1)} MB) from ${result.identifier}`);
      break;
    }

    if (!romUrl) throw new Error('NO_ROM_FILE');

    // 3 — Store ROM metadata locally so the "Save to Library" button can re-fetch it.
    //     This is passed explicitly to launchWithEmulatorJS rather than via a global.
    _cloudRomData = { url: romUrl, filename: romFilename, systemId: game.systemId };

    // 4 — Download the ROM ourselves using fetch before handing off to EmulatorJS.
    //
    //     WHY: EmulatorJS uses XHR internally. Archive.org /download/ URLs redirect
    //     across CDN servers (e.g. ia600704.us.archive.org) that may lack CORS headers,
    //     causing XHR to fail with a "Network Error".  The browser's fetch() API handles
    //     redirects transparently and returns the data regardless of the redirect chain.
    //     We then hand EmulatorJS a local blob: URL — zero CORS surface.
    const sizeMb    = romSizeBytes ? ` (${(romSizeBytes / 1_048_576).toFixed(0)} MB)` : '';
    if (statusEl()) statusEl().textContent = `DOWNLOADING ROM${sizeMb}...`;

    let blobUrl;
    try {
      // Route the download through the native server proxy when it's running.
      // Archive.org's CDN servers (ia600xxx.us.archive.org) frequently drop the
      // CORS header on redirect responses, blocking direct browser fetches.
      // The native server fetches without CORS restrictions and pipes the data
      // back with Access-Control-Allow-Origin: *, completely bypassing the issue.
      //
      // When the native server is online (Batocera mode), also pass save=1 so
      // the server writes the ROM to /userdata/roms/<system>/ while streaming it
      // to the browser — one download trip, two results.
      // ── Resolve the best fetch URL ──────────────────────────────────────
      // Priority:
      //   1. Native server (Batocera) — proxy + save-to-disk, zero CORS
      //   2. kente-server.py on localhost:7777 (dev mode) — CORS bypass only
      //   3. Direct Archive.org URL — works when CDN includes ACAO header
      //   4. corsproxy.io mirror — public CORS proxy, browser-only fallback
      //
      // Archive.org CDN servers (ia600xxx.us.archive.org) frequently drop the
      // Access-Control-Allow-Origin header on redirect responses. Options 1-2
      // route through a server-side fetch that has no CORS restrictions at all.
      // Option 4 mirrors the request through a public CORS-enabled proxy.

      let fetchUrl = romUrl;
      let savedBatoceraPath = null;

      if (KENTE_SERVER_ONLINE) {
        // Batocera: proxy + save to /userdata/roms/<system>/ simultaneously
        const pp = new URLSearchParams({
          url:      romUrl,
          save:     '1',
          systemId: game.systemId,
          filename: romFilename,
        });
        fetchUrl = `${KENTE_SERVER_URL}/api/rom-proxy?${pp}`;
      } else {
        // Dev mode: ping localhost:7777 — if running, use it just for CORS bypass
        try {
          const ping = await fetch(`${KENTE_SERVER_URL}/api/ping`,
            { signal: _abortTimeout(1500), cache: 'no-store' });
          if (ping.ok) {
            fetchUrl = `${KENTE_SERVER_URL}/api/rom-proxy?url=${encodeURIComponent(romUrl)}`;
          }
        } catch (_) { /* server not running — will try direct then proxy */ }
      }

      // ── Streaming download helper ────────────────────────────────────────
      async function _streamRom(url) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP_${r.status}`);
        if (!r.body) throw new Error('NO_BODY');
        return r;
      }

      let resp;
      if (fetchUrl !== romUrl) {
        // Server proxy path — already CORS-safe, no fallback needed
        if (DEBUG) console.log(`[Kente/dl] Using server proxy: ${fetchUrl.slice(0, 80)}...`);
        resp = await _streamRom(fetchUrl);
        savedBatoceraPath = resp.headers.get('X-Kente-Saved-Path');
      } else {
        // Browser-direct path:
        // 1. Try Archive.org directly (works when CDN returns CORS headers)
        // 2. Try corsproxy.io   (free public CORS proxy)
        // 3. Try allorigins.win (second public proxy — different infrastructure)
        // Each step is logged so devtools shows exactly which step succeeded/failed.
        const CORS_PROXIES = [
          u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
          u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        ];
        let lastErr = null;

        // Step 1 — direct
        try {
          console.log('[Kente/dl] Trying direct Archive.org fetch...');
          resp = await _streamRom(romUrl);
          console.log('[Kente/dl] Direct fetch succeeded.');
        } catch (e1) {
          lastErr = e1;
          console.warn('[Kente/dl] Direct fetch failed:', e1.message);
        }

        // Steps 2-3 — CORS proxies
        if (!resp) {
          for (const buildProxy of CORS_PROXIES) {
            const proxiedUrl = buildProxy(romUrl);
            try {
              if (DEBUG) console.log(`[Kente/dl] Trying CORS proxy: ${proxiedUrl.slice(0, 60)}...`);
              if (statusEl()) statusEl().textContent = 'RETRYING VIA CORS PROXY...';
              resp = await _streamRom(proxiedUrl);
              console.log('[Kente/dl] CORS proxy succeeded.');
              break;
            } catch (eProxy) {
              lastErr = eProxy;
              console.warn(`[Kente/dl] Proxy failed (${proxiedUrl.slice(0, 40)}):`, eProxy.message);
            }
          }
        }

        if (!resp) throw lastErr || new Error('ALL_PROXIES_FAILED');
      }

      // ── Stream body with live progress ───────────────────────────────────
      const total  = Number(resp.headers.get('Content-Length')) || 0;
      const reader = resp.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (statusEl()) {
          const mb     = (received / 1_048_576).toFixed(1);
          const pctStr = total ? ` · ${Math.round(received / total * 100)}%` : '';
          statusEl().textContent = `DOWNLOADING ROM... ${mb} MB${pctStr}`;
        }
      }

      blobUrl = URL.createObjectURL(new Blob(chunks));

      // If the native server saved a copy to Batocera, mark it as locally available
      if (savedBatoceraPath) {
        ROM_STATUS[game.id] = true;
        refreshGameCardDots();
        console.log(`[Kente] ROM persisted to Batocera: ${savedBatoceraPath}`);
      }
    } catch (dlErr) {
      console.error('[KenteKorner] ROM download failed:', dlErr.message || dlErr);
      throw new Error('DOWNLOAD_FAILED');
    }

    if (statusEl()) statusEl().textContent = 'ROM READY — STARTING EMULATOR...';

    // 5 — Pass the local blob URL to EmulatorJS (treated as a "cloud" URL in the UI
    //     since it came from the cloud — save button and cloud badge stay visible).
    await launchWithEmulatorJS(game, blobUrl, _cloudRomData);

  } catch (err) {
    // Snapshot the found ROM url — used for the "Open on Archive.org" fallback
    const failedRomUrl = _cloudRomData?.url || null;

    // Classify the error for the user-facing message
    let errLine1, errLine2, showArchiveLink = false;
    if (err.message === 'NO_RESULTS' || err.message === 'NO_ROM_FILE') {
      errLine1 = 'ROM NOT FOUND';
      errLine2 = `COULD NOT FIND A FILE FOR<br><span style="color:#777">${escHtml(game.title)}</span><br>ON ARCHIVE.ORG`;
    } else if (err.message === 'DOWNLOAD_FAILED' || err.message?.startsWith('HTTP_')) {
      const code = err.message.startsWith('HTTP_') ? ` (${err.message.slice(5)})` : '';
      errLine1 = `DOWNLOAD FAILED${code}`;
      // CORS on Archive.org CDN redirects is the most common cause in browser-only mode.
      // Offer a direct link so the user can grab the file manually and load it.
      errLine2 = 'THE ROM WAS FOUND BUT COULD NOT BE FETCHED.<br>OPEN THE FILE ON ARCHIVE.ORG TO DOWNLOAD MANUALLY,<br>THEN USE "LOAD ROM FILE" BELOW.';
      showArchiveLink = !!failedRomUrl;
    } else {
      errLine1 = 'SEARCH FAILED';
      errLine2 = 'CHECK YOUR INTERNET CONNECTION<br>AND TRY AGAIN';
    }

    // Keep the emulator overlay open — inject an inline error state so the user
    // stays in the full-screen flow and can retry or manually load a file.
    // Do NOT call showRomOptions() — that breaks the immersion with a separate screen.
    const con = document.getElementById('ejs-container');
    if (con) {
      const archiveLinkBtn = showArchiveLink
        ? `<a id="ejserr-archive" href="${escHtml(failedRomUrl)}" target="_blank" rel="noopener"
             style="display:block;background:#0a1a0a;border:1px solid #1a3a1a;color:#30d880;
                    font-family:var(--font-mono);font-size:10px;letter-spacing:0.2em;
                    padding:13px 0;cursor:pointer;text-decoration:none;text-align:center">
             ↗ &nbsp;OPEN ON ARCHIVE.ORG
           </a>`
        : '';

      con.innerHTML = `
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
                    justify-content:center;gap:14px;color:#555;font-family:var(--font-mono);
                    font-size:11px;letter-spacing:0.15em;text-align:center;padding:32px">
          <div style="font-size:28px;opacity:0.25;margin-bottom:2px">◎</div>
          <div style="color:var(--brand,#e8a000);letter-spacing:0.25em">${errLine1}</div>
          <div style="color:#3a3a3a;font-size:10px;line-height:2.2;max-width:300px">${errLine2}</div>
          <div style="display:flex;flex-direction:column;gap:10px;width:260px;margin-top:10px">
            ${archiveLinkBtn}
            <button id="ejserr-retry"
              style="background:#111;border:1px solid #2a2a2a;color:#aaa;font-family:var(--font-mono);
                     font-size:10px;letter-spacing:0.2em;padding:13px 0;cursor:pointer">
              ↺ &nbsp;RETRY SEARCH
            </button>
            <button id="ejserr-pick"
              style="background:transparent;border:1px solid #181818;color:#3a3a3a;font-family:var(--font-mono);
                     font-size:10px;letter-spacing:0.2em;padding:11px 0;cursor:pointer">
              🗂 &nbsp;LOAD ROM FILE MANUALLY
            </button>
          </div>
        </div>`;

      document.getElementById('ejserr-retry').addEventListener('click', () => {
        launchFromCloud(game);
      });
      document.getElementById('ejserr-pick').addEventListener('click', () => {
        // exitEmulator resets overlay, state.screen, and audio cleanly
        exitEmulator();
        openRomPickerForGame(game);
      });
    } else {
      // Fallback: container gone — reset to room state
      overlay.classList.remove('active');
      state.screen = 'room';
      KenteAudio.setHumVol(0.018);
    }
  }
}

/* ══════════════════════════════════════════
   EMULATORJS LAUNCHER
══════════════════════════════════════════ */
let _currentRomUrl  = null;
let _currentBiosUrl = null;
let _flashIframe    = null;   // active Flash iframe (for gamepad relay)
let _flashRelayRaf  = null;   // rAF handle for the relay loop

// handleOrUrl:  FileSystemFileHandle  →  local disk play
//               string (http/https)   →  cloud streaming play
// cloudRomData: { url, filename, systemId } — passed from cloud launch paths so
//               the Save button and filename detection work without a global variable.
async function launchWithEmulatorJS(game, handleOrUrl, cloudRomData = null) {
  // `let` — may be promoted from desmume2015 → melonds if NDS BIOS is present
  let core = CORE_MAP[game.systemId];
  if (!core) {
    showToast(`⚠ ${game.system} NOT YET SUPPORTED IN BROWSER MODE`);
    return;
  }

  // If an emulator instance is already live (user launched from Download Center while
  // a game was running, or a second launch slipped through) tear the old one down first.
  // Without this, two WebWorkers fight over the same #ejs-container → black screen.
  if (state.screen === 'playing' || state.screen === 'paused') {
    exitEmulator();
  }

  const isCloudUrl = typeof handleOrUrl === 'string';

  // Show overlay (launchFromCloud may have already set it up; skip if already active)
  const overlay   = document.getElementById('emulator-overlay');
  const container = document.getElementById('ejs-container');
  document.getElementById('ejs-game-title').textContent   = game.title;
  document.getElementById('ejs-system-badge').textContent = game.system.toUpperCase();

  // Cloud badge + save button visibility
  const cloudBadge = document.getElementById('ejs-cloud-badge');
  const saveBtn    = document.getElementById('ejs-save-btn');
  cloudBadge.hidden = !isCloudUrl;
  saveBtn.hidden    = !isCloudUrl;
  if (isCloudUrl) {
    // If the ROM is already indexed locally, show saved state — no need to save again
    const alreadyLocal = game.id && ROM_STATUS[game.id];
    if (alreadyLocal) {
      saveBtn.textContent = '✓ IN LIBRARY';
      saveBtn.disabled    = true;
      cloudBadge.hidden   = true;   // treat as local — hide cloud badge too
    } else {
      saveBtn.textContent = '↓ SAVE TO LIBRARY';
      saveBtn.disabled    = false;
      // Capture cloudRomData in closure so the save button always uses the data
      // from this specific launch rather than any later global mutation.
      saveBtn.onclick = () => saveCloudRomToLibrary(game, cloudRomData);
    }
  }

  // ── Always clean up any leftover loader before injecting a new one ──
  // If loader was previously removed by exitEmulator this is a no-op;
  // if somehow still present (e.g. rapid relaunch), we wipe it cleanly.
  document.getElementById('ejs-loader')?.remove();

  if (!overlay.classList.contains('active')) {
    container.innerHTML = `
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
                  justify-content:center;gap:16px;color:#555;font-family:var(--font-mono);font-size:12px;
                  letter-spacing:0.2em">
        <div id="ejs-load-spinner" style="width:36px;height:36px;border:2px solid #222;border-top-color:#e8a000;
             border-radius:50%;animation:ejs-spin 0.8s linear infinite"></div>
        <div id="ejs-load-status">LOADING ROM...</div>
      </div>
      <style>@keyframes ejs-spin{to{transform:rotate(360deg)}}</style>`;
    overlay.classList.add('active');
    state.screen = 'playing';
    KenteAudio.setHumVol(0);
  }
  document.getElementById('ejs-exit').onclick = showIngameMenu;

  // ── BIOS check ──
  const biosReq = BIOS_MAP[game.systemId];
  let biosUrl = null;
  if (biosReq) {
    const biosHandle = await BiosDB.get(game.systemId);
    if (biosHandle) {
      try {
        const perm = await biosHandle.queryPermission?.({ mode: 'read' });
        if (perm === 'granted' || perm === undefined) {
          const biosFile = await biosHandle.getFile();
          biosUrl = URL.createObjectURL(biosFile);
        } else {
          const newPerm = await biosHandle.requestPermission?.({ mode: 'read' });
          if (newPerm === 'granted') {
            const biosFile = await biosHandle.getFile();
            biosUrl = URL.createObjectURL(biosFile);
          } else {
            await BiosDB.remove(game.systemId);
          }
        }
      } catch {
        await BiosDB.remove(game.systemId);
      }
    }
    if (!biosUrl && biosReq.required) {
      overlay.classList.remove('active');
      cloudBadge.hidden = true; saveBtn.hidden = true;
      KenteAudio.setHumVol(0.018);
      showBiosPicker(game, handleOrUrl, biosReq);
      return;
    }
  }

  const statusEl = () => document.getElementById('ejs-load-status');

  // ── Dreamcast: flycast-wasm core requires the kente-server CDN proxy ──────────
  // The flycast core is NOT on the EmulatorJS stable CDN. kente-server downloads it
  // from GitHub and proxies all other EJS assets. Without the server we have no core.
  // Also: flycast needs BIOS at /dc/dc_boot.bin in the WASM FS (not via EJS_biosUrl),
  // so we suppress the standard EJS_biosUrl path and write it manually in EJS_ready.
  const needsEjsProxy = (game.systemId === 'dreamcast');
  if (needsEjsProxy && !KENTE_SERVER_ONLINE) {
    overlay.classList.remove('active');
    cloudBadge.hidden = true; saveBtn.hidden = true;
    KenteAudio.setHumVol(0.018);
    showNativeModeRequired(game);
    return;
  }
  // For Dreamcast, suppress EJS_biosUrl — we write the BIOS directly to the WASM FS
  // in EJS_ready instead (flycast expects it at /dc/dc_boot.bin, not at the FS root).
  if (needsEjsProxy) biosUrl = null;

  // ── Resolve ROM URL (blob for disk, direct URL for cloud) ──
  if (_currentBiosUrl) URL.revokeObjectURL(_currentBiosUrl);
  _currentBiosUrl = biosUrl;

  // NDS: desmume2015 runs without a BIOS, but if the user has supplied bios7.bin
  // through the BIOS settings panel, promote to melonDS — it has better accuracy,
  // proper wifi support, and correct timing for DS-exclusive titles.
  if (game.systemId === 'nds' && biosUrl && core === 'desmume2015') {
    core = 'melonds';
    if (DEBUG) console.log('[EJS] NDS BIOS detected — promoting core: desmume2015 → melonds');
  }

  // romName is passed to EJS_gameName so EmulatorJS can detect the ROM format.
  // blob: URLs have no file extension, so without this EJS cannot determine
  // whether a file is .nes, .z64, .bin, .iso, etc. and silently fails to load.
  let romName = game.title;

  if (isCloudUrl) {
    if (handleOrUrl.startsWith('blob:')) {
      // Already a local blob (pre-downloaded by launchFromCloud) — use directly.
      if (_currentRomUrl?.startsWith('blob:') && _currentRomUrl !== handleOrUrl) {
        URL.revokeObjectURL(_currentRomUrl);
      }
      _currentRomUrl = handleOrUrl;
      // Recover the original filename from the cloud metadata passed in
      romName = cloudRomData?.filename || game.title;
      if (statusEl()) statusEl().textContent = 'ROM READY — STARTING EMULATOR...';
    } else {
      // Raw https:// URL — must pre-download to a blob first.
      // EmulatorJS uses XHR internally; Archive.org /download/ URLs redirect to
      // CDN servers that often lack CORS headers → XHR fails with Network Error.
      // fetch() handles the redirect chain transparently; the blob is same-origin.
      if (statusEl()) statusEl().textContent = 'DOWNLOADING ROM...';
      try {
        const resp = await fetch(handleOrUrl);
        if (!resp.ok) throw new Error(`HTTP_${resp.status}`);
        const dlTotal  = Number(resp.headers.get('Content-Length')) || 0;
        const dlReader = resp.body.getReader();
        const dlChunks = [];
        let   dlRecv   = 0;
        while (true) {
          const { done, value } = await dlReader.read();
          if (done) break;
          dlChunks.push(value);
          dlRecv += value.length;
          if (statusEl()) {
            const mb  = (dlRecv / 1_048_576).toFixed(1);
            const pct = dlTotal ? ` · ${Math.round(dlRecv / dlTotal * 100)}%` : '';
            statusEl().textContent = `DOWNLOADING ROM... ${mb} MB${pct}`;
          }
        }
        if (_currentRomUrl?.startsWith('blob:')) URL.revokeObjectURL(_currentRomUrl);
        _currentRomUrl = URL.createObjectURL(new Blob(dlChunks));
        // Extract filename from the URL path for format detection
        romName = decodeURIComponent(handleOrUrl.split('/').pop().split('?')[0]) || game.title;
        if (statusEl()) statusEl().textContent = 'ROM READY — STARTING EMULATOR...';
      } catch (dlErr) {
        overlay.classList.remove('active');
        state.screen = 'room';
        KenteAudio.setHumVol(0.018);
        if (biosUrl) URL.revokeObjectURL(biosUrl);
        _currentBiosUrl = null;
        showToast('⚠ ROM DOWNLOAD FAILED — CHECK CONNECTION AND TRY AGAIN');
        return;
      }
    }
  } else {
    // Disk path — read file and create blob URL
    let file;
    try {
      file = await handleOrUrl.getFile();
    } catch (err) {
      console.error('[EJS] getFile failed:', err);
      overlay.classList.remove('active');
      if (biosUrl) URL.revokeObjectURL(biosUrl);
      await RomDB.remove(game.id).catch(() => {});
      showRomOptions(game);
      return;
    }
    if (statusEl()) statusEl().textContent = 'CREATING ROM BLOB...';
    if (_currentRomUrl?.startsWith('blob:')) URL.revokeObjectURL(_currentRomUrl);
    _currentRomUrl = URL.createObjectURL(file);
    romName = file.name; // file.name always has the real extension (.nes, .z64, .iso…)
  }

  if (statusEl()) statusEl().textContent = 'LOADING EMULATOR CORE...';

  // CDN base: Dreamcast games use the kente-server EJS proxy (which serves the
  // community flycast-wasm.data core); all other systems use the stable CDN directly.
  const ejsBase = needsEjsProxy ? `${KENTE_SERVER_URL}/api/ejs/` : EJS_CDN;

  // Set EmulatorJS globals BEFORE injecting the script
  window.EJS_player          = '#ejs-container';
  window.EJS_core            = core;
  window.EJS_gameUrl         = _currentRomUrl;
  window.EJS_gameName        = romName;   // ← tells EJS the file extension / format
  window.EJS_pathtodata      = ejsBase;
  // Dreamcast: EJS_startOnLoaded=false so we can write the BIOS to the WASM FS in
  // EJS_ready before the core boots.  All other systems auto-start as normal.
  window.EJS_startOnLoaded   = !needsEjsProxy;
  window.EJS_color           = '#e8a000';
  window.EJS_backgroundColor = '#070810';
  window.EJS_Buttons         = { playPause: false };
  // EJS_gamepadSupport controls the VIRTUAL on-screen gamepad (for mobile touch),
  // NOT physical controller support. Enabling it can interfere with canvas focus and
  // input routing on desktop. Physical gamepads are handled by the keyboard bridge below.
  // Leave it unset (false/default) so no on-screen overlay is created.
  if (_currentBiosUrl) window.EJS_biosUrl = _currentBiosUrl;

  // ── Lifecycle callbacks ──
  // EJS_ready fires once the emulator UI is mounted (not yet running the game)
  window.EJS_ready = () => {
    const spinner = document.getElementById('ejs-load-spinner');
    if (spinner) spinner.style.display = 'none';
    if (statusEl()) statusEl().textContent = 'EMULATOR READY — LOADING GAME...';

    if (needsEjsProxy) {
      // Dreamcast: EJS_startOnLoaded=false — we must start the game manually AFTER
      // writing BIOS files to the correct location in the WASM filesystem.
      // Flycast expects dc_boot.bin (and optionally dc_flash.bin) at /dc/ in the FS.
      (async () => {
        try {
          const fs = window.EJS_emulator?.FS;
          if (fs) {
            try { fs.mkdir('/dc'); } catch (_) { /* already exists */ }

            // Write dc_boot.bin (required — BIOS check above already confirmed present)
            const bootFh = await BiosDB.get('dreamcast').catch(() => null);
            if (bootFh) {
              const buf = await (await bootFh.getFile()).arrayBuffer();
              fs.writeFile('/dc/dc_boot.bin', new Uint8Array(buf));
              if (DEBUG) console.log('[flycast] wrote /dc/dc_boot.bin');
            }
            // Write dc_flash.bin (optional — saves VMU data and regional settings)
            const flashFh = await BiosDB.get('dreamcast_flash').catch(() => null);
            if (flashFh) {
              const fbuf = await (await flashFh.getFile()).arrayBuffer();
              fs.writeFile('/dc/dc_flash.bin', new Uint8Array(fbuf));
              if (DEBUG) console.log('[flycast] wrote /dc/dc_flash.bin');
            }
          }
        } catch (e) {
          console.warn('[flycast] BIOS FS write failed:', e);
        }
        // Start the game now that BIOS files are in place
        window.EJS_emulator?.startGame?.();
      })();
    }
  };
  // EJS_onGameStart fires when emulation actually begins
  window.EJS_onGameStart = () => {
    // Remove any lingering spinner overlay — EJS has taken over the canvas
    const spinnerWrap = document.getElementById('ejs-load-spinner')?.parentElement;
    if (spinnerWrap?.style?.position === 'absolute') spinnerWrap.remove();

    requestAnimationFrame(() => {
      // Re-dispatch gamepadconnected for any already-connected pads so EJS
      // binds each one to a player slot (P1=index 0, P2=index 1, …).
      // EJS may have missed the original event (fired before loader.js ran).
      let nPads = 0;
      for (const gp of (navigator.getGamepads() || [])) {
        if (!gp?.connected) continue;
        nPads++;
        try { window.dispatchEvent(new GamepadEvent('gamepadconnected', { gamepad: gp })); }
        catch (_) { /* unsupported — keyboard bridge below covers P1 input */ }
      }

      // Focus the canvas so keyboard events reach Emscripten's listeners
      const ejsCanvas = document.querySelector('#ejs-container canvas');
      if (ejsCanvas) {
        ejsCanvas.setAttribute('tabindex', '-1');
        ejsCanvas.focus({ preventScroll: true });
      }

      // ── Keyboard bridge (P1 fallback path) ───────────────────────────
      // Translates pad-0 button presses into RetroArch P1 keyboard binds and
      // dispatches them to the canvas. RetroArch only ships default keyboard
      // binds for P1 — P2/P3/P4 are routed through EJS's native gamepad
      // polling (the gamepadconnected re-dispatch above seeds it).
      _startEJSKeyBridge();

      // Announce how many players are wired up. Single-player stays quiet
      // (the room toast already showed "PLAYER 1 READY" on connect).
      if (nPads >= 2) showToast(`🎮 ${nPads} PLAYERS READY — MULTIPLAYER ACTIVE`);
    });
  };

  // Show the REMAP button in the HUD; clicking it opens EJS's gamepad config
  const ctrlBtn = document.getElementById('ejs-ctrl-btn');
  if (ctrlBtn) {
    ctrlBtn.hidden = false;
    ctrlBtn.onclick = () => {
      // EmulatorJS exposes its instance on window.EJS_emulator after init.
      // Try to click its internal gamepad config button; fall back to a toast.
      const ejsGpBtn = document.querySelector(
        '.ejs_button_gamepad, [title*="controller" i], [data-id="gamepad"]'
      );
      if (ejsGpBtn) {
        ejsGpBtn.click();
      } else {
        showToast('🎮 HOVER BOTTOM OF GAME → TOOLBAR → GAMEPAD ICON TO REMAP');
      }
    };
  }

  // ── Dreamcast WebGL2 compatibility patches ────────────────────────────────
  // flycast-wasm requires three runtime patches to the WebGL2 context before EJS
  // loads.  These intercept HTMLCanvasElement.getContext and wrap the resulting
  // WebGL2RenderingContext with compatibility shims that fix:
  //   A) glGetString returning garbage (forces GLES3 version strings)
  //   B) GL_INVALID_ENUM (0x500) from WebGL2 FBO ops killing RetroArch video init
  //   C) texParameteri called on unbound textures (causes per-frame console spam)
  // Also suppresses harmless Emscripten/Flycast console.warn noise.
  // Reference: nasomers/flycast-wasm TECHNICAL_WRITEUP.md — Phase 10.
  if (needsEjsProxy) {
    document.getElementById('flycast-webgl2-patch')?.remove();
    const patch = document.createElement('script');
    patch.id = 'flycast-webgl2-patch';
    patch.textContent = `(function(){
  var _orig=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(t,a){
    var ctx=_orig.call(this,t,a);
    if(!ctx||!(ctx instanceof WebGL2RenderingContext))return ctx;
    var oGP=ctx.getParameter.bind(ctx);
    ctx.getParameter=function(p){
      if(p===0x1F02)return'OpenGL ES 3.0 WebGL 2.0';
      if(p===0x8B8C)return'OpenGL ES GLSL ES 3.00';
      return oGP(p);
    };
    var oGE=ctx.getError.bind(ctx);
    ctx.getError=function(){var e=oGE();while(e===0x500)e=oGE();return e;};
    var tb={};tb[ctx.TEXTURE_2D]=ctx.TEXTURE_BINDING_2D;
    tb[ctx.TEXTURE_CUBE_MAP]=ctx.TEXTURE_BINDING_CUBE_MAP;
    tb[ctx.TEXTURE_3D]=ctx.TEXTURE_BINDING_3D;
    tb[ctx.TEXTURE_2D_ARRAY]=ctx.TEXTURE_BINDING_2D_ARRAY;
    var oTI=ctx.texParameteri.bind(ctx);
    ctx.texParameteri=function(t,p,v){var b=tb[t];if(b&&!oGP(b))return;return oTI(t,p,v);};
    var oTF=ctx.texParameterf.bind(ctx);
    ctx.texParameterf=function(t,p,v){var b=tb[t];if(b&&!oGP(b))return;return oTF(t,p,v);};
    return ctx;
  };
  var _ow=console.warn;
  console.warn=function(){var s=arguments[0];
    if(typeof s==='string'&&(s.indexOf('__syscall_mprotect')>-1||s.indexOf('is not a valid value')>-1))return;
    _ow.apply(console,arguments);};
})();`;
    document.head.appendChild(patch);
  }

  // Inject EmulatorJS loader script
  const script = document.createElement('script');
  script.id  = 'ejs-loader';
  script.src = ejsBase + 'loader.js';
  script.onerror = () => {
    console.error('[EJS] Failed to load EmulatorJS from CDN');
    overlay.classList.remove('active');
    cloudBadge.hidden = true; saveBtn.hidden = true;
    // Reset screen state so the controller isn't stuck in play-mode isolation
    state.screen = 'room';
    showToast('⚠ COULD NOT LOAD EMULATOR — CHECK YOUR INTERNET CONNECTION');
    if (_currentRomUrl?.startsWith('blob:')) { URL.revokeObjectURL(_currentRomUrl); }
    _currentRomUrl = null;
    if (_currentBiosUrl) { URL.revokeObjectURL(_currentBiosUrl); _currentBiosUrl = null; }
    KenteAudio.setHumVol(0.018);
  };
  document.body.appendChild(script);
}

/* ══════════════════════════════════════════
   ARCHIVE DOWNLOADS PANEL
══════════════════════════════════════════ */

// System color map for the system badge in each row
const DL_SYS_COLORS = {
  nes: '#c0392b', snes: '#8e44ad', gameboy: '#2980b9', gbc: '#27ae60',
  gba: '#e67e22', genesis: '#16a085', mastersys: '#1abc9c',
  gamegear: '#2ecc71', segacd: '#8e44ad', sega32x: '#e74c3c',
  n64: '#2c3e50', ps1: '#2980b9', ps2: '#2471a3', gamecube: '#6c3483',
  nds: '#9b59b6', wii: '#7f8c8d', psp: '#1a5276',
  dreamcast: '#c0392b', saturn: '#7d3c98',
  atari2600: '#e74c3c', atari7800: '#c0392b', turbografx: '#b7950b',
  neogeo: '#922b21',
  // Tier 4-5 native-only systems
  xbox:    '#107c10', xbox360: '#52b043',
  ps3:     '#003087',
  wiiu:    '#009ac7',
  switch:  '#e4000f',
};

/* ══════════════════════════════════════════
   DOWNLOAD CONTROL CENTER
   PS5-style right-side panel. Shows live
   download progress, queue, and completed
   items with a LAUNCH button.
══════════════════════════════════════════ */
/* ══════════════════════════════════════════
   GUIDE OVERLAY
   Opened from Settings › SYSTEM → USB Boot Guide / PS4 Console Mod
   type: 'usb' | 'ps4'
══════════════════════════════════════════ */
const GUIDE_CONTENT = {
  usb: {
    title: 'USB BOOT GUIDE',
    subtitle: 'Make any PC or laptop boot KenteOS from a USB drive',
    sections: [
      {
        heading: 'WHAT YOU NEED',
        steps: [
          'A USB drive — 4 GB minimum (8 GB+ recommended)',
          'WSL (Windows Subsystem for Linux) installed on your PC',
          'Admin PowerShell for writing to the drive',
          'The KenteCorner project folder (this app)',
        ],
      },
      {
        heading: 'STEP 1 — BUILD THE ISO (WSL Terminal)',
        code: 'bash build/create-iso.sh',
        note: 'Creates dist/KenteOS.iso and dist/kente.squashfs. Takes ~5–10 minutes first run.',
      },
      {
        heading: 'STEP 2 — WRITE TO USB (Admin PowerShell)',
        code: '.\\build\\write-usb.ps1 -Mode PC',
        note: 'You will be prompted to choose your USB drive from a list. All existing data on the USB will be erased.',
      },
      {
        heading: 'STEP 3 — BOOT FROM USB',
        steps: [
          'Plug the USB into the target PC',
          'Power on and press the boot menu key: F12 (Dell/Lenovo), F11 (MSI), F9 (HP), ESC/DEL (others)',
          'Select your USB drive from the boot menu list',
          'KenteOS boots in about 15 seconds',
        ],
      },
      {
        heading: 'WHAT HAPPENS ON BOOT',
        steps: [
          'Alpine Linux minimal environment loads from the USB',
          'X11 + Openbox window manager start automatically',
          "Kente's Korner launches full-screen",
          'Your settings, favorites, and saves live on the USB — portable between PCs',
        ],
      },
      {
        heading: 'WANT PC + PS4 ON THE SAME USB?',
        code: '.\\build\\write-usb.ps1 -Mode Both',
        note: 'Writes a FAT32 partition with GRUB (PC boot) AND the PS4 kernel payload side by side.',
      },
    ],
  },

  ps4: {
    title: 'PS4 CONSOLE MOD',
    subtitle: 'Boot KenteOS from USB on your jailbroken PlayStation 4',
    sections: [
      {
        heading: 'WHAT IS THIS?',
        steps: [
          "Turns your PS4 into a full KenteOS retro gaming station using Linux kexec",
          'The PS4 boots our custom Alpine Linux image from your USB drive',
          "Kente's Korner launches on your TV via HDMI — just like a real console",
          'Your PS4 OS and saves are untouched — remove the USB to return to normal',
        ],
      },
      {
        heading: 'REQUIREMENTS',
        steps: [
          'PS4 with firmware 5.05 — 11.00 (PPPwn or GoldHEN jailbreak)',
          'GoldHEN 2.x or PPPwn exploit active on the console',
          'USB drive with KenteOS PS4 payload (written from this PC)',
          'WSL on your Windows PC for building the payload',
        ],
      },
      {
        heading: 'SUPPORTED FIRMWARE',
        note: '5.05 \u00B7 6.72 \u00B7 7.02 \u00B7 7.55 \u00B7 8.00 \u00B7 8.50 \u00B7 9.00 \u00B7 9.60 \u00B7 10.01 \u00B7 11.00',
      },
      {
        heading: 'STEP 1 — BUILD THE PS4 KERNEL PAYLOAD (WSL)',
        code: 'bash build/create-ps4-payload.sh',
        note: 'Downloads a PS4-patched Linux kernel (bzImage) and builds a custom initramfs that finds and mounts kente.squashfs from your USB.',
      },
      {
        heading: 'STEP 2 — BUILD THE SYSTEM IMAGE (WSL)',
        code: 'bash build/create-iso.sh',
        note: 'Creates dist/kente.squashfs — the compressed KenteOS root filesystem.',
      },
      {
        heading: 'STEP 3 — WRITE TO USB (Admin PowerShell)',
        code: '.\\build\\write-usb.ps1 -Mode PS4',
        note: 'Formats USB as FAT32 and copies: bzImage, initramfs.cpio.gz, bootargs.txt, kente.squashfs. Takes about 2–3 minutes.',
      },
      {
        heading: 'STEP 4 — BOOT ON THE PS4',
        steps: [
          'Activate your jailbreak — run PPPwn or load GoldHEN',
          'Plug the KenteOS USB into the PS4 (any port)',
          'Open GoldHEN \u2192 BinLoader (or use a PS4-compatible browser payload)',
          'Visit ps4boot.github.io and select your exact firmware version',
          'The page loads the kexec payload — it will find the USB automatically',
          'PS4 screen goes black, then KenteOS boots \u2192 X11 starts \u2192 Kente\u2019s Korner appears on your TV',
        ],
      },
      {
        heading: 'HOW THE BOOT CHAIN WORKS',
        steps: [
          'GoldHEN / kexec payload reads bzImage + bootargs.txt from the FAT32 USB',
          'kexec hands control to the custom PS4 Linux kernel (AMD GCN GPU support)',
          'initramfs init script scans all drives for kente.squashfs',
          'squashfs is loop-mounted with an overlayfs writable layer for saves',
          'switch_root hands off to Alpine Linux \u2192 X11 \u2192 Openbox \u2192 Kente\u2019s Korner',
        ],
      },
    ],
  },
};

function _buildGuideHTML(guide) {
  const sections = guide.sections.map(s => {
    let body = '';
    if (s.steps)  body += `<ul class="guide-steps">${s.steps.map(t => `<li>${t}</li>`).join('')}</ul>`;
    if (s.code)   body += `<div class="guide-code"><span class="guide-code-prompt">$</span> ${escHtml(s.code)}</div>`;
    if (s.note)   body += `<p class="guide-note">${s.note}</p>`;
    return `<div class="guide-section"><h3 class="guide-section-title">${s.heading}</h3>${body}</div>`;
  }).join('');
  return `
    <div class="guide-header">
      <h2 class="guide-title">${guide.title}</h2>
      <p class="guide-subtitle">${guide.subtitle}</p>
    </div>
    <div class="guide-body">${sections}</div>`;
}

function openGuide(type) {
  const guide = GUIDE_CONTENT[type];
  if (!guide) return;
  const overlay = document.getElementById('guide-overlay');
  const panel   = document.getElementById('guide-panel');
  if (!overlay || !panel) return;
  panel.innerHTML = _buildGuideHTML(guide);
  overlay.classList.add('active');
  panel.scrollTop = 0;

  const close = () => {
    overlay.classList.remove('active');
    overlay.removeEventListener('click', onOverlayClick);
    GamepadManager?.resetFocus?.();
  };
  const onOverlayClick = e => { if (e.target === overlay) close(); };
  overlay.addEventListener('click', onOverlayClick);

  // Close button injected into header
  const closeBtn = document.createElement('button');
  closeBtn.className = 'guide-close-btn';
  closeBtn.textContent = '\u2715 CLOSE';
  closeBtn.onclick = close;
  panel.querySelector('.guide-header')?.appendChild(closeBtn);
}

function openDownloadCenter() {
  KenteAudio.click();
  const overlay = document.getElementById('downloads-overlay');
  overlay.classList.add('active');
  DownloadManager.render();
  document.getElementById('dl-close').onclick = () => {
    overlay.classList.remove('active');
    GamepadManager.resetFocus();
  };
}

/* ══════════════════════════════════════════
   KENTE'S REPOSITORY
   Left-side slide panel. Fetches the public
   GitHub repo n-13thehat/KentesKorner via the
   GitHub REST API and shows ROMs, ISOs, and
   emulator releases available for download.
   • ROM/ISO → queued in DownloadManager
   • Emulator → browser file download (to the
     user's default downloads folder)
══════════════════════════════════════════ */
const KENTE_REPO_API  = 'https://api.github.com/repos/n-13thehat/KentesKorner';
const KENTE_REPO_URL  = 'https://github.com/n-13thehat/KentesKorner';

// File extension → systemId
const _REPO_EXT_SID = {
  '.nes':'nes',  '.sfc':'snes',  '.smc':'snes',  '.gba':'gba',
  '.gbc':'gbc',  '.gb':'gameboy','.nds':'nds',    '.psp':'psp',
  '.cso':'psp',  '.iso':'ps1',   '.bin':'ps1',    '.cue':'ps1',
  '.gcm':'gamecube', '.n64':'n64', '.z64':'n64',  '.v64':'n64',
  '.md':'genesis',   '.smd':'genesis', '.sms':'mastersys', '.gg':'gamegear',
  '.32x':'sega32x',  '.pce':'tgfx', '.ngp':'neogeo', '.ws':'wonderswan',
  '.vb':'virtualboy','.lnx':'lynx', '.a26':'atari2600','.a78':'atari7800',
  '.chd':'ps1',  '.nsp':'switch','.xci':'switch', '.nsz':'switch',
};

// Known emulator folder names and their display info
const _REPO_EMU_DIRS = {
  'dolphin':{ name:'Dolphin',    icon:'🐬', systems:'GameCube · Wii',     sid:'gamecube' },
  'pcsx2':  { name:'PCSX2',      icon:'🎮', systems:'PlayStation 2',       sid:'ps2'      },
  'psx':    { name:'PCSX2',      icon:'🎮', systems:'PlayStation 2',       sid:'ps2'      },
  'rpcs3':  { name:'RPCS3',      icon:'🎮', systems:'PlayStation 3',       sid:'ps3'      },
  'cemu':   { name:'Cemu',       icon:'🎮', systems:'Wii U',               sid:'wiiu'     },
  'ryujinx':{ name:'Ryujinx',    icon:'🎮', systems:'Nintendo Switch',     sid:'switch'   },
};

function _repoExt(filename) {
  const d = filename.lastIndexOf('.');
  return d >= 0 ? filename.slice(d).toLowerCase() : '';
}
function _repoSid(filename) { return _REPO_EXT_SID[_repoExt(filename)] || null; }
function _repoFmtSize(b) {
  if (!b) return '';
  if (b < 1048576)      return `${(b/1024).toFixed(0)} KB`;
  if (b < 1073741824)   return `${(b/1048576).toFixed(1)} MB`;
  return `${(b/1073741824).toFixed(2)} GB`;
}

async function _repoFetch(endpoint) {
  const r = await fetch(KENTE_REPO_API + endpoint, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!r.ok) { const t = await r.text().catch(()=>''); throw new Error(`GitHub ${r.status}: ${t.slice(0,120)}`); }
  return r.json();
}

async function _repoGetAll() {
  // Fetch local library + GitHub in parallel
  const [localData, root, releases] = await Promise.all([
    KENTE_SERVER_ONLINE
      ? fetch(`${KENTE_SERVER_URL}/api/local-library`).then(r => r.json()).catch(() => ({ emulators: [], roms: [] }))
      : Promise.resolve({ emulators: [], roms: [] }),
    _repoFetch('/contents').catch(() => []),
    _repoFetch('/releases').catch(() => []),
  ]);

  const ghRoms = [];
  const ghEmus = [];

  // Walk GitHub root — one level deep
  for (const item of root) {
    if (item.type === 'dir') {
      const key = item.name.toLowerCase();
      if (_REPO_EMU_DIRS[key]) {
        ghEmus.push({ kind: 'folder', ...item, info: _REPO_EMU_DIRS[key] });
        continue;
      }
      const children = await _repoFetch(`/contents/${item.path}`).catch(() => []);
      for (const c of children) {
        if (c.type !== 'file') continue;
        const sid = _repoSid(c.name);
        if (sid) ghRoms.push({ ...c, sid });
      }
    } else if (item.type === 'file') {
      const sid = _repoSid(item.name);
      if (sid) ghRoms.push({ ...item, sid });
    }
  }

  // GitHub release assets
  for (const rel of releases) {
    for (const asset of rel.assets || []) {
      const sid    = _repoSid(asset.name);
      const emuKey = Object.keys(_REPO_EMU_DIRS).find(k => asset.name.toLowerCase().includes(k));
      if (emuKey) {
        ghEmus.push({ kind: 'release', name: asset.name, size: asset.size,
                      dl: asset.browser_download_url, tag: rel.tag_name, info: _REPO_EMU_DIRS[emuKey] });
      } else if (sid) {
        ghRoms.push({ name: asset.name, size: asset.size,
                      download_url: asset.browser_download_url, sid, fromRelease: rel.tag_name });
      }
    }
  }

  return {
    localEmus: localData.emulators || [],
    localRoms: localData.roms      || [],
    ghRoms, ghEmus,
  };
}

async function _renderRepoList() {
  const list = document.getElementById('repo-list');
  if (!list) return;
  list.innerHTML = '<div class="repo-scanning">⟳ &nbsp;SCANNING...</div>';

  let data;
  try { data = await _repoGetAll(); }
  catch (e) {
    list.innerHTML = `<div class="repo-error">⚠ COULD NOT LOAD LIBRARY<br><span style="font-size:9px;opacity:0.5">${e.message}</span></div>`;
    return;
  }

  const { localEmus, localRoms, ghRoms, ghEmus } = data;
  let html = '';

  // ── INSTALLED EMULATORS ──────────────────────────────────────────────────
  if (localEmus.length) {
    html += `<div class="repo-section-label">🛠 &nbsp;INSTALLED EMULATORS</div>`;
    for (const e of localEmus) {
      const shortPath = e.path.replace(/.*[/\\](.+[/\\].+)$/, '…/$1');
      html += `
        <div class="repo-card">
          <div class="repo-card-icon">${e.icon}</div>
          <div class="repo-card-info">
            <div class="repo-card-name">${e.name}</div>
            <div class="repo-card-sys">${e.systems}</div>
            <div class="repo-card-tag" title="${escHtml(e.path)}">${escHtml(shortPath)}</div>
          </div>
          <span class="repo-card-btn repo-card-btn-installed">✓ INSTALLED</span>
        </div>`;
    }
  }

  // ── LOCAL ROM LIBRARY ────────────────────────────────────────────────────
  if (localRoms.length) {
    html += `<div class="repo-section-label">📁 &nbsp;LOCAL LIBRARY (${localRoms.length} ROMS)</div>`;
    for (const r of localRoms) {
      const sys = ALL_SYSTEMS?.find(s => s.id === r.systemId);
      const sysLabel = sys?.label || r.systemId.toUpperCase();
      const sizeLabel = r.sizeBytes > 0 ? _repoFmtSize(r.sizeBytes) : 'ON DISK';
      // Build a game-like object so launchNative can find it via find_rom
      const safeTitle = encodeURIComponent(r.title);
      const safeSid   = encodeURIComponent(r.systemId);
      html += `
        <div class="repo-card">
          <div class="repo-card-icon">🎮</div>
          <div class="repo-card-info">
            <div class="repo-card-name">${escHtml(r.title)}</div>
            <div class="repo-card-sys">${escHtml(sysLabel)}</div>
            <div class="repo-card-tag">${escHtml(sizeLabel)}</div>
          </div>
          <button class="repo-card-btn repo-card-btn-play"
            onclick="repoLaunchLocal(decodeURIComponent('${safeTitle}'),decodeURIComponent('${safeSid}'))">▶ PLAY</button>
        </div>`;
    }
  }

  // ── GITHUB — EMULATORS ───────────────────────────────────────────────────
  if (ghEmus.length) {
    html += `<div class="repo-section-label">☁ &nbsp;GITHUB EMULATORS</div>`;
    for (const e of ghEmus) {
      if (e.kind === 'folder') {
        html += `
          <div class="repo-card">
            <div class="repo-card-icon">${e.info.icon}</div>
            <div class="repo-card-info">
              <div class="repo-card-name">${e.info.name}</div>
              <div class="repo-card-sys">${e.info.systems}</div>
              <div class="repo-card-tag">FOLDER · NO RELEASE YET</div>
            </div>
            <a class="repo-card-btn repo-card-btn-dim" href="${KENTE_REPO_URL}/tree/main/${e.path}" target="_blank">BROWSE ↗</a>
          </div>`;
      } else {
        html += `
          <div class="repo-card">
            <div class="repo-card-icon">${e.info.icon}</div>
            <div class="repo-card-info">
              <div class="repo-card-name">${e.info.name}</div>
              <div class="repo-card-sys">${e.info.systems}</div>
              <div class="repo-card-tag">${e.tag || ''} · ${_repoFmtSize(e.size)}</div>
            </div>
            <a class="repo-card-btn" href="${e.dl}" download="${e.name}">↓ INSTALL</a>
          </div>`;
      }
    }
  }

  // ── GITHUB — ROMS ────────────────────────────────────────────────────────
  if (ghRoms.length) {
    html += `<div class="repo-section-label">☁ &nbsp;GITHUB ROMS & ISOS (${ghRoms.length})</div>`;
    for (const r of ghRoms) {
      const title = r.name.replace(/\.[^.]+$/, '');
      const safe  = encodeURIComponent(r.download_url);
      const safeN = encodeURIComponent(r.name);
      html += `
        <div class="repo-card">
          <div class="repo-card-icon">🎮</div>
          <div class="repo-card-info">
            <div class="repo-card-name">${title}</div>
            <div class="repo-card-sys">${(r.sid || '').toUpperCase()}</div>
            <div class="repo-card-tag">${r.fromRelease ? r.fromRelease + ' · ' : ''}${_repoFmtSize(r.size)}</div>
          </div>
          <button class="repo-card-btn"
            onclick="repoDownloadRom(decodeURIComponent('${safe}'),'${r.sid}',decodeURIComponent('${safeN}'))">↓ GET</button>
        </div>`;
    }
  }

  // ── NOTHING AT ALL ───────────────────────────────────────────────────────
  if (!html) {
    html = `
      <div class="repo-empty-state">
        <div class="repo-empty-icon">📦</div>
        <div class="repo-empty-title">LIBRARY EMPTY</div>
        <div class="repo-empty-sub">No ROMs found in roms/ and no emulators installed.<br>
          Add files to <a href="${KENTE_REPO_URL}" target="_blank" style="color:var(--brand)">n-13thehat/KentesKorner ↗</a></div>
      </div>`;
  }

  list.innerHTML = html;
}

function openKenteRepo() {
  KenteAudio.click();
  const overlay = document.getElementById('repo-overlay');
  if (!overlay) return;
  overlay.classList.add('active');
  _renderRepoList();
  document.getElementById('repo-close').onclick = () => {
    overlay.classList.remove('active');
    GamepadManager.resetFocus();
  };
  // Close if backdrop clicked
  overlay.onclick = e => { if (e.target === overlay) { overlay.classList.remove('active'); GamepadManager.resetFocus(); } };
}

function repoDownloadRom(url, sid, filename) {
  // Build a minimal game object — enough for DownloadManager to display and launch
  const title = filename.replace(/\.[^.]+$/, '');
  const sys   = ALL_SYSTEMS.find(s => s.id === sid);
  const game  = { title, systemId: sid, systemLabel: sys?.label || sid.toUpperCase(), img: null };

  DownloadManager.enqueue(game, url, filename);

  // Close repo panel, open Download Center so the user can watch progress
  document.getElementById('repo-overlay')?.classList.remove('active');
  openDownloadCenter();
}

function repoLaunchLocal(title, systemId) {
  // Launch a ROM from the LOCAL LIBRARY section of Kente's Repo panel.
  // Routes the same way as clicking the game in the room:
  //   • Browser-playable (CORE_MAP entry)  → launchWithEmulatorJS (in-window)
  //   • Native-only (no CORE_MAP entry)    → launchNative → Dolphin/PCSX2/etc.
  document.getElementById('repo-overlay')?.classList.remove('active');
  KenteAudio.click();

  const sys  = ALL_SYSTEMS?.find(s => s.id === systemId);
  const game = {
    id:       `local_${systemId}_${title.toLowerCase().replace(/\s+/g, '_')}`,
    title,
    systemId,
    system:   sys?.label || systemId.toUpperCase(),
    tier:     sys?.tier  || 3,
    img:      null,
  };

  // Re-use the same routing logic as launchGame so the experience is identical
  if (CORE_MAP[systemId]) {
    // Browser-playable — EmulatorJS iframe inside the app
    launchWithEmulatorJS(game);
  } else if (KENTE_SERVER_ONLINE) {
    // Native-only — find ROM on disk and open with installed emulator
    launchNative(game, true);
  } else {
    showNativeModeRequired(game);
  }
}

/* ══════════════════════════════════════════
   LAUNCH FROM DOWNLOAD CENTER
   Called when user clicks ▶ LAUNCH on a
   completed download card in the panel.
══════════════════════════════════════════ */
async function launchFromDownloadCenter(dlid) {
  const item = DownloadManager.getAll().find(i => i.id === dlid);
  if (!item || item.status !== 'complete') return;

  // Close the panel before launching
  document.getElementById('downloads-overlay').classList.remove('active');
  KenteAudio.click();
  // Theater audio collision — same hook as launchGame; this entry point
  // skips that path on several branches.
  _silenceTheaterForLaunch();

  const game = findGameForDownload(item.game.systemId, item.filename) || item.game;

  if (serverIsBatocera) {
    // On Batocera the file is in /userdata/roms/ — native launch works immediately
    launchNative(game, true);
    return;
  }

  if (CORE_MAP[game.systemId]) {
    // Browser-playable system — try RomDB handle, then OPFS, then stream from archive
    const handle = await RomDB.get(game.id).catch(() => null);
    if (handle) { launchWithEmulatorJS(game, handle); return; }

    if (navigator?.storage?.getDirectory) {
      try {
        const romsRoot   = await getOPFSLibrary();
        const sysDir     = await romsRoot.getDirectoryHandle(game.systemId, { create: false });
        const opfsHandle = await sysDir.getFileHandle(item.filename);
        await RomDB.set(game.id, opfsHandle, item.filename).catch(() => {});
        ROM_STATUS[game.id] = true;
        refreshGameCardDots();
        launchWithEmulatorJS(game, opfsHandle);
        return;
      } catch { /* fall through to archive stream */ }
    }

    if (item.archiveUrl) {
      showToast('📡 STREAMING FROM ARCHIVE.ORG...');
      launchWithEmulatorJS(game, item.archiveUrl,
        { url: item.archiveUrl, filename: item.filename, systemId: game.systemId });
      return;
    }

    launchGame(game);
    return;
  }

  // Native-only system on non-Batocera host.
  // The ROM was streamed through the server proxy and saved to roms/<system>/.
  // Use launchNative → /api/launch → find_rom() → native emulator (Dolphin, PCSX2, etc.)
  if (KENTE_SERVER_ONLINE) {
    launchNative(game, true);
  } else {
    showNativeModeRequired(game);
  }
}

/* ══════════════════════════════════════════
   FLASH GAMEPAD RELAY
   Polls gamepads in the parent page and forwards
   button + axis state to the Flash iframe via
   postMessage.  This covers the cross-origin case
   where navigator.getGamepads() is unavailable
   inside the iframe (e.g. localhost:7777 vs :5500).
   The Flash HTML pages share the same _prev map
   with their own poll loop, so there's no
   double-firing when both paths are active.
══════════════════════════════════════════ */
function _startFlashRelay(iframe) {
  _flashIframe = iframe;
  if (_flashRelayRaf) cancelAnimationFrame(_flashRelayRaf);

  // Resolve the iframe's actual origin once so we can target postMessage
  // explicitly instead of broadcasting with '*'. Falls back to the parent
  // origin for relative srcs (the common case under kente-server).
  let _flashOrigin;
  try { _flashOrigin = new URL(iframe.src || '', location.href).origin; }
  catch { _flashOrigin = location.origin; }

  function relay() {
    if (!_flashIframe) return;
    const pads = navigator.getGamepads?.() || [];
    for (let i = 0; i < Math.min(pads.length, 4); i++) {
      const gp = pads[i];
      if (!gp) continue;
      try {
        _flashIframe.contentWindow?.postMessage({
          type:     'kente-gamepad',
          padIndex: i,
          buttons:  gp.buttons.map(b => b.pressed),
          axes:     Array.from(gp.axes),
        }, _flashOrigin);
      } catch { /* cross-origin write-access blocked → silently skip */ }
    }
    _flashRelayRaf = requestAnimationFrame(relay);
  }
  _flashRelayRaf = requestAnimationFrame(relay);
}

function _stopFlashRelay() {
  if (_flashRelayRaf) { cancelAnimationFrame(_flashRelayRaf); _flashRelayRaf = null; }
  _flashIframe = null;
}

/* ══════════════════════════════════════════
   FLASH CONTROLS REFERENCE
   Shows the gamepad→key mapping for the current
   Flash game in the launch-overlay panel.
══════════════════════════════════════════ */
const FLASH_CTRL_LAYOUTS = {
  ssf1: {
    title: 'SUPER SMASH FLASH',
    p1: [
      ['South (A/✕)',   'Attack'],
      ['East  (B/○)',   'Jump'],
      ['West  (X/□)',   'Special'],
      ['North (Y/△)',   'Strong Attack'],
      ['LB / L1',       'Grab'],
      ['RB / R1',       'Taunt / Shield'],
      ['LT / L2',       'Shield'],
      ['PS / Home',     'Kente Menu'],
      ['D-Pad / L-Stick', 'Move'],
    ],
    p2: [
      ['South (A/✕)',   'Attack'],
      ['East  (B/○)',   'Jump'],
      ['West  (X/□)',   'Special'],
      ['North (Y/△)',   'Strong Attack'],
      ['LB / L1',       'Grab'],
      ['RB / R1',       'Taunt'],
      ['LT / L2',       'Shield'],
      ['PS / Home',     'Kente Menu'],
      ['D-Pad / L-Stick', 'Move'],
    ],
  },
  ssf2: {
    title: 'SUPER SMASH FLASH 2',
    p1: [
      ['South (A/✕)',   'Jump'],
      ['East  (B/○)',   'Attack'],
      ['West  (X/□)',   'Special'],
      ['North (Y/△)',   'Shield / Dodge'],
      ['LB / L1',       'Grab'],
      ['RB / R1',       'Taunt'],
      ['LT / L2',       'Shield (alt)'],
      ['RT / R2',       'Grab (alt)'],
      ['PS / Home',     'Kente Menu'],
      ['D-Pad / L-Stick', 'Move'],
    ],
    p2: [
      ['South (A/✕)',   'Jump'],
      ['East  (B/○)',   'Attack'],
      ['West  (X/□)',   'Special'],
      ['North (Y/△)',   'Shield'],
      ['LB / L1',       'Grab'],
      ['PS / Home',     'Kente Menu'],
      ['D-Pad / L-Stick', 'Move'],
    ],
    note: 'Remap freely in SSF2 → OPTIONS → CONTROLS',
  },
};

function showFlashControls(game) {
  const layout = FLASH_CTRL_LAYOUTS[game.id];
  const overlay = document.getElementById('launch-overlay');
  const con     = document.getElementById('launch-content');
  if (!overlay || !con) return;

  function col(rows) {
    return rows.map(([btn, action]) =>
      `<tr>
        <td style="padding:3px 14px 3px 0;color:var(--text-dim);white-space:nowrap">${btn}</td>
        <td style="padding:3px 0;color:var(--text-main)">${action}</td>
      </tr>`
    ).join('');
  }

  if (layout) {
    const hasP2 = layout.p2?.length > 0;
    con.innerHTML = `
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.15em;
                  max-height:80vh;overflow-y:auto;padding:4px">
        <div style="font-size:14px;letter-spacing:.2em;margin-bottom:18px;color:var(--brand)">
          🎮 ${layout.title} — CONTROLS
        </div>
        <div style="display:flex;gap:32px;flex-wrap:wrap;align-items:flex-start">
          <div>
            <div style="color:var(--text-dim);margin-bottom:8px;font-size:10px">PLAYER 1 · GAMEPAD 0</div>
            <table style="border-collapse:collapse">${col(layout.p1)}</table>
          </div>
          ${hasP2 ? `<div>
            <div style="color:var(--text-dim);margin-bottom:8px;font-size:10px">PLAYER 2 · GAMEPAD 1</div>
            <table style="border-collapse:collapse">${col(layout.p2)}</table>
          </div>` : ''}
        </div>
        ${layout.note ? `<div style="margin-top:16px;color:#888;font-size:10px">ℹ ${layout.note}</div>` : ''}
        <div style="margin-top:20px;color:#555;font-size:9px">
          CONTROLLER 1 = PLAYER 1 · CONTROLLER 2 = PLAYER 2<br>
          TOUCHPAD TAP = CLICK · DOUBLE-TAP = CURSOR MODE
        </div>
        <button class="launch-dismiss"
                style="margin-top:20px;padding:8px 24px;background:var(--brand);
                       color:#000;font-family:var(--font-mono);font-size:11px;
                       letter-spacing:.15em;border:none;cursor:pointer">
          ✕ CLOSE
        </button>
      </div>`;
  } else {
    // Generic layout for any other Flash game
    con.innerHTML = `
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.15em">
        <div style="font-size:13px;margin-bottom:16px;color:var(--brand)">🎮 FLASH CONTROLLER LAYOUT</div>
        <p style="color:var(--text-dim);line-height:1.8;margin-bottom:16px">
          Controller input is relayed to keyboard events automatically.<br>
          D-Pad / Left Stick → Arrow Keys<br>
          South (A/✕) → Enter / Confirm<br>
          East  (B/○) → Backspace / Back<br>
          PS / Home → Kente Menu<br><br>
          Use the Ruffle right-click menu inside the game to remap keys.
        </p>
        <button class="launch-dismiss"
                style="padding:8px 24px;background:var(--brand);color:#000;
                       font-family:var(--font-mono);font-size:11px;
                       letter-spacing:.15em;border:none;cursor:pointer">
          ✕ CLOSE
        </button>
      </div>`;
  }

  overlay.classList.add('active');
}

/* ══════════════════════════════════════════
   FLASH GAME LAUNCHER (Ruffle / iframe)
   Priority:  LOCAL  →  kente-server:7777/games/flash/<path>
              REMOTE →  game.flashUrl (web fallback)
   Reuses the emulator overlay. No ROM file needed.
══════════════════════════════════════════ */
async function launchFlashGame(game) {
  const overlay   = document.getElementById('emulator-overlay');
  const container = document.getElementById('ejs-container');

  // ── HUD ──
  document.getElementById('ejs-game-title').textContent   = game.title;
  document.getElementById('ejs-system-badge').textContent = 'FLASH';
  const cloudBadge = document.getElementById('ejs-cloud-badge');
  cloudBadge.hidden = false;
  document.getElementById('ejs-save-btn').hidden    = true;
  // Show a controls reference button — wired to showFlashControls()
  const _flashCtrlBtn = document.getElementById('ejs-ctrl-btn');
  if (_flashCtrlBtn) {
    _flashCtrlBtn.hidden  = false;
    _flashCtrlBtn.textContent = '🎮 CONTROLS';
    _flashCtrlBtn.onclick = () => showFlashControls(game);
  }

  // ── Wipe any previous emulator content ──
  container.innerHTML = '';
  container.style.position = 'relative';

  // ── Loading spinner ──
  const loader = document.createElement('div');
  loader.id = 'flash-loader';
  loader.style.cssText = [
    'position:absolute;inset:0;display:flex;flex-direction:column',
    'align-items:center;justify-content:center;gap:16px',
    'color:#555;font-family:var(--font-mono);font-size:12px',
    'letter-spacing:0.2em;background:#070810;z-index:2',
  ].join(';');
  loader.innerHTML = `
    <div style="width:36px;height:36px;border:2px solid #222;
                border-top-color:#e8a000;border-radius:50%;
                animation:spin 0.8s linear infinite"></div>
    <div>LOADING FLASH ENGINE...</div>
    <div style="font-size:9px;color:#444;margin-top:4px;letter-spacing:.15em">
      ${escHtml(game.title.toUpperCase())} · RUFFLE
    </div>`;
  container.appendChild(loader);

  overlay.classList.add('active');
  state.screen = 'playing';
  document.getElementById('ejs-exit').onclick = showIngameMenu;
  KenteAudio.powerUp();

  // ── Resolve: local kente-server first, web fallback ──
  // Local path: served by kente-server.py even in dev mode (always on :7777)
  let gameUrl = game.flashUrl;      // web fallback
  let isLocal = false;
  if (game.flashPath) {
    try {
      const probe = await fetch(`${KENTE_SERVER_URL}/${game.flashPath}`,
        { method: 'HEAD', signal: _abortTimeout(800) });
      if (probe.ok) {
        gameUrl  = `${KENTE_SERVER_URL}/${game.flashPath}`;
        isLocal  = true;
      }
    } catch { /* server not running — use web fallback */ }
  }

  cloudBadge.textContent = isLocal ? '⚡ LOCAL' : '⚡ WEB';
  if (!isLocal) showToast('ℹ RUN kente-server.py FOR LOCAL FLASH MODE');

  // ── Iframe ──
  const iframe = document.createElement('iframe');
  iframe.title = game.title;
  // 'gamepad' is required so Ruffle inside a cross-origin iframe
  // (localhost:7777 vs localhost:8080) can call navigator.getGamepads()
  iframe.allow = 'autoplay; fullscreen; clipboard-write; gamepad';
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  iframe.style.cssText = [
    'position:absolute;inset:0;width:100%;height:100%',
    'border:none;background:#000;opacity:0',
    'transition:opacity 0.5s ease;z-index:1',
  ].join(';');
  iframe.src = gameUrl;

  // Fade in once loaded, then grab keyboard focus so key input works immediately
  iframe.addEventListener('load', () => {
    iframe.style.opacity = '1';
    loader.style.opacity = '0';
    loader.style.transition = 'opacity 0.4s';
    setTimeout(() => loader.remove(), 420);
    // Focus the iframe so keyboard events route into it right away.
    // Works for same-origin (both on :7777); for cross-origin the
    // user's first click on the game area automatically gives focus.
    try { iframe.contentWindow?.focus(); } catch {}
    // Start parent-page gamepad relay so controllers work even in
    // cross-origin iframes where navigator.getGamepads() is blocked.
    // The relay forwards each pad index to the iframe's MAPS[gi] entry,
    // so up to 4 controllers auto-bind to P1..P4 keymaps.
    _startFlashRelay(iframe);
    const nPads = (typeof GamepadManager !== 'undefined') ? GamepadManager.liveCount() : 0;
    showToast(nPads >= 2
      ? `🎮 ${nPads} PLAYERS READY — CLICK GAME IF INPUT DOESN'T RESPOND`
      : '🎮 CONTROLLER READY — CLICK GAME IF INPUT DOESN\'T RESPOND');
  }, { once: true });

  // 12 s fallback — offer "OPEN IN NEW TAB" if embed is blocked or stalled
  const fallbackTimer = setTimeout(() => {
    if (!loader.isConnected) return;
    const webHref = escHtml(game.flashUrl);
    loader.innerHTML = `
      <div style="color:#888;margin-bottom:8px">
        ${isLocal ? 'LOCAL SERVER STALLED' : 'EMBED BLOCKED OR LOADING SLOWLY'}
      </div>
      <a href="${webHref}" target="_blank" rel="noopener"
         style="padding:10px 20px;background:var(--brand,#e8a000);color:#000;
                font-family:var(--font-mono);font-size:11px;letter-spacing:.15em;
                text-decoration:none">
        ⬡ OPEN IN NEW TAB
      </a>
      <div style="font-size:9px;color:#444;margin-top:8px">
        (THEN CLOSE THIS OVERLAY WITH ✕)
      </div>`;
  }, 12000);

  iframe.addEventListener('load', () => clearTimeout(fallbackTimer), { once: true });
  container.appendChild(iframe);
}

async function closeGame() {
  // Kill the currently running native emulator process or browser-based emulator
  GamepadManager.cancelTouchpadTimer();
  hideIngameMenu(/* skipStateReset */ true);

  try {
    const res = await fetch(`${KENTE_SERVER_URL}/api/kill`);
    const data = await res.json();
    if (data.success) {
      // Native process killed successfully
      console.log('[closeGame] Process terminated:', data.message);
    } else if (data.error !== 'No game is running') {
      console.warn('[closeGame] Failed to kill process:', data.error);
    }
  } catch (err) {
    console.warn('[closeGame] API call failed:', err);
  }

  // Clean up both browser-based and native emulator state
  // Stop the native app polling
  if (_nativeAppPoll) { clearInterval(_nativeAppPoll); _nativeAppPoll = null; }

  // Clean up browser-based emulator (EmulatorJS)
  try {
    if (window.EJS_emulator) {
      window.EJS_emulator.gameManager?.worker?.terminate?.();
      window.EJS_emulator.Module?.quit?.();
    }
  } catch (e) {
    console.warn('[closeGame] EJS cleanup warning:', e);
  }
  delete window.EJS_emulator;
  delete window.EJS_ready;
  delete window.EJS_onGameStart;

  // Remove EmulatorJS scripts
  document.getElementById('ejs-loader')?.remove();
  document.getElementById('flycast-webgl2-patch')?.remove();
  document.head.querySelectorAll('script[src*="emulatorjs.org"],link[href*="emulatorjs.org"]')
    .forEach(el => el.remove());

  // Clean up UI
  document.getElementById('ejs-container').innerHTML = '';
  document.getElementById('emulator-overlay').classList.remove('active');
  document.getElementById('ejs-cloud-badge').hidden = true;
  document.getElementById('ejs-save-btn').hidden    = true;
  document.getElementById('ejs-ctrl-btn').hidden    = true;

  // Revoke blob URLs
  if (_currentRomUrl?.startsWith('blob:'))  { URL.revokeObjectURL(_currentRomUrl); }
  if (_currentBiosUrl) { URL.revokeObjectURL(_currentBiosUrl); _currentBiosUrl = null; }
  _currentRomUrl = null;

  // Stop bridges and relays
  _stopEJSKeyBridge();
  _stopFlashRelay();

  // Clean EJS config globals
  ['EJS_player','EJS_core','EJS_gameUrl','EJS_gameName','EJS_pathtodata','EJS_startOnLoaded',
   'EJS_color','EJS_backgroundColor','EJS_biosUrl','EJS_Buttons']
    .forEach(k => delete window[k]);

  // Restore window and state
  window.electronAPI?.showWindow?.();
  window.electronAPI?.clearDiscordPresence?.();
  state.screen = 'room';
  KenteAudio.setHumVol(0.018);
}

function exitEmulator() {
  // Cancel any pending touchpad single-tap timer so it doesn't fire
  // openDownloadCenter() on a stale closure after the emulator takes over input.
  GamepadManager.cancelTouchpadTimer();

  // Always close the pause menu first, then reset state
  hideIngameMenu(/* skipStateReset */ true);

  // ── Terminate the old EmulatorJS instance ──
  // Without this, the old WebWorker + WebGL context stay alive and fight
  // the next EJS instance for the same #ejs-container → black screen.
  try {
    if (window.EJS_emulator) {
      window.EJS_emulator.gameManager?.worker?.terminate?.();
      window.EJS_emulator.Module?.quit?.();
    }
  } catch (e) {
    console.warn('[EJS] Cleanup warning:', e);
  }
  delete window.EJS_emulator;
  delete window.EJS_ready;
  delete window.EJS_onGameStart;

  // Remove the loader script so the next launch gets a clean execution
  document.getElementById('ejs-loader')?.remove();
  // Remove the Dreamcast WebGL2 patch script (no-op for non-Dreamcast sessions)
  document.getElementById('flycast-webgl2-patch')?.remove();
  // Remove sub-scripts loader.js injected (emulator.min.js, nipplejs, etc.)
  // so the next launch re-executes them fresh with no stale module state.
  document.head.querySelectorAll('script[src*="emulatorjs.org"],link[href*="emulatorjs.org"]')
    .forEach(el => el.remove());

  document.getElementById('ejs-container').innerHTML = '';
  document.getElementById('emulator-overlay').classList.remove('active');
  // Discord: browser-emulated game ended — go back to "Browsing"
  window.electronAPI?.clearDiscordPresence?.();
  document.getElementById('ejs-cloud-badge').hidden = true;
  document.getElementById('ejs-save-btn').hidden    = true;
  document.getElementById('ejs-ctrl-btn').hidden    = true;
  // Only revoke blob URLs — remote URLs must not be revoked
  if (_currentRomUrl?.startsWith('blob:'))  { URL.revokeObjectURL(_currentRomUrl); }
  if (_currentBiosUrl) { URL.revokeObjectURL(_currentBiosUrl); _currentBiosUrl = null; }
  _currentRomUrl = null;
  // Stop all bridges and polling before clearing state
  _stopEJSKeyBridge();
  _stopFlashRelay();                                         // no-op if a regular ROM was running
  if (_nativeAppPoll) { clearInterval(_nativeAppPoll); _nativeAppPoll = null; }

  // Clean EJS config globals
  ['EJS_player','EJS_core','EJS_gameUrl','EJS_gameName','EJS_pathtodata','EJS_startOnLoaded',
   'EJS_color','EJS_backgroundColor','EJS_biosUrl','EJS_Buttons']
    .forEach(k => delete window[k]);
  state.screen = 'room';
  KenteAudio.setHumVol(0.018);
}

/* ══════════════════════════════════════════
   EJS KEYBOARD BRIDGE
   Translates physical gamepad button presses
   into RetroArch default keyboard events and
   dispatches them to the EmulatorJS canvas.

   WHY THIS IS NEEDED:
   EmulatorJS relies on gamepadconnected events
   to discover connected controllers. When the
   user navigates to a game WITH their controller
   already plugged in, the browser fired that event
   before EJS's listener existed — EJS never learns
   about the pad and its gamepad loop never starts.

   Instead of fighting EJS's gamepad detection,
   we use the keyboard input path, which Emscripten
   always has active. RetroArch key binds are
   well-known constants; we map W3C button indices
   directly to those keys every animation frame.

   Button 16 (PS/Guide/Home) is intentionally excluded
   — it opens the Kente shell overlay instead of forwarding to the emulator.
   Button 9 (Start/Options) is forwarded as Enter (RetroArch default for Start).
══════════════════════════════════════════ */
let _ejsKbRaf  = null;       // rAF handle for the bridge loop
const _ejsKbPrev = {};       // previous pressed state per pad+button

// W3C standard gamepad button index → RetroArch default keyboard bind
//
// W3C layout:  0=South  1=East  2=West  3=North
// SNES names:  0=B      1=A     2=Y     3=X
// RA kbd:      B='z'    A='x'   Y='a'   X='s'
//
// RetroArch config.def.h: RETRO_DEF_JOYPAD_B=z, A=x, Y=a, X=s, L=q, R=w
//                          SELECT=rshift, START=return, UP/DOWN/LEFT/RIGHT=arrows
//
// Button 16 (PS/Guide/Home) is intentionally skipped here — it opens
// the Kente shell overlay instead of being forwarded to the emulator.
// Button 9 (Start/Options) is now correctly forwarded as Enter so games
// can use their own in-game pause/start without Kente intercepting it.
const _EJS_KEY_MAP = [
  { key: 'z',          code: 'KeyZ'        },  // 0: South (A/Cross/B)      → RA B  → z
  { key: 'x',          code: 'KeyX'        },  // 1: East  (B/Circle/A)     → RA A  → x
  { key: 'a',          code: 'KeyA'        },  // 2: West  (X/Square/Y)     → RA Y  → a
  { key: 's',          code: 'KeyS'        },  // 3: North (Y/Triangle/X)   → RA X  → s
  { key: 'q',          code: 'KeyQ'        },  // 4: L1                     → RA L  → q
  { key: 'w',          code: 'KeyW'        },  // 5: R1                     → RA R  → w
  null,                                         // 6: L2  (analog — skip)
  null,                                         // 7: R2  (analog — skip)
  { key: 'Shift',      code: 'ShiftRight'  },  // 8: Select/Share           → RA Select → RShift
  { key: 'Enter',      code: 'Enter'       },  // 9: Start/Options          → RA Start  → Enter
  null, null,                                   // 10, 11: L3, R3 (skip)
  { key: 'ArrowUp',    code: 'ArrowUp'     },  // 12: D-Up
  { key: 'ArrowDown',  code: 'ArrowDown'   },  // 13: D-Down
  { key: 'ArrowLeft',  code: 'ArrowLeft'   },  // 14: D-Left
  { key: 'ArrowRight', code: 'ArrowRight'  },  // 15: D-Right
  null,                                         // 16: PS/Guide/Home → Kente shell overlay (skip)
];

function _startEJSKeyBridge() {
  if (_ejsKbRaf) return;  // already running

  function frame() {
    if (state.screen !== 'playing') { _ejsKbRaf = null; return; }

    const pads = navigator.getGamepads() || [];
    for (const gp of pads) {
      if (!gp) continue;
      // P1 ONLY — RetroArch defaults map keyboard binds to player 1 only.
      // P2/P3/P4 are routed by EJS's native gamepad polling (gamepadconnected
      // events were re-dispatched at game start so EJS sees every pad). If we
      // also fired keyboard events for index>0, those pads would double-act
      // as P1 and clobber multiplayer.
      if (gp.index !== 0) continue;
      gp.buttons.forEach((btn, idx) => {
        const map = _EJS_KEY_MAP[idx];
        if (!map) return;

        const k   = `${gp.index}_${idx}`;
        const was = !!_ejsKbPrev[k];
        const now =   btn.pressed;
        if (now === was) return;
        _ejsKbPrev[k] = now;

        // Dispatch ONLY on document — Emscripten registers its keyboard handler there.
        // Do NOT also dispatch on the canvas with bubbles:true; that would cause the
        // event to bubble up to document a second time and fire the handler twice.
        const type = now ? 'keydown' : 'keyup';
        document.dispatchEvent(new KeyboardEvent(type, {
          key: map.key, code: map.code, bubbles: true, cancelable: true,
        }));
      });
    }
    _ejsKbRaf = requestAnimationFrame(frame);
  }

  _ejsKbRaf = requestAnimationFrame(frame);
}

function _stopEJSKeyBridge() {
  if (_ejsKbRaf) { cancelAnimationFrame(_ejsKbRaf); _ejsKbRaf = null; }
  // Release any keys still held down so they don't stick after exiting
  for (const k of Object.keys(_ejsKbPrev)) {
    if (!_ejsKbPrev[k]) continue;
    const btnIdx = Number(k.split('_')[1]);
    const map    = _EJS_KEY_MAP[btnIdx];
    if (!map) continue;
    document.dispatchEvent(new KeyboardEvent('keyup', {
      key: map.key, code: map.code, bubbles: true, cancelable: true,
    }));
  }
  for (const k in _ejsKbPrev) delete _ejsKbPrev[k];
}

/* ── IN-GAME PAUSE MENU ───────────────────────────────────────── */
let _igmFocus = 0;  // 0 = RESUME, 1 = CLOSE GAME, 2 = MAIN MENU

function updateIgmFocus() {
  document.querySelectorAll('.ingame-btn').forEach((btn, i) => {
    btn.classList.toggle('igm-focused', i === _igmFocus);
  });
}

function showIngameMenu() {
  const menu = document.getElementById('ingame-menu');
  if (!menu) return;
  // Populate the title from the HUD
  const title = document.getElementById('ejs-game-title')?.textContent || '';
  const titleEl = document.getElementById('igm-title');
  if (titleEl) titleEl.textContent = title;
  _igmFocus = 0;
  menu.classList.add('active');
  updateIgmFocus();
  state.screen = 'paused';
}

// skipStateReset = true when called from exitEmulator (we'll set state.screen = 'room' there)
function hideIngameMenu(skipStateReset) {
  const menu = document.getElementById('ingame-menu');
  if (!menu) return;
  menu.classList.remove('active');
  if (!skipStateReset) state.screen = 'playing';
}

/* ── SAVE CLOUD ROM TO LOCAL LIBRARY ──────────────────────── */
async function saveCloudRomToLibrary(game, cloudRomData) {
  if (!cloudRomData || !_currentRomUrl) return;
  const { url: archiveUrl, filename, systemId } = cloudRomData;

  const saveBtn    = document.getElementById('ejs-save-btn');
  const cloudBadge = document.getElementById('ejs-cloud-badge');
  saveBtn.textContent = '↓ SAVING...';
  saveBtn.disabled    = true;

  try {
    // ── Determine storage target ──
    const libEntry = await LibraryDB.getRoot();
    let rootHandle;
    if (libEntry?.handle) {
      const perm = await libEntry.handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('NO_PERMISSION');
      rootHandle = libEntry.handle;
    } else if (navigator?.storage?.getDirectory) {
      rootHandle = await getOPFSLibrary();
    } else {
      throw new Error('NO_LIBRARY');
    }

    // ── Write the in-memory blob to storage — no second network fetch ──
    // _currentRomUrl is a blob: URL already in RAM from the active playback session.
    const sysFolder  = await rootHandle.getDirectoryHandle(systemId, { create: true });
    const fileHandle = await sysFolder.getFileHandle(filename, { create: true });
    const writable   = await fileHandle.createWritable();
    const response   = await fetch(_currentRomUrl);   // instant: reads from blob cache
    const reader     = response.body.getReader();
    const total      = parseInt(response.headers.get('Content-Length') || '0');
    let received     = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.length;
      if (total) saveBtn.textContent = `↓ ${Math.round(received / total * 100)}%`;
    }
    await writable.close();

    // ── Index in RomDB + ROM_STATUS ──
    if (game.id) {
      await RomDB.set(game.id, fileHandle, filename);
      ROM_STATUS[game.id] = true;
      refreshGameCardDots();
    }

    // ── Add to DownloadDB (only if not already recorded for this file) ──
    const existing = await DownloadDB.getAll();
    const alreadyLogged = existing.some(d => d.filename === filename && d.systemId === systemId);
    if (!alreadyLogged) {
      await DownloadDB.add({
        id:           'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        filename,
        systemId,
        systemName:   game.system || systemId.toUpperCase(),
        archiveUrl,           // store the real archive URL, not the in-memory blob URL
        downloadedAt: Date.now(),
        sizeBytes:    received,
        storage:      libEntry?.handle ? 'library' : 'opfs',
      });
    }

    // ── Update UI ──
    saveBtn.textContent = '✓ IN LIBRARY';
    if (cloudBadge) cloudBadge.hidden = true;
    showToast(`✓ ${filename} SAVED TO LIBRARY`);

  } catch (err) {
    saveBtn.textContent = '↓ SAVE TO LIBRARY';
    saveBtn.disabled    = false;
    if (err.message === 'NO_PERMISSION') {
      showToast('⚠ LIBRARY PERMISSION DENIED — CHECK SOURCES');
    } else if (err.message === 'NO_LIBRARY') {
      showToast('⚠ SET UP A ROM LIBRARY FIRST — SOURCES → ROM LIBRARY');
    } else {
      showToast('⚠ SAVE FAILED — ' + (err.message || 'UNKNOWN ERROR').toUpperCase());
    }
  }
}

// DualSense / DualShock 4 detection — matches Chrome and Firefox USB/BT IDs
const DUALSENSE_RE = /dualsense|054c.*0ce6|0ce6.*054c/i;

/* ══════════════════════════════════════════
   GAMEPAD MANAGER
   Compatible with: PS4 DualShock 4, PS5 DualSense,
   Xbox One / Series X|S controllers, and any HID
   gamepad that exposes the W3C "standard" mapping.

   Handles shell navigation only — EmulatorJS
   manages its own gamepad input while a ROM runs.
══════════════════════════════════════════ */
const GamepadManager = (() => {

  /* Standard gamepad button indices (W3C spec) */
  const BTN = {
    SOUTH:0, EAST:1, WEST:2, NORTH:3,   // A/✕  B/○  X/□  Y/△
    LB:4,    RB:5,   LT:6,   RT:7,      // L1   R1   L2   R2
    SELECT:8, START:9, L3:10, R3:11,    // Share Options L3 R3
    DUP:12, DDOWN:13, DLEFT:14, DRIGHT:15,
    HOME:16,                             // PS / Guide / Home — Kente system button
  };

  const DEADZONE     = 0.40;  // ignore analog stick noise below this
  const FIRST_DELAY  = 380;   // ms before key-repeat starts
  const REPEAT_MS    = 110;   // ms between repeats while held

  /* DualSense touchpad double-tap state */
  let _dsLastTap       = 0;     // timestamp of last touchpad press
  let _dsSingleTapTimer = null; // pending single-tap → Download Center timer
  const DS_DTAP_MS = 450;       // window for double-tap recognition (ms)

  /* ── Wii Remote support ───────────────────────────────────────
     Wiimotes connected via Bluetooth report gamepad.mapping = ""
     (non-standard). Their raw button indices are completely different
     from the W3C standard layout used by PS4/PS5/Xbox controllers.

     Mapping works for:
       • Wii Remote alone  (vertical hold — A=confirm, B=back, D-pad=nav)
       • Wii Remote alone  (horizontal/sideways hold — 2=confirm, 1=back)
       • Wii Remote + Nunchuk (A=confirm, B=back, Nunchuk stick=nav)
       • Wii Classic Controller (typically maps as "standard" already)
       • Mayflash DolphinBar Mode 2 (maps as "standard" — no change needed)
  ── ─────────────────────────────────────────────────────────── */
  const WIIMOTE_RE  = /nintendo|rvl-cnt|wiimote/i;

  const WIIMOTE_BTN = {
    0:  BTN.SOUTH,   // 2 button        → Confirm (horizontal-hold right finger)
    1:  BTN.EAST,    // 1 button        → Back    (horizontal-hold left finger)
    2:  BTN.EAST,    // B trigger       → Back
    3:  BTN.SOUTH,   // A button        → Confirm
    4:  BTN.SELECT,  // − (minus)       → Back / Select
    5:  BTN.START,   // + (plus)        → Start
    6:  BTN.START,   // Home            → Start / back to room
    7:  BTN.DUP,     // D-pad Up
    8:  BTN.DDOWN,   // D-pad Down
    9:  BTN.DLEFT,   // D-pad Left
    10: BTN.DRIGHT,  // D-pad Right
    11: BTN.SOUTH,   // Nunchuk Z       → Confirm
    12: BTN.LB,      // Nunchuk C       → Previous / cycle
  };

  /** Returns a button-index translation map, or null for standard pads. */
  function getButtonMap(gp) {
    if (gp.mapping === 'standard')  return null;        // PS4 / PS5 / Xbox
    if (WIIMOTE_RE.test(gp.id))    return WIIMOTE_BTN; // Wii Remote (raw BT)
    return null;
  }

  /**
   * Returns [axisX, axisY] indices to use for analog stick navigation,
   * or null if the device should not use axis-based navigation.
   *
   * Wiimote axes 0-2 are the accelerometer (useless for menus).
   * Nunchuk stick lives on axes 3-4 when attached (buttons.length > 12).
   * Standard controllers use axes 0-1 (left stick).
   */
  function getStickAxes(gp) {
    if (WIIMOTE_RE.test(gp.id) && gp.mapping !== 'standard') {
      return gp.buttons.length > 12 ? [3, 4] : null; // nunchuk attached / not
    }
    return [0, 1]; // standard left stick
  }

  /* Active overlay layers in z-priority order.
     First selector that matches a visible element wins as the nav scope. */
  const LAYERS = [
    '#emulator-overlay.active',   // game running — only HUD navigable
    '#downloads-overlay.active',
    '#cloud-overlay.active',
    '#theater-detail-overlay.active',   // poster card → detail panel
    '#game-detail-panel.open',
    '.launch-overlay.active',
    '.menu-screen.active',
  ];

  /* Focusable elements (ordered by tab stop importance) */
  const FOCUSABLE = [
    '.filter-chip', '.game-card', '.source-card', '.profile-card',
    '.theater-poster', '.theater-hero-btn', '.theater-detail-btn',
    '.theater-detail-close',
    '.theater-eps-tab', '.theater-ep-row', '.tvp-btn', '.tvp-select',
    '.cloud-sys-chip', '.cloud-result-row', '.cloud-file-row',
    '.rom-option-btn', '.dl-play-btn', '.dl-del-btn', '.dl-cancel-btn',
    '.gdp-launch-btn', '.gdp-fav-btn', '.sdp-action-btn',
    '.menu-back-btn', '.launch-dismiss', '#ejs-exit', '#ejs-save-btn',
    '#cloud-close', '#cloud-play-now-btn', '#dl-close',
    '#rom-back', '#sdp-close',
  ].join(',');

  let _raf  = null;
  let _prev = {};   // previous state per button/axis key
  let _held = {};   // keys being held: { since, lastFire }
  let _idx  = -1;   // currently focused element index
  let _gpN  = 0;    // connected gamepad count
  let _anchorX = null; // sticky horizontal anchor for vertical navigation

  // ── Scope & focusables ───────────────────────────────────────
  function getScope() {
    for (const sel of LAYERS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null; // room level
  }

  function getFocusables() {
    const scope = getScope();
    if (!scope) return Array.from(document.querySelectorAll('.tv-zone'));
    return Array.from(scope.querySelectorAll(FOCUSABLE))
      .filter(el => el.offsetParent !== null && !el.hidden && !el.disabled);
  }

  // ── Visual focus ─────────────────────────────────────────────
  function clearFocus() {
    document.querySelectorAll('.gp-focus').forEach(el => el.classList.remove('gp-focus'));
  }

  function applyFocus(idx) {
    const items = getFocusables();
    if (!items.length) { _idx = -1; return; }
    _idx = Math.max(0, Math.min(items.length - 1, idx));
    clearFocus();
    const el = items[_idx];
    el.classList.add('gp-focus');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function resetFocus() { clearFocus(); _idx = -1; _anchorX = null; }

  // ── Theater row-snap helper ──────────────────────────────────
  // When traversing vertically across .theater-row containers,
  // snap to the poster in the next/previous visible row whose
  // horizontal centre is closest to the sticky anchor X.  Returns
  // the focusables-index of the chosen target, or -1 when no
  // suitable row exists.
  function _theaterRowSnap(items, curEl, dir, anchorX) {
    const curRow = curEl.closest('.theater-row');
    if (!curRow) return -1;
    const rowsHost = curRow.parentElement;
    if (!rowsHost) return -1;
    const allRows = Array.from(rowsHost.querySelectorAll(':scope > .theater-row'))
      .filter(r => r.style.display !== 'none' && r.offsetParent !== null);
    const idx  = allRows.indexOf(curRow);
    if (idx < 0) return -1;
    const next = allRows[idx + (dir === 'down' ? 1 : -1)];
    if (!next) return -1;
    const candidates = Array.from(next.querySelectorAll('.theater-poster'))
      .filter(el => el.offsetParent !== null);
    if (!candidates.length) return -1;
    let best = null, bestDx = Infinity;
    candidates.forEach(p => {
      const r  = p.getBoundingClientRect();
      const dx = Math.abs((r.left + r.width / 2) - anchorX);
      if (dx < bestDx) { bestDx = dx; best = p; }
    });
    return best ? items.indexOf(best) : -1;
  }

  // ── Grid-aware directional navigation ────────────────────────
  function navigate(dir) {
    const items = getFocusables();
    if (!items.length) return;

    // Room level: cycle TVs with d-pad
    if (!getScope()) {
      const delta = (dir === 'left' || dir === 'up') ? -1 : 1;
      state.focusIndex = ((state.focusIndex || 0) + delta + TV_ZONES.length) % TV_ZONES.length;
      focusZone(TV_ZONES[state.focusIndex]);
      return;
    }

    if (_idx < 0) { applyFocus(0); return; }

    // Horizontal — also re-arms the anchor X for subsequent vertical hops.
    if (dir === 'left' || dir === 'right') {
      applyFocus(_idx + (dir === 'left' ? -1 : 1));
      const f = items[_idx];
      if (f) {
        const r = f.getBoundingClientRect();
        _anchorX = r.left + r.width / 2;
      }
      return;
    }

    // Up/Down: find closest item in that direction using screen position
    const cur  = items[_idx];
    const cR   = cur.getBoundingClientRect();
    const cCX  = cR.left + cR.width  / 2;
    const cCY  = cR.top  + cR.height / 2;
    if (_anchorX == null) _anchorX = cCX;

    // Theater poster → row-snap to the closest poster in the adjacent row.
    if (cur.classList.contains('theater-poster')) {
      const snap = _theaterRowSnap(items, cur, dir, _anchorX);
      if (snap >= 0) { applyFocus(snap); return; }
      // Top of theater rows → bubble up to hero / toolbar; bottom is a no-op.
      if (dir === 'up') {
        const heroBtn = document.querySelector('.theater-hero-btn');
        const chip    = document.querySelector('.theater-toolbar .filter-chip.active')
                     || document.querySelector('.theater-toolbar .filter-chip');
        const target  = heroBtn || chip;
        const t = target ? items.indexOf(target) : -1;
        if (t >= 0) { applyFocus(t); return; }
      }
    }
    // Hero / toolbar going DOWN → first poster in first visible row.
    if (dir === 'down' && (cur.classList.contains('theater-hero-btn')
                        || cur.classList.contains('filter-chip'))) {
      const firstRow = Array.from(document.querySelectorAll('#theater-rows > .theater-row'))
        .find(r => r.style.display !== 'none' && r.offsetParent !== null);
      const first = firstRow?.querySelector('.theater-poster');
      const t = first ? items.indexOf(first) : -1;
      if (t >= 0) { applyFocus(t); return; }
    }

    let best = null, bestScore = Infinity;
    items.forEach((el, i) => {
      if (i === _idx) return;
      const r  = el.getBoundingClientRect();
      const dy = (r.top + r.height / 2) - cCY;
      if (dir === 'up'   && dy >= -4) return;
      if (dir === 'down' && dy <=  4) return;
      const dx    = Math.abs((r.left + r.width / 2) - _anchorX);
      const score = Math.abs(dy) + dx * 0.35;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best !== null) applyFocus(best);
  }

  // ── Confirm / Back ───────────────────────────────────────────
  function confirm() {
    // DualSense touchpad cursor — click element under the blue dot
    if (typeof DSPointer !== 'undefined' && DSPointer.active) {
      DSPointer.click(); return;
    }
    // Wii pointer — fire a real mouse-button sequence at the crosshair so
    // the player chrome (slider drags, video click-to-pause) reacts the
    // same as it does for a real mouse.
    if (typeof CameraManager !== 'undefined' && CameraManager.wiiActive) {
      if (CameraManager.clickAtPointer()) return;
    }

    if (!getScope()) {
      // Room: select focused TV
      const tv = TV_ZONES[state.focusIndex ?? 0];
      if (tv) selectTV(tv);
      return;
    }
    const items = getFocusables();
    if (_idx >= 0 && items[_idx]) items[_idx].click();
    else applyFocus(0);
  }

  function back() {
    const closeMap = [
      '#theater-detail-overlay.active #theater-detail-close',
      '#game-detail-panel.open #gdp-close',
      '#cloud-overlay.active #cloud-close',
      '#downloads-overlay.active #dl-close',
      '.launch-overlay.active #rom-back',
      '.launch-overlay.active .launch-dismiss',
    ];
    for (const sel of closeMap) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); resetFocus(); return; }
    }
    if (state.screen === 'menu') { closeMenu(); resetFocus(); }
  }

  // ── Button → action dispatch ─────────────────────────────────
  function dispatch(btnIdx) {

    // ── ON-SCREEN KEYBOARD: full input isolation ─────────────
    // When KenteOSK is open, every button drives the keyboard
    // grid — surrounding menu navigation must not fire.
    if (typeof KenteOSK !== 'undefined' && KenteOSK.active()) {
      switch (btnIdx) {
        case BTN.SOUTH:  KenteOSK.confirm();        break;
        case BTN.EAST:
        case BTN.SELECT:
        case BTN.START:  KenteOSK.close();          break;
        case BTN.WEST:   KenteOSK.backspace();      break;
        case BTN.NORTH:  KenteOSK.shift();          break;
        case BTN.DUP:    KenteOSK.navigate('up');    break;
        case BTN.DDOWN:  KenteOSK.navigate('down');  break;
        case BTN.DLEFT:  KenteOSK.navigate('left');  break;
        case BTN.DRIGHT: KenteOSK.navigate('right'); break;
        case BTN.LB:     KenteOSK.navigate('left');  break;
        case BTN.RB:     KenteOSK.navigate('right'); break;
      }
      return;
    }

    // ── IN-GAME: full input isolation ────────────────────────
    // When a game is running, block every OS action except the
    // PS/Guide/Home button (BTN.HOME), which opens the Kente
    // shell overlay.  All other buttons — including Start (9) —
    // are forwarded to the emulator via the EJS keyboard bridge
    // so games can use their own in-game menus without conflict.
    if (state.screen === 'playing') {
      if (btnIdx === BTN.HOME) showIngameMenu();
      return; // all other buttons are absorbed by the EJS bridge
    }

    // ── IN-GAME PAUSE MENU navigation ────────────────────────
    if (state.screen === 'paused') {
      const btns = [...document.querySelectorAll('.ingame-btn')];
      switch (btnIdx) {
        case BTN.DUP:
        case BTN.DLEFT:
          _igmFocus = (_igmFocus - 1 + btns.length) % btns.length;
          updateIgmFocus(); break;
        case BTN.DDOWN:
        case BTN.DRIGHT:
          _igmFocus = (_igmFocus + 1) % btns.length;
          updateIgmFocus(); break;
        case BTN.SOUTH:
          btns[_igmFocus]?.click(); break;
        case BTN.EAST:
        case BTN.HOME:   // PS button toggles the overlay closed again
        case BTN.START:  // Start also resumes — it can't reach the game while paused
          hideIngameMenu(); break;
      }
      return;
    }

    // ── THEATER PLAYER: in-flight playback ───────────────────
    // Keeps controller input scoped to the player; START / EAST / HOME open
    // the pause menu. Native <video> path also supports seek / volume on
    // the d-pad. Embed path uses LB / RB to cycle source hosts.
    if (state.screen === 'theater-playing') {
      const v = document.getElementById('theater-video');
      // Cursor mode short-circuit — when DSPointer or the Wii crosshair is
      // active, the A button acts as a real click at the cursor (so users
      // can hit ▶, CC, the source dropdown, etc.) instead of jumping to
      // the default pause / pause-menu action.
      if (btnIdx === BTN.SOUTH) {
        if (typeof DSPointer !== 'undefined' && DSPointer.active) {
          DSPointer.click(); return;
        }
        if (typeof CameraManager !== 'undefined' && CameraManager.wiiActive) {
          if (CameraManager.clickAtPointer()) return;
        }
      }
      switch (btnIdx) {
        case BTN.SOUTH:
          if (TheaterPlayer.embed) { showTheaterPauseMenu(); }
          else if (v) { v.paused ? v.play().catch(()=>{}) : v.pause(); }
          break;
        case BTN.EAST:
        case BTN.START:
        case BTN.HOME:
          showTheaterPauseMenu(); break;
        case BTN.DLEFT:
          if (!TheaterPlayer.embed && v) v.currentTime = Math.max(0, v.currentTime - 10);
          break;
        case BTN.DRIGHT:
          if (!TheaterPlayer.embed && v) v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
          break;
        case BTN.DUP:
          if (!TheaterPlayer.embed && v) v.volume = Math.min(1, v.volume + 0.05);
          break;
        case BTN.DDOWN:
          if (!TheaterPlayer.embed && v) v.volume = Math.max(0, v.volume - 0.05);
          break;
        case BTN.LB:
        case BTN.RB: {
          // Shows: LB = prev episode, RB = next episode (when not at the
          // boundary). Movies in embed mode keep LB/RB on source cycling
          // since there's no episode list to walk.
          const list = TheaterPlayer.epList || [];
          if (list.length) {
            _tvpJumpEpisode(btnIdx === BTN.LB ? -1 : +1);
          } else if (TheaterPlayer.embed) {
            _tpmCycleSource();
          }
          break;
        }
        case BTN.SELECT:
          // Toggle the on-screen controller-bindings card. Doesn't change
          // state.screen — playback + d-pad keep working underneath.
          _tvpToggleHelp(); break;
      }
      return;
    }

    // ── THEATER PAUSE MENU navigation ────────────────────────
    if (state.screen === 'theater-paused') {
      const btns = _tpmButtons();
      switch (btnIdx) {
        case BTN.DUP:
        case BTN.DLEFT:
          TheaterPlayer.pauseMenuFocus =
            (TheaterPlayer.pauseMenuFocus - 1 + btns.length) % btns.length;
          _tpmUpdateFocus(); break;
        case BTN.DDOWN:
        case BTN.DRIGHT:
          TheaterPlayer.pauseMenuFocus =
            (TheaterPlayer.pauseMenuFocus + 1) % btns.length;
          _tpmUpdateFocus(); break;
        case BTN.SOUTH:
          btns[TheaterPlayer.pauseMenuFocus]?.click(); break;
        case BTN.EAST:
        case BTN.HOME:
        case BTN.START:
          hideTheaterPauseMenu(); break;
      }
      return;
    }

    // ── Normal OS navigation ──────────────────────────────────
    switch (btnIdx) {
      case BTN.SOUTH:  confirm();             break;
      case BTN.EAST:
      case BTN.SELECT: back();               break;
      case BTN.LB:     navigate('left');     break;
      case BTN.RB:     navigate('right');    break;
      case BTN.START:
        // Advance the splash screen, or go back from any menu
        if (state.screen === 'splash') {
          document.getElementById('splash')?.click();
        } else if (state.screen === 'menu') {
          back();
        }
        break;
      case BTN.DUP:    navigate('up');       break;
      case BTN.DDOWN:  navigate('down');     break;
      case BTN.DLEFT:  navigate('left');     break;
      case BTN.DRIGHT: navigate('right');    break;
    }
  }

  // ── Poll loop ────────────────────────────────────────────────
  function poll() {
    const pads = navigator.getGamepads() || [];
    const now  = Date.now();

    for (const gp of pads) {
      if (!gp) continue;

      const btnMap   = getButtonMap(gp);   // null = standard, object = Wiimote
      const stickAx  = getStickAxes(gp);   // [xIdx, yIdx] or null (skip axes)

      // ── Buttons ──────────────────────────────────────────────
      gp.buttons.forEach((btn, i) => {
        const key   = `${gp.index}_b${i}`;
        const wasOn = _prev[key];
        const isOn  = btn.pressed;

        // Translate raw button index → standard BTN index for Wiimotes
        const logical = btnMap ? btnMap[i] : i;
        if (logical === undefined) { _prev[key] = isOn; return; } // unmapped

        if (isOn && !wasOn) {
          dispatch(logical);
          _held[key] = { since: now, lastFire: now };
        } else if (isOn && _held[key]) {
          const h = _held[key];
          if (now - h.since > FIRST_DELAY && now - h.lastFire > REPEAT_MS) {
            dispatch(logical);
            h.lastFire = now;
          }
        } else if (!isOn) { delete _held[key]; }

        _prev[key] = isOn;
      });

      // ── Analog stick (skipped for Wiimote without Nunchuk) ───
      // Also skipped while a game owns the controller ('playing') or while
      // the DualSense touchpad cursor is active (left stick drives the cursor instead).
      if (stickAx && state.screen !== 'playing' && !(typeof DSPointer !== 'undefined' && DSPointer.active)) {
        const ax  = gp.axes[stickAx[0]] || 0;
        const ay  = gp.axes[stickAx[1]] || 0;
        const dir = ay < -DEADZONE ? 'up'   : ay > DEADZONE ? 'down'
                  : ax < -DEADZONE ? 'left' : ax > DEADZONE ? 'right' : null;
        const sk  = `${gp.index}_s`;
        const was = _prev[sk];

        // Route stick through dispatch when pause menu is open
        const stickNavigate = (d) => {
          if (typeof KenteOSK !== 'undefined' && KenteOSK.active()) {
            KenteOSK.navigate(d);
          } else if (state.screen === 'paused' || state.screen === 'theater-paused') {
            dispatch(d === 'up' || d === 'left' ? BTN.DUP : BTN.DDOWN);
          } else if (state.screen === 'theater-playing') {
            // Map stick direction to seek / volume on the theater player.
            const map = { left: BTN.DLEFT, right: BTN.DRIGHT, up: BTN.DUP, down: BTN.DDOWN };
            dispatch(map[d]);
          } else {
            navigate(d);
          }
        };

        if (dir !== was) {
          if (dir) { stickNavigate(dir); _held[sk] = { since: now, lastFire: now }; }
          else     { delete _held[sk]; }
          _prev[sk] = dir;
        } else if (dir && _held[sk]) {
          const h = _held[sk];
          if (now - h.since > FIRST_DELAY && now - h.lastFire > REPEAT_MS) {
            stickNavigate(dir); h.lastFire = now;
          }
        }
      }

      // ── DualSense touchpad (button 17) ────────────────────────
      // Double-tap  → toggle cursor mode on/off
      // Single tap  (cursor active) → click element under cursor
      // Single tap  (cursor off)    → do nothing (wait for second tap)
      if (DUALSENSE_RE.test(gp.id) && gp.mapping === 'standard' && state.screen !== 'playing') {
        const tpBtn = gp.buttons[17];
        if (tpBtn) {
          const tpKey  = `${gp.index}_tp`;
          const wasTP  = !!_prev[tpKey];
          const isTP   = tpBtn.pressed;
          if (isTP && !wasTP) {
            const t2  = Date.now();
            const dbl = t2 - _dsLastTap < DS_DTAP_MS;
            _dsLastTap = dbl ? 0 : t2;   // reset so triple-tap doesn't re-toggle

            if (DSPointer.active) {
              // Cursor mode on: single-tap = click, double-tap = exit cursor
              dbl ? DSPointer.stop() : DSPointer.click();
            } else if (dbl) {
              // Double-tap while cursor off → cancel pending Download Center open, start cursor
              if (_dsSingleTapTimer) { clearTimeout(_dsSingleTapTimer); _dsSingleTapTimer = null; }
              DSPointer.start(gp);
            } else {
              // Single tap while cursor off → open Download Center after the double-tap window
              // (if a second tap arrives within DS_DTAP_MS the timer is cancelled above)
              _dsSingleTapTimer = setTimeout(() => {
                _dsSingleTapTimer = null;
                openDownloadCenter();
              }, DS_DTAP_MS);
            }
          }
          _prev[tpKey] = isTP;
        }
      }
    }
    _raf = requestAnimationFrame(poll);
  }

  // ── HUD indicator ────────────────────────────────────────────
  // Counts live pads from navigator.getGamepads() (most accurate — _gpN can
  // drift if connect/disconnect events fire out of order on Bluetooth pads).
  function _liveCount() {
    let n = 0;
    for (const gp of (navigator.getGamepads() || [])) if (gp?.connected) n++;
    return n;
  }
  function _updateBadge() {
    const el = document.getElementById('gp-indicator');
    if (!el) return;
    const n = _liveCount();
    _gpN = n;   // keep the cached counter in sync with reality
    el.hidden = (n === 0);
    const cnt = document.getElementById('gp-count');
    // Show "P1·P2" up to 4 pads, fall back to "×N" beyond that
    if (cnt) cnt.textContent = n <= 4
      ? Array.from({length:n}, (_,i) => `P${i+1}`).join('·')
      : `×${n}`;
  }

  // ── Connect / Disconnect ─────────────────────────────────────
  function onConnect(e) {
    if (!_raf) _raf = requestAnimationFrame(poll);
    const slot  = (e.gamepad?.index ?? 0) + 1;
    const label = (e.gamepad?.id || '').replace(/\(.*\)/g,'').trim().slice(0,40).toUpperCase()
                  || 'CONTROLLER';
    showToast(`🎮 PLAYER ${slot} READY — ${label}`);
    _updateBadge();
    // On first controller connection, auto-focus the current TV zone so the
    // user can navigate immediately without pressing a direction button first.
    if (_gpN === 1 && !getScope()) {
      state.focusIndex = state.focusIndex ?? 0;
      focusZone(TV_ZONES[state.focusIndex]);
    }
  }

  function onDisconnect(e) {
    const slot = (e?.gamepad?.index ?? 0) + 1;
    _updateBadge();
    if (_gpN === 0 && _raf) { cancelAnimationFrame(_raf); _raf = null; resetFocus(); }
    showToast(`🎮 PLAYER ${slot} DISCONNECTED`);
  }

  // ── Public API ───────────────────────────────────────────────
  function init() {
    window.addEventListener('gamepadconnected',    onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);
    // Pick up gamepads already connected before the page loaded
    _updateBadge();   // syncs _gpN from navigator.getGamepads()
    if (_gpN > 0) {
      _raf = requestAnimationFrame(poll);
      // Gamepad was already plugged in when the page loaded — apply focus
      // immediately so the controller is usable without a first-button press.
      // Use rAF to let the room DOM finish rendering before calling focusZone.
      requestAnimationFrame(() => {
        if (!getScope()) {
          state.focusIndex = state.focusIndex ?? 0;
          focusZone(TV_ZONES[state.focusIndex]);
        }
      });
    }
  }

  /** Live-pad accessor used by emulator launch flows that want to announce
   *  "N PLAYERS READY" without re-implementing the navigator probe. */
  function liveCount() { return _liveCount(); }

  /** Cancel any pending single-tap Download-Center timer.
   *  Call from exitEmulator() to prevent a stale timer firing after the
   *  emulator launches or the user navigates away. */
  function cancelTouchpadTimer() {
    if (_dsSingleTapTimer) {
      clearTimeout(_dsSingleTapTimer);
      _dsSingleTapTimer = null;
    }
  }

  return { init, resetFocus, applyFocus, navigate, confirm, cancelTouchpadTimer, liveCount };
})();

/* ══════════════════════════════════════════
   DUALSENSE TOUCHPAD CURSOR
   Double-tap the touchpad to toggle.
   Right stick → move cursor (velocity).
   Single tap  → click element under cursor.
   Double-tap again → exit cursor mode.
══════════════════════════════════════════ */
const DSPointer = (() => {
  const STICK_SPEED  = 0.012;  // cursor screen-fraction per frame at full left-stick
  const TP_SCALE     = 0.75;   // touchpad delta → cursor sensitivity
  const SCROLL_SPEED = 10;     // px per frame at full right-stick deflection
  const DEADZONE     = 0.14;   // inner dead zone (same for all inputs)

  let _active  = false;
  let _raf     = null;
  let _gpIndex = -1;
  let _x = 0.5, _y = 0.5;     // cursor position [0–1] screen fraction
  let _lastMoveX = -1;        // last screen-px X we dispatched mousemove at
  let _lastMoveY = -1;
  let _lastHover = null;      // last element we sent mouseover to

  // Touchpad swipe tracking (delta between frames, not absolute position)
  let _prevTpX = null;
  let _prevTpY = null;

  const _el = () => document.getElementById('ds-cursor');

  // ── Synthetic mouse helpers ──────────────────────────────────
  // Resolve the element under (px, py) without the cursor element
  // catching the hit-test.
  function _hitTest(px, py) {
    const cur = _el();
    if (cur) cur.style.pointerEvents = 'none';
    const el = document.elementFromPoint(px, py);
    if (cur) cur.style.pointerEvents = '';
    return el;
  }

  // Dispatch a real mousemove (+ pointermove + over/out as needed) at the
  // current cursor position so the player's idle handler, hover styling,
  // tooltips, and slider drags all respond as if a real mouse were used.
  function _dispatchMove() {
    const px = _x * window.innerWidth;
    const py = _y * window.innerHeight;
    if (Math.abs(px - _lastMoveX) < 1 && Math.abs(py - _lastMoveY) < 1) return;
    _lastMoveX = px; _lastMoveY = py;
    const target = _hitTest(px, py);
    if (!target) { _lastHover = null; return; }
    const opts = { bubbles: true, cancelable: true, view: window,
                   clientX: px, clientY: py, screenX: px, screenY: py,
                   button: 0, buttons: 0 };
    if (target !== _lastHover) {
      try { _lastHover?.dispatchEvent(new MouseEvent('mouseout', { ...opts, relatedTarget: target })); } catch {}
      try { _lastHover?.dispatchEvent(new PointerEvent('pointerout', { ...opts, pointerType: 'mouse', isPrimary: true, relatedTarget: target })); } catch {}
      try { target.dispatchEvent(new MouseEvent('mouseover', { ...opts, relatedTarget: _lastHover })); } catch {}
      try { target.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerType: 'mouse', isPrimary: true, relatedTarget: _lastHover })); } catch {}
      _lastHover = target;
    }
    try { target.dispatchEvent(new PointerEvent('pointermove', { ...opts, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mousemove', opts)); } catch {}
  }

  // ── Scroll helpers ────────────────────────────────────────────
  /**
   * Walk up the DOM from `el` and return the first element that can
   * actually scroll in either axis, or null if nothing scrollable is found.
   */
  function _findScrollable(el) {
    while (el && el !== document.documentElement) {
      const st = getComputedStyle(el);
      const oy = st.overflowY, ox = st.overflowX;
      const canScrollY = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1;
      const canScrollX = (ox === 'auto' || ox === 'scroll') && el.scrollWidth  > el.clientWidth  + 1;
      if (canScrollY || canScrollX) return el;
      el = el.parentElement;
    }
    // Final fallback: the document root (handles full-page overflow)
    const root = document.documentElement;
    return (root.scrollHeight > root.clientHeight || root.scrollWidth > root.clientWidth) ? root : null;
  }

  /**
   * Scroll the nearest scrollable element under the cursor by (dx, dy) px.
   * Shows the scroll indicator on the cursor element while active.
   */
  function _scrollAt(dx, dy) {
    const px = _x * window.innerWidth;
    const py = _y * window.innerHeight;
    const cursorEl = _el();

    if (cursorEl) cursorEl.style.pointerEvents = 'none';
    const hit = document.elementFromPoint(px, py);
    if (cursorEl) cursorEl.style.pointerEvents = '';

    const target = hit ? _findScrollable(hit) : null;
    if (target) {
      target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      // Show scroll indicator on the cursor
      cursorEl?.classList.add('scrolling');
    }
  }

  // ── Animation loop ────────────────────────────────────────────
  function _loop() {
    if (!_active) return;

    const pads = navigator.getGamepads() || [];
    const gp   = pads[_gpIndex] || [...pads].find(g => g && DUALSENSE_RE.test(g.id));
    const el   = _el();
    let isScrolling = false;

    if (gp) {
      // ── Left stick (axes 0, 1) → cursor velocity ────────────────
      const lx = Math.abs(gp.axes[0] || 0) > DEADZONE ? gp.axes[0] : 0;
      const ly = Math.abs(gp.axes[1] || 0) > DEADZONE ? gp.axes[1] : 0;
      _x = Math.max(0.01, Math.min(0.99, _x + lx * STICK_SPEED));
      _y = Math.max(0.01, Math.min(0.99, _y + ly * STICK_SPEED));

      // ── Right stick (axes 2, 3) → scroll element under cursor ───
      const rx = Math.abs(gp.axes[2] || 0) > DEADZONE ? gp.axes[2] : 0;
      const ry = Math.abs(gp.axes[3] || 0) > DEADZONE ? gp.axes[3] : 0;
      if (rx !== 0 || ry !== 0) {
        _scrollAt(rx * SCROLL_SPEED, ry * SCROLL_SPEED);
        isScrolling = true;
      }

      // ── Touchpad swipe (axes 4, 5) → cursor delta ───────────────
      // Chrome exposes the DualSense first touch-point as axes[4] (X) and
      // axes[5] (Y) on USB on Windows / all connections on macOS/Linux.
      // Delta-based so resting at the pad edge doesn't drift the cursor.
      if (gp.axes.length > 5) {
        const tpX = gp.axes[4];
        const tpY = gp.axes[5];
        if (_prevTpX !== null) {
          const dx = tpX - _prevTpX;
          const dy = tpY - _prevTpY;
          if (Math.abs(dx) > 0.004 || Math.abs(dy) > 0.004) {
            _x = Math.max(0.01, Math.min(0.99, _x + dx * TP_SCALE));
            _y = Math.max(0.01, Math.min(0.99, _y + dy * TP_SCALE));
          }
        }
        _prevTpX = tpX;
        _prevTpY = tpY;
      }
    }

    // Update cursor position
    if (el) {
      el.style.left = `${(_x * 100).toFixed(2)}%`;
      el.style.top  = `${(_y * 100).toFixed(2)}%`;
      // Toggle scroll indicator class — remove it one frame after scrolling stops
      if (!isScrolling) el.classList.remove('scrolling');
    }

    // Drive synthetic mouse events so the player chrome (and any other
    // hover-aware UI) reacts as if a real mouse were under the cursor.
    _dispatchMove();

    _raf = requestAnimationFrame(_loop);
  }

  // ── Public API ───────────────────────────────────────────────
  function start(gp) {
    if (_active) return;
    _active  = true;
    _gpIndex = gp?.index ?? -1;
    _x = 0.5; _y = 0.5;
    _prevTpX = null; _prevTpY = null;
    _lastMoveX = -1; _lastMoveY = -1; _lastHover = null;
    const el = _el();
    if (el) el.hidden = false;
    _raf = requestAnimationFrame(_loop);
    showToast('👆 CURSOR ON — L-STICK: MOVE · R-STICK: SCROLL · TAP: CLICK · DOUBLE-TAP: EXIT');
  }

  function stop() {
    _active  = false;
    _prevTpX = null; _prevTpY = null;
    if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    // Send a final mouseout to whatever was under the cursor so any hover
    // styling clears cleanly when cursor mode exits.
    if (_lastHover) {
      try { _lastHover.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, view: window })); } catch {}
      _lastHover = null;
    }
    const el = _el();
    if (el) { el.hidden = true; el.classList.remove('scrolling'); }
    showToast('👆 TOUCHPAD CURSOR OFF');
  }

  function toggle(gp) { _active ? stop() : start(gp); }

  function click() {
    const el = _el();
    const px = _x * window.innerWidth;
    const py = _y * window.innerHeight;
    const target = _hitTest(px, py);
    if (!target) return;

    // Full mouse-button pipeline so video click-to-pause, slider drags,
    // label-for inputs, focus management, and pointer-event listeners
    // all respond identically to a real mouse click.
    const opts = { bubbles: true, cancelable: true, view: window,
                   clientX: px, clientY: py, screenX: px, screenY: py,
                   button: 0, buttons: 1, detail: 1 };
    try { target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
    try { target.dispatchEvent(new PointerEvent('pointerup',   { ...opts, buttons: 0, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 })); } catch {}
    try { target.dispatchEvent(new MouseEvent('click',   { ...opts, buttons: 0 })); } catch {}

    if (el) {
      el.classList.add('clicking');
      setTimeout(() => el?.classList.remove('clicking'), 130);
    }
  }

  return {
    get active() { return _active; },
    start, stop, toggle, click,
  };
})();

/* ══════════════════════════════════════════
   CAMERA MANAGER
   Powers:
     • VR Parallax — optical-flow / FaceDetector head tracking
       drives CSS vars --vr-x / --vr-y on <html>
     • Wii Pointer  — Wiimote accelerometer tilt → on-screen crosshair
       (real IR-bar replacement is hardware; this is the software proxy)
══════════════════════════════════════════ */
const CameraManager = (() => {
  /* ── Config ── */
  const VR_STRENGTH   = 18;    // max px shift at full tilt/motion
  const VR_SMOOTH     = 0.07;  // lerp factor (lower = smoother / slower)
  const WII_SMOOTH    = 0.10;  // pointer lerp factor
  const MOTION_THRESH = 12;    // brightness delta to count as motion
  const SAMPLE_COLS   = 16;    // grid sampling for optical flow
  const SAMPLE_ROWS   = 12;

  /* ── State ── */
  let _stream    = null;   // MediaStream
  let _vrActive  = false;
  let _wiiActive = false;
  let _vrRaf     = null;
  let _wiiRaf    = null;
  let _prevPixels = null;  // Uint8Array — previous frame luminance
  let _vrX = 0, _vrY = 0; // smoothed parallax offsets
  let _ptrX = 0.5, _ptrY = 0.5; // smoothed Wii pointer [0-1]

  /* ── DOM refs ── */
  const _video  = () => document.getElementById('cam-feed');
  const _canvas = () => document.getElementById('cam-canvas');
  const _cursor = () => document.getElementById('wii-cursor');
  const _badge  = () => document.getElementById('cam-indicator');

  /* ── Camera access ── */
  async function _acquireCamera() {
    if (_stream) return true;
    try {
      _stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 80, height: 60 }, audio: false });
      _video().srcObject = _stream;
      await _video().play();
      return true;
    } catch (err) {
      showToast('⚠ CAMERA ACCESS DENIED — VR/WII POINTER DISABLED');
      return false;
    }
  }

  function _releaseCamera() {
    if (_vrActive || _wiiActive) return; // still needed by other mode
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  }

  /* ── Badge update ── */
  function _updateBadge() {
    const b = _badge();
    if (!b) return;
    const vrSpan  = document.getElementById('cam-indicator-vr');
    const wiiSpan = document.getElementById('cam-indicator-wii');
    if (vrSpan)  vrSpan.classList.toggle('active',  _vrActive);
    if (wiiSpan) wiiSpan.classList.toggle('active', _wiiActive);
    b.hidden = !_vrActive && !_wiiActive;
  }

  /* ══ VR PARALLAX ══════════════════════════════════════════════ */

  /* Apply current _vrX/_vrY to the root element CSS vars */
  function _applyParallax() {
    document.documentElement.style.setProperty('--vr-x', `${_vrX.toFixed(2)}px`);
    document.documentElement.style.setProperty('--vr-y', `${_vrY.toFixed(2)}px`);
  }

  /* Sample luminance from current video frame into Uint8Array */
  function _sampleFrame() {
    const cv  = _canvas();
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(_video(), 0, 0, cv.width, cv.height);
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    // collapse to single-channel luminance
    const luma = new Uint8Array(cv.width * cv.height);
    for (let i = 0; i < luma.length; i++) {
      luma[i] = (data[i*4]*77 + data[i*4+1]*150 + data[i*4+2]*29) >> 8;
    }
    return luma;
  }

  /* Compute motion vector from two luma frames using a coarse grid.
     Respects Kinect calibration zone to restrict sampling region.   */
  const _ZONES = {
    full:   [0,    0,    1,    1   ],
    center: [0.25, 0.25, 0.75, 0.75],
    left:   [0,    0,    0.5,  1   ],
    right:  [0.5,  0,    1,    1   ],
    upper:  [0,    0,    1,    0.5 ],
    lower:  [0,    0.5,  1,    1   ],
  };

  function _motionVector(prev, curr, w, h) {
    // Read Kinect zone from CalibrationManager if available
    const kinCal = (typeof CalibrationManager !== 'undefined') ? CalibrationManager.get('kinect') : null;
    const [zx0, zy0, zx1, zy1] = _ZONES[(kinCal && kinCal.zone) || 'full'] || _ZONES.full;
    const kinSens = kinCal ? (kinCal.sens || 1) : 1;

    let dx = 0, dy = 0, n = 0;

    for (let row = 0; row < SAMPLE_ROWS; row++) {
      for (let col = 0; col < SAMPLE_COLS; col++) {
        // Map grid cell to pixel coordinates within calibrated zone
        const relX = zx0 + (col / SAMPLE_COLS) * (zx1 - zx0);
        const relY = zy0 + (row / SAMPLE_ROWS) * (zy1 - zy0);
        const px  = Math.floor(relX * w);
        const py  = Math.floor(relY * h);
        const idx = py * w + px;
        if (Math.abs(curr[idx] - prev[idx]) > MOTION_THRESH) {
          // normalise position to [-1, 1] range
          dx += (px / w - 0.5) * 2;
          dy += (py / h - 0.5) * 2;
          n++;
        }
      }
    }
    if (n < 3) return { x: 0, y: 0 }; // too few motion points → ignore
    return { x: (dx / n) * kinSens, y: (dy / n) * kinSens };
  }

  function _vrLoop() {
    if (!_vrActive) return;
    const v = _video();
    if (v.readyState >= 2) {
      const curr = _sampleFrame();
      if (_prevPixels) {
        const cv  = _canvas();
        const { x, y } = _motionVector(_prevPixels, curr, cv.width, cv.height);
        // Allow Oculus / PSVR calibration to override VR_STRENGTH and VR_SMOOTH
        const xrCal   = (typeof CalibrationManager !== 'undefined')
          ? (CalibrationManager.get('oculus') || CalibrationManager.get('psvr'))
          : null;
        const strength = xrCal ? (xrCal.vrStrength ?? VR_STRENGTH) : VR_STRENGTH;
        const smooth   = xrCal ? (xrCal.vrSmooth   ?? VR_SMOOTH)   : VR_SMOOTH;
        const targetX = -x * strength;
        const targetY = -y * strength;
        _vrX += (targetX - _vrX) * smooth;
        _vrY += (targetY - _vrY) * smooth;
        // Decay toward zero when no motion is detected
        if (Math.abs(x) < 0.01 && Math.abs(y) < 0.01) {
          _vrX *= 0.95; _vrY *= 0.95;
        }
        _applyParallax();
      }
      _prevPixels = curr;
    }
    _vrRaf = requestAnimationFrame(_vrLoop);
  }

  async function startVR() {
    if (_vrActive) return;
    if (!await _acquireCamera()) return;
    _vrActive   = true;
    _prevPixels = null;
    _vrRaf      = requestAnimationFrame(_vrLoop);
    _updateBadge();
    showToast('👁 VR PARALLAX ACTIVE');
  }

  function stopVR() {
    _vrActive = false;
    if (_vrRaf) { cancelAnimationFrame(_vrRaf); _vrRaf = null; }
    _vrX = 0; _vrY = 0; _applyParallax();
    _releaseCamera();
    _updateBadge();
  }

  /* ══ WII POINTER ══════════════════════════════════════════════ */
  /* Uses Wiimote accelerometer axes (0=X tilt, 1=Y tilt) exposed
     through the Gamepad API — no IR sensor bar needed.
     The crosshair maps tilt angle to screen position.             */

  const WIIMOTE_RE = /nintendo.*wii|wiimote|rv-s702/i;
  const PSMOVE_RE  = /ps.*move|sony.*motion|motion.*control/i;

  /* Returns first connected Wiimote OR PS Move (both use tilt axes) */
  function _findWiimote() {
    for (const gp of (navigator.getGamepads() || [])) {
      if (gp && (WIIMOTE_RE.test(gp.id) || PSMOVE_RE.test(gp.id))) return gp;
    }
    return null;
  }

  /* Apply calibration curve: (raw - center) / range, clamped to ±1 */
  function _calibrateAxis(raw, center, range) {
    return Math.max(-1, Math.min(1, (raw - center) / Math.max(range, 0.05)));
  }

  /* Synthetic-mouse helpers — same pattern as DSPointer. Lets the Wii
     crosshair drive hover styling, idle reveal, slider drags, and click
     handlers in the player and the rest of the UI.                    */
  let _wiiLastMoveX = -1, _wiiLastMoveY = -1, _wiiLastHover = null;

  function _wiiHitTest(px, py) {
    const cur = _cursor();
    if (cur) cur.style.pointerEvents = 'none';
    const el = document.elementFromPoint(px, py);
    if (cur) cur.style.pointerEvents = '';
    return el;
  }

  function _wiiDispatchMove() {
    const px = _ptrX * window.innerWidth;
    const py = _ptrY * window.innerHeight;
    if (Math.abs(px - _wiiLastMoveX) < 1 && Math.abs(py - _wiiLastMoveY) < 1) return;
    _wiiLastMoveX = px; _wiiLastMoveY = py;
    const target = _wiiHitTest(px, py);
    if (!target) { _wiiLastHover = null; return; }
    const opts = { bubbles: true, cancelable: true, view: window,
                   clientX: px, clientY: py, screenX: px, screenY: py,
                   button: 0, buttons: 0 };
    if (target !== _wiiLastHover) {
      try { _wiiLastHover?.dispatchEvent(new MouseEvent('mouseout', { ...opts, relatedTarget: target })); } catch {}
      try { _wiiLastHover?.dispatchEvent(new PointerEvent('pointerout', { ...opts, pointerType: 'mouse', isPrimary: true, relatedTarget: target })); } catch {}
      try { target.dispatchEvent(new MouseEvent('mouseover', { ...opts, relatedTarget: _wiiLastHover })); } catch {}
      try { target.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerType: 'mouse', isPrimary: true, relatedTarget: _wiiLastHover })); } catch {}
      _wiiLastHover = target;
    }
    try { target.dispatchEvent(new PointerEvent('pointermove', { ...opts, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mousemove', opts)); } catch {}
  }

  function _wiiLoop() {
    if (!_wiiActive) return;
    const gp = _findWiimote();

    if (gp && gp.axes.length >= 2) {
      // Resolve calibration key (Wii or PS Move)
      const calKey = PSMOVE_RE.test(gp.id) ? 'psmove' : 'wii';
      const cal = (typeof CalibrationManager !== 'undefined')
        ? CalibrationManager.get(calKey)
        : { cx:0, cy:0, rx:1, ry:1, sens:1 };

      // Apply calibration: offset center, normalise to ±1, apply sensitivity
      const ax = _calibrateAxis(gp.axes[0], cal.cx ?? 0, cal.rx ?? 1) * (cal.sens ?? 1);
      const ay = _calibrateAxis(gp.axes[1], cal.cy ?? 0, cal.ry ?? 1) * (cal.sens ?? 1);

      // Map calibrated [-1,1] → [0,1] screen fraction, clamped
      const tx = Math.max(0, Math.min(1, (ax + 1) / 2));
      const ty = Math.max(0, Math.min(1, (ay + 1) / 2));
      _ptrX += (tx - _ptrX) * WII_SMOOTH;
      _ptrY += (ty - _ptrY) * WII_SMOOTH;
    } else {
      // Drift back to center when no controller is found
      _ptrX += (0.5 - _ptrX) * 0.03;
      _ptrY += (0.5 - _ptrY) * 0.03;
    }

    const cur = _cursor();
    if (cur) {
      cur.style.left = `${(_ptrX * 100).toFixed(2)}%`;
      cur.style.top  = `${(_ptrY * 100).toFixed(2)}%`;
    }
    _wiiDispatchMove();
    _wiiRaf = requestAnimationFrame(_wiiLoop);
  }

  function startWiiPointer() {
    if (_wiiActive) return;
    _wiiActive = true;
    _ptrX = 0.5; _ptrY = 0.5;
    _wiiLastMoveX = -1; _wiiLastMoveY = -1; _wiiLastHover = null;
    const cur = _cursor();
    if (cur) cur.hidden = false;
    _wiiRaf = requestAnimationFrame(_wiiLoop);
    _updateBadge();
    showToast('🎯 WII POINTER ACTIVE — TILT REMOTE TO AIM');
  }

  function stopWiiPointer() {
    _wiiActive = false;
    if (_wiiRaf) { cancelAnimationFrame(_wiiRaf); _wiiRaf = null; }
    if (_wiiLastHover) {
      try { _wiiLastHover.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, view: window })); } catch {}
      _wiiLastHover = null;
    }
    const cur = _cursor();
    if (cur) cur.hidden = true;
    _updateBadge();
  }

  /* Returns the element currently under the Wii crosshair, or null */
  function getPointerTarget() {
    if (!_wiiActive) return null;
    const x = _ptrX * window.innerWidth;
    const y = _ptrY * window.innerHeight;
    return _wiiHitTest(x, y);
  }

  /* Synthesise a real mouse-button click (mousedown→mouseup→click) at the
     current crosshair position. Mirrors DSPointer.click().               */
  function clickAtPointer() {
    if (!_wiiActive) return false;
    const px = _ptrX * window.innerWidth;
    const py = _ptrY * window.innerHeight;
    const target = _wiiHitTest(px, py);
    if (!target) return false;
    const opts = { bubbles: true, cancelable: true, view: window,
                   clientX: px, clientY: py, screenX: px, screenY: py,
                   button: 0, buttons: 1, detail: 1 };
    try { target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
    try { target.dispatchEvent(new PointerEvent('pointerup',   { ...opts, buttons: 0, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 })); } catch {}
    try { target.dispatchEvent(new MouseEvent('click',   { ...opts, buttons: 0 })); } catch {}
    return true;
  }

  return {
    startVR, stopVR,
    startWiiPointer, stopWiiPointer,
    getPointerTarget, clickAtPointer,
    get vrActive()  { return _vrActive;  },
    get wiiActive() { return _wiiActive; },
  };
})();

/* ══════════════════════════════════════════
   CALIBRATION MANAGER
   Supports: Wii Remote · PS Move · Oculus · PSVR · Xbox Kinect
   Calibration data persisted in localStorage.
══════════════════════════════════════════ */
const CalibrationManager = (() => {
  const STORE = 'kente_calibration';

  /* ── Device registry ── */
  const WIIMOTE_RE = /nintendo.*wii|wiimote|rv-s702/i;
  const PSMOVE_RE  = /ps.*move|sony.*motion|motion.*control/i;

  const DEVICES = [
    { key:'wii',    label:'WII REMOTE', icon:'🕹', type:'gamepad', re: WIIMOTE_RE },
    { key:'psmove', label:'PS MOVE',    icon:'🔵', type:'gamepad', re: PSMOVE_RE  },
    { key:'oculus', label:'OCULUS',     icon:'👓', type:'webxr'                   },
    { key:'psvr',   label:'PSVR',       icon:'🥽', type:'webxr'                   },
    { key:'kinect', label:'KINECT',     icon:'📷', type:'camera'                  },
  ];

  /* ── Defaults ── */
  const DEFAULTS = {
    wii:    { cx:0, cy:0, rx:1, ry:1, sens:1.0 },
    psmove: { cx:0, cy:0, rx:1, ry:1, sens:1.0 },
    oculus: { vrStrength:18, vrSmooth:0.07 },
    psvr:   { vrStrength:18, vrSmooth:0.07 },
    kinect: { zone:'full',   sens:1.0 },
  };

  /* ── Runtime state ── */
  let _data        = {};
  let _activeKey   = null;
  let _step        = 0;
  let _rafId       = null;
  let _capture     = {};   // temp during calibration
  let _rangeTimer  = null;

  /* ── Storage ── */
  function _load() {
    try { const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
      _data = {};
      for (const k of Object.keys(DEFAULTS)) _data[k] = { ...DEFAULTS[k], ...(raw[k] || {}) };
    } catch { _data = {}; for (const k of Object.keys(DEFAULTS)) _data[k] = { ...DEFAULTS[k] }; }
  }
  _load();

  function get(key)      { return _data[key] || { ...DEFAULTS[key] } || {}; }
  function save(key, d)  { _data[key] = { ...(_data[key]||{}), ...d }; try { localStorage.setItem(STORE, JSON.stringify(_data)); } catch {} }
  function reset(key)    { _data[key] = { ...DEFAULTS[key] };           try { localStorage.setItem(STORE, JSON.stringify(_data)); } catch {} }

  /* ── Find connected gamepad for a device def ── */
  function _findPad(def) {
    for (const gp of (navigator.getGamepads() || [])) {
      if (gp && def.re && def.re.test(gp.id)) return gp;
    }
    return null;
  }

  /* ── Live axis loop ── */
  function _stopLive() { if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; } }

  function _liveAxes(def) {
    _stopLive();
    function tick() {
      const gp = _findPad(def);
      if (!gp) return;
      ['x','y'].forEach((axis, i) => {
        const raw = gp.axes[i] || 0;
        const fill = document.getElementById(`cal-fill-${axis}`);
        const val  = document.getElementById(`cal-val-${axis}`);
        if (!fill || !val) return;
        // Track range during sweep
        if (_capture.sweeping) {
          _capture.minX = Math.min(_capture.minX ?? raw, raw);
          _capture.maxX = Math.max(_capture.maxX ?? raw, raw);
          if (i === 1) {
            _capture.minY = Math.min(_capture.minY ?? raw, raw);
            _capture.maxY = Math.max(_capture.maxY ?? raw, raw);
          }
        }
        // Render bar: center is 50%, raw ±1 maps to 0–100%
        const pct = (raw + 1) / 2 * 100;
        const cx  = 50;
        const left  = Math.min(pct, cx);
        const width = Math.abs(pct - cx);
        fill.style.left  = `${left}%`;
        fill.style.width = `${width}%`;
        val.textContent  = raw.toFixed(3);
      });
      _rafId = requestAnimationFrame(tick);
    }
    _rafId = requestAnimationFrame(tick);
  }

  /* ── Axis meter HTML helper ── */
  function _axisMeters() {
    return ['X','Y'].map(a => `
      <div class="cal-axis-row">
        <span class="cal-axis-lbl">${a}</span>
        <div class="cal-axis-track">
          <div class="cal-axis-center-mark"></div>
          <div class="cal-axis-fill" id="cal-fill-${a.toLowerCase()}"></div>
        </div>
        <span class="cal-axis-val" id="cal-val-${a.toLowerCase()}">0.000</span>
      </div>`).join('');
  }

  /* ══ WIZARD RENDERERS ══════════════════════════════════════════ */

  function _renderGamepad(def) {
    const wiz   = document.getElementById('cal-wizard');
    const cal   = get(def.key);
    const gp    = _findPad(def);
    const found = !!gp;

    if (!found) {
      wiz.innerHTML = `
        <div class="cal-status err">NO ${def.label} DETECTED — CONNECT DEVICE AND REOPEN CALIBRATION</div>
        <p class="cal-instruction">Make sure the controller is paired via Bluetooth or USB,<br>
        then click the device chip above again.</p>`;
      return;
    }

    if (_step === 0) {
      wiz.innerHTML = `
        <div class="cal-step-label">STEP 1 OF 3</div>
        <div class="cal-step-title">NEUTRAL POSITION</div>
        <p class="cal-instruction">Hold the ${def.label} flat and still, pointed at the screen.<br>
        Press <strong>CAPTURE NEUTRAL</strong> to record the zero point.</p>
        ${_axisMeters()}
        <div class="cal-step-nav">
          <button class="cal-btn" id="cal-capture-neutral">CAPTURE NEUTRAL</button>
          <button class="cal-btn sec" id="cal-skip-neutral">SKIP</button>
        </div>`;
      _liveAxes(def);
      document.getElementById('cal-capture-neutral').onclick = () => {
        const g = _findPad(def);
        if (!g) return;
        save(def.key, { cx: g.axes[0] || 0, cy: g.axes[1] || 0 });
        showToast(`✓ NEUTRAL CAPTURED (${(g.axes[0]||0).toFixed(3)}, ${(g.axes[1]||0).toFixed(3)})`);
        _step = 1; _stopLive(); _renderGamepad(def);
      };
      document.getElementById('cal-skip-neutral').onclick = () => { _step = 1; _stopLive(); _renderGamepad(def); };

    } else if (_step === 1) {
      _capture = { sweeping: false };
      wiz.innerHTML = `
        <div class="cal-step-label">STEP 2 OF 3</div>
        <div class="cal-step-title">RANGE SWEEP</div>
        <p class="cal-instruction">Click <strong>START SWEEP</strong> then slowly tilt the ${def.label}<br>
        to the edges of your comfortable movement range. You have 4 seconds.</p>
        ${_axisMeters()}
        <div id="cal-sweep-countdown"></div>
        <div class="cal-range-note" id="cal-range-result"></div>
        <div class="cal-step-nav">
          <button class="cal-btn" id="cal-start-sweep">START SWEEP</button>
          <button class="cal-btn sec" id="cal-skip-range">SKIP</button>
        </div>`;
      _liveAxes(def);
      document.getElementById('cal-start-sweep').onclick = () => {
        _capture = { sweeping: true, minX:0, maxX:0, minY:0, maxY:0 };
        let secs = 4;
        const countdown = document.getElementById('cal-sweep-countdown');
        const btn = document.getElementById('cal-start-sweep');
        if (btn) btn.disabled = true;
        const tick = setInterval(() => {
          secs--;
          if (countdown) countdown.innerHTML = `<div class="cal-countdown">${secs}</div>`;
          if (secs <= 0) {
            clearInterval(tick);
            _capture.sweeping = false;
            const rx = Math.max(0.1, Math.max(Math.abs(_capture.maxX), Math.abs(_capture.minX)));
            const ry = Math.max(0.1, Math.max(Math.abs(_capture.maxY), Math.abs(_capture.minY)));
            save(def.key, { rx, ry });
            const note = document.getElementById('cal-range-result');
            if (note) note.innerHTML = `✓ RANGE SAVED — X: ±${rx.toFixed(3)}  Y: ±${ry.toFixed(3)}`;
            if (countdown) countdown.innerHTML = '';
          }
        }, 1000);
      };
      document.getElementById('cal-skip-range').onclick = () => { _step = 2; _stopLive(); _renderGamepad(def); };

    } else {
      _stopLive();
      const cur = get(def.key);
      wiz.innerHTML = `
        <div class="cal-step-label">STEP 3 OF 3</div>
        <div class="cal-step-title">SENSITIVITY</div>
        <p class="cal-instruction">Adjust pointer sensitivity. 1.0 = normal · 0.5 = slow · 2.0 = fast</p>
        <div class="cal-slider-row">
          <span class="cal-axis-lbl">SENS</span>
          <input type="range" id="cal-sens-slider" min="0.3" max="2.5" step="0.05" value="${cur.sens || 1.0}">
          <span class="cal-slider-val" id="cal-sens-val">${(cur.sens||1.0).toFixed(2)}×</span>
        </div>
        <div class="cal-status ok">✓ CALIBRATION COMPLETE — ${def.label}</div>
        <div class="cal-step-nav">
          <button class="cal-btn" id="cal-save-done">SAVE &amp; CLOSE</button>
          <button class="cal-btn danger" id="cal-reset">RESET TO DEFAULT</button>
        </div>`;
      document.getElementById('cal-sens-slider').oninput = e => {
        const v = parseFloat(e.target.value);
        document.getElementById('cal-sens-val').textContent = `${v.toFixed(2)}×`;
        save(def.key, { sens: v });
      };
      document.getElementById('cal-save-done').onclick = () => close();
      document.getElementById('cal-reset').onclick = () => {
        reset(def.key); _step = 0; _renderGamepad(def);
        showToast(`↺ ${def.label} CALIBRATION RESET`);
      };
    }
  }

  function _renderWebXR(def) {
    const wiz = document.getElementById('cal-wizard');
    const cal = get(def.key);
    const xrOk = 'xr' in navigator;

    let statusHtml, xrNote;
    if (!xrOk) {
      statusHtml = `<div class="cal-status err">WEBXR NOT AVAILABLE — USE A COMPATIBLE BROWSER (Chrome/Edge + headset driver)</div>`;
      xrNote = '';
    } else {
      statusHtml = `<div class="cal-status ok">✓ WEBXR API DETECTED</div>`;
      xrNote = `<p class="cal-instruction">Click <strong>CHECK HEADSET</strong> to probe ${def.label} connection.<br>
      When wearing the headset and looking straight ahead, click <strong>RESET CENTER</strong>.</p>`;
    }

    wiz.innerHTML = `
      <div class="cal-step-label">${def.label} — VR PARALLAX CALIBRATION</div>
      ${statusHtml}${xrNote}
      <p class="cal-instruction">Parallax Strength controls how much the room shifts with head movement.<br>
      Higher = more dramatic. Smooth controls follow speed.</p>
      <div class="cal-slider-row">
        <span class="cal-axis-lbl" style="width:60px;font-size:8px">STRENGTH</span>
        <input type="range" id="cal-xr-strength" min="4" max="40" step="1" value="${cal.vrStrength ?? 18}">
        <span class="cal-slider-val" id="cal-xr-str-val">${cal.vrStrength ?? 18}px</span>
      </div>
      <div class="cal-slider-row">
        <span class="cal-axis-lbl" style="width:60px;font-size:8px">SMOOTH</span>
        <input type="range" id="cal-xr-smooth" min="0.02" max="0.25" step="0.01" value="${cal.vrSmooth ?? 0.07}">
        <span class="cal-slider-val" id="cal-xr-smo-val">${(cal.vrSmooth ?? 0.07).toFixed(2)}</span>
      </div>
      <div class="cal-step-nav">
        ${xrOk ? `<button class="cal-btn sec" id="cal-xr-check">CHECK HEADSET</button>
        <button class="cal-btn" id="cal-xr-center">RESET CENTER</button>` : ''}
        <button class="cal-btn" id="cal-xr-save">SAVE &amp; CLOSE</button>
        <button class="cal-btn danger" id="cal-xr-reset">RESET DEFAULT</button>
      </div>
      <div id="cal-xr-status" class="cal-range-note"></div>`;

    document.getElementById('cal-xr-strength').oninput = e => {
      const v = parseInt(e.target.value);
      document.getElementById('cal-xr-str-val').textContent = `${v}px`;
      save(def.key, { vrStrength: v });
    };
    document.getElementById('cal-xr-smooth').oninput = e => {
      const v = parseFloat(e.target.value);
      document.getElementById('cal-xr-smo-val').textContent = v.toFixed(2);
      save(def.key, { vrSmooth: v });
    };
    if (xrOk) {
      document.getElementById('cal-xr-check').onclick = async () => {
        const st = document.getElementById('cal-xr-status');
        try {
          const ok = await navigator.xr.isSessionSupported('immersive-vr');
          if (st) st.innerHTML = ok
            ? '<span style="color:var(--green)">✓ HEADSET READY FOR IMMERSIVE VR</span>'
            : '<span style="color:var(--brand)">⚠ HEADSET NOT IN IMMERSIVE VR MODE — PUT ON HEADSET</span>';
        } catch { if (st) st.innerHTML = '<span style="color:var(--red)">✕ XR CHECK FAILED</span>'; }
      };
      document.getElementById('cal-xr-center').onclick = () => {
        save(def.key, { recalibrated: true });
        showToast(`✓ ${def.label} CENTER LOCKED`);
        const st = document.getElementById('cal-xr-status');
        if (st) st.innerHTML = '<span style="color:var(--green)">✓ CENTER POSITION SAVED</span>';
      };
    }
    document.getElementById('cal-xr-save').onclick  = () => close();
    document.getElementById('cal-xr-reset').onclick = () => { reset(def.key); _renderWebXR(def); showToast(`↺ ${def.label} RESET`); };
  }

  function _renderKinect(def) {
    const wiz  = document.getElementById('cal-wizard');
    const cal  = get(def.key);
    const ZONES = [
      { key:'full',   label:'FULL FRAME'  },
      { key:'center', label:'CENTER ZONE' },
      { key:'left',   label:'LEFT HALF'   },
      { key:'right',  label:'RIGHT HALF'  },
      { key:'upper',  label:'UPPER HALF'  },
      { key:'lower',  label:'LOWER HALF'  },
    ];
    const zoneGrid = ZONES.map(z =>
      `<button class="cal-zone-btn${cal.zone === z.key ? ' active':''}" data-zone="${z.key}">${z.label}</button>`
    ).join('');

    wiz.innerHTML = `
      <div class="cal-step-label">KINECT / DEPTH CAMERA — MOTION ZONE CALIBRATION</div>
      <div class="cal-status warn">⚠ KINECT DEPTH STREAM NOT ACCESSIBLE IN BROWSER — USING RGB CAMERA MODE</div>
      <p class="cal-instruction">Kinect is used as a standard webcam for VR Parallax motion detection.<br>
      Select which region of the camera frame to track. CENTER ZONE reduces false triggers from background motion.</p>
      <div class="cal-zone-grid">${zoneGrid}</div>
      <p class="cal-instruction" style="margin-top:12px">Motion Sensitivity — lower to reduce jitter from ambient movement.</p>
      <div class="cal-slider-row">
        <span class="cal-axis-lbl" style="width:40px;font-size:8px">SENS</span>
        <input type="range" id="cal-kinect-sens" min="0.3" max="2.0" step="0.05" value="${cal.sens ?? 1.0}">
        <span class="cal-slider-val" id="cal-kinect-sens-val">${(cal.sens??1.0).toFixed(2)}×</span>
      </div>
      <div class="cal-step-nav">
        <button class="cal-btn" id="cal-kinect-save">SAVE &amp; CLOSE</button>
        <button class="cal-btn danger" id="cal-kinect-reset">RESET DEFAULT</button>
      </div>`;

    wiz.querySelectorAll('.cal-zone-btn').forEach(btn => {
      btn.onclick = () => {
        wiz.querySelectorAll('.cal-zone-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        save('kinect', { zone: btn.dataset.zone });
      };
    });
    document.getElementById('cal-kinect-sens').oninput = e => {
      const v = parseFloat(e.target.value);
      document.getElementById('cal-kinect-sens-val').textContent = `${v.toFixed(2)}×`;
      save('kinect', { sens: v });
    };
    document.getElementById('cal-kinect-save').onclick  = () => close();
    document.getElementById('cal-kinect-reset').onclick = () => { reset('kinect'); _renderKinect(def); showToast('↺ KINECT CALIBRATION RESET'); };
  }

  /* ── Render dispatcher ── */
  function _renderWizard(key) {
    _stopLive();
    _step = 0;
    _activeKey = key;
    const def = DEVICES.find(d => d.key === key);
    if (!def) return;
    // Highlight device chip
    document.querySelectorAll('.cal-dev-btn').forEach(b => b.classList.toggle('active', b.dataset.key === key));
    if (def.type === 'gamepad') _renderGamepad(def);
    else if (def.type === 'webxr')  _renderWebXR(def);
    else                            _renderKinect(def);
  }

  /* ── Public open / close ── */
  function open(deviceKey) {
    const overlay = document.getElementById('calibration-overlay');
    const devs    = document.getElementById('cal-devices');
    if (!overlay || !devs) return;

    devs.innerHTML = DEVICES.map(d =>
      `<button class="cal-dev-btn${d.key === (deviceKey||DEVICES[0].key) ? ' active':''}" data-key="${d.key}">${d.icon} ${d.label}</button>`
    ).join('');

    devs.querySelectorAll('.cal-dev-btn').forEach(btn => {
      btn.onclick = () => _renderWizard(btn.dataset.key);
    });

    document.getElementById('cal-close').onclick = close;
    overlay.classList.add('active');
    _renderWizard(deviceKey || DEVICES[0].key);
  }

  function close() {
    _stopLive();
    const overlay = document.getElementById('calibration-overlay');
    if (overlay) overlay.classList.remove('active');
    _activeKey = null;
  }

  return { open, close, get, save, reset };
})();

/* ══════════════════════════════════════════
   THEATER VIDEO PLAYER — HLS + custom CRT chrome
══════════════════════════════════════════ */
const TheaterPlayer = {
  hls: null,
  payload: null,    // { streams:{q:url}, qualities:[...] }
  ctx: null,        // canonical item used by TheaterDB.saveProgress
  resumeAt: 0,      // seconds — applied on next MANIFEST_PARSED / loadedmetadata
  resumed:  false,  // becomes true once we've seeked to the resume position
  saveTimer: 0,     // last persist time (epoch ms) — throttles timeupdate writes
  idleTimer: null,
  bound: false,
  embed: false,         // true while iframe player is active
  activeSource: null,   // current embed host key (vidsrc, 2embed, ...)
  prevScreen: null,     // state.screen before player opened — restored on close
  wakeLock: null,       // Screen Wake Lock sentinel — keeps display on while playing
  pauseMenuFocus: 0,    // 0 = RESUME, 1 = NEXT SOURCE, 2 = CLOSE
  embedSources: [],     // current source[] list — drives the pill row + watchdog
  watchdog: null,       // setTimeout handle — auto-advance when no load fires
  loadGen: 0,           // increments per src= write; load handler ignores stale frames
  miniplayer: false,    // true while the floating corner widget is engaged
  ccTracks: [],         // [{lang,label,url}] — currently mounted CC tracks
  ccIndex: -1,          // -1 = off, 0..N-1 = active textTrack index
  epList: [],           // flat episode list for shows ({id,season,number,title})
  epIndex: -1,          // current index in epList; -1 = movie or unknown
  playbackRate: 1,      // current speed; preserved across quality switches
  speedIdx: 2,          // index into _TVP_SPEEDS — kept in sync with playbackRate
  helpOpen: false,      // SELECT-toggled help overlay visibility
  // Up Next countdown state — reset on every episode change / close.
  // visible:   card currently shown on screen
  // dismissed: user clicked CANCEL on the current episode (suppress until next)
  // forEpIdx:  the epIndex the card was last shown for (so dismiss + cancel
  //            scope to one episode)
  upNext: { visible: false, dismissed: false, forEpIdx: -1, fired: false },
};

// Speed-control rungs for the ⏵ button. Index 2 = 1× (default).
const _TVP_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
function _tvpFmtSpeed(r) {
  // 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2× — strip trailing zero on whole numbers.
  return (r % 1 === 0 ? String(r) : String(r)) + '×';
}
function _tvpApplySpeed(rate) {
  const v = document.getElementById('theater-video');
  const btn = document.getElementById('tvp-speed');
  TheaterPlayer.playbackRate = rate;
  if (v) { try { v.playbackRate = rate; } catch {} }
  if (btn) {
    btn.textContent = _tvpFmtSpeed(rate);
    btn.classList.toggle('tvp-btn-active', rate !== 1);
  }
}
function _tvpCycleSpeed() {
  TheaterPlayer.speedIdx = (TheaterPlayer.speedIdx + 1) % _TVP_SPEEDS.length;
  const rate = _TVP_SPEEDS[TheaterPlayer.speedIdx];
  _tvpApplySpeed(rate);
  showToast(`SPEED ${_tvpFmtSpeed(rate)}`);
}

// Help overlay (SELECT button). Toggled on top of playback without changing
// state.screen so the d-pad / scrubber keep working underneath. Auto-clears
// on player close.
function _tvpShowHelp() {
  const el = document.getElementById('tvp-help-overlay');
  if (!el) return;
  el.classList.add('tvp-help-show');
  el.setAttribute('aria-hidden', 'false');
  TheaterPlayer.helpOpen = true;
}
function _tvpHideHelp() {
  const el = document.getElementById('tvp-help-overlay');
  if (!el) return;
  el.classList.remove('tvp-help-show');
  el.setAttribute('aria-hidden', 'true');
  TheaterPlayer.helpOpen = false;
}
function _tvpToggleHelp() {
  if (TheaterPlayer.helpOpen) _tvpHideHelp();
  else _tvpShowHelp();
}

// Title with overflow-aware marquee. The text lives inside a `.tvp-title-track`
// span so the parent (#theater-video-title) keeps clipping; when the track is
// wider than its container we tag the parent with `.tvp-marquee` and the CSS
// alternates a translateX from 0 to -(overflow-px) on a loop.
function _tvpSetTitle(text) {
  const el = document.getElementById('theater-video-title');
  if (!el) return;
  const track = el.querySelector('.tvp-title-track')
             || (() => { const s = document.createElement('span');
                         s.className = 'tvp-title-track'; el.replaceChildren(s); return s; })();
  track.textContent = text || 'PLAYBACK';
  // Defer measurement to next frame so layout is settled.
  requestAnimationFrame(() => {
    const overflow = track.scrollWidth - el.clientWidth;
    if (overflow > 4) {
      el.style.setProperty('--tvp-marq-shift', `-${overflow + 12}px`);
      el.classList.add('tvp-marquee');
    } else {
      el.classList.remove('tvp-marquee');
      el.style.removeProperty('--tvp-marq-shift');
    }
  });
}

function _tvpFmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`
    : `${m}:${String(r).padStart(2,'0')}`;
}

// Called from launchGame() right before any emulator/native-app dispatch.
// Previously this fully tore down the theater overlay; now it shrinks the
// player into the miniplayer widget so playback survives the launch. The
// widget sits at z-index 1200, above #emulator-overlay (900) and
// #launch-overlay (600), so iframe / Flash / EmulatorJS sessions render the
// game underneath while the corner player keeps running. Native game
// launches (Dolphin, .exe, etc.) take focus at the OS level — the player
// keeps playing in the background and is right there when the user returns.
function _silenceTheaterForLaunch() {
  const ov = document.getElementById('theater-video-overlay');
  if (!ov || !ov.classList.contains('active')) return;
  if (TheaterPlayer.miniplayer) return;       // already a corner widget — nothing to do
  try {
    enterMiniplayer();
    showToast('THEATER → MINI-PLAYER');
  } catch {
    try { closeTheaterVideo(); } catch {}
  }
}

function _tvpResolveUrl(rel) {
  // Server returns root-relative '/api/theater/proxy?url=...' — prepend the
  // server origin so cross-origin range requests carry the right base.
  if (!rel) return '';
  return /^https?:/i.test(rel) ? rel : `${KENTE_SERVER_URL}${rel}`;
}

function _tvpPickInitialQuality(qualities) {
  // Prefer 720p, then 1080p, then 480p, then whatever's first.
  const order = ['720p','720','1080p','1080','480p','480','360p','360'];
  for (const q of order) if (qualities.includes(q)) return q;
  return qualities[0];
}

function _tvpAttachSource(quality) {
  const v   = document.getElementById('theater-video');
  const url = _tvpResolveUrl(TheaterPlayer.payload.streams[quality]);
  if (!v || !url) return;
  // Pick the seek-to time: a saved resume position takes priority on the
  // first manifest of a session; later quality switches keep the live
  // playhead so the user doesn't lose their place.
  const startTime = (!TheaterPlayer.resumed && TheaterPlayer.resumeAt > 0)
    ? TheaterPlayer.resumeAt
    : (v.currentTime || 0);

  // Tear down previous Hls instance, if any.
  if (TheaterPlayer.hls) { try { TheaterPlayer.hls.destroy(); } catch {} TheaterPlayer.hls = null; }

  const Hls = window.Hls;
  const isM3u8 = /\.m3u8($|\?)/i.test(url) || url.includes('mpegurl');
  if (isM3u8 && Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
    TheaterPlayer.hls = hls;
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      v.currentTime = startTime;
      if (startTime > 0) TheaterPlayer.resumed = true;
      try { v.playbackRate = TheaterPlayer.playbackRate; } catch {}
      v.play().catch(()=>{});
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      console.warn('[TheaterPlayer] HLS error:', data.type, data.details);
      if (data.fatal) _tvpShowError('STREAM ERROR — TRY A DIFFERENT QUALITY');
    });
  } else {
    // Native HLS (Safari) or direct mp4.
    v.src = url;
    v.currentTime = startTime;
    if (startTime > 0) TheaterPlayer.resumed = true;
    try { v.playbackRate = TheaterPlayer.playbackRate; } catch {}
    v.play().catch(()=>{});
  }
  _tvpRefreshCCTracks();
}

// ── Closed captions ──────────────────────────────────────────────────────
// Subtitle URLs come pre-proxied through /api/theater/proxy by the server,
// so we don't need to worry about CORS for the .vtt fetches. We always start
// in OFF state on a fresh source attach; the user opts in via the CC button.
function _tvpRefreshCCTracks() {
  const v   = document.getElementById('theater-video');
  const btn = document.getElementById('tvp-cc');
  if (!v || !btn) return;
  // Strip previously-injected tracks. Hardcoded `data-tvp-cc` so any pre-existing
  // <track> elements declared in HTML (none today, but safe-by-default) are kept.
  v.querySelectorAll('track[data-tvp-cc]').forEach(t => t.remove());
  const subs = (TheaterPlayer.payload?.source?.subtitles)
            || TheaterPlayer.payload?.subtitles
            || [];
  TheaterPlayer.ccTracks = subs;
  TheaterPlayer.ccIndex  = -1;
  btn.hidden = false;
  btn.textContent = 'CC';
  btn.classList.remove('tvp-btn-active');
  btn.classList.toggle('tvp-btn-disabled', !subs.length);
  if (!subs.length) return;
  subs.forEach((s, i) => {
    const t = document.createElement('track');
    t.kind     = 'subtitles';
    t.src      = s.url || '';
    t.srclang  = (s.lang || 'en').slice(0, 5);
    t.label    = (s.label || s.lang || `Track ${i+1}`);
    t.default  = false;
    t.setAttribute('data-tvp-cc', '1');
    v.appendChild(t);
  });
  // textTracks are populated synchronously after appendChild; force them off
  // so nothing renders until the user toggles CC on.
  Array.from(v.textTracks || []).forEach(tt => { tt.mode = 'disabled'; });
}

function _tvpCycleCC() {
  const v = document.getElementById('theater-video');
  const btn = document.getElementById('tvp-cc');
  if (!v || !btn) return;
  const subs = TheaterPlayer.ccTracks || [];
  if (!subs.length) {
    // Button stays visible even when nothing's bundled — flash a hint so the
    // user knows the click registered and the source just doesn't ship subs.
    _tvpShowError('NO SUBTITLES AVAILABLE FOR THIS SOURCE');
    return;
  }
  // Cycle: -1 (off) -> 0 -> 1 -> ... -> N-1 -> -1
  const next = TheaterPlayer.ccIndex + 1 >= subs.length ? -1 : TheaterPlayer.ccIndex + 1;
  TheaterPlayer.ccIndex = next;
  Array.from(v.textTracks || []).forEach((tt, i) => {
    tt.mode = (i === next) ? 'showing' : 'disabled';
  });
  if (next < 0) {
    btn.textContent = 'CC';
    btn.classList.remove('tvp-btn-active');
  } else {
    const lang = (subs[next].lang || subs[next].label || 'EN').toString().toUpperCase().slice(0, 4);
    btn.textContent = `CC: ${lang}`;
    btn.classList.add('tvp-btn-active');
  }
}

// ── Episode skip ────────────────────────────────────────────────────────
// Drives the ⏮ / ⏭ buttons when the active ctx is a TV show. We keep the
// flat episode list on TheaterPlayer.epList (sourced from ctx._episodes,
// which the detail overlay assembled). Buttons hide for movies and go
// disabled at the boundaries.
function _tvpRefreshEpButtons() {
  const prev = document.getElementById('tvp-prev-ep');
  const next = document.getElementById('tvp-next-ep');
  if (!prev || !next) return;
  const list = TheaterPlayer.epList || [];
  const idx  = TheaterPlayer.epIndex;
  const isShow = (TheaterPlayer.ctx?.kind === 'show'
               || TheaterPlayer.ctx?.type === 'show')
               && list.length > 0;
  prev.hidden = next.hidden = !isShow;
  if (!isShow) return;
  prev.classList.toggle('tvp-btn-disabled', idx <= 0);
  next.classList.toggle('tvp-btn-disabled', idx < 0 || idx >= list.length - 1);
  prev.title = idx > 0
    ? `Previous Episode (S${list[idx-1].season} · E${list[idx-1].number})`
    : 'Previous Episode';
  next.title = (idx >= 0 && idx < list.length - 1)
    ? `Next Episode (S${list[idx+1].season} · E${list[idx+1].number})`
    : 'Next Episode';
}

function _tvpJumpEpisode(delta) {
  const list = TheaterPlayer.epList || [];
  const idx  = TheaterPlayer.epIndex;
  const ctx  = TheaterPlayer.ctx;
  if (!ctx || !list.length) return;
  const target = idx + delta;
  if (target < 0 || target >= list.length) return;
  const ep = list[target];
  _tvpUpNextHide();   // tear down any active Up Next card before swapping
  // Re-issue the same flow as a fresh episode click in the detail overlay.
  // _theaterStartStream picks the right player (HLS vs embed) so the user
  // gets a seamless swap without going back to detail.
  _theaterStartStream(
    ctx.provider, 'show', ctx.slug || ctx.id, ep.id,
    `${ctx.title || ''} — ${ep.title}`,
    { ...ctx, episodeId: ep.id, episodeTitle: ep.title, _episodes: list }
  );
}

/* ── UP NEXT CARD ─────────────────────────────────────────
   Auto-shown in the last 15 s of an episode when there's a next entry
   in epList and we're on the native HLS path. Auto-fires PLAY NOW when
   the countdown hits zero; CANCEL suppresses for the rest of the episode.
   Embed-mode sessions skip Up Next entirely (no native tail to detect). */
const _TVP_UP_NEXT_WINDOW = 15;   // seconds before end to surface the card

function _tvpUpNextShow(nextEp) {
  const root = document.getElementById('tvp-up-next');
  if (!root) return;
  const ctx     = TheaterPlayer.ctx || {};
  const poster  = nextEp.thumbnail || nextEp.poster || ctx.poster || '';
  const epLine  = (nextEp.season != null && nextEp.number != null)
    ? `S${nextEp.season} · E${nextEp.number}`
    : (nextEp.label || `EPISODE ${TheaterPlayer.epIndex + 2}`);
  const titleEl = document.getElementById('tvp-un-title');
  const epEl    = document.getElementById('tvp-un-ep');
  const posEl   = document.getElementById('tvp-un-poster');
  if (epEl)    epEl.textContent    = epLine.toUpperCase();
  if (titleEl) titleEl.textContent = (nextEp.title || epLine).toUpperCase();
  if (posEl)   posEl.style.backgroundImage = poster ? `url("${poster}")` : '';
  root.classList.add('tvp-un-show');
  root.setAttribute('aria-hidden', 'false');
  TheaterPlayer.upNext.visible  = true;
  TheaterPlayer.upNext.forEpIdx = TheaterPlayer.epIndex;
}

function _tvpUpNextHide() {
  const root = document.getElementById('tvp-up-next');
  if (!root) return;
  root.classList.remove('tvp-un-show');
  root.setAttribute('aria-hidden', 'true');
  TheaterPlayer.upNext.visible = false;
}

function _tvpUpNextResetForEpisode() {
  TheaterPlayer.upNext.dismissed = false;
  TheaterPlayer.upNext.forEpIdx  = -1;
  TheaterPlayer.upNext.fired     = false;
  _tvpUpNextHide();
}

/* Per-tick update — called from the timeupdate listener. Drives both the
   show / hide decision and the countdown ring + seconds label. */
function _tvpUpNextTick(currentTime, duration) {
  if (TheaterPlayer.embed || TheaterPlayer.miniplayer) {
    if (TheaterPlayer.upNext.visible) _tvpUpNextHide();
    return;
  }
  const list = TheaterPlayer.epList || [];
  const nextIdx = TheaterPlayer.epIndex + 1;
  if (!list.length || nextIdx <= 0 || nextIdx >= list.length) return;
  if (!duration || duration <= 0) return;
  const remaining = duration - currentTime;
  const inWindow  = remaining > 0 && remaining <= _TVP_UP_NEXT_WINDOW;

  // Out of window — hide and clear the per-episode dismiss so a rewind +
  // re-entry doesn't get blocked by a stale dismissal.
  if (!inWindow) {
    if (TheaterPlayer.upNext.visible) _tvpUpNextHide();
    return;
  }
  // Dismissed for this episode — never re-show until the episode changes.
  if (TheaterPlayer.upNext.dismissed &&
      TheaterPlayer.upNext.forEpIdx === TheaterPlayer.epIndex) return;

  // First entry into the window — render the card.
  if (!TheaterPlayer.upNext.visible) {
    _tvpUpNextShow(list[nextIdx]);
  }
  // Update countdown text + ring.
  const secs = Math.max(0, Math.ceil(remaining));
  const secsEl = document.getElementById('tvp-un-secs');
  if (secsEl) secsEl.textContent = String(secs);
  const ring = document.querySelector('.tvp-un-ring-fg');
  if (ring) {
    const pct = Math.max(0, Math.min(1, remaining / _TVP_UP_NEXT_WINDOW));
    ring.style.strokeDashoffset = String(100 * (1 - pct));
  }
  // Auto-fire when countdown hits zero. The native 'ended' handler also
  // calls _tvpJumpEpisode, but firing slightly early (≤ 0.4 s remaining)
  // keeps the card responsive on streams that stall right at the tail.
  if (remaining <= 0.4) _tvpUpNextFire();
}

function _tvpUpNextFire() {
  if (!TheaterPlayer.upNext.visible) return;
  TheaterPlayer.upNext.fired = true;   // gate the 'ended' handler's auto-jump
  _tvpUpNextHide();
  _tvpJumpEpisode(+1);
}

function _tvpUpNextCancel() {
  TheaterPlayer.upNext.dismissed = true;
  TheaterPlayer.upNext.forEpIdx  = TheaterPlayer.epIndex;
  _tvpUpNextHide();
}

function _tvpShowError(msg) {
  const el = document.getElementById('theater-video-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 5000);
}

function _tvpBindControlsOnce() {
  if (TheaterPlayer.bound) return;
  TheaterPlayer.bound = true;

  const v       = document.getElementById('theater-video');
  const stage   = document.getElementById('theater-video-stage');
  const playBtn = document.getElementById('tvp-play');
  const backBtn = document.getElementById('tvp-back');
  const fwdBtn  = document.getElementById('tvp-fwd');
  const cur     = document.getElementById('tvp-cur');
  const dur     = document.getElementById('tvp-dur');
  const scrub   = document.getElementById('tvp-scrub');
  const fill    = scrub.querySelector('.tvp-scrub-fill');
  const buf     = scrub.querySelector('.tvp-scrub-buf');
  const handle  = scrub.querySelector('.tvp-scrub-handle');
  const muteBtn = document.getElementById('tvp-mute');
  const volSl   = document.getElementById('tvp-vol-slider');
  const qSel    = document.getElementById('tvp-quality');
  const fullBtn = document.getElementById('tvp-full');
  const pipBtn  = document.getElementById('tvp-pip');
  const ccBtn   = document.getElementById('tvp-cc');
  const loading = document.getElementById('theater-video-loading');

  if (ccBtn) ccBtn.addEventListener('click', () => { _tvpCycleCC(); KenteAudio.click(); });

  const speedBtn = document.getElementById('tvp-speed');
  speedBtn?.addEventListener('click', () => { _tvpCycleSpeed(); KenteAudio.click(); });

  const prevEp = document.getElementById('tvp-prev-ep');
  const nextEp = document.getElementById('tvp-next-ep');
  prevEp?.addEventListener('click', () => {
    if (prevEp.classList.contains('tvp-btn-disabled')) return;
    KenteAudio.click(); _tvpJumpEpisode(-1);
  });
  nextEp?.addEventListener('click', () => {
    if (nextEp.classList.contains('tvp-btn-disabled')) return;
    KenteAudio.click(); _tvpJumpEpisode(+1);
  });

  // Up Next card buttons — PLAY NOW jumps now, CANCEL suppresses for the ep.
  document.getElementById('tvp-un-play')?.addEventListener('click', () => {
    KenteAudio.click(); _tvpUpNextFire();
  });
  document.getElementById('tvp-un-cancel')?.addEventListener('click', () => {
    KenteAudio.click(); _tvpUpNextCancel();
  });

  playBtn.addEventListener('click', () => v.paused ? v.play() : v.pause());
  backBtn.addEventListener('click', () => { v.currentTime = Math.max(0, v.currentTime - 10); });
  fwdBtn .addEventListener('click', () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); });
  v.addEventListener('play',  () => { playBtn.textContent = '❚❚'; stage.classList.remove('tvp-paused'); });
  v.addEventListener('pause', () => { playBtn.textContent = '▶';  stage.classList.add('tvp-paused'); });
  v.addEventListener('waiting', () => { loading.hidden = false; });
  v.addEventListener('playing', () => { loading.hidden = true;  });
  v.addEventListener('canplay', () => { loading.hidden = true;  });
  v.addEventListener('click', () => v.paused ? v.play() : v.pause());

  v.addEventListener('timeupdate', () => {
    const d = v.duration || 0;
    cur.textContent = _tvpFmt(v.currentTime);
    dur.textContent = _tvpFmt(d);
    const pct = d ? (v.currentTime / d) * 100 : 0;
    fill.style.width = pct + '%';
    handle.style.left = pct + '%';
    try {
      const tr = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      buf.style.width = (d ? (tr / d) * 100 : 0) + '%';
    } catch {}
    // Persist resume position every ~5 s.  Skipped while the resume seek is
    // still pending so we don't overwrite the saved position with 0.
    const ctx = TheaterPlayer.ctx;
    if (ctx && v.currentTime > 1 && (TheaterPlayer.resumed || TheaterPlayer.resumeAt === 0)) {
      const now = Date.now();
      if (now - (TheaterPlayer.saveTimer || 0) > 5000) {
        TheaterPlayer.saveTimer = now;
        TheaterDB.saveProgress(ctx, v.currentTime, d);
      }
    }
    // Up Next countdown tick — show / hide / advance the bottom-right card.
    try { _tvpUpNextTick(v.currentTime, d); } catch {}
  });
  v.addEventListener('ended', () => {
    if (TheaterPlayer.ctx) TheaterDB.clearProgress(TheaterPlayer.ctx);
    // If the Up Next card already triggered the jump, don't double-fire.
    if (TheaterPlayer.upNext.fired) return;
    // Auto-advance to the next episode when we have one. Embed-mode
    // sessions can't fire `ended` (no native <video> source), so this
    // path is HLS-only — embed users still rely on the manual ⏭ button.
    const list = TheaterPlayer.epList || [];
    const nextIdx = TheaterPlayer.epIndex + 1;
    if (list.length && nextIdx >= 0 && nextIdx < list.length) {
      const ep = list[nextIdx];
      showToast(`▶ NEXT EPISODE — ${(ep.title || `S${ep.season}E${ep.number}`).toUpperCase()}`);
      _tvpJumpEpisode(+1);
    }
  });
  // Scrub bar — pointer-driven so cursor-mode (DSPointer / Wii) drags work
  // alongside real mouse drags. Also keeps a click-to-seek fallback. Skipped
  // entirely while in embed mode (the native <video> has no source then).
  let _scrubDragging = false;
  let _scrubWasPaused = false;
  const _scrubSeekTo = (clientX) => {
    if (!v.duration || stage.classList.contains('tvp-embed-mode')) return;
    const r = scrub.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    v.currentTime = p * v.duration;
    fill.style.width   = (p * 100) + '%';
    handle.style.left  = (p * 100) + '%';
  };
  scrub.addEventListener('pointerdown', e => {
    if (stage.classList.contains('tvp-embed-mode')) return;
    _scrubDragging = true;
    _scrubWasPaused = v.paused;
    try { v.pause(); } catch {}
    try { scrub.setPointerCapture(e.pointerId); } catch {}
    _scrubSeekTo(e.clientX);
    e.preventDefault();
  });
  scrub.addEventListener('pointermove', e => {
    if (!_scrubDragging) return;
    _scrubSeekTo(e.clientX);
  });
  const _scrubEnd = (e) => {
    if (!_scrubDragging) return;
    _scrubDragging = false;
    if (e && e.pointerId !== undefined) {
      try { scrub.releasePointerCapture(e.pointerId); } catch {}
    }
    if (!_scrubWasPaused) { try { v.play(); } catch {} }
  };
  scrub.addEventListener('pointerup',     _scrubEnd);
  scrub.addEventListener('pointercancel', _scrubEnd);
  // Window-level safety net for drags that leave the bar before release.
  window.addEventListener('pointerup', _scrubEnd);

  muteBtn.addEventListener('click', () => {
    v.muted = !v.muted;
    muteBtn.textContent = v.muted ? '🔇' : '🔊';
  });
  volSl.addEventListener('input', e => {
    v.volume = parseFloat(e.target.value);
    if (v.volume > 0) v.muted = false;
    muteBtn.textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
  });

  qSel.addEventListener('change', () => _tvpAttachSource(qSel.value));

  fullBtn.addEventListener('click', () => {
    // Target the overlay shell so the header, watermark, source dropdown,
    // and pause menu all remain inside the fullscreen surface. Falls back
    // to the panel/stage if the browser refuses (e.g. iframe sandbox).
    const target = document.getElementById('theater-video-overlay')
                || document.getElementById('theater-video-panel')
                || document.getElementById('theater-video-stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else (target.requestFullscreen?.() || Promise.reject()).catch(() => {
      document.getElementById('theater-video-stage')?.requestFullscreen?.().catch(()=>{});
    });
  });
  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    fullBtn.textContent = fs ? '⛶✕' : '⛶';
    fullBtn.classList.toggle('tvp-btn-active', fs);
    document.getElementById('theater-video-overlay')?.classList.toggle('tvp-fullscreen', fs);
  });
  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v.requestPictureInPicture) await v.requestPictureInPicture();
    } catch (_e) {}
  });

  // Idle-hide cursor + chrome after 2.5s of no movement.
  // We also toggle .tvp-show so that synthetic mousemove events (DSPointer /
  // Wii pointer) can reveal the controls — CSS :hover doesn't fire for
  // JS-dispatched events.
  const armIdle = () => {
    stage.classList.remove('tvp-idle');
    stage.classList.add('tvp-show');
    clearTimeout(TheaterPlayer.idleTimer);
    TheaterPlayer.idleTimer = setTimeout(() => {
      if (!v.paused) {
        stage.classList.add('tvp-idle');
        stage.classList.remove('tvp-show');
      }
    }, 2500);
  };
  stage.addEventListener('mousemove', armIdle);
  stage.addEventListener('mouseleave', () => {
    stage.classList.remove('tvp-idle');
    stage.classList.remove('tvp-show');
  });
}

/* ── Screen Wake Lock — keeps the display on while a film/episode plays.
     Browser auto-releases on tab blur / fullscreen change, so we re-acquire
     on visibilitychange while the overlay is open. */
async function _tvpAcquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (TheaterPlayer.wakeLock) return;
    TheaterPlayer.wakeLock = await navigator.wakeLock.request('screen');
    TheaterPlayer.wakeLock.addEventListener?.('release', () => {
      // Cleared by the browser — drop our reference so the visibilitychange
      // handler can re-acquire if the overlay is still open.
      TheaterPlayer.wakeLock = null;
    });
  } catch (_e) { /* user may deny or unsupported — quietly degrade */ }
}
function _tvpReleaseWakeLock() {
  const wl = TheaterPlayer.wakeLock;
  TheaterPlayer.wakeLock = null;
  if (wl && typeof wl.release === 'function') {
    try { wl.release(); } catch {}
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const ov = document.getElementById('theater-video-overlay');
  if (ov?.classList.contains('active')) _tvpAcquireWakeLock();
});

/* ── Theater pause menu ─────────────────────────────────────
   Mirrors the in-game pause menu but lives inside the theater
   overlay.  Pauses the native <video> when present.  For the
   iframe path we can't actually pause cross-origin playback;
   the overlay simply hides the iframe behind the menu. */
function _tpmUpdateFocus() {
  const btns = _tpmButtons();
  btns.forEach((b, i) => b.classList.toggle('tpm-focused', i === TheaterPlayer.pauseMenuFocus));
}
function _tpmButtons() {
  // Visible buttons only (NEXT SOURCE is hidden for native-stream sessions).
  return [...document.querySelectorAll('#tpm-btns .tpm-btn')]
    .filter(b => !b.hidden && b.offsetParent !== null);
}
function showTheaterPauseMenu() {
  const menu = document.getElementById('theater-pause-menu');
  if (!menu) return;
  // Pause native video (no-op for iframe — cross-origin can't be paused).
  const v = document.getElementById('theater-video');
  if (v && !TheaterPlayer.embed) { try { v.pause(); } catch {} }
  // Title from the player header.
  const title = document.getElementById('theater-video-title')?.textContent || '';
  const titleEl = document.getElementById('tpm-title');
  if (titleEl) titleEl.textContent = title;
  // NEXT SOURCE only meaningful when 2+ embed sources are available.
  const srcBtn  = document.getElementById('tpm-source');
  const sources = (TheaterPlayer.payload?.source?.sources) || TheaterPlayer.payload?.sources || [];
  if (srcBtn) srcBtn.hidden = !(TheaterPlayer.embed && sources.length >= 2);
  TheaterPlayer.pauseMenuFocus = 0;
  menu.classList.add('active');
  _tpmUpdateFocus();
  state.screen = 'theater-paused';
  KenteAudio.click?.();
}
function hideTheaterPauseMenu() {
  const menu = document.getElementById('theater-pause-menu');
  if (!menu) return;
  menu.classList.remove('active');
  // Resume native video; iframe playback was never actually paused.
  const v = document.getElementById('theater-video');
  if (v && !TheaterPlayer.embed) { try { v.play().catch(()=>{}); } catch {} }
  state.screen = 'theater-playing';
}
function _tpmCycleSource() {
  // Click the next option in the source dropdown — same flow as the user
  // selecting from the menu. Keeps localStorage / badge updates consistent.
  const opts = [...document.querySelectorAll('#theater-source-switcher .tss-option')];
  if (opts.length < 2) return;
  let idx = opts.findIndex(p => p.classList.contains('active'));
  if (idx < 0) idx = -1;
  const next = opts[(idx + 1) % opts.length];
  next?.click();
}

/* ── Embed watchdog ─────────────────────────────────────────────────────
   Several iframe hosts (vidsrcpm, multiembed, 2embedstream, …) occasionally
   fail to render anything at all — DNS hiccup, CSP block, Cloudflare 5xx.
   In those cases the iframe never fires `load`, so we arm a 12 s timer per
   src= write and auto-advance to the next pill if it expires. Manual pill
   clicks reset the auto-advance tracker so the user always trumps the
   watchdog.                                                              */
const _TVP_WATCHDOG_MS = 12000;

// Per-host reliability ledger — increments on load / decrements on watchdog
// timeout. Used to bias the initial source pick on cold launches when the
// user has no explicit preference yet. Capped at ±20 so a single bad day
// for a host doesn't permanently sink it.
const _TVP_SCORE_KEY = 'kente.theater.sourceScores';
function _tvpReadScores() {
  try { return JSON.parse(localStorage.getItem(_TVP_SCORE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function _tvpWriteScores(map) {
  try { localStorage.setItem(_TVP_SCORE_KEY, JSON.stringify(map)); } catch {}
}
function _tvpBumpScore(key, delta) {
  if (!key) return;
  const m = _tvpReadScores();
  const cur = (m[key] && typeof m[key].score === 'number') ? m[key].score : 0;
  m[key] = { score: Math.max(-20, Math.min(20, cur + delta)), at: Date.now() };
  _tvpWriteScores(m);
}

function _tvpClearWatchdog() {
  if (TheaterPlayer.watchdog) {
    clearTimeout(TheaterPlayer.watchdog);
    TheaterPlayer.watchdog = null;
  }
}

function _tvpArmWatchdog(frame, key, gen) {
  _tvpClearWatchdog();
  TheaterPlayer.watchdog = setTimeout(() => {
    if (gen !== TheaterPlayer.loadGen) return;       // a newer src= already won
    if (!TheaterPlayer.embed) return;                // player closed in the meantime
    if (!TheaterPlayer.autoAdvanceTried) TheaterPlayer.autoAdvanceTried = new Set();
    if (TheaterPlayer.autoAdvanceTried.has(key)) return;
    TheaterPlayer.autoAdvanceTried.add(key);
    // Penalize the host that just timed out so future cold launches skip it.
    _tvpBumpScore(key, -2);
    const sources = TheaterPlayer.embedSources || [];
    if (sources.length < 2) { _tvpHideEmbedLoading(); return; }
    const idx = sources.findIndex(s => s.name === key);
    let next = null;
    for (let i = 1; i <= sources.length; i++) {
      const cand = sources[(idx + i) % sources.length];
      if (!TheaterPlayer.autoAdvanceTried.has(cand.name)) { next = cand; break; }
    }
    if (!next) { _tvpHideEmbedLoading(); return; }   // every host already tried
    try {
      showToast(`⚠ ${String(key).toUpperCase()} UNRESPONSIVE — TRYING ${String(next.label || next.name).toUpperCase()}`);
    } catch {}
    _tvpLoadEmbedSource(frame, next, { auto: true });
  }, _TVP_WATCHDOG_MS);
}

// Loading overlay — covers the iframe while a host is initializing so the
// user sees progress instead of a blank black rectangle. Hidden on the
// frame's `load` event or when the watchdog gives up.
function _tvpShowEmbedLoading(label) {
  const el = document.getElementById('theater-embed-loading');
  if (!el) return;
  const lbl = el.querySelector('.tel-label');
  if (lbl) lbl.textContent = `LOADING ${String(label || 'SOURCE').toUpperCase()}…`;
  el.hidden = false;
}
function _tvpHideEmbedLoading() {
  const el = document.getElementById('theater-embed-loading');
  if (el) el.hidden = true;
}

function _tvpLoadEmbedSource(frame, src, opts) {
  if (!frame || !src || !src.url) return;
  const key = src.name;
  const lab = src.label || src.name || '';
  const gen = ++TheaterPlayer.loadGen;
  _tvpClearWatchdog();
  _tvpShowEmbedLoading(lab || key);
  try { frame.src = 'about:blank'; } catch {}
  // Tiny gap forces the iframe to remount cleanly on hosts that ignore
  // same-origin src updates; matches the previous manual-pill behavior.
  setTimeout(() => {
    if (gen !== TheaterPlayer.loadGen) return;
    try { frame.src = src.url; } catch {}
    _tvpArmWatchdog(frame, key, gen);
  }, 30);
  // UI updates fire immediately so the click feels responsive.
  const switcher = document.getElementById('theater-source-switcher');
  if (switcher) {
    switcher.querySelectorAll('.tss-option').forEach(p => {
      p.classList.toggle('active', p.getAttribute('data-key') === key);
    });
    const trig = switcher.querySelector('.tss-trigger-label');
    if (trig) trig.textContent = String(lab || key || 'SOURCE').toUpperCase();
  }
  const badge = document.getElementById('theater-embed-badge');
  if (badge) badge.textContent = `EMBEDDED PLAYER · ${String(lab || key || 'EXTERNAL').toUpperCase()}`;
  TheaterPlayer.activeSource = key;
  if (!opts || !opts.auto) {
    try { localStorage.setItem('kente.theater.embedSource', key); } catch {}
  }
}
/* ── Mini-player ────────────────────────────────────────────────────────
   A floating corner widget that re-frames `#theater-video-overlay` as a
   draggable mini view. The DOM stays put — we only toggle `.miniplayer-
   mode`, restore `state.screen` so the underlying screen drives gamepad
   nav, and bind drag handlers to the header. Position + size persist per-
   session in localStorage.                                              */
const _MP_POS_KEY = 'kente.theater.mpPos';
const _MP_MIN_W = 240, _MP_MIN_H = 150;
const _MP_MAX_W = 960, _MP_MAX_H = 600;

function _tvpMpReadPos() {
  try { return JSON.parse(localStorage.getItem(_MP_POS_KEY) || 'null'); }
  catch { return null; }
}
function _tvpMpWritePos(pos) {
  try { localStorage.setItem(_MP_POS_KEY, JSON.stringify(pos)); } catch {}
}
function _tvpMpApplyPos(overlay) {
  const p = _tvpMpReadPos();
  // Default — bottom-right corner via the CSS variable fallbacks.
  overlay.style.setProperty('--mp-top',    p?.top    != null ? p.top + 'px'    : 'auto');
  overlay.style.setProperty('--mp-left',   p?.left   != null ? p.left + 'px'   : 'auto');
  overlay.style.setProperty('--mp-right',  p?.right  != null ? p.right + 'px'  : (p ? 'auto' : '18px'));
  overlay.style.setProperty('--mp-bottom', p?.bottom != null ? p.bottom + 'px' : (p ? 'auto' : '18px'));
  // Size variables — default 360x220 matches the CSS fallback.
  overlay.style.setProperty('--mp-w', (p?.w != null ? p.w : 360) + 'px');
  overlay.style.setProperty('--mp-h', (p?.h != null ? p.h : 220) + 'px');
}

function enterMiniplayer() {
  const overlay = document.getElementById('theater-video-overlay');
  if (!overlay || !overlay.classList.contains('active')) return;
  if (TheaterPlayer.miniplayer) return;
  TheaterPlayer.miniplayer = true;
  overlay.classList.add('miniplayer-mode');
  _tvpMpApplyPos(overlay);
  // Hide pause menu if it was up; widget is too small for it.
  document.getElementById('theater-pause-menu')?.classList.remove('active');
  // Restore the underlying screen so the rest of the UI drives gamepad
  // nav and click handlers normally. closeTheaterVideo will skip the
  // restore on exit because prevScreen is consumed here.
  const prev = TheaterPlayer.prevScreen || 'menu';
  if (state.screen === 'theater-playing' || state.screen === 'theater-paused') {
    state.screen = prev;
  }
  if (prev === 'menu') KenteAudio.setHumVol(0.018);
  // Update the toggle's label.
  const btn = document.getElementById('theater-video-mini');
  if (btn) btn.textContent = '⤡ EXPAND';
}

function exitMiniplayer() {
  const overlay = document.getElementById('theater-video-overlay');
  if (!overlay || !TheaterPlayer.miniplayer) return;
  TheaterPlayer.miniplayer = false;
  overlay.classList.remove('miniplayer-mode', 'mp-dragging');
  state.screen = 'theater-playing';
  KenteAudio.setHumVol(0);
  const btn = document.getElementById('theater-video-mini');
  if (btn) btn.textContent = '⬓ MINI';
}

function toggleMiniplayer() {
  if (TheaterPlayer.miniplayer) exitMiniplayer();
  else enterMiniplayer();
}

function _tvpBindMpDrag(overlay, header) {
  // Single drag binding shared by mouse + touch. Only active while the
  // overlay is in miniplayer mode; clicks on inner buttons bubble out
  // before this runs because we ignore mousedowns on <button> targets.
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  const onDown = (e) => {
    if (!TheaterPlayer.miniplayer) return;
    if (e.target.closest('button')) return;
    const t = (e.touches && e.touches[0]) || e;
    const r = overlay.getBoundingClientRect();
    dragging = true;
    sx = t.clientX; sy = t.clientY;
    ox = r.left;    oy = r.top;
    overlay.classList.add('mp-dragging');
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const t = (e.touches && e.touches[0]) || e;
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    const w = overlay.offsetWidth, h = overlay.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth  - w, ox + dx));
    const top  = Math.max(0, Math.min(window.innerHeight - h, oy + dy));
    overlay.style.setProperty('--mp-left',   left + 'px');
    overlay.style.setProperty('--mp-top',    top  + 'px');
    overlay.style.setProperty('--mp-right',  'auto');
    overlay.style.setProperty('--mp-bottom', 'auto');
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    overlay.classList.remove('mp-dragging');
    const r = overlay.getBoundingClientRect();
    // Preserve the existing size when persisting position.
    const prev = _tvpMpReadPos() || {};
    _tvpMpWritePos({
      left: Math.round(r.left), top: Math.round(r.top),
      w: prev.w, h: prev.h,
    });
  };
  header.addEventListener('mousedown',  onDown);
  header.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('mousemove',  onMove);
  window.addEventListener('touchmove',  onMove, { passive: false });
  window.addEventListener('mouseup',    onUp);
  window.addEventListener('touchend',   onUp);
  window.addEventListener('touchcancel', onUp);
}

function _tvpBindMpResize(overlay, grip) {
  // Bottom-right corner resize. Only active in miniplayer mode. The overlay
  // anchors to top-left during a resize so the grip stays under the cursor
  // even when the widget was previously bottom-right anchored.
  let resizing = false, sx = 0, sy = 0, sw = 0, sh = 0;
  const onDown = (e) => {
    if (!TheaterPlayer.miniplayer) return;
    const t = (e.touches && e.touches[0]) || e;
    const r = overlay.getBoundingClientRect();
    resizing = true;
    sx = t.clientX; sy = t.clientY;
    sw = r.width;   sh = r.height;
    // Lock the widget to its current top-left so the resize doesn't make
    // it appear to "jump" across the screen.
    overlay.style.setProperty('--mp-left',   r.left + 'px');
    overlay.style.setProperty('--mp-top',    r.top  + 'px');
    overlay.style.setProperty('--mp-right',  'auto');
    overlay.style.setProperty('--mp-bottom', 'auto');
    overlay.classList.add('mp-resizing');
    e.preventDefault();
    e.stopPropagation();
  };
  const onMove = (e) => {
    if (!resizing) return;
    const t = (e.touches && e.touches[0]) || e;
    const w = Math.max(_MP_MIN_W, Math.min(_MP_MAX_W, sw + (t.clientX - sx)));
    const h = Math.max(_MP_MIN_H, Math.min(_MP_MAX_H, sh + (t.clientY - sy)));
    overlay.style.setProperty('--mp-w', w + 'px');
    overlay.style.setProperty('--mp-h', h + 'px');
  };
  const onUp = () => {
    if (!resizing) return;
    resizing = false;
    overlay.classList.remove('mp-resizing');
    const r = overlay.getBoundingClientRect();
    _tvpMpWritePos({
      left: Math.round(r.left), top: Math.round(r.top),
      w:    Math.round(r.width), h: Math.round(r.height),
    });
  };
  grip.addEventListener('mousedown',  onDown);
  grip.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('mousemove',  onMove);
  window.addEventListener('touchmove',  onMove, { passive: false });
  window.addEventListener('mouseup',    onUp);
  window.addEventListener('touchend',   onUp);
  window.addEventListener('touchcancel', onUp);
}

// Wire pause-menu + chrome buttons once on DOM ready.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tpm-resume')?.addEventListener('click', hideTheaterPauseMenu);
  document.getElementById('tpm-source')?.addEventListener('click', () => {
    _tpmCycleSource();
    hideTheaterPauseMenu();
  });
  document.getElementById('tpm-mini')  ?.addEventListener('click', () => {
    hideTheaterPauseMenu();
    enterMiniplayer();
  });
  document.getElementById('tpm-close') ?.addEventListener('click', closeTheaterVideo);
  // Header MINI / EXPAND toggle + drag binding.
  document.getElementById('theater-video-mini')?.addEventListener('click', toggleMiniplayer);
  const ov = document.getElementById('theater-video-overlay');
  const hd = document.getElementById('theater-video-header');
  if (ov && hd) _tvpBindMpDrag(ov, hd);
  // Resize grip — created lazily so we don't need to touch index.html. The
  // grip is only visible while .miniplayer-mode is active (CSS-controlled).
  if (ov) {
    let grip = document.getElementById('theater-video-resize');
    if (!grip) {
      grip = document.createElement('div');
      grip.id = 'theater-video-resize';
      grip.className = 'mp-resize-grip';
      grip.title = 'Drag to resize';
      ov.appendChild(grip);
    }
    _tvpBindMpResize(ov, grip);
  }
});

async function openTheaterVideo(payload, title, ctx) {
  const overlay = document.getElementById('theater-video-overlay');
  const v       = document.getElementById('theater-video');
  const stage   = document.getElementById('theater-video-stage');
  const label   = document.getElementById('theater-video-title');
  const qSel    = document.getElementById('tvp-quality');
  if (!overlay || !v) return;

  _tvpBindControlsOnce();
  // Native HLS path — clear any leftover embed-mode flag so the scrub bar
  // and time display reappear after switching from an embed session.
  stage?.classList.remove('tvp-embed-mode');

  TheaterPlayer.payload   = payload;
  TheaterPlayer.ctx       = ctx || null;
  TheaterPlayer.resumed   = false;
  TheaterPlayer.resumeAt  = 0;
  TheaterPlayer.saveTimer = 0;
  TheaterPlayer.embed     = false;
  TheaterPlayer.epList    = (ctx && Array.isArray(ctx._episodes)) ? ctx._episodes : [];
  TheaterPlayer.epIndex   = TheaterPlayer.epList.findIndex(ep => ep.id === ctx?.episodeId);
  _tvpUpNextResetForEpisode();   // fresh episode → re-arm the Up Next card
  // Capture the previous screen so closeTheaterVideo can restore it.
  if (state.screen !== 'theater-playing' && state.screen !== 'theater-paused') {
    TheaterPlayer.prevScreen = state.screen;
  }
  state.screen = 'theater-playing';
  AttractMode.onLeaveRoom();
  _tvpAcquireWakeLock();
  // Look up a saved resume position for this title/episode. Smart Resume:
  // skip the resume offer when the saved spot is in the last 90 s of the
  // runtime or past the 95% mark — those count as 'finished', and any stale
  // record that snuck past the saveProgress filter is cleared on the spot.
  if (ctx) {
    try {
      const rec  = await TheaterDB.getProgress(ctx);
      const dur  = rec?.duration || 0;
      const pos  = rec?.position || 0;
      const tail = dur > 0 && (dur - pos) <= 90;
      const past = dur > 0 && pos > 0.95 * dur;
      if (rec && (tail || past)) {
        try { await TheaterDB.clearProgress(ctx); } catch {}
      } else if (rec && pos > 5) {
        TheaterPlayer.resumeAt = pos;
        showToast(`▶ RESUMING AT ${_tvpFmt(pos)}`);
      }
    } catch {}
  }
  _tvpSetTitle(title);
  _tvpSetHeaderMeta([_fmtRuntime(ctx?.runtime)]);
  _tvpRefreshEpButtons();

  // Build quality dropdown
  const qualities = payload.qualities || Object.keys(payload.streams || {});
  qSel.innerHTML = qualities.map(q => `<option value="${q}">${q.toUpperCase()}</option>`).join('');
  const initial = _tvpPickInitialQuality(qualities);
  qSel.value = initial;

  document.getElementById('theater-video-error').hidden = true;
  document.getElementById('theater-video-loading').hidden = false;
  overlay.classList.add('active');
  KenteAudio.setHumVol(0);
  closeTheaterDetail();
  _tvpAttachSource(initial);
}

/* ── Embedded iframe player ──
   Used by VidSrc / 2Embed / VidSrc.pm / MultiEmbed providers.  The remote
   site renders its own controls inside the iframe; we can't poll currentTime
   for progress, so resume / Continue Watching is suppressed.  An "EMBEDDED
   PLAYER" badge replaces the quality selector to make the difference
   visible to the user.                                                     */
/* ── AdShield ───────────────────────────────────────────────────────────
   Layered, sandbox-less popup / hijack mitigation. Engaged for the
   duration of an embed playback session (open → close).

     1. window.open interceptor with a user-gesture grace window.
        Programmatic popups (no recent click) are dropped silently;
        opens within 1 s of a real pointer/key/touch event are allowed.
     2. beforeunload guard. If the host or an ad iframe tries to navigate
        the top window away from the app while playback is active, the
        browser shows the standard "Leave site?" prompt.
     3. document.title watchdog. Some ad scripts mutate the parent title
        ("⚠ Virus detected!" etc.); we restore it every 750 ms.
     4. Counter is surfaced via a toast on deactivate so the user knows
        how many popups were blocked during the session.

   No-op when appSettings.theaterAdShield is false.
   ───────────────────────────────────────────────────────────────────── */
const AdShield = (() => {
  let active = false;
  let originalOpen = null;
  let originalTitle = '';
  let titleTimer = null;
  let lastGesture = 0;
  let blocked = 0;
  const GESTURE_GRACE_MS = 1000;

  const _markGesture = () => { lastGesture = Date.now(); };
  const _onBeforeUnload = (e) => {
    if (!active) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  };

  function activate() {
    if (active) return;
    if (!appSettings.theaterAdShield) return;
    active = true;
    blocked = 0;

    // (1) window.open interceptor — gated by recent-gesture flag.
    originalOpen = window.open;
    window.open = function(url, target, features) {
      const gestureAge = Date.now() - lastGesture;
      if (gestureAge > GESTURE_GRACE_MS) {
        blocked++;
        try { console.info('[AdShield] blocked popup:', url); } catch {}
        return null;
      }
      // Within grace window — allow same-origin opens (rare in this app).
      try {
        const u = new URL(url || '', location.href);
        if (u.origin === location.origin) {
          return originalOpen.call(window, url, target, features);
        }
      } catch {}
      blocked++;
      return null;
    };

    document.addEventListener('pointerdown', _markGesture, true);
    document.addEventListener('keydown',     _markGesture, true);
    document.addEventListener('touchstart',  _markGesture, true);

    // (2) beforeunload — only intercepts top-window unload, ignored by
    // browsers without user activation, so it doesn't fire on legitimate
    // closes (closeTheaterVideo runs deactivate() before any teardown).
    window.addEventListener('beforeunload', _onBeforeUnload);

    // (3) title watchdog.
    originalTitle = document.title;
    titleTimer = setInterval(() => {
      if (document.title !== originalTitle) document.title = originalTitle;
    }, 750);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    // try/finally guarantees the title watchdog interval is cleared even if
    // an earlier teardown step throws — otherwise the 750 ms timer would
    // outlive the AdShield session and keep rewriting document.title.
    try {
      if (originalOpen) { window.open = originalOpen; originalOpen = null; }
      document.removeEventListener('pointerdown', _markGesture, true);
      document.removeEventListener('keydown',     _markGesture, true);
      document.removeEventListener('touchstart',  _markGesture, true);
      window.removeEventListener('beforeunload', _onBeforeUnload);
      if (blocked > 0) {
        try { showToast(`\u{1F6E1} AD SHIELD BLOCKED ${blocked} POPUP${blocked===1?'':'S'}`); } catch {}
      }
      blocked = 0;
    } finally {
      if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
    }
  }

  return { activate, deactivate, isActive: () => active };
})();

async function openTheaterEmbed(payload, title, ctx) {
  const overlay = document.getElementById('theater-video-overlay');
  const stage   = document.getElementById('theater-video-stage');
  const label   = document.getElementById('theater-video-title');
  if (!overlay || !stage) return;
  AdShield.activate();
  // Mark embed mode on the stage so CSS can hide controls that have no
  // meaning for a cross-origin iframe (scrub bar, time display, ±10 s).
  stage.classList.add('tvp-embed-mode');

  // Tear down any prior native-video session before swapping in the iframe.
  const prevV = document.getElementById('theater-video');
  if (prevV) { try { prevV.pause(); prevV.removeAttribute('src'); prevV.load(); } catch {} }
  if (TheaterPlayer.hls) { try { TheaterPlayer.hls.destroy(); } catch {} TheaterPlayer.hls = null; }

  TheaterPlayer.payload  = payload;
  TheaterPlayer.ctx      = ctx || null;
  TheaterPlayer.resumed  = false;
  TheaterPlayer.resumeAt = 0;
  TheaterPlayer.embed    = true;
  TheaterPlayer.epList   = (ctx && Array.isArray(ctx._episodes)) ? ctx._episodes : [];
  TheaterPlayer.epIndex  = TheaterPlayer.epList.findIndex(ep => ep.id === ctx?.episodeId);
  if (state.screen !== 'theater-playing' && state.screen !== 'theater-paused') {
    TheaterPlayer.prevScreen = state.screen;
  }
  state.screen = 'theater-playing';
  AttractMode.onLeaveRoom();
  _tvpAcquireWakeLock();
  _tvpSetTitle(title);
  _tvpSetHeaderMeta([_fmtRuntime(ctx?.runtime)]);
  _tvpRefreshEpButtons();

  // Hide the native video element + quality selector; show an iframe instead.
  // The original DOM structure is restored on close so future MP4 / HLS
  // playback paths continue to work.
  if (prevV) prevV.style.display = 'none';
  document.getElementById('theater-video-loading').hidden = true;
  document.getElementById('theater-video-error').hidden   = true;
  const qWrap = document.getElementById('tvp-quality')?.closest('label, .tvp-quality-wrap')
                ?? document.getElementById('tvp-quality');
  if (qWrap) qWrap.style.visibility = 'hidden';
  // CC tracks live on the (now-hidden) <video>; the host iframe owns its own
  // caption UI. Keep the CC button visible but disabled-styled so the user
  // can still see captions are theoretically supported — clicking flashes a
  // "NO SUBTITLES AVAILABLE" toast via the existing _tvpCycleCC path.
  const ccBtn = document.getElementById('tvp-cc');
  if (ccBtn) {
    ccBtn.hidden = false;
    ccBtn.textContent = 'CC';
    ccBtn.classList.remove('tvp-btn-active');
    ccBtn.classList.add('tvp-btn-disabled');
  }
  TheaterPlayer.ccTracks = [];
  TheaterPlayer.ccIndex  = -1;

  let frame = document.getElementById('theater-video-iframe');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = 'theater-video-iframe';
    frame.allow = 'autoplay; fullscreen; picture-in-picture';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'no-referrer';
    Object.assign(frame.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      border: '0', background: '#000',
    });
    // Cancel the watchdog as soon as the host renders something. The load
    // event fires for cross-origin frames too (we just can't read the
    // body), so this is enough to know the network round-trip succeeded.
    // Skip the about:blank reset that precedes every src= write.
    frame.addEventListener('load', () => {
      try { if ((frame.src || '').startsWith('about:')) return; } catch {}
      _tvpClearWatchdog();
      _tvpHideEmbedLoading();
      // Reward the host that just rendered; biases future cold-launch picks.
      if (TheaterPlayer.activeSource) _tvpBumpScore(TheaterPlayer.activeSource, +1);
    });
    stage.appendChild(frame);
  }
  // Loading overlay sibling — sits inside the stage so it's clipped + scaled
  // alongside the iframe. Created once, reused for every source switch.
  let loading = document.getElementById('theater-embed-loading');
  if (!loading) {
    loading = document.createElement('div');
    loading.id = 'theater-embed-loading';
    loading.className = 'tel-loading';
    loading.hidden = true;
    loading.innerHTML =
      '<div class="tel-spinner"></div>' +
      '<div class="tel-label">LOADING SOURCE…</div>' +
      '<div class="tel-hint">↻ AUTO-ADVANCES IF UNRESPONSIVE</div>';
    stage.appendChild(loading);
  }
  // Sandbox is re-applied per-launch so toggling the Settings switch takes
  // effect on the next title without a page reload.
  //   OFF (default)       — attribute omitted entirely. Several hosts
  //                          (vidsrc family, embed.su, multiembed) probe for
  //                          window.frameElement.sandbox and abort with
  //                          "sandboxing is not allowed" / "media unavailable"
  //                          regardless of which tokens are granted, so the
  //                          only way to keep them playable is to not set
  //                          the attribute at all. Acceptable on a closed
  //                          single-user retro box.
  //   PERMISSIVE          — broad token set; works for most hosts that don't
  //                          actively probe.
  //   STRICT              — blocks popups + top-nav for max ad isolation.
  //   ULTRA               — also drops allow-same-origin so the host gets
  //                          a unique origin (kills cross-site cookies and
  //                          most tracking; breaks roughly half the hosts).
  const _sandboxMode = appSettings.theaterSandbox || 'OFF';
  if (_sandboxMode === 'OFF') {
    frame.removeAttribute('sandbox');
  } else {
    const _sandboxTokens = _sandboxMode === 'ULTRA' ? [
      'allow-scripts',
      'allow-forms',
      'allow-presentation',
    ] : _sandboxMode === 'STRICT' ? [
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-presentation',
    ] : [
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-presentation',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-top-navigation-by-user-activation',
      'allow-modals',
      'allow-orientation-lock',
      'allow-pointer-lock',
    ];
    frame.setAttribute('sandbox', _sandboxTokens.join(' '));
  }

  // Source switcher — when the backend ships a `sources[]` fallback chain,
  // render pills so the user can cycle through hosts (vidsrc/2embed/embed.su/
  // multiembed/etc.) until one of them actually has a working stream. Many
  // iframe aggregators show "No sources available" inside their player when
  // their CDN doesn't have a particular IMDB id; switching hosts is the
  // standard workaround. Persists the last-good host per session in
  // localStorage so the next launch starts on the user's preferred edge.
  const sources = (payload.source && payload.source.sources) || payload.sources || [];
  let initialUrl = payload.embed;
  let initialKey = payload.provider;
  if (sources.length) {
    let preferred = null;
    try { preferred = localStorage.getItem('kente.theater.embedSource') || null; } catch {}
    if (preferred) {
      const hit = sources.find(s => s.name === preferred);
      if (hit) { initialUrl = hit.url; initialKey = hit.name; }
    } else {
      // No explicit preference yet — pick the highest-scored host the user
      // has seen succeed before. Ties fall back to the backend's order
      // (which already biases anime to anime-aware hosts via `primary`).
      const scores = _tvpReadScores();
      let best = null, bestScore = -Infinity;
      sources.forEach((s, i) => {
        const sc = (scores[s.name] && typeof scores[s.name].score === 'number')
                   ? scores[s.name].score : 0;
        if (sc > bestScore) { best = s; bestScore = sc; }
      });
      if (best && bestScore > 0) { initialUrl = best.url; initialKey = best.name; }
    }
  }
  // Cache the source list on TheaterPlayer so the watchdog + cycle helpers
  // can resolve URLs without re-parsing the DOM. Falls back to a one-entry
  // list when the backend ships a single embed URL with no `sources[]`.
  TheaterPlayer.embedSources = sources.length
    ? sources
    : (initialUrl ? [{ name: initialKey, url: initialUrl, label: initialKey }] : []);
  TheaterPlayer.autoAdvanceTried = new Set();
  frame.style.display = 'block';

  // Provider badge — replaces the quality dropdown's affordance.
  let badge = document.getElementById('theater-embed-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'theater-embed-badge';
    badge.className = 'theater-embed-badge';
    stage.parentElement?.insertBefore(badge, stage);
  }
  badge.style.display = 'block';

  // Source dropdown — lives inside the controls bar so it auto-fades with
  // the rest of the chrome and never floats over the video. The slot is a
  // placeholder div in index.html; we just (re)mount the switcher into it.
  const sourceSlot = document.getElementById('tvp-source-slot');
  let switcher = document.getElementById('theater-source-switcher');
  if (!switcher) {
    switcher = document.createElement('div');
    switcher.id = 'theater-source-switcher';
    switcher.className = 'theater-source-switcher';
  }
  if (sourceSlot && switcher.parentElement !== sourceSlot) sourceSlot.appendChild(switcher);
  if (sources.length >= 2) {
    const activeSrc = sources.find(s => s.name === initialKey) || sources[0];
    const triggerLabel = (activeSrc?.label || activeSrc?.name || 'SOURCE').toUpperCase();
    switcher.innerHTML =
        `<button type="button" class="tss-trigger" aria-haspopup="listbox" aria-expanded="false" title="Switch source">`
      +   `<span class="tss-trigger-label">${escHtml(triggerLabel)}</span>`
      +   `<span class="tss-trigger-caret">▾</span>`
      + `</button>`
      + `<div class="tss-menu" role="listbox" hidden>`
      +   sources.map(s =>
            `<button type="button" class="tss-option${s.name === initialKey ? ' active' : ''}" `
            + `role="option" data-key="${escHtml(s.name)}" `
            + `data-label="${escHtml(s.label || s.name)}">${escHtml(s.label || s.name)}</button>`
          ).join('')
      + `</div>`;
    switcher.style.display = 'inline-flex';
    const trigger = switcher.querySelector('.tss-trigger');
    const menu    = switcher.querySelector('.tss-menu');
    const closeMenu = () => {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      switcher.classList.remove('tss-open');
    };
    const openMenu = () => {
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      switcher.classList.add('tss-open');
    };
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden ? openMenu() : closeMenu();
    });
    // Click outside closes — single doc listener, removed when switcher dies.
    const onDocClick = (ev) => { if (!switcher.contains(ev.target)) closeMenu(); };
    document.addEventListener('click', onDocClick);
    switcher._tssOff = () => document.removeEventListener('click', onDocClick);
    menu.querySelectorAll('.tss-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-key');
        const src = (TheaterPlayer.embedSources || []).find(s => s.name === key);
        closeMenu();
        if (!src) return;
        // User just intervened — drop the auto-advance ledger so the next
        // host gets a clean watchdog window instead of being skipped.
        TheaterPlayer.autoAdvanceTried = new Set();
        _tvpLoadEmbedSource(frame, src, { auto: false });
      });
    });
  } else {
    switcher.innerHTML = '';
    switcher.style.display = 'none';
    if (switcher._tssOff) { switcher._tssOff(); switcher._tssOff = null; }
  }

  // Initial load goes through the same helper as manual pill clicks so
  // the watchdog / badge / activeSource state stays consistent.
  const _initial = TheaterPlayer.embedSources.find(s => s.name === initialKey)
                || TheaterPlayer.embedSources[0];
  if (_initial) {
    _tvpLoadEmbedSource(frame, _initial, { auto: false });
  } else {
    // No usable source at all — fall back to whatever the payload had.
    try { frame.src = initialUrl || 'about:blank'; } catch {}
    if (badge) badge.textContent = `EMBEDDED PLAYER · ${(initialKey || 'EXTERNAL').toUpperCase()}`;
    TheaterPlayer.activeSource = initialKey;
  }

  overlay.classList.add('active');
  KenteAudio.setHumVol(0);
  closeTheaterDetail();
}

function closeTheaterVideo() {
  const overlay = document.getElementById('theater-video-overlay');
  const v       = document.getElementById('theater-video');
  const stage   = document.getElementById('theater-video-stage');
  if (!overlay) return;
  stage?.classList.remove('tvp-embed-mode');
  // Drop AdShield first so the beforeunload guard doesn't trip on the
  // user's own close action and the popup-block toast can render.
  AdShield.deactivate();
  // Iframe path: tear down the iframe, restore the native <video>, hide badge.
  const frame = document.getElementById('theater-video-iframe');
  if (frame) { try { frame.src = 'about:blank'; } catch {} frame.style.display = 'none'; }
  const badge = document.getElementById('theater-embed-badge');
  if (badge) badge.style.display = 'none';
  const switcher = document.getElementById('theater-source-switcher');
  if (switcher) {
    // Drop the document-level click listener installed when the menu was
    // built, otherwise it survives across plays and accumulates.
    if (switcher._tssOff) { switcher._tssOff(); switcher._tssOff = null; }
    switcher.innerHTML = '';
    switcher.style.display = 'none';
  }
  _tvpHideEmbedLoading();
  if (v) v.style.display = '';
  const qWrap = document.getElementById('tvp-quality')?.closest('label, .tvp-quality-wrap')
                ?? document.getElementById('tvp-quality');
  if (qWrap) qWrap.style.visibility = '';
  // Tear down CC tracks + reset header meta chip for the next session.
  if (v) v.querySelectorAll('track[data-tvp-cc]').forEach(t => t.remove());
  TheaterPlayer.ccTracks = [];
  TheaterPlayer.ccIndex  = -1;
  const ccBtn = document.getElementById('tvp-cc');
  if (ccBtn) {
    ccBtn.hidden = false;
    ccBtn.textContent = 'CC';
    ccBtn.classList.remove('tvp-btn-active');
    ccBtn.classList.add('tvp-btn-disabled');
  }
  _tvpSetHeaderMeta([]);
  // Final progress save before tearing the player down — only meaningful for
  // the native <video> path; iframe sessions can't be polled.
  if (!TheaterPlayer.embed && v && TheaterPlayer.ctx && v.currentTime > 1 && TheaterPlayer.resumed) {
    try { TheaterDB.saveProgress(TheaterPlayer.ctx, v.currentTime, v.duration || 0); } catch {}
  }
  if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} }
  if (TheaterPlayer.hls) { try { TheaterPlayer.hls.destroy(); } catch {} TheaterPlayer.hls = null; }
  TheaterPlayer.payload = null;
  TheaterPlayer.ctx     = null;
  TheaterPlayer.resumed = false;
  TheaterPlayer.resumeAt = 0;
  TheaterPlayer.embed   = false;
  TheaterPlayer.activeSource = null;
  TheaterPlayer.embedSources = [];
  TheaterPlayer.epList    = [];
  TheaterPlayer.epIndex   = -1;
  TheaterPlayer.autoAdvanceTried = null;
  _tvpUpNextResetForEpisode();
  TheaterPlayer.loadGen++;          // invalidate any in-flight watchdog
  // Reset playback rate to 1× so the next session doesn't inherit the prior
  // speed; the help overlay also collapses on close.
  TheaterPlayer.speedIdx = 2;
  _tvpApplySpeed(1);
  _tvpHideHelp();
  // Hide the prev/next-episode buttons + clear the disabled-state classes
  // so the next playback session opens with clean chrome.
  ['tvp-prev-ep','tvp-next-ep'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.hidden = true; b.classList.add('tvp-btn-disabled'); }
  });
  _tvpClearWatchdog();
  // Drop miniplayer chrome before hiding the overlay — keeps state.screen
  // and the MINI button label consistent for the next playback session.
  if (TheaterPlayer.miniplayer) {
    TheaterPlayer.miniplayer = false;
    overlay.classList.remove('miniplayer-mode', 'mp-dragging');
    const mb = document.getElementById('theater-video-mini');
    if (mb) mb.textContent = '⬓ MINI';
  }
  overlay.classList.remove('active');
  document.getElementById('theater-video-stage')?.classList.remove('tvp-idle','tvp-paused');
  // Tear down pause menu + release wake lock + restore state.screen.
  document.getElementById('theater-pause-menu')?.classList.remove('active');
  _tvpReleaseWakeLock();
  const prev = TheaterPlayer.prevScreen || 'menu';
  TheaterPlayer.prevScreen = null;
  // If we're already on the previous screen (because miniplayer restored
  // it earlier), don't clobber the user's current location.
  if (state.screen === 'theater-playing' || state.screen === 'theater-paused') {
    state.screen = prev;
  }
  if (state.screen === 'menu' || prev === 'menu') KenteAudio.setHumVol(0.018);
}

// Wire close button + backdrop close on DOM ready.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('theater-video-close')?.addEventListener('click', closeTheaterVideo);
  document.getElementById('theater-video-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'theater-video-overlay') closeTheaterVideo();
  });
  document.addEventListener('keydown', e => {
    const ovActive = document.getElementById('theater-video-overlay')?.classList.contains('active');
    if (!ovActive) return;
    // Escape: route through pause menu — first press pauses, second closes.
    if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      if (state.screen === 'theater-paused') hideTheaterPauseMenu();
      else if (state.screen === 'theater-playing') showTheaterPauseMenu();
      else closeTheaterVideo();
      return;
    }
    // Pause-menu keyboard navigation
    if (state.screen === 'theater-paused') {
      const btns = _tpmButtons();
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        TheaterPlayer.pauseMenuFocus = (TheaterPlayer.pauseMenuFocus + 1) % btns.length;
        _tpmUpdateFocus();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        TheaterPlayer.pauseMenuFocus = (TheaterPlayer.pauseMenuFocus - 1 + btns.length) % btns.length;
        _tpmUpdateFocus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        btns[TheaterPlayer.pauseMenuFocus]?.click();
      }
      return;
    }
    // Lightweight player shortcuts while playing (native <video> only).
    if (state.screen === 'theater-playing' && !TheaterPlayer.embed) {
      const v = document.getElementById('theater-video');
      if (!v) return;
      if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); }
      else if (e.key === 'ArrowUp')    { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.05); }
      else if (e.key === 'ArrowDown')  { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.05); }
    }
  });
});

/* ══════════════════════════════════════════
   GLOBAL CLICK DELEGATION
══════════════════════════════════════════ */
document.addEventListener('click', e => {
  // ── Theater poster cards (Netflix-style detail open) ──
  const theaterPoster = e.target.closest('.theater-poster');
  if (theaterPoster) {
    KenteAudio.click();
    const { provider, kind, slug, title } = theaterPoster.dataset;
    if (provider && slug) openTheaterDetail(provider, kind || 'movie', slug, title);
    return;
  }

  // ── Game cards ──
  const gameCard = e.target.closest('.game-card[data-id]');
  if (gameCard && !e.target.closest('#game-detail-panel')) {
    openGameDetail(gameCard.dataset.id); return;
  }

  // ── Source cards ──
  const srcCard = e.target.closest('.source-card[data-src]');
  if (srcCard) {
    openSourceDetail(srcCard.dataset.name, srcCard.dataset.icon, srcCard.dataset.status, Number(srcCard.dataset.count));
    return;
  }

  // ── Filter chips ──
  if (e.target.classList.contains('filter-chip')) {
    KenteAudio.click();
    const bar = e.target.closest('.filter-bar');
    if (bar) bar.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    e.target.classList.add('active');
    if (bar?.id === 'play-filter-bar') {
      const sys = e.target.dataset.system || 'all';
      document.querySelectorAll('#play-grid .game-card').forEach(card => {
        card.style.display = (sys === 'all' || card.dataset.system === sys) ? '' : 'none';
      });
    }
    if (bar?.id === 'col-filter-bar') {
      const col   = e.target.dataset.col || 'all';
      const strip = document.getElementById('col-info-strip');
      const grid  = document.getElementById('col-grid');

      // Restore original DOM order before every filter operation so
      // switching away from A-Z (or between collections) always starts clean.
      if (grid) {
        [...grid.children]
          .sort((a, b) => Number(a.dataset.origIdx || 0) - Number(b.dataset.origIdx || 0))
          .forEach(c => grid.appendChild(c));
      }

      if (col === 'az') {
        // Show every card, then sort the DOM nodes alphabetically by title
        if (grid) {
          [...grid.children].forEach(c => c.style.display = '');
          [...grid.children]
            .sort((a, b) => (a.dataset.title || '').localeCompare(b.dataset.title || ''))
            .forEach(c => grid.appendChild(c));
        }
        if (strip) {
          const total = grid ? grid.childElementCount : 0;
          strip.hidden = false;
          strip.innerHTML = `
            <span class="col-info-icon">🔤</span>
            <div class="col-info-text">
              <div class="col-info-name">A–Z</div>
              <div class="col-info-desc">ALL TITLES SORTED ALPHABETICALLY · ${total} GAME${total !== 1 ? 'S' : ''}</div>
            </div>`;
        }
      } else if (col === 'favorites') {
        // ★ Favorites filter — show only favorited games
        const favSet = new Set(getFavorites());
        document.querySelectorAll('#col-grid .game-card').forEach(card => {
          card.style.display = favSet.has(card.dataset.id) ? '' : 'none';
        });
        if (strip) {
          strip.hidden = false;
          strip.innerHTML = `
            <span class="col-info-icon">★</span>
            <div class="col-info-text">
              <div class="col-info-name">FAVORITES</div>
              <div class="col-info-desc">YOUR STARRED GAMES · ${favSet.size} TITLE${favSet.size !== 1 ? 'S' : ''}</div>
            </div>`;
        }
      } else {
        // Normal collection filter (all = show everything, col-id = tag filter)
        document.querySelectorAll('#col-grid .game-card').forEach(card => {
          const cardCols = (card.dataset.col || '').split(' ');
          card.style.display = (col === 'all' || cardCols.includes(col)) ? '' : 'none';
        });

        // Info strip — hide for ALL, show details for a specific collection
        if (strip) {
          if (col === 'all') {
            strip.hidden = true;
          } else {
            // dataset read-back decodes HTML entities (e.g. &quot; → "), so
            // re-escape before injecting into innerHTML.
            const { colIcon: icon, colName: name, colDesc: desc, colCount: count } = e.target.dataset;
            strip.hidden = false;
            strip.innerHTML = `
              <span class="col-info-icon">${escHtml(icon)}</span>
              <div class="col-info-text">
                <div class="col-info-name">${escHtml(name)}</div>
                <div class="col-info-desc">${escHtml(desc)} · ${escHtml(count)} TITLE${Number(count)!==1?'S':''}</div>
              </div>`;
          }
        }
      }
    }
    // Theater chips are wired in hydrateTheaterMenu() — leave them alone here.
    return;
  }

  // ── Interactive settings items ──
  const settingItem = e.target.closest('.settings-item[data-setting]');
  if (settingItem) {
    const key  = settingItem.dataset.setting;
    const type = settingItem.dataset.type;
    if (type === 'toggle') {
      appSettings[key] = !appSettings[key];
    } else if (type === 'cycle') {
      const opts = JSON.parse(settingItem.dataset.opts);
      const cur  = opts.indexOf(appSettings[key]);
      appSettings[key] = opts[(cur + 1) % opts.length];
    }
    saveSettings();
    applySetting(key);
    KenteAudio.click();
    // Refresh just this value
    const valEl = settingItem.querySelector('.settings-item-value');
    const cfg   = SETTINGS_CONFIG.flatMap(g=>g.items).find(i=>i.key===key);
    if (valEl && cfg) {
      const v = appSettings[key];
      valEl.textContent = cfg.type === 'toggle' ? (v?'ON':'OFF') : (typeof v==='number' ? v+'%' : v);
    }
    return;
  }

  // ── Network action items ──
  const netItem = e.target.closest('[data-net-action]');
  if (netItem) {
    const na = netItem.dataset.netAction;
    if (na === 'scan')       { KenteAudio.click(); wifiScanAndShow(); return; }
    if (na === 'disconnect') { KenteAudio.click(); wifiDisconnect(); return; }
    if (na === 'refresh')    { KenteAudio.click(); hydrateNetworkStatus(); return; }
  }
  // ── WiFi network list item click ──
  const wifiItem = e.target.closest('.wifi-item');
  if (wifiItem) {
    KenteAudio.click();
    wifiConnect(wifiItem.dataset.ssid, wifiItem.dataset.secured === '1');
    return;
  }

  // ── Settings action items ──
  const actionItem = e.target.closest('[data-action]');
  if (actionItem) {
    const action = actionItem.dataset.action;
    if (action === 'openChamber') openChamber();
    if (action === 'resetSystems') {
      if (confirm('Factory reset all sacrificed systems? This cannot be undone.')) {
        resetSystemState();
        showToast('✓ SYSTEMS RESTORED TO FACTORY DEFAULT');
      }
    }
    if (action === 'addSource') {
      KenteAudio.click();
      // Custom source linking is a planned V2 feature.
      // For now, direct the user to the Cloud Browser — the current way to
      // stream and save ROMs from Archive.org without any local source config.
      showToast('⚡ USE THE CLOUD BROWSER TO ADD ROMS — OPEN IT FROM ANY GAME ZONE');
    }
    if (action === 'openCloud') {
      KenteAudio.click();
      openCloudBrowser(actionItem.dataset.provider || 'archive');
    }
    if (action === 'setLibrary') {
      KenteAudio.click();
      setRomLibraryRoot(); // async, fire-and-forget — shows its own toast on complete
    }
    if (action === 'openDownloads') {
      openDownloadCenter();
    }
    if (action === 'openKenteRepo') {
      openKenteRepo();
    }
    if (action === 'calibrate') {
      KenteAudio.click();
      CalibrationManager.open();
    }
    if (action === 'usbGuide') {
      KenteAudio.click();
      openGuide('usb');
    }
    if (action === 'ps4Guide') {
      KenteAudio.click();
      openGuide('ps4');
    }
  }

  // ── Generic launch-overlay dismiss (covers showNativeModeRequired + any unnamed dismiss btn) ──
  if (e.target.classList.contains('launch-dismiss')) {
    document.getElementById('launch-overlay')?.classList.remove('active');
    return;
  }

  // ── Download Control Center panel buttons ──
  const dlAction = e.target.dataset.dlaction;
  const dlId     = e.target.dataset.dlid;
  if (dlAction) {
    if (dlAction === 'clearCompleted') { DownloadManager.clearCompleted(); return; }
    if (dlId) {
      if (dlAction === 'cancel')      { DownloadManager.cancel(dlId);      return; }
      if (dlAction === 'remove')      { DownloadManager.remove(dlId);      return; }
      if (dlAction === 'retry')       { DownloadManager.retry(dlId);       return; }
      if (dlAction === 'cycleSource') { DownloadManager.cycleSource(dlId); return; }
      if (dlAction === 'launch')      { launchFromDownloadCenter(dlId);    return; }
    }
  }

  // ── In-game pause menu ──
  if (e.target.closest('#igm-resume')) {
    KenteAudio.click();
    hideIngameMenu();
    return;
  }
  if (e.target.closest('#igm-close')) {
    KenteAudio.click();
    closeGame();
    return;
  }
  if (e.target.closest('#igm-mainmenu')) {
    KenteAudio.click();
    exitEmulator();
    return;
  }

  // ── Memory Card profile selection ──
  const profCard = e.target.closest('.profile-card');
  if (profCard) {
    KenteAudio.click();
    state.activeProfile = profCard.dataset.profile || 'player1';
    document.querySelectorAll('.profile-card').forEach(c =>
      c.classList.toggle('active', c.dataset.profile === state.activeProfile)
    );
    try { localStorage.setItem('kente_profile', state.activeProfile); } catch {}
    showToast(`✓ PROFILE: ${(profCard.querySelector('.profile-name')?.textContent || state.activeProfile).toUpperCase()}`);
  }
});

/* ══════════════════════════════════════════
   ATTRACT MODE
   Triggers after 30 s of inactivity while on
   the room screen. Cycles through game titles.
   Any input dismisses it.
══════════════════════════════════════════ */
const AttractMode = (() => {
  const IDLE_MS  = 30_000;   // 30 s before attract fires
  const CYCLE_MS = 3_000;    // rotate title every 3 s

  let _idleTimer  = null;
  let _cycleTimer = null;
  let _active     = false;
  let _gameIdx    = 0;

  function _allGames() {
    // SYSTEMS is the module-scoped array (kente.js §09).
    // window.KenteLibrary has no .systems property — that caused every game to be
    // filtered out, leaving attract mode permanently stuck on the fallback title.
    return (window.KenteLibrary?.games || []).filter(g => {
      const sys = SYSTEMS.find(s => s.id === g.systemId);
      return sys && sys.active && !sys.sacrificed;
    });
  }

  function _cycleTitle() {
    const games = _allGames();
    if (!games.length) return;
    _gameIdx = (_gameIdx + 1) % games.length;
    const g  = games[_gameIdx];
    const el = document.getElementById('attract-title');
    const sys = document.getElementById('attract-sys');
    if (el)  { el.style.opacity  = '0'; setTimeout(() => { if (el)  { el.textContent  = g.title.toUpperCase();  el.style.opacity  = '1'; }}, 300); }
    if (sys) { sys.style.opacity = '0'; setTimeout(() => { if (sys) { sys.textContent = (g.system || g.systemId).toUpperCase() + ' · ' + g.year; sys.style.opacity = '1'; }}, 300); }
  }

  function enter() {
    if (_active || state.screen !== 'room') return;
    _active  = true;
    _gameIdx = 0;
    document.body.classList.add('attract-mode');
    const games   = _allGames();
    const g       = games[0] || { title: "KENTE'S KORNER", system: 'READY', year: '' };
    const overlay = document.getElementById('attract-overlay');
    if (overlay) {
      const titleEl = overlay.querySelector('#attract-title');
      const sysEl   = overlay.querySelector('#attract-sys');
      if (titleEl) titleEl.textContent = g.title.toUpperCase();
      if (sysEl)   sysEl.textContent   = (g.system || g.systemId || '').toUpperCase() + (g.year ? ' · ' + g.year : '');
      overlay.classList.add('active');
    }
    _cycleTimer = setInterval(_cycleTitle, CYCLE_MS);
  }

  function exit() {
    if (!_active) return;
    _active = false;
    document.body.classList.remove('attract-mode');
    const overlay = document.getElementById('attract-overlay');
    if (overlay) overlay.classList.remove('active');
    clearInterval(_cycleTimer);
    _cycleTimer = null;
    _resetIdleTimer();
  }

  function _resetIdleTimer() {
    clearTimeout(_idleTimer);
    if (state.screen === 'room') {
      _idleTimer = setTimeout(enter, IDLE_MS);
    }
  }

  function _onActivity() {
    if (_active) { exit(); return; }
    _resetIdleTimer();
  }

  function init() {
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'click', 'gamepadconnected']
      .forEach(ev => document.addEventListener(ev, _onActivity, { passive: true }));
  }

  function onEnterRoom() { _resetIdleTimer(); }
  function onLeaveRoom() { clearTimeout(_idleTimer); if (_active) exit(); }

  return { init, enter, exit, onEnterRoom, onLeaveRoom };
})();

/* ══════════════════════════════════════════
   KICK IT OFF
══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', boot);
