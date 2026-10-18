/* Kente's Korner — EJS keyboard bridge, gamepad manager, DualSense pointer. */
'use strict';

/* ══════════════════════════════════════════
   EJS KEYBOARD BRIDGE
   Translates physical gamepad button presses
   into RetroArch default keyboard events and
   dispatches them to the EmulatorJS canvas.

   WHY THIS IS NEEDED:
   EmulatorJS relies on gamepadconnected events
   to discover connected controllers. When the
   user navigates to a game WITH their controller
   already plugged in, the browser fired that event
   before EJS's listener existed — EJS never learns
   about the pad and its gamepad loop never starts.

   Instead of fighting EJS's gamepad detection,
   we use the keyboard input path, which Emscripten
   always has active. RetroArch key binds are
   well-known constants; we map W3C button indices
   directly to those keys every animation frame.

   Button 16 (PS/Guide/Home) is intentionally excluded
   — it opens the Kente shell overlay instead of forwarding to the emulator.
   Button 9 (Start/Options) is forwarded as Enter (RetroArch default for Start).
══════════════════════════════════════════ */
let _ejsKbRaf  = null;       // rAF handle for the bridge loop
const _ejsKbPrev = {};       // previous pressed state per pad+button

// W3C standard gamepad button index → RetroArch default keyboard bind
//
// W3C layout:  0=South  1=East  2=West  3=North
// SNES names:  0=B      1=A     2=Y     3=X
// RA kbd:      B='z'    A='x'   Y='a'   X='s'
//
// RetroArch config.def.h: RETRO_DEF_JOYPAD_B=z, A=x, Y=a, X=s, L=q, R=w
//                          SELECT=rshift, START=return, UP/DOWN/LEFT/RIGHT=arrows
//
// Button 16 (PS/Guide/Home) is intentionally skipped here — it opens
// the Kente shell overlay instead of being forwarded to the emulator.
// Button 9 (Start/Options) is now correctly forwarded as Enter so games
// can use their own in-game pause/start without Kente intercepting it.
const _EJS_KEY_MAP = [
  { key: 'z',          code: 'KeyZ'        },  // 0: South (A/Cross/B)      → RA B  → z
  { key: 'x',          code: 'KeyX'        },  // 1: East  (B/Circle/A)     → RA A  → x
  { key: 'a',          code: 'KeyA'        },  // 2: West  (X/Square/Y)     → RA Y  → a
  { key: 's',          code: 'KeyS'        },  // 3: North (Y/Triangle/X)   → RA X  → s
  { key: 'q',          code: 'KeyQ'        },  // 4: L1                     → RA L  → q
  { key: 'w',          code: 'KeyW'        },  // 5: R1                     → RA R  → w
  null,                                         // 6: L2  (analog — skip)
  null,                                         // 7: R2  (analog — skip)
  { key: 'Shift',      code: 'ShiftRight'  },  // 8: Select/Share           → RA Select → RShift
  { key: 'Enter',      code: 'Enter'       },  // 9: Start/Options          → RA Start  → Enter
  null, null,                                   // 10, 11: L3, R3 (skip)
  { key: 'ArrowUp',    code: 'ArrowUp'     },  // 12: D-Up
  { key: 'ArrowDown',  code: 'ArrowDown'   },  // 13: D-Down
  { key: 'ArrowLeft',  code: 'ArrowLeft'   },  // 14: D-Left
  { key: 'ArrowRight', code: 'ArrowRight'  },  // 15: D-Right
  null,                                         // 16: PS/Guide/Home → Kente shell overlay (skip)
];

function _startEJSKeyBridge() {
  if (_ejsKbRaf) return;  // already running

  function frame() {
    if (state.screen !== 'playing') { _ejsKbRaf = null; return; }

    const pads = navigator.getGamepads() || [];
    for (const gp of pads) {
      if (!gp) continue;
      // P1 ONLY — RetroArch defaults map keyboard binds to player 1 only.
      // P2/P3/P4 are routed by EJS's native gamepad polling (gamepadconnected
      // events were re-dispatched at game start so EJS sees every pad). If we
      // also fired keyboard events for index>0, those pads would double-act
      // as P1 and clobber multiplayer.
      if (gp.index !== 0) continue;
      gp.buttons.forEach((btn, idx) => {
        const map = _EJS_KEY_MAP[idx];
        if (!map) return;

        const k   = `${gp.index}_${idx}`;
        const was = !!_ejsKbPrev[k];
        const now =   btn.pressed;
        if (now === was) return;
        _ejsKbPrev[k] = now;

        // Dispatch ONLY on document — Emscripten registers its keyboard handler there.
        // Do NOT also dispatch on the canvas with bubbles:true; that would cause the
        // event to bubble up to document a second time and fire the handler twice.
        const type = now ? 'keydown' : 'keyup';
        document.dispatchEvent(new KeyboardEvent(type, {
          key: map.key, code: map.code, bubbles: true, cancelable: true,
        }));
      });
    }
    _ejsKbRaf = requestAnimationFrame(frame);
  }

  _ejsKbRaf = requestAnimationFrame(frame);
}

function _stopEJSKeyBridge() {
  if (_ejsKbRaf) { cancelAnimationFrame(_ejsKbRaf); _ejsKbRaf = null; }
  // Release any keys still held down so they don't stick after exiting
  for (const k of Object.keys(_ejsKbPrev)) {
    if (!_ejsKbPrev[k]) continue;
    const btnIdx = Number(k.split('_')[1]);
    const map    = _EJS_KEY_MAP[btnIdx];
    if (!map) continue;
    document.dispatchEvent(new KeyboardEvent('keyup', {
      key: map.key, code: map.code, bubbles: true, cancelable: true,
    }));
  }
  for (const k in _ejsKbPrev) delete _ejsKbPrev[k];
}

/* ── IN-GAME PAUSE MENU ───────────────────────────────────────── */
let _igmFocus = 0;  // 0 = RESUME, 1 = CLOSE GAME, 2 = MAIN MENU

