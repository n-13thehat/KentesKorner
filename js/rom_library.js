/* Kente's Korner — ROM library (directory-based indexing). */
'use strict';

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
