/* Native game surfaces share Kente's existing player HUD and return controls. */
'use strict';
const NativePlayer = (() => {
  let active = false, generation = 0, poll = null, observer = null, resizing = false;
  let stopping = Promise.resolve();
  let sessionId = null;
  let cancelImport = null;
  const supported = () => !!window.electronAPI?.nativePlayerSupported;
  const rect = () => {
    const box = document.getElementById('ejs-container').getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  };
  function stop() {
    if (!active) return stopping;
    active = false;
    generation++;
    cancelImport?.();
    cancelImport = null;
    if (poll) clearInterval(poll);
    poll = null;
    observer?.disconnect();
    observer = null;
    const ended = sessionId;
    sessionId = null;
    stopping = window.electronAPI.controlNativePlayer('stop', null, ended).catch(error => console.warn('[Native player]', error));
    return stopping;
  }
  async function menu(opened) {
    if (!active) return;
    try { await window.electronAPI.controlNativePlayer(opened ? 'menu' : 'resume', null, sessionId); }
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
      let result = await window.electronAPI.launchNativePlayer(request, rect());
      if (result.error === 'PS3_FIRMWARE_MISSING' && !options.firmwareAttempted) {
        await preparePs3Firmware(token, status);
        if (active && token === generation) {
          result = await window.electronAPI.launchNativePlayer(request, rect());
        }
      }
      if (result.error === 'NO_EMULATOR' && result.engine) {
        await installEngine(result.engine, token, status);
        if (active && token === generation) result = await window.electronAPI.launchNativePlayer(request, rect());
      }
      if (!active || token !== generation) return;
      if (!result.success) {
        if (result.error === 'PS2_BIOS_MISSING') {
          await stop();
          exitEmulator();
          showBiosPicker(game, null, { required: true, filename: 'scph39001.bin', label: 'PlayStation 2 BIOS' });
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
      container.innerHTML = '';
      observer = new ResizeObserver(() => {
        if (resizing || !active) return;
        resizing = true;
        requestAnimationFrame(() => {
          resizing = false;
          if (active) window.electronAPI.controlNativePlayer('resize', rect(), sessionId).catch(() => {});
        });
      });
      observer.observe(container);
      poll = setInterval(async () => {
        if (!active || token !== generation) return;
        try {
          const current = await window.electronAPI.nativePlayerStatus();
          if (!active || token !== generation) return;
          if (!current.running) {
            const error = current.error;
            await stop();
            exitEmulator();
            if (error) showToast('⚠ ' + error);
            return;
          }
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
  return { supported, launch, stop, menu, get active() { return active; }, get sessionId() { return sessionId; } };
})();