function updateIgmFocus() {
  document.querySelectorAll('.ingame-btn').forEach((btn, i) => {
    btn.classList.toggle('igm-focused', i === _igmFocus);
  });
}

function showIngameMenu() {
  const menu = document.getElementById('ingame-menu');
  if (!menu) return;
  // Populate the title from the HUD
  const title = document.getElementById('ejs-game-title')?.textContent || '';
  const titleEl = document.getElementById('igm-title');
  if (titleEl) titleEl.textContent = title;
  _igmFocus = 0;
  menu.classList.add('active');
  updateIgmFocus();
  state.screen = 'paused';
}

// skipStateReset = true when called from exitEmulator (we'll set state.screen = 'room' there)
function hideIngameMenu(skipStateReset) {
  const menu = document.getElementById('ingame-menu');
  if (!menu) return;
  menu.classList.remove('active');
  if (!skipStateReset) state.screen = 'playing';
}

/* ── SAVE CLOUD ROM TO LOCAL LIBRARY ──────────────────────── */
async function saveCloudRomToLibrary(game, cloudRomData) {
  if (!cloudRomData || !_currentRomUrl) return;
  const { url: archiveUrl, filename, systemId } = cloudRomData;

  const saveBtn    = document.getElementById('ejs-save-btn');
  const cloudBadge = document.getElementById('ejs-cloud-badge');
  saveBtn.textContent = '↓ SAVING...';
  saveBtn.disabled    = true;

  try {
    // ── Determine storage target ──
    const libEntry = await LibraryDB.getRoot();
    let rootHandle;
    if (libEntry?.handle) {
      const perm = await libEntry.handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('NO_PERMISSION');
      rootHandle = libEntry.handle;
    } else if (navigator?.storage?.getDirectory) {
      rootHandle = await getOPFSLibrary();
    } else {
      throw new Error('NO_LIBRARY');
    }

    // ── Write the in-memory blob to storage — no second network fetch ──
    // _currentRomUrl is a blob: URL already in RAM from the active playback session.
    const sysFolder  = await rootHandle.getDirectoryHandle(systemId, { create: true });
    const fileHandle = await sysFolder.getFileHandle(filename, { create: true });
    const writable   = await fileHandle.createWritable();
    const response   = await fetch(_currentRomUrl);   // instant: reads from blob cache
    const reader     = response.body.getReader();
    const total      = parseInt(response.headers.get('Content-Length') || '0');
    let received     = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.length;
      if (total) saveBtn.textContent = `↓ ${Math.round(received / total * 100)}%`;
    }
    await writable.close();

    // ── Index in RomDB + ROM_STATUS ──
    if (game.id) {
      await RomDB.set(game.id, fileHandle, filename);
      ROM_STATUS[game.id] = true;
      refreshGameCardDots();
    }

    // ── Add to DownloadDB (only if not already recorded for this file) ──
    const existing = await DownloadDB.getAll();
    const alreadyLogged = existing.some(d => d.filename === filename && d.systemId === systemId);
    if (!alreadyLogged) {
      await DownloadDB.add({
        id:           'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        filename,
        systemId,
        systemName:   game.system || systemId.toUpperCase(),
        archiveUrl,           // store the real archive URL, not the in-memory blob URL
        downloadedAt: Date.now(),
        sizeBytes:    received,
        storage:      libEntry?.handle ? 'library' : 'opfs',
      });
    }

    // ── Update UI ──
    saveBtn.textContent = '✓ IN LIBRARY';
    if (cloudBadge) cloudBadge.hidden = true;
    showToast(`✓ ${filename} SAVED TO LIBRARY`);

  } catch (err) {
    saveBtn.textContent = '↓ SAVE TO LIBRARY';
    saveBtn.disabled    = false;
    if (err.message === 'NO_PERMISSION') {
      showToast('⚠ LIBRARY PERMISSION DENIED — CHECK SOURCES');
    } else if (err.message === 'NO_LIBRARY') {
      showToast('⚠ SET UP A ROM LIBRARY FIRST — SOURCES → ROM LIBRARY');
    } else {
      showToast('⚠ SAVE FAILED — ' + (err.message || 'UNKNOWN ERROR').toUpperCase());
    }
  }
}

// DualSense / DualShock 4 detection — matches Chrome and Firefox USB/BT IDs
const DUALSENSE_RE = /dualsense|054c.*0ce6|0ce6.*054c/i;

