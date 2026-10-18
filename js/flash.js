/* Kente's Korner — Flash gamepad relay, controls reference, Ruffle launcher. */
'use strict';

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
