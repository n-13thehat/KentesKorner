/* Kente's Korner — Boot sequence, screen transitions, TV zones, event binding, zone editor. */
'use strict';

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
    showToast('📋 POSITIONS SAVED + COPIED TO CLIPBOARD\nPASTE INTO TV_ZONES IN js/config.js TO MAKE PERMANENT');
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
