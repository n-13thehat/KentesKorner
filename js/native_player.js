/* Native game surfaces share Kente's existing player HUD and return controls. */
'use strict';
const NativePlayer = (() => {
  let active = false, generation = 0, poll = null, inputPoll = null, observer = null, resizing = false;
  let stopping = Promise.resolve();
  let sessionId = null;
  let cancelImport = null;
  const macKeys = new Set();
  let macKeyDown = null, macKeyUp = null;
  // Browser-standard order is A, B, X, Y, L1, R1, L2, R2, Select,
  // Start, stick clicks, then the four d-pad buttons. Libretro's RetroPad
  // order differs, so translate it explicitly.
  const macStandardMap = [[0, 8], [1, 0], [2, 9], [3, 1], [4, 10], [5, 11], [6, 12], [7, 13],
    [8, 2], [9, 3], [10, 14], [11, 15], [12, 4], [13, 5], [14, 6], [15, 7]];
  // Common raw-order fallback for controllers without a standard mapping.
  const macFallbackMap = [[0, 0], [1, 8], [2, 1], [3, 9], [4, 10], [5, 11], [6, 12], [7, 13],
    [8, 2], [9, 3], [10, 14], [11, 15], [12, 4], [13, 5], [14, 6], [15, 7]];
  const macKeyButtons = { KeyZ: 0, KeyX: 8, KeyA: 1, KeyS: 9, KeyQ: 10, KeyW: 11,
    ShiftRight: 2, Enter: 3, ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7 };
  const supported = systemId => !!window.electronAPI?.nativePlayerSupported
    || (systemId === 'ps2' && !!window.electronAPI?.macNativeCoreAvailable);
  const isMacCore = () => !!window.electronAPI?.macNativeCoreAvailable;
  const control = (action, bounds, id) => isMacCore()
    ? window.electronAPI.controlMacNativePlayer(action, bounds)
    : window.electronAPI.controlNativePlayer(action, bounds, id);
  function sendMacInput() {
    if (!isMacCore()) return;
    const pad = Array.from(navigator.getGamepads?.() || []).find(item => item?.connected);
    let buttons = 0;
    const map = pad?.mapping === 'standard' ? macStandardMap : macFallbackMap;
    if (pad) for (const [source, target] of map)
      if (pad.buttons[source]?.pressed) buttons |= 1 << target;
    for (const code of macKeys) {
      const target = macKeyButtons[code];
      if (target !== undefined) buttons |= 1 << target;
    }
    window.electronAPI.setMacNativePlayerInput(buttons, pad
      ? [pad.axes[0] || 0, pad.axes[1] || 0, pad.axes[2] || 0, pad.axes[3] || 0]
      : [0, 0, 0, 0]);
  }
  function clearMacInput() {
    macKeys.clear();
    if (isMacCore()) window.electronAPI.setMacNativePlayerInput(0, [0, 0, 0, 0]);
  }
  const rect = () => {
    const box = document.getElementById('ejs-container').getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  };
  function updateDiscControls(status) {
    const count = isMacCore() ? Math.max(0, Number(status?.discCount) || 0) : 0;
    const index = Math.max(0, Number(status?.discIndex) || 0);
    const previous = document.getElementById('igm-disc-prev');
    const next = document.getElementById('igm-disc-next');
    if (!previous || !next) return;
    previous.hidden = next.hidden = count < 2;
    previous.textContent = `◀  PREVIOUS DISC  ${index + 1}/${count}`;
    next.textContent = `NEXT DISC  ${index + 1}/${count}  ▶`;
    if (state.screen === 'paused') updateIgmFocus();
  }
  async function changeDisc(direction) {
    if (!active || !isMacCore()) return false;
    try {
      const result = await window.electronAPI.changeMacNativePlayerDisc(direction);
      if (!active) return false;
      if (!result?.success) {
        showToast('⚠ The PS2 disc could not be changed.');
        return false;
      }
      const status = await window.electronAPI.macNativePlayerStatus();
      updateDiscControls(status);
      showToast(`DISC ${status.discIndex + 1} / ${status.discCount}`);
      return true;
    } catch (error) {
      console.warn('[Native player] Disc change failed:', error);
      showToast('⚠ The PS2 disc could not be changed.');
      return false;
    }
  }
  function stop() {
    if (!active) return stopping;
    clearMacInput();
    if (macKeyDown) document.removeEventListener('keydown', macKeyDown);
    if (macKeyUp) document.removeEventListener('keyup', macKeyUp);
    macKeyDown = macKeyUp = null;
    active = false;
    generation++;
    cancelImport?.();
    cancelImport = null;
    if (poll) clearInterval(poll);
    poll = null;
    if (inputPoll) clearInterval(inputPoll);
    inputPoll = null;
    observer?.disconnect();
    observer = null;
    const ended = sessionId;
    sessionId = null;
    stopping = control('stop', null, ended).catch(error => console.warn('[Native player]', error));
    return stopping;
  }
  async function menu(opened) {
    if (!active) return;
    if (isMacCore() && opened) clearMacInput();
    try {
      const result = isMacCore()
        ? await control(opened ? 'pause' : 'resume', null, sessionId)
        : await control(opened ? 'menu' : 'resume', null, sessionId);
      if (!active || !isMacCore() || result?.success !== false) return;
      // Keep the shared HUD state aligned with the native session when the OS
      // audio queue refuses a pause/resume transition.
      state.screen = opened ? 'playing' : 'paused';
      document.getElementById('ingame-menu')?.classList.toggle('active', !opened);
      showToast('⚠ The Mac player could not change its pause state.');
    }
    catch (error) { console.warn('[Native player]', error); }
  }
  async function offerImport(engine, status, message) {
    status.textContent = message;
    const button = document.createElement('button');
    button.className = 'launch-dismiss';
    button.textContent = 'ADD GAME ENGINE';
    status.parentElement.appendChild(button);
    try {
      await new Promise((resolve, reject) => {
        cancelImport = () => reject(new Error('Game launch cancelled.'));
        button.onclick = async () => {
          button.disabled = true;
          try {
            const result = await window.electronAPI.importNativeEngine(engine);
            if (result.success) resolve();
            else if (!result.cancelled) status.textContent = result.error || 'Choose the folder containing the game engine.';
          } catch (error) { status.textContent = error.message; }
          finally { button.disabled = false; }
        };
      });
    } finally { button.remove(); cancelImport = null; }
  }
  async function installEngine(engine, token, status) {
    const response = await fetch(`${KENTE_SERVER_URL}/api/emulators/install`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ only: [engine] }),
    });
    if (!response.ok) throw new Error('This game engine could not be installed.');
    const deadline = Date.now() + 600000;
    while (active && token === generation && Date.now() < deadline) {
      const result = await fetch(`${KENTE_SERVER_URL}/api/emulators/install/status`, { signal: _abortTimeout(4000) });
      const state = await result.json();
      status.textContent = state.current ? `PREPARING ${state.current.toUpperCase()}...` : 'PREPARING GAME ENGINE...';
      if (state.done) {
        const item = state.results?.[engine];
        if (!item || ['error', 'manual_required', 'unavailable'].includes(item.status)) {
          await offerImport(engine, status, 'Add this game engine to Kente to continue.');
          return;
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error('Game launch cancelled.');
  }
  async function preparePs3Firmware(token, status) {
    await fetch(`${KENTE_SERVER_URL}/api/bios/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowDownload: true }), signal: _abortTimeout(8000),
    });
    const deadline = Date.now() + 30 * 60_000;
    while (active && token === generation && Date.now() < deadline) {
      const response = await fetch(`${KENTE_SERVER_URL}/api/bios/download/status`, { signal: _abortTimeout(4000) });
      const result = await response.json();
      status.textContent = `${(result.phase || result.current || 'PREPARING FIRMWARE').toString().toUpperCase()}...`;
      if (result.error) throw new Error('PS3 firmware setup failed. Add PS3UPDAT.PUP in Sources and try again.');
      if (result.done) return;
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    throw new Error('PS3 firmware setup was cancelled or timed out.');
  }
  async function launch(game, options = {}) {
    await stopping;
    if (active) await stop();
    const token = ++generation;
    sessionId = crypto.randomUUID();
    active = true;
    const overlay = document.getElementById('emulator-overlay');
    const container = document.getElementById('ejs-container');
    _closeLaunchOverlay();
    document.getElementById('ejs-game-title').textContent = game.title;
    document.getElementById('ejs-system-badge').textContent = (game.system || game.systemId).toUpperCase();
    for (const id of ['ejs-cloud-badge', 'ejs-save-btn', 'ejs-ctrl-btn']) document.getElementById(id).hidden = true;
    document.getElementById('ejs-exit').onclick = showIngameMenu;
    container.innerHTML = '<div class="native-player-loading"><div class="native-player-status">PREPARING GAME...</div><div>ESC / HOME · GAME MENU &nbsp; F11 · FULLSCREEN</div></div>';
    const status = container.querySelector('.native-player-status');
    overlay.classList.add('active');
    state.screen = 'playing';
    KenteAudio.setHumVol(0);
    try {
      // Wait for the HUD's flex layout before giving native code the viewport.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!active || token !== generation) return;
      const request = { systemId: game.systemId, title: game.title, filename: options.filename,
        exePath: options.exePath, sessionId, remotePlayer2: options.remotePlayer2 === true };
      let result = isMacCore()
        ? await window.electronAPI.launchMacNativePlayer(request, rect())
        : await window.electronAPI.launchNativePlayer(request, rect());
      if (result.error === 'PS3_FIRMWARE_MISSING' && !options.firmwareAttempted) {
        await preparePs3Firmware(token, status);
        if (active && token === generation) {
          result = isMacCore()
            ? await window.electronAPI.launchMacNativePlayer(request, rect())
            : await window.electronAPI.launchNativePlayer(request, rect());
        }
      }
      if (result.error === 'NO_EMULATOR' && result.engine) {
        await installEngine(result.engine, token, status);
        if (active && token === generation) result = isMacCore()
          ? await window.electronAPI.launchMacNativePlayer(request, rect())
          : await window.electronAPI.launchNativePlayer(request, rect());
      }
      if (!active || token !== generation) return;
      if (!result.success) {
        if (result.error === 'PS2_BIOS_MISSING') {
          await stop();
          exitEmulator();
          showBiosPicker(game, null, { required: true, filename: 'scph39001.bin', label: 'PlayStation 2 BIOS' },
            () => launch(game, options));
          return;
        }
        if (result.error === 'ROM_NOT_FOUND') {
          await stop();
          exitEmulator();
          await DownloadManager.enqueue(game, { autoLaunch: true });
          openDownloadCenter();
          return;
        }
        throw new Error(result.message || result.error || 'The game could not be started.');
      }
      if (isMacCore()) {
        // The user can open the HUD menu while ROM resolution/extraction is
        // still in progress. The core starts asynchronously and initializes
        // its paused flag on its worker thread, so repeat the pause after the
        // launch IPC returns to keep the HUD and native surface in sync.
        if (state.screen === 'paused') await control('pause', null, sessionId);
        let frameDeadline = Date.now() + 60000;
        let wasPaused = state.screen === 'paused';
        let videoReady = false;
        while (active && token === generation) {
          const current = await window.electronAPI.macNativePlayerStatus();
          if (!current.running)
            throw new Error(current.error || 'The PS2 emulator stopped before producing video.');
          updateDiscControls(current);
          if (current.videoFrames > 0) { videoReady = true; break; }
          const paused = state.screen === 'paused';
          if (wasPaused && !paused) frameDeadline = Date.now() + 60000;
          wasPaused = paused;
          if (!paused && Date.now() >= frameDeadline) break;
          status.textContent = paused ? 'PLAYSTATION 2 PAUSED' : 'STARTING PLAYSTATION 2...';
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!active || token !== generation) return;
        if (!videoReady)
          throw new Error('The PS2 emulator did not produce a video frame within 60 seconds.');
      }
      container.innerHTML = '';
      observer = new ResizeObserver(() => {
        if (resizing || !active) return;
        resizing = true;
        requestAnimationFrame(() => {
          resizing = false;
          if (active) control('resize', rect(), sessionId).catch(() => {});
        });
      });
      observer.observe(container);
      if (isMacCore()) {
        macKeyDown = event => {
          if (!active) return;
          if (event.code === 'Escape') {
            if (event.repeat) return;
            event.preventDefault();
            if (state.screen === 'playing') showIngameMenu();
            else if (state.screen === 'paused') hideIngameMenu();
            return;
          }
          if (state.screen !== 'playing' || !(event.code in macKeyButtons)) return;
          macKeys.add(event.code);
          event.preventDefault();
        };
        macKeyUp = event => {
          if (!(event.code in macKeyButtons)) return;
          macKeys.delete(event.code);
          if (active && state.screen === 'playing') event.preventDefault();
        };
        document.addEventListener('keydown', macKeyDown);
        document.addEventListener('keyup', macKeyUp);
        inputPoll = setInterval(() => {
          if (!active) return;
          if (state.screen === 'playing') sendMacInput();
        }, 33);
      }
      poll = setInterval(async () => {
        if (!active || token !== generation) return;
        try {
          const current = isMacCore()
            ? await window.electronAPI.macNativePlayerStatus()
            : await window.electronAPI.nativePlayerStatus();
          if (!active || token !== generation) return;
          if (!current.running) {
            const error = current.error;
            await stop();
            exitEmulator();
            if (error) showToast('⚠ ' + error);
            return;
          }
          if (isMacCore()) updateDiscControls(current);
          if (current.menuRequested && state.screen === 'playing') showIngameMenu();
          if (current.fullscreenRequested) window.electronAPI.toggleFullScreen();
        } catch (error) { console.warn('[Native player]', error); }
      }, 300);
    } catch (error) {
      if (!active || token !== generation) return;
      await stop();
      exitEmulator();
      showToast('⚠ ' + error.message);
    }
  }
  return { supported, launch, stop, menu, changeDisc, get active() { return active; }, get sessionId() { return sessionId; } };
})();
