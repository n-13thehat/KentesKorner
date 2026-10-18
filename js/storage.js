/* Kente's Korner — Native server flags, BIOS map, IndexedDB / OPFS layers, source ledger. */
'use strict';

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
// RomDB lives in js/rom_db.js, loaded by index.html before the other js/ files.  The
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

/* ── Extract upstream status from a /api/rom-proxy 502 body ────────────────
   The proxy returns JSON like {error, upstreamStatus, upstreamHost, code}
   when archive.org or another CDN returns 5xx. We thread the upstream code
   into the error message so the toast can show the real cause
   (e.g. "DOWNLOAD FAILED — UPSTREAM 503 ARCHIVE.ORG") instead of a generic
   HTTP_502. Shared by DownloadManager and the cloud-launch path.          */
async function _proxyErrorTag(resp) {
  try {
    const j = await resp.clone().json();
    if (j?.upstreamStatus) {
      const host = (j.upstreamHost || '').toUpperCase();
      return `UPSTREAM_${j.upstreamStatus}${host ? '_' + host : ''}`;
    }
    if (j?.code) return j.code;
  } catch (_) { /* not JSON or already consumed */ }
  return `HTTP_${resp.status}`;
}