/* ══════════════════════════════════════════
   GAMEPAD MANAGER
   Compatible with: PS4 DualShock 4, PS5 DualSense,
   Xbox One / Series X|S controllers, and any HID
   gamepad that exposes the W3C "standard" mapping.

   Handles shell navigation only — EmulatorJS
   manages its own gamepad input while a ROM runs.
══════════════════════════════════════════ */
const GamepadManager = (() => {

  /* Standard gamepad button indices (W3C spec) */
  const BTN = {
    SOUTH:0, EAST:1, WEST:2, NORTH:3,   // A/✕  B/○  X/□  Y/△
    LB:4,    RB:5,   LT:6,   RT:7,      // L1   R1   L2   R2
    SELECT:8, START:9, L3:10, R3:11,    // Share Options L3 R3
    DUP:12, DDOWN:13, DLEFT:14, DRIGHT:15,
    HOME:16,                             // PS / Guide / Home — Kente system button
  };

  const DEADZONE     = 0.40;  // ignore analog stick noise below this
  const FIRST_DELAY  = 380;   // ms before key-repeat starts
  const REPEAT_MS    = 110;   // ms between repeats while held

  /* DualSense touchpad double-tap state */
  let _dsLastTap       = 0;     // timestamp of last touchpad press
  let _dsSingleTapTimer = null; // pending single-tap → Download Center timer
  const DS_DTAP_MS = 450;       // window for double-tap recognition (ms)

  /* ── Wii Remote support ───────────────────────────────────────
     Wiimotes connected via Bluetooth report gamepad.mapping = ""
     (non-standard). Their raw button indices are completely different
     from the W3C standard layout used by PS4/PS5/Xbox controllers.

     Mapping works for:
       • Wii Remote alone  (vertical hold — A=confirm, B=back, D-pad=nav)
       • Wii Remote alone  (horizontal/sideways hold — 2=confirm, 1=back)
       • Wii Remote + Nunchuk (A=confirm, B=back, Nunchuk stick=nav)
       • Wii Classic Controller (typically maps as "standard" already)
       • Mayflash DolphinBar Mode 2 (maps as "standard" — no change needed)
  ── ─────────────────────────────────────────────────────────── */
  const WIIMOTE_RE  = /nintendo|rvl-cnt|wiimote/i;

  const WIIMOTE_BTN = {
    0:  BTN.SOUTH,   // 2 button        → Confirm (horizontal-hold right finger)
    1:  BTN.EAST,    // 1 button        → Back    (horizontal-hold left finger)
    2:  BTN.EAST,    // B trigger       → Back
    3:  BTN.SOUTH,   // A button        → Confirm
    4:  BTN.SELECT,  // − (minus)       → Back / Select
    5:  BTN.START,   // + (plus)        → Start
    6:  BTN.START,   // Home            → Start / back to room
    7:  BTN.DUP,     // D-pad Up
    8:  BTN.DDOWN,   // D-pad Down
    9:  BTN.DLEFT,   // D-pad Left
    10: BTN.DRIGHT,  // D-pad Right
    11: BTN.SOUTH,   // Nunchuk Z       → Confirm
    12: BTN.LB,      // Nunchuk C       → Previous / cycle
  };

  /** Returns a button-index translation map, or null for standard pads. */
  function getButtonMap(gp) {
    if (gp.mapping === 'standard')  return null;        // PS4 / PS5 / Xbox
    if (WIIMOTE_RE.test(gp.id))    return WIIMOTE_BTN; // Wii Remote (raw BT)
    return null;
  }

  /**
   * Returns [axisX, axisY] indices to use for analog stick navigation,
   * or null if the device should not use axis-based navigation.
   *
   * Wiimote axes 0-2 are the accelerometer (useless for menus).
   * Nunchuk stick lives on axes 3-4 when attached (buttons.length > 12).
   * Standard controllers use axes 0-1 (left stick).
   */
  function getStickAxes(gp) {
    if (WIIMOTE_RE.test(gp.id) && gp.mapping !== 'standard') {
      return gp.buttons.length > 12 ? [3, 4] : null; // nunchuk attached / not
    }
    return [0, 1]; // standard left stick
  }

  /* Active overlay layers in z-priority order.
     First selector that matches a visible element wins as the nav scope. */
  const LAYERS = [
    '#emulator-overlay.active',   // game running — only HUD navigable
    '#downloads-overlay.active',
    '#cloud-overlay.active',
    '#theater-detail-overlay.active',   // poster card → detail panel
    '#game-detail-panel.open',
    '.launch-overlay.active',
    '.menu-screen.active',
  ];

  /* Focusable elements (ordered by tab stop importance) */
  const FOCUSABLE = [
    '.filter-chip', '.game-card', '.source-card', '.profile-card',
    '.theater-poster', '.theater-hero-btn', '.theater-detail-btn',
    '.theater-detail-close',
    '.theater-eps-tab', '.theater-ep-row', '.tvp-btn', '.tvp-select',
    '.cloud-sys-chip', '.cloud-result-row', '.cloud-file-row',
    '.rom-option-btn', '.dl-play-btn', '.dl-del-btn', '.dl-cancel-btn',
    '.gdp-launch-btn', '.gdp-fav-btn', '.sdp-action-btn',
    '.menu-back-btn', '.launch-dismiss', '#ejs-exit', '#ejs-save-btn',
    '#cloud-close', '#cloud-play-now-btn', '#dl-close',
    '#rom-back', '#sdp-close',
  ].join(',');

  let _raf  = null;
  let _prev = {};   // previous state per button/axis key
  let _held = {};   // keys being held: { since, lastFire }
  let _idx  = -1;   // currently focused element index
  let _gpN  = 0;    // connected gamepad count
  let _anchorX = null; // sticky horizontal anchor for vertical navigation

  // ── Scope & focusables ───────────────────────────────────────
  function getScope() {
    for (const sel of LAYERS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null; // room level
  }

  function getFocusables() {
    const scope = getScope();
    if (!scope) return Array.from(document.querySelectorAll('.tv-zone'));
    return Array.from(scope.querySelectorAll(FOCUSABLE))
      .filter(el => el.offsetParent !== null && !el.hidden && !el.disabled);
  }

  // ── Visual focus ─────────────────────────────────────────────
  function clearFocus() {
    document.querySelectorAll('.gp-focus').forEach(el => el.classList.remove('gp-focus'));
  }

  function applyFocus(idx) {
    const items = getFocusables();
    if (!items.length) { _idx = -1; return; }
    _idx = Math.max(0, Math.min(items.length - 1, idx));
    clearFocus();
    const el = items[_idx];
    el.classList.add('gp-focus');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function resetFocus() { clearFocus(); _idx = -1; _anchorX = null; }

  // ── Theater row-snap helper ──────────────────────────────────
  // When traversing vertically across .theater-row containers,
  // snap to the poster in the next/previous visible row whose
  // horizontal centre is closest to the sticky anchor X.  Returns
  // the focusables-index of the chosen target, or -1 when no
  // suitable row exists.
  function _theaterRowSnap(items, curEl, dir, anchorX) {
    const curRow = curEl.closest('.theater-row');
    if (!curRow) return -1;
    const rowsHost = curRow.parentElement;
    if (!rowsHost) return -1;
    const allRows = Array.from(rowsHost.querySelectorAll(':scope > .theater-row'))
      .filter(r => r.style.display !== 'none' && r.offsetParent !== null);
    const idx  = allRows.indexOf(curRow);
    if (idx < 0) return -1;
    const next = allRows[idx + (dir === 'down' ? 1 : -1)];
    if (!next) return -1;
    const candidates = Array.from(next.querySelectorAll('.theater-poster'))
      .filter(el => el.offsetParent !== null);
    if (!candidates.length) return -1;
    let best = null, bestDx = Infinity;
    candidates.forEach(p => {
      const r  = p.getBoundingClientRect();
      const dx = Math.abs((r.left + r.width / 2) - anchorX);
      if (dx < bestDx) { bestDx = dx; best = p; }
    });
    return best ? items.indexOf(best) : -1;
  }

  // ── Grid-aware directional navigation ────────────────────────
  function navigate(dir) {
    const items = getFocusables();
    if (!items.length) return;

    // Room level: cycle TVs with d-pad
    if (!getScope()) {
      const delta = (dir === 'left' || dir === 'up') ? -1 : 1;
      state.focusIndex = ((state.focusIndex || 0) + delta + TV_ZONES.length) % TV_ZONES.length;
      focusZone(TV_ZONES[state.focusIndex]);
      return;
    }

    if (_idx < 0) { applyFocus(0); return; }

    // Horizontal — also re-arms the anchor X for subsequent vertical hops.
    if (dir === 'left' || dir === 'right') {
      applyFocus(_idx + (dir === 'left' ? -1 : 1));
      const f = items[_idx];
      if (f) {
        const r = f.getBoundingClientRect();
        _anchorX = r.left + r.width / 2;
      }
      return;
    }

    // Up/Down: find closest item in that direction using screen position
    const cur  = items[_idx];
    const cR   = cur.getBoundingClientRect();
    const cCX  = cR.left + cR.width  / 2;
    const cCY  = cR.top  + cR.height / 2;
    if (_anchorX == null) _anchorX = cCX;

    // Theater poster → row-snap to the closest poster in the adjacent row.
    if (cur.classList.contains('theater-poster')) {
      const snap = _theaterRowSnap(items, cur, dir, _anchorX);
      if (snap >= 0) { applyFocus(snap); return; }
      // Top of theater rows → bubble up to hero / toolbar; bottom is a no-op.
      if (dir === 'up') {
        const heroBtn = document.querySelector('.theater-hero-btn');
        const chip    = document.querySelector('.theater-toolbar .filter-chip.active')
                     || document.querySelector('.theater-toolbar .filter-chip');
        const target  = heroBtn || chip;
        const t = target ? items.indexOf(target) : -1;
        if (t >= 0) { applyFocus(t); return; }
      }
    }
    // Hero / toolbar going DOWN → first poster in first visible row.
    if (dir === 'down' && (cur.classList.contains('theater-hero-btn')
                        || cur.classList.contains('filter-chip'))) {
      const firstRow = Array.from(document.querySelectorAll('#theater-rows > .theater-row'))
        .find(r => r.style.display !== 'none' && r.offsetParent !== null);
      const first = firstRow?.querySelector('.theater-poster');
      const t = first ? items.indexOf(first) : -1;
      if (t >= 0) { applyFocus(t); return; }
    }

    let best = null, bestScore = Infinity;
    items.forEach((el, i) => {
      if (i === _idx) return;
      const r  = el.getBoundingClientRect();
      const dy = (r.top + r.height / 2) - cCY;
      if (dir === 'up'   && dy >= -4) return;
      if (dir === 'down' && dy <=  4) return;
      const dx    = Math.abs((r.left + r.width / 2) - _anchorX);
      const score = Math.abs(dy) + dx * 0.35;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best !== null) applyFocus(best);
  }

  // ── Confirm / Back ───────────────────────────────────────────
  function confirm() {
    // DualSense touchpad cursor — click element under the blue dot
    if (typeof DSPointer !== 'undefined' && DSPointer.active) {
      DSPointer.click(); return;
    }
    // Wii pointer — fire a real mouse-button sequence at the crosshair so
    // the player chrome (slider drags, video click-to-pause) reacts the
    // same as it does for a real mouse.
    if (typeof CameraManager !== 'undefined' && CameraManager.wiiActive) {
      if (CameraManager.clickAtPointer()) return;
    }

    if (!getScope()) {
      // Room: select focused TV
      const tv = TV_ZONES[state.focusIndex ?? 0];
      if (tv) selectTV(tv);
      return;
    }
    const items = getFocusables();
    if (_idx >= 0 && items[_idx]) items[_idx].click();
    else applyFocus(0);
  }

  function back() {
    const closeMap = [
      '#theater-detail-overlay.active #theater-detail-close',
      '#game-detail-panel.open #gdp-close',
      '#cloud-overlay.active #cloud-close',
      '#downloads-overlay.active #dl-close',
      '.launch-overlay.active #rom-back',
      '.launch-overlay.active .launch-dismiss',
    ];
    for (const sel of closeMap) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); resetFocus(); return; }
    }
    if (state.screen === 'menu') { closeMenu(); resetFocus(); }
  }

  // ── Button → action dispatch ─────────────────────────────────
  function dispatch(btnIdx) {

    // ── ON-SCREEN KEYBOARD: full input isolation ─────────────
    // When KenteOSK is open, every button drives the keyboard
    // grid — surrounding menu navigation must not fire.
    if (typeof KenteOSK !== 'undefined' && KenteOSK.active()) {
      switch (btnIdx) {
        case BTN.SOUTH:  KenteOSK.confirm();        break;
        case BTN.EAST:
        case BTN.SELECT:
        case BTN.START:  KenteOSK.close();          break;
        case BTN.WEST:   KenteOSK.backspace();      break;
        case BTN.NORTH:  KenteOSK.shift();          break;
        case BTN.DUP:    KenteOSK.navigate('up');    break;
        case BTN.DDOWN:  KenteOSK.navigate('down');  break;
        case BTN.DLEFT:  KenteOSK.navigate('left');  break;
        case BTN.DRIGHT: KenteOSK.navigate('right'); break;
        case BTN.LB:     KenteOSK.navigate('left');  break;
        case BTN.RB:     KenteOSK.navigate('right'); break;
      }
      return;
    }

    // ── IN-GAME: full input isolation ────────────────────────
    // When a game is running, block every OS action except the
    // PS/Guide/Home button (BTN.HOME), which opens the Kente
    // shell overlay.  All other buttons — including Start (9) —
    // are forwarded to the emulator via the EJS keyboard bridge
    // so games can use their own in-game menus without conflict.
    if (state.screen === 'playing') {
      if (btnIdx === BTN.HOME) showIngameMenu();
      return; // all other buttons are absorbed by the EJS bridge
    }

    // ── IN-GAME PAUSE MENU navigation ────────────────────────
    if (state.screen === 'paused') {
      const btns = [...document.querySelectorAll('.ingame-btn')];
      switch (btnIdx) {
        case BTN.DUP:
        case BTN.DLEFT:
          _igmFocus = (_igmFocus - 1 + btns.length) % btns.length;
          updateIgmFocus(); break;
        case BTN.DDOWN:
        case BTN.DRIGHT:
          _igmFocus = (_igmFocus + 1) % btns.length;
          updateIgmFocus(); break;
        case BTN.SOUTH:
          btns[_igmFocus]?.click(); break;
        case BTN.EAST:
        case BTN.HOME:   // PS button toggles the overlay closed again
        case BTN.START:  // Start also resumes — it can't reach the game while paused
          hideIngameMenu(); break;
      }
      return;
    }

    // ── THEATER PLAYER: in-flight playback ───────────────────
    // Keeps controller input scoped to the player; START / EAST / HOME open
    // the pause menu. Native <video> path also supports seek / volume on
    // the d-pad. Embed path uses LB / RB to cycle source hosts.
    if (state.screen === 'theater-playing') {
      const v = document.getElementById('theater-video');
      // Cursor mode short-circuit — when DSPointer or the Wii crosshair is
      // active, the A button acts as a real click at the cursor (so users
      // can hit ▶, CC, the source dropdown, etc.) instead of jumping to
      // the default pause / pause-menu action.
      if (btnIdx === BTN.SOUTH) {
        if (typeof DSPointer !== 'undefined' && DSPointer.active) {
          DSPointer.click(); return;
        }
        if (typeof CameraManager !== 'undefined' && CameraManager.wiiActive) {
          if (CameraManager.clickAtPointer()) return;
        }
      }
      switch (btnIdx) {
        case BTN.SOUTH:
          if (TheaterPlayer.embed) { showTheaterPauseMenu(); }
          else if (v) { v.paused ? v.play().catch(()=>{}) : v.pause(); }
          break;
        case BTN.EAST:
        case BTN.START:
        case BTN.HOME:
          showTheaterPauseMenu(); break;
        case BTN.DLEFT:
          if (!TheaterPlayer.embed && v) v.currentTime = Math.max(0, v.currentTime - 10);
          break;
        case BTN.DRIGHT:
          if (!TheaterPlayer.embed && v) v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
          break;
        case BTN.DUP:
          if (!TheaterPlayer.embed && v) v.volume = Math.min(1, v.volume + 0.05);
          break;
        case BTN.DDOWN:
          if (!TheaterPlayer.embed && v) v.volume = Math.max(0, v.volume - 0.05);
          break;
        case BTN.LB:
        case BTN.RB: {
          // Shows: LB = prev episode, RB = next episode (when not at the
          // boundary). Movies in embed mode keep LB/RB on source cycling
          // since there's no episode list to walk.
          const list = TheaterPlayer.epList || [];
          if (list.length) {
            _tvpJumpEpisode(btnIdx === BTN.LB ? -1 : +1);
          } else if (TheaterPlayer.embed) {
            _tpmCycleSource();
          }
          break;
        }
        case BTN.SELECT:
          // Toggle the on-screen controller-bindings card. Doesn't change
          // state.screen — playback + d-pad keep working underneath.
          _tvpToggleHelp(); break;
      }
      return;
    }

    // ── THEATER PAUSE MENU navigation ────────────────────────
    if (state.screen === 'theater-paused') {
      const btns = _tpmButtons();
      switch (btnIdx) {
        case BTN.DUP:
        case BTN.DLEFT:
          TheaterPlayer.pauseMenuFocus =
            (TheaterPlayer.pauseMenuFocus - 1 + btns.length) % btns.length;
          _tpmUpdateFocus(); break;
        case BTN.DDOWN:
        case BTN.DRIGHT:
          TheaterPlayer.pauseMenuFocus =
            (TheaterPlayer.pauseMenuFocus + 1) % btns.length;
          _tpmUpdateFocus(); break;
        case BTN.SOUTH:
          btns[TheaterPlayer.pauseMenuFocus]?.click(); break;
        case BTN.EAST:
        case BTN.HOME:
        case BTN.START:
          hideTheaterPauseMenu(); break;
      }
      return;
    }

    // ── Normal OS navigation ──────────────────────────────────
    switch (btnIdx) {
      case BTN.SOUTH:  confirm();             break;
      case BTN.EAST:
      case BTN.SELECT: back();               break;
      case BTN.LB:     navigate('left');     break;
      case BTN.RB:     navigate('right');    break;
      case BTN.START:
        // Advance the splash screen, or go back from any menu
        if (state.screen === 'splash') {
          document.getElementById('splash')?.click();
        } else if (state.screen === 'menu') {
          back();
        }
        break;
      case BTN.DUP:    navigate('up');       break;
      case BTN.DDOWN:  navigate('down');     break;
      case BTN.DLEFT:  navigate('left');     break;
      case BTN.DRIGHT: navigate('right');    break;
    }
  }

  // ── Poll loop ────────────────────────────────────────────────
  function poll() {
    const pads = navigator.getGamepads() || [];
    const now  = Date.now();

    for (const gp of pads) {
      if (!gp) continue;

      const btnMap   = getButtonMap(gp);   // null = standard, object = Wiimote
      const stickAx  = getStickAxes(gp);   // [xIdx, yIdx] or null (skip axes)

      // ── Buttons ──────────────────────────────────────────────
      gp.buttons.forEach((btn, i) => {
        const key   = `${gp.index}_b${i}`;
        const wasOn = _prev[key];
        const isOn  = btn.pressed;

        // Translate raw button index → standard BTN index for Wiimotes
        const logical = btnMap ? btnMap[i] : i;
        if (logical === undefined) { _prev[key] = isOn; return; } // unmapped

        if (isOn && !wasOn) {
          dispatch(logical);
          _held[key] = { since: now, lastFire: now };
        } else if (isOn && _held[key]) {
          const h = _held[key];
          if (now - h.since > FIRST_DELAY && now - h.lastFire > REPEAT_MS) {
            dispatch(logical);
            h.lastFire = now;
          }
        } else if (!isOn) { delete _held[key]; }

        _prev[key] = isOn;
      });

      // ── Analog stick (skipped for Wiimote without Nunchuk) ───
      // Also skipped while a game owns the controller ('playing') or while
      // the DualSense touchpad cursor is active (left stick drives the cursor instead).
      if (stickAx && state.screen !== 'playing' && !(typeof DSPointer !== 'undefined' && DSPointer.active)) {
        const ax  = gp.axes[stickAx[0]] || 0;
        const ay  = gp.axes[stickAx[1]] || 0;
        const dir = ay < -DEADZONE ? 'up'   : ay > DEADZONE ? 'down'
                  : ax < -DEADZONE ? 'left' : ax > DEADZONE ? 'right' : null;
        const sk  = `${gp.index}_s`;
        const was = _prev[sk];

        // Route stick through dispatch when pause menu is open
        const stickNavigate = (d) => {
          if (typeof KenteOSK !== 'undefined' && KenteOSK.active()) {
            KenteOSK.navigate(d);
          } else if (state.screen === 'paused' || state.screen === 'theater-paused') {
            dispatch(d === 'up' || d === 'left' ? BTN.DUP : BTN.DDOWN);
          } else if (state.screen === 'theater-playing') {
            // Map stick direction to seek / volume on the theater player.
            const map = { left: BTN.DLEFT, right: BTN.DRIGHT, up: BTN.DUP, down: BTN.DDOWN };
            dispatch(map[d]);
          } else {
            navigate(d);
          }
        };

        if (dir !== was) {
          if (dir) { stickNavigate(dir); _held[sk] = { since: now, lastFire: now }; }
          else     { delete _held[sk]; }
          _prev[sk] = dir;
        } else if (dir && _held[sk]) {
          const h = _held[sk];
          if (now - h.since > FIRST_DELAY && now - h.lastFire > REPEAT_MS) {
            stickNavigate(dir); h.lastFire = now;
          }
        }
      }

      // ── DualSense touchpad (button 17) ────────────────────────
      // Double-tap  → toggle cursor mode on/off
      // Single tap  (cursor active) → click element under cursor
      // Single tap  (cursor off)    → do nothing (wait for second tap)
      if (DUALSENSE_RE.test(gp.id) && gp.mapping === 'standard' && state.screen !== 'playing') {
        const tpBtn = gp.buttons[17];
        if (tpBtn) {
          const tpKey  = `${gp.index}_tp`;
          const wasTP  = !!_prev[tpKey];
          const isTP   = tpBtn.pressed;
          if (isTP && !wasTP) {
            const t2  = Date.now();
            const dbl = t2 - _dsLastTap < DS_DTAP_MS;
            _dsLastTap = dbl ? 0 : t2;   // reset so triple-tap doesn't re-toggle

            if (DSPointer.active) {
              // Cursor mode on: single-tap = click, double-tap = exit cursor
              dbl ? DSPointer.stop() : DSPointer.click();
            } else if (dbl) {
              // Double-tap while cursor off → cancel pending Download Center open, start cursor
              if (_dsSingleTapTimer) { clearTimeout(_dsSingleTapTimer); _dsSingleTapTimer = null; }
              DSPointer.start(gp);
            } else {
              // Single tap while cursor off → open Download Center after the double-tap window
              // (if a second tap arrives within DS_DTAP_MS the timer is cancelled above)
              _dsSingleTapTimer = setTimeout(() => {
                _dsSingleTapTimer = null;
                openDownloadCenter();
              }, DS_DTAP_MS);
            }
          }
          _prev[tpKey] = isTP;
        }
      }
    }
    _raf = requestAnimationFrame(poll);
  }

  // ── HUD indicator ────────────────────────────────────────────
  // Counts live pads from navigator.getGamepads() (most accurate — _gpN can
  // drift if connect/disconnect events fire out of order on Bluetooth pads).
  function _liveCount() {
    let n = 0;
    for (const gp of (navigator.getGamepads() || [])) if (gp?.connected) n++;
    return n;
  }
  function _updateBadge() {
    const el = document.getElementById('gp-indicator');
    if (!el) return;
    const n = _liveCount();
    _gpN = n;   // keep the cached counter in sync with reality
    el.hidden = (n === 0);
    const cnt = document.getElementById('gp-count');
    // Show "P1·P2" up to 4 pads, fall back to "×N" beyond that
    if (cnt) cnt.textContent = n <= 4
      ? Array.from({length:n}, (_,i) => `P${i+1}`).join('·')
      : `×${n}`;
  }

  // ── Connect / Disconnect ─────────────────────────────────────
  function onConnect(e) {
    if (!_raf) _raf = requestAnimationFrame(poll);
    const slot  = (e.gamepad?.index ?? 0) + 1;
    const label = (e.gamepad?.id || '').replace(/\(.*\)/g,'').trim().slice(0,40).toUpperCase()
                  || 'CONTROLLER';
    showToast(`🎮 PLAYER ${slot} READY — ${label}`);
    _updateBadge();
    // On first controller connection, auto-focus the current TV zone so the
    // user can navigate immediately without pressing a direction button first.
    if (_gpN === 1 && !getScope()) {
      state.focusIndex = state.focusIndex ?? 0;
      focusZone(TV_ZONES[state.focusIndex]);
    }
  }

  function onDisconnect(e) {
    const slot = (e?.gamepad?.index ?? 0) + 1;
    _updateBadge();
    if (_gpN === 0 && _raf) { cancelAnimationFrame(_raf); _raf = null; resetFocus(); }
    showToast(`🎮 PLAYER ${slot} DISCONNECTED`);
  }

  // ── Public API ───────────────────────────────────────────────
  function init() {
    window.addEventListener('gamepadconnected',    onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);
    // Pick up gamepads already connected before the page loaded
    _updateBadge();   // syncs _gpN from navigator.getGamepads()
    if (_gpN > 0) {
      _raf = requestAnimationFrame(poll);
      // Gamepad was already plugged in when the page loaded — apply focus
      // immediately so the controller is usable without a first-button press.
      // Use rAF to let the room DOM finish rendering before calling focusZone.
      requestAnimationFrame(() => {
        if (!getScope()) {
          state.focusIndex = state.focusIndex ?? 0;
          focusZone(TV_ZONES[state.focusIndex]);
        }
      });
    }
  }

  /** Live-pad accessor used by emulator launch flows that want to announce
   *  "N PLAYERS READY" without re-implementing the navigator probe. */
  function liveCount() { return _liveCount(); }

  /** Cancel any pending single-tap Download-Center timer.
   *  Call from exitEmulator() to prevent a stale timer firing after the
   *  emulator launches or the user navigates away. */
  function cancelTouchpadTimer() {
    if (_dsSingleTapTimer) {
      clearTimeout(_dsSingleTapTimer);
      _dsSingleTapTimer = null;
    }
  }

  return { init, resetFocus, applyFocus, navigate, confirm, cancelTouchpadTimer, liveCount };
})();

