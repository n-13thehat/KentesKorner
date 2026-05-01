/* ══════════════════════════════════════════
   RomDB — IndexedDB ROM handle persistence
   ──────────────────────────────────────────
   Extracted from kente.js as the first step toward modularising the
   monolithic renderer.  Loaded as a separate <script> before kente.js so
   the global `RomDB` symbol is available when the main script runs.
══════════════════════════════════════════ */
const RomDB = (() => {
  const DB_NAME = 'kente_roms', STORE = 'handles', VER = 1;
  let db = null;

  function open() {
    return new Promise((res, rej) => {
      if (db) return res(db);
      const req = indexedDB.open(DB_NAME, VER);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE, { keyPath: 'gameId' });
      req.onsuccess = e => { db = e.target.result; res(db); };
      req.onerror   = () => rej(req.error);
    });
  }

  async function get(gameId) {
    const db  = await open();
    return new Promise(res => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(gameId);
      req.onsuccess = () => res(req.result?.handle || null);
      req.onerror   = () => res(null);
    });
  }

  /** Returns the full stored record {gameId, handle, fileName, savedAt} or null */
  async function getMeta(gameId) {
    const db  = await open();
    return new Promise(res => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(gameId);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => res(null);
    });
  }

  async function set(gameId, handle, fileName) {
    try {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = res;
        tx.onerror    = () => rej(tx.error);
        tx.onabort    = () => rej(new Error('IDB transaction aborted'));
        tx.objectStore(STORE).put({ gameId, handle, fileName, savedAt: Date.now() });
      });
    } catch (err) {
      console.warn('[RomDB] set failed (handle may not be serializable):', err.message);
    }
  }

  async function remove(gameId) {
    try {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(gameId);
    } catch (err) {
      console.warn('[RomDB] remove failed:', err.message);
    }
  }

  return { get, getMeta, set, remove };
})();
