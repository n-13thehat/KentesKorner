/* Kente's Korner — ROM matcher, folder scanner, ROM options, BIOS picker, connectivity. */
'use strict';

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