/* ══════════════════════════════════════════
   DUALSENSE TOUCHPAD CURSOR
   Double-tap the touchpad to toggle.
   Right stick → move cursor (velocity).
   Single tap  → click element under cursor.
   Double-tap again → exit cursor mode.
══════════════════════════════════════════ */
const DSPointer = (() => {
  const STICK_SPEED  = 0.012;  // cursor screen-fraction per frame at full left-stick
  const TP_SCALE     = 0.75;   // touchpad delta → cursor sensitivity
  const SCROLL_SPEED = 10;     // px per frame at full right-stick deflection
  const DEADZONE     = 0.14;   // inner dead zone (same for all inputs)

  let _active  = false;
  let _raf     = null;
  let _gpIndex = -1;
  let _x = 0.5, _y = 0.5;     // cursor position [0–1] screen fraction
  let _lastMoveX = -1;        // last screen-px X we dispatched mousemove at
  let _lastMoveY = -1;
  let _lastHover = null;      // last element we sent mouseover to

  // Touchpad swipe tracking (delta between frames, not absolute position)
  let _prevTpX = null;
  let _prevTpY = null;

  const _el = () => document.getElementById('ds-cursor');

  // ── Synthetic mouse helpers ──────────────────────────────────
  // Resolve the element under (px, py) without the cursor element
  // catching the hit-test.
  function _hitTest(px, py) {
    const cur = _el();
    if (cur) cur.style.pointerEvents = 'none';
    const el = document.elementFromPoint(px, py);
    if (cur) cur.style.pointerEvents = '';
    return el;
  }

  // Dispatch a real mousemove (+ pointermove + over/out as needed) at the
  // current cursor position so the player's idle handler, hover styling,
  // tooltips, and slider drags all respond as if a real mouse were used.
  function _dispatchMove() {
    const px = _x * window.innerWidth;
    const py = _y * window.innerHeight;
    if (Math.abs(px - _lastMoveX) < 1 && Math.abs(py - _lastMoveY) < 1) return;
    _lastMoveX = px; _lastMoveY = py;
    const target = _hitTest(px, py);
    if (!target) { _lastHover = null; return; }

    // Electron-only: make cursor mode a real mouse for cross-origin iframes
    // (embed players ignore synthetic JS-dispatched events).
    if (target.tagName === 'IFRAME' && window.electronAPI?.sendMouseMove) {
      try { window.electronAPI.sendMouseMove(px, py); } catch {}
      _lastHover = target;
      return;
    }

    const opts = { bubbles: true, cancelable: true, view: window,
                   clientX: px, clientY: py, screenX: px, screenY: py,
                   button: 0, buttons: 0 };
    if (target !== _lastHover) {
      try { _lastHover?.dispatchEvent(new MouseEvent('mouseout', { ...opts, relatedTarget: target })); } catch {}
      try { _lastHover?.dispatchEvent(new PointerEvent('pointerout', { ...opts, pointerType: 'mouse', isPrimary: true, relatedTarget: target })); } catch {}
      try { target.dispatchEvent(new MouseEvent('mouseover', { ...opts, relatedTarget: _lastHover })); } catch {}
      try { target.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerType: 'mouse', isPrimary: true, relatedTarget: _lastHover })); } catch {}
      _lastHover = target;
    }
    try { target.dispatchEvent(new PointerEvent('pointermove', { ...opts, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mousemove', opts)); } catch {}
  }

  // ── Scroll helpers ────────────────────────────────────────────
  /**
   * Walk up the DOM from `el` and return the first element that can
   * actually scroll in either axis, or null if nothing scrollable is found.
   */
  function _findScrollable(el) {
    while (el && el !== document.documentElement) {
      const st = getComputedStyle(el);
      const oy = st.overflowY, ox = st.overflowX;
      const canScrollY = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1;
      const canScrollX = (ox === 'auto' || ox === 'scroll') && el.scrollWidth  > el.clientWidth  + 1;
      if (canScrollY || canScrollX) return el;
      el = el.parentElement;
    }
    // Final fallback: the document root (handles full-page overflow)
    const root = document.documentElement;
    return (root.scrollHeight > root.clientHeight || root.scrollWidth > root.clientWidth) ? root : null;
  }

  /**
   * Scroll the nearest scrollable element under the cursor by (dx, dy) px.
   * Shows the scroll indicator on the cursor element while active.
   */
  function _scrollAt(dx, dy) {
    const px = _x * window.innerWidth;
    const py = _y * window.innerHeight;
    const cursorEl = _el();

    if (cursorEl) cursorEl.style.pointerEvents = 'none';
    const hit = document.elementFromPoint(px, py);
    if (cursorEl) cursorEl.style.pointerEvents = '';

    const target = hit ? _findScrollable(hit) : null;
    if (target) {
      target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      // Show scroll indicator on the cursor
      cursorEl?.classList.add('scrolling');
    }
  }

  // ── Animation loop ────────────────────────────────────────────
  function _loop() {
    if (!_active) return;

    const pads = navigator.getGamepads() || [];
    const gp   = pads[_gpIndex] || [...pads].find(g => g && DUALSENSE_RE.test(g.id));
    const el   = _el();
    let isScrolling = false;

    if (gp) {
      // ── Left stick (axes 0, 1) → cursor velocity ────────────────
      const lx = Math.abs(gp.axes[0] || 0) > DEADZONE ? gp.axes[0] : 0;
      const ly = Math.abs(gp.axes[1] || 0) > DEADZONE ? gp.axes[1] : 0;
      _x = Math.max(0.01, Math.min(0.99, _x + lx * STICK_SPEED));
      _y = Math.max(0.01, Math.min(0.99, _y + ly * STICK_SPEED));

      // ── Right stick (axes 2, 3) → scroll element under cursor ───
      const rx = Math.abs(gp.axes[2] || 0) > DEADZONE ? gp.axes[2] : 0;
      const ry = Math.abs(gp.axes[3] || 0) > DEADZONE ? gp.axes[3] : 0;
      if (rx !== 0 || ry !== 0) {
        _scrollAt(rx * SCROLL_SPEED, ry * SCROLL_SPEED);
        isScrolling = true;
      }

      // ── Touchpad swipe (axes 4, 5) → cursor delta ───────────────
      // Chrome exposes the DualSense first touch-point as axes[4] (X) and
      // axes[5] (Y) on USB on Windows / all connections on macOS/Linux.
      // Delta-based so resting at the pad edge doesn't drift the cursor.
      if (gp.axes.length > 5) {
        const tpX = gp.axes[4];
        const tpY = gp.axes[5];
        if (_prevTpX !== null) {
          const dx = tpX - _prevTpX;
          const dy = tpY - _prevTpY;
          if (Math.abs(dx) > 0.004 || Math.abs(dy) > 0.004) {
            _x = Math.max(0.01, Math.min(0.99, _x + dx * TP_SCALE));
            _y = Math.max(0.01, Math.min(0.99, _y + dy * TP_SCALE));
          }
        }
        _prevTpX = tpX;
        _prevTpY = tpY;
      }
    }

    // Update cursor position
    if (el) {
      el.style.left = `${(_x * 100).toFixed(2)}%`;
      el.style.top  = `${(_y * 100).toFixed(2)}%`;
      // Toggle scroll indicator class — remove it one frame after scrolling stops
      if (!isScrolling) el.classList.remove('scrolling');
    }

    // Drive synthetic mouse events so the player chrome (and any other
    // hover-aware UI) reacts as if a real mouse were under the cursor.
    _dispatchMove();

    _raf = requestAnimationFrame(_loop);
  }

  // ── Public API ───────────────────────────────────────────────
  function start(gp) {
    if (_active) return;
    _active  = true;
    _gpIndex = gp?.index ?? -1;
    _x = 0.5; _y = 0.5;
    _prevTpX = null; _prevTpY = null;
    _lastMoveX = -1; _lastMoveY = -1; _lastHover = null;
    const el = _el();
    if (el) el.hidden = false;
    _raf = requestAnimationFrame(_loop);
    showToast('👆 CURSOR ON — L-STICK: MOVE · R-STICK: SCROLL · TAP: CLICK · DOUBLE-TAP: EXIT');
  }

  function stop() {
    _active  = false;
    _prevTpX = null; _prevTpY = null;
    if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    // Send a final mouseout to whatever was under the cursor so any hover
    // styling clears cleanly when cursor mode exits.
    if (_lastHover) {
      try { _lastHover.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, view: window })); } catch {}
      _lastHover = null;
    }
    const el = _el();
    if (el) { el.hidden = true; el.classList.remove('scrolling'); }
    showToast('👆 TOUCHPAD CURSOR OFF');
  }

  function toggle(gp) { _active ? stop() : start(gp); }

  function click() {
    const el = _el();
    const px = _x * window.innerWidth;
    const py = _y * window.innerHeight;
    const target = _hitTest(px, py);
    if (!target) return;

    // Electron-only: allow cursor mode to click inside cross-origin iframes
    // (theater embed hosts, etc.) by injecting Chromium-level mouse events.
    if (target.tagName === 'IFRAME' && window.electronAPI?.sendMouseClick) {
      try { window.electronAPI.sendMouseClick(px, py); } catch {}
      if (el) {
        el.classList.add('clicking');
        setTimeout(() => el?.classList.remove('clicking'), 130);
      }
      return;
    }

    // Full mouse-button pipeline so video click-to-pause, slider drags,
    // label-for inputs, focus management, and pointer-event listeners
    // all respond identically to a real mouse click.
    const opts = { bubbles: true, cancelable: true, view: window,
                   clientX: px, clientY: py, screenX: px, screenY: py,
                   button: 0, buttons: 1, detail: 1 };
    try { target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
    try { target.dispatchEvent(new PointerEvent('pointerup',   { ...opts, buttons: 0, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 })); } catch {}
    try { target.dispatchEvent(new MouseEvent('click',   { ...opts, buttons: 0 })); } catch {}

    if (el) {
      el.classList.add('clicking');
      setTimeout(() => el?.classList.remove('clicking'), 130);
    }
  }

  return {
    get active() { return _active; },
    start, stop, toggle, click,
  };
})();
