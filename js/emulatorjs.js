/* Kente's Korner — EmulatorJS launcher. */
'use strict';

/* ══════════════════════════════════════════
   EMULATORJS LAUNCHER
══════════════════════════════════════════ */
let _currentRomUrl  = null;
let _currentBiosUrl = null;
let _flashIframe    = null;   // active Flash iframe (for gamepad relay)
let _flashRelayRaf  = null;   // rAF handle for the relay loop
let _flycastPatchApplied = false;

function _applyFlycastWebgl2Patch() {
  // Avoid re-wrapping getContext / console.warn across launches.
  if (_flycastPatchApplied) return;
  _flycastPatchApplied = true;
  try {
    const _orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(t, a) {
      const ctx = _orig.call(this, t, a);
      if (!ctx || typeof WebGL2RenderingContext !== 'function' || !(ctx instanceof WebGL2RenderingContext)) return ctx;
      const oGP = ctx.getParameter.bind(ctx);
      ctx.getParameter = function(p) {
        if (p === 0x1F02) return 'OpenGL ES 3.0 WebGL 2.0';
        if (p === 0x8B8C) return 'OpenGL ES GLSL ES 3.00';
        return oGP(p);
      };
      const oGE = ctx.getError.bind(ctx);
      ctx.getError = function() {
        let e = oGE();
        while (e === 0x500) e = oGE();
        return e;
      };
      const tb = {};
      tb[ctx.TEXTURE_2D]       = ctx.TEXTURE_BINDING_2D;
      tb[ctx.TEXTURE_CUBE_MAP] = ctx.TEXTURE_BINDING_CUBE_MAP;
      tb[ctx.TEXTURE_3D]       = ctx.TEXTURE_BINDING_3D;
      tb[ctx.TEXTURE_2D_ARRAY] = ctx.TEXTURE_BINDING_2D_ARRAY;
      const oTI = ctx.texParameteri.bind(ctx);
      ctx.texParameteri = function(t2, p2, v2) {
        const b = tb[t2];
        if (b && !oGP(b)) return;
        return oTI(t2, p2, v2);
      };
      const oTF = ctx.texParameterf.bind(ctx);
      ctx.texParameterf = function(t2, p2, v2) {
        const b = tb[t2];
        if (b && !oGP(b)) return;
        return oTF(t2, p2, v2);
      };
      return ctx;
    };

    const _ow = console.warn;
    console.warn = function() {
      const s = arguments[0];
      if (typeof s === 'string' && (s.includes('__syscall_mprotect') || s.includes('is not a valid value'))) return;
      _ow.apply(console, arguments);
    };
  } catch {}
}

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

  // ── EmulatorJS asset source ───────────────────────────────────────────────────
  // Default: load EmulatorJS from the public CDN.
  // If the local kente-server is reachable (LAN/offline OK), route ALL EmulatorJS
  // assets through its /api/ejs/ proxy so offline play can work from cache/mirror.
  //
  // Dreamcast is special: the flycast-wasm core is not on the stable CDN, so it
  // requires the kente-server to provide that community core.
  const isDreamcast = (game.systemId === 'dreamcast');
  const useEjsProxy = !!KENTE_SERVER_ONLINE;
  if (isDreamcast && !useEjsProxy) {
    overlay.classList.remove('active');
    cloudBadge.hidden = true; saveBtn.hidden = true;
    KenteAudio.setHumVol(0.018);
    showNativeModeRequired(game);
    return;
  }
  // For Dreamcast, suppress EJS_biosUrl — we write the BIOS directly to the WASM FS
  // in EJS_ready instead (flycast expects it at /dc/dc_boot.bin, not at the FS root).
  if (isDreamcast) biosUrl = null;

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

  // CDN base: Prefer the local kente-server /api/ejs/ when available so EmulatorJS
  // can run without WAN internet (server may serve from disk cache/mirror).
  const ejsBase = useEjsProxy ? `${KENTE_SERVER_URL}/api/ejs/` : EJS_CDN;

  // Set EmulatorJS globals BEFORE injecting the script
  window.EJS_player          = '#ejs-container';
  window.EJS_core            = core;
  window.EJS_gameUrl         = _currentRomUrl;
  window.EJS_gameName        = romName;   // ← tells EJS the file extension / format
  window.EJS_pathtodata      = ejsBase;
  // Dreamcast: EJS_startOnLoaded=false so we can write the BIOS to the WASM FS in
  // EJS_ready before the core boots.  All other systems auto-start as normal.
  window.EJS_startOnLoaded   = !isDreamcast;
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

    if (isDreamcast) {
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
  if (isDreamcast) {
    _applyFlycastWebgl2Patch();
  }

  // Inject EmulatorJS loader script
  const script = document.createElement('script');
  script.id  = 'ejs-loader';
  script.src = ejsBase + 'loader.js';
  script.onerror = async () => {
    console.error(`[EJS] Failed to load EmulatorJS loader: ${script.src}`);
    overlay.classList.remove('active');
    cloudBadge.hidden = true; saveBtn.hidden = true;
    // Reset screen state so the controller isn't stuck in play-mode isolation
    state.screen = 'room';
    let msg = '⚠ COULD NOT LOAD EMULATOR';
    if (!KENTE_SERVER_ONLINE) {
      msg = '⚠ COULD NOT LOAD EMULATOR — KENTE SERVER OFFLINE';
    } else if (!navigator.onLine) {
      msg = '⚠ OFFLINE MODE — EMULATOR PACK NOT CACHED YET (CONNECT ONCE TO SETUP)';
    } else {
      // If the offline pack is currently downloading, tell the user to retry soon.
      try {
        const r = await fetch(`${KENTE_SERVER_URL}/api/ejs/prefetch/status`, { signal: _abortTimeout(1500) });
        if (r.ok) {
          const st = await r.json();
          if (st?.running) msg = '⚠ EMULATOR PACK DOWNLOADING — TRY AGAIN IN A MOMENT';
        }
      } catch { /* ignore */ }
      // Kick off a prefetch just in case (idempotent server-side).
      try {
        fetch(`${KENTE_SERVER_URL}/api/ejs/prefetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      } catch { /* ignore */ }
    }
    showToast(msg);
    if (_currentRomUrl?.startsWith('blob:')) { URL.revokeObjectURL(_currentRomUrl); }
    _currentRomUrl = null;
    if (_currentBiosUrl) { URL.revokeObjectURL(_currentBiosUrl); _currentBiosUrl = null; }
    KenteAudio.setHumVol(0.018);
  };
  document.body.appendChild(script);
}
