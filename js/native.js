/* Kente's Korner — Native server detection, mods, native launchers and downloads. */
'use strict';

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

async function launchNative(game, fromCloud = false, installAttempted = false, ps3SetupAttempted = false) {
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
      // Native launches may need time to extract large ROM archives (.zip/.7z) before boot.
      signal:  _abortTimeout(10 * 60_000),
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

    } else if ((data.error === 'PS3_FIRMWARE_MISSING' || data.error === 'PS3_FIRMWARE_INSTALLING') && !ps3SetupAttempted) {
      // RPCS3 needs PS3 firmware (PS3UPDAT.PUP). Trigger the BIOS setup thread (which
      // downloads the official firmware if missing) and show live progress.
      con.innerHTML = `
        <div class="launch-title">SETTING UP PS3</div>
        <div class="launch-game">${escHtml(game.title)}</div>
        <div class="launch-sys">PLAYSTATION 3 · FIRMWARE</div>
        <div id="ps3-fw-status" style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);
                    letter-spacing:0.15em;margin-top:24px">
          PREPARING FIRMWARE...
        </div>`;
      con.appendChild(cancelBtn);

      const statusEl = () => document.getElementById('ps3-fw-status');
      try {
        await fetch(`${KENTE_SERVER_URL}/api/bios/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowDownload: true }),
          signal: _abortTimeout(8000),
        });
      } catch { /* non-fatal */ }

      let tries = 0;
      while (tries++ < 1200) { // up to ~30 min
        if (!overlay.classList.contains('active')) return; // user cancelled
        try {
          const sr = await fetch(`${KENTE_SERVER_URL}/api/bios/download/status`, { signal: _abortTimeout(4000) });
          if (!sr.ok) { await new Promise(r => setTimeout(r, 1200)); continue; }
          const st = await sr.json();
          const phase = (st.phase || st.current || 'WORKING').toString().toUpperCase();
          if (statusEl()) statusEl().textContent = `${phase}...`;
          if (st.error) {
            _closeLaunchOverlay();
            KenteAudio.setHumVol(0.018);
            const fwReason = st.results?.rpcs3_firmware?.reason || '';
            if (fwReason === 'pup_missing') {
              showToast('⚠ PS3 FIRMWARE MISSING — PUT PS3UPDAT.PUP IN YOUR BIOS FOLDER');
            } else if (fwReason === 'firmware_url_failed' || fwReason === 'download_failed') {
              showToast('⚠ PS3 FIRMWARE DOWNLOAD FAILED — CONNECT INTERNET OR ADD PS3UPDAT.PUP MANUALLY');
            } else {
              showToast('⚠ PS3 FIRMWARE SETUP FAILED — CHECK BIOS/NETWORK');
            }
            return;
          }
          if (st.done) break;
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 1500));
      }

      // Retry launch once after setup completes.
      await launchNative(game, fromCloud, installAttempted, true);

    } else if (data.error === 'PS3_KEY_MISSING') {
      _closeLaunchOverlay();
      KenteAudio.setHumVol(0.018);
      showToast('⚠ PS3 ISO NEEDS A DISC KEY (.KEY/.DKEY) NEXT TO THE ISO');
      return;
    } else if (data.error === 'PS3_BAD_DUMP') {
      _closeLaunchOverlay();
      KenteAudio.setHumVol(0.018);
      showToast('⚠ PS3 FOLDER DUMP INVALID — MUST CONTAIN PS3_GAME/');
      return;
    } else if (data.error === 'NO_EMULATOR' && !installAttempted) {
      // Missing native emulator (PCSX2/RPCS3/etc.). Trigger the server's dependency
      // installer and show live progress, then retry the launch once.
      con.innerHTML = `
        <div class="launch-title">INSTALLING EMULATOR</div>
        <div class="launch-game">${escHtml(game.title)}</div>
        <div class="launch-sys">${(game.system || game.systemId || '').toUpperCase()} · DEPENDENCIES</div>
        <div id="emu-inst-status" style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);
                    letter-spacing:0.15em;margin-top:24px">
          STARTING INSTALL...
        </div>`;
      con.appendChild(cancelBtn);

      const statusEl = () => document.getElementById('emu-inst-status');
      try {
        await fetch(`${KENTE_SERVER_URL}/api/emulators/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ systemId: game.systemId }),
          signal: _abortTimeout(10 * 60_000),
        });
      } catch (e) {
        _closeLaunchOverlay();
        KenteAudio.setHumVol(0.018);
        showToast('⚠ COULD NOT START EMULATOR INSTALL — CHECK SERVER');
        return;
      }

      // Poll install status until done, then retry launch.
      let tries = 0;
      while (tries++ < 360) { // ~12 minutes
        if (!overlay.classList.contains('active')) return; // user cancelled
        try {
          const sr = await fetch(`${KENTE_SERVER_URL}/api/emulators/install/status`, { signal: _abortTimeout(3000) });
          if (!sr.ok) { await new Promise(r => setTimeout(r, 1200)); continue; }
          const st = await sr.json();
          const cur = (st.current || '').toUpperCase();
          if (statusEl()) statusEl().textContent = cur ? `INSTALLING ${cur}...` : 'FINALIZING...';
          if (st.error) {
            _closeLaunchOverlay();
            KenteAudio.setHumVol(0.018);
            showToast(`⚠ EMULATOR INSTALL FAILED — ${String(st.error).toUpperCase()}`);
            return;
          }
          if (st.done) break;
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 1500));
      }
      // Retry launch once after install completes.
      await launchNative(game, fromCloud, true, ps3SetupAttempted);
    } else if (data.error === 'ROM_NOT_FOUND' && !fromCloud) {
      // ROM missing from disk — queue a background download and auto-launch once ready.
      // This keeps the UI responsive and lets large ISOs download without blocking
      // the "launch" overlay loop.
      try {
        await DownloadManager.enqueue(game, { autoLaunch: true });
        _closeLaunchOverlay();
        KenteAudio.setHumVol(0.018);
        openDownloadCenter();
      } catch {
        // Fallback: legacy inline download flow (blocking overlay).
        launchNativeFromCloud(game, overlay, con);
      }
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
      // Composite score: orphan-cue penalty → extension rank → region → size.
      // Mirrors _collectCloudMirrors above so the native-download path makes
      // the same picks as the EmulatorJS path.
      const _EXT_RANK = EXT_RANK_BY_SYS[game.systemId] || null;
      const _extScore = n => {
        if (!_EXT_RANK) return 0;
        const nl = n.toLowerCase();
        for (let i = 0; i < _EXT_RANK.length; i++) {
          if (nl.endsWith(_EXT_RANK[i])) return _EXT_RANK.length - i;
        }
        return 0;
      };
      const _hasCompanion = (n, all) => {
        const nl = n.toLowerCase();
        if (!nl.endsWith('.cue') && !nl.endsWith('.ccd')) return true;
        const stem = nl.replace(/\.(cue|ccd)$/, '');
        return all.some(o => {
          const ol = o.name.toLowerCase();
          if (ol === nl) return false;
          if (!ol.endsWith('.bin') && !ol.endsWith('.img') && !ol.endsWith('.sub')) return false;
          const oStem = ol.replace(/\.[^.]+$/, '');
          return oStem.startsWith(stem) || stem.includes(oStem) || oStem.includes(stem);
        });
      };
      pool.sort((a, b) => {
        const orphan = n => (_hasCompanion(n, valid) ? 0 : -10);
        const region = n => RGN_USA.test(n) ? 3
                          : !RGN_EU.test(n) && !RGN_JP.test(n) ? 2
                          : RGN_EU.test(n) ? 1 : 0;
        return (orphan(b.name) - orphan(a.name))
            || (_extScore(b.name) - _extScore(a.name))
            || (region(b.name)    - region(a.name))
            || ((Number(b.size)||0) - (Number(a.size)||0));
      });
      const match = pool[0];
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
