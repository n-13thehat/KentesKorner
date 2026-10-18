/* Kente's Korner — Camera / VR manager and calibration. */
'use strict';

/* ══════════════════════════════════════════
   CAMERA MANAGER
   Powers:
     • VR Parallax — optical-flow / FaceDetector head tracking
       drives CSS vars --vr-x / --vr-y on <html>
     • Wii Pointer  — Wiimote accelerometer tilt → on-screen crosshair
       (real IR-bar replacement is hardware; this is the software proxy)
══════════════════════════════════════════ */
const CameraManager = (() => {
  /* ── Config ── */
  const VR_STRENGTH   = 18;    // max px shift at full tilt/motion
  const VR_SMOOTH     = 0.07;  // lerp factor (lower = smoother / slower)
  const WII_SMOOTH    = 0.10;  // pointer lerp factor
  const MOTION_THRESH = 12;    // brightness delta to count as motion
  const SAMPLE_COLS   = 16;    // grid sampling for optical flow
  const SAMPLE_ROWS   = 12;

  /* ── State ── */
  let _stream    = null;   // MediaStream
  let _vrActive  = false;
  let _wiiActive = false;
  let _vrRaf     = null;
  let _wiiRaf    = null;
  let _prevPixels = null;  // Uint8Array — previous frame luminance
  let _vrX = 0, _vrY = 0; // smoothed parallax offsets
  let _ptrX = 0.5, _ptrY = 0.5; // smoothed Wii pointer [0-1]

  /* ── DOM refs ── */
  const _video  = () => document.getElementById('cam-feed');
  const _canvas = () => document.getElementById('cam-canvas');
  const _cursor = () => document.getElementById('wii-cursor');
  const _badge  = () => document.getElementById('cam-indicator');

  /* ── Camera access ── */
  async function _acquireCamera() {
    if (_stream) return true;
    try {
      _stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 80, height: 60 }, audio: false });
      _video().srcObject = _stream;
      await _video().play();
      return true;
    } catch (err) {
      showToast('⚠ CAMERA ACCESS DENIED — VR/WII POINTER DISABLED');
      return false;
    }
  }

  function _releaseCamera() {
    if (_vrActive || _wiiActive) return; // still needed by other mode
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  }

  /* ── Badge update ── */
  function _updateBadge() {
    const b = _badge();
    if (!b) return;
    const vrSpan  = document.getElementById('cam-indicator-vr');
    const wiiSpan = document.getElementById('cam-indicator-wii');
    if (vrSpan)  vrSpan.classList.toggle('active',  _vrActive);
    if (wiiSpan) wiiSpan.classList.toggle('active', _wiiActive);
    b.hidden = !_vrActive && !_wiiActive;
  }

  /* ══ VR PARALLAX ══════════════════════════════════════════════ */

  /* Apply current _vrX/_vrY to the root element CSS vars */
  function _applyParallax() {
    document.documentElement.style.setProperty('--vr-x', `${_vrX.toFixed(2)}px`);
    document.documentElement.style.setProperty('--vr-y', `${_vrY.toFixed(2)}px`);
  }

  /* Sample luminance from current video frame into Uint8Array */
  function _sampleFrame() {
    const cv  = _canvas();
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(_video(), 0, 0, cv.width, cv.height);
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    // collapse to single-channel luminance
    const luma = new Uint8Array(cv.width * cv.height);
    for (let i = 0; i < luma.length; i++) {
      luma[i] = (data[i*4]*77 + data[i*4+1]*150 + data[i*4+2]*29) >> 8;
    }
    return luma;
  }

  /* Compute motion vector from two luma frames using a coarse grid.
     Respects Kinect calibration zone to restrict sampling region.   */
  const _ZONES = {
    full:   [0,    0,    1,    1   ],
    center: [0.25, 0.25, 0.75, 0.75],
    left:   [0,    0,    0.5,  1   ],
    right:  [0.5,  0,    1,    1   ],
    upper:  [0,    0,    1,    0.5 ],
    lower:  [0,    0.5,  1,    1   ],
  };

  function _motionVector(prev, curr, w, h) {
    // Read Kinect zone from CalibrationManager if available
    const kinCal = (typeof CalibrationManager !== 'undefined') ? CalibrationManager.get('kinect') : null;
    const [zx0, zy0, zx1, zy1] = _ZONES[(kinCal && kinCal.zone) || 'full'] || _ZONES.full;
    const kinSens = kinCal ? (kinCal.sens || 1) : 1;

    let dx = 0, dy = 0, n = 0;

    for (let row = 0; row < SAMPLE_ROWS; row++) {
      for (let col = 0; col < SAMPLE_COLS; col++) {
        // Map grid cell to pixel coordinates within calibrated zone
        const relX = zx0 + (col / SAMPLE_COLS) * (zx1 - zx0);
        const relY = zy0 + (row / SAMPLE_ROWS) * (zy1 - zy0);
        const px  = Math.floor(relX * w);
        const py  = Math.floor(relY * h);
        const idx = py * w + px;
        if (Math.abs(curr[idx] - prev[idx]) > MOTION_THRESH) {
          // normalise position to [-1, 1] range
          dx += (px / w - 0.5) * 2;
          dy += (py / h - 0.5) * 2;
          n++;
        }
      }
    }
    if (n < 3) return { x: 0, y: 0 }; // too few motion points → ignore
    return { x: (dx / n) * kinSens, y: (dy / n) * kinSens };
  }

  function _vrLoop() {
    if (!_vrActive) return;
    const v = _video();
    if (v.readyState >= 2) {
      const curr = _sampleFrame();
      if (_prevPixels) {
        const cv  = _canvas();
        const { x, y } = _motionVector(_prevPixels, curr, cv.width, cv.height);
        // Allow Oculus / PSVR calibration to override VR_STRENGTH and VR_SMOOTH
        const xrCal   = (typeof CalibrationManager !== 'undefined')
          ? (CalibrationManager.get('oculus') || CalibrationManager.get('psvr'))
          : null;
        const strength = xrCal ? (xrCal.vrStrength ?? VR_STRENGTH) : VR_STRENGTH;
        const smooth   = xrCal ? (xrCal.vrSmooth   ?? VR_SMOOTH)   : VR_SMOOTH;
        const targetX = -x * strength;
        const targetY = -y * strength;
        _vrX += (targetX - _vrX) * smooth;
        _vrY += (targetY - _vrY) * smooth;
        // Decay toward zero when no motion is detected
        if (Math.abs(x) < 0.01 && Math.abs(y) < 0.01) {
          _vrX *= 0.95; _vrY *= 0.95;
        }
        _applyParallax();
      }
      _prevPixels = curr;
    }
    _vrRaf = requestAnimationFrame(_vrLoop);
  }

  async function startVR() {
    if (_vrActive) return;
    if (!await _acquireCamera()) return;
    _vrActive   = true;
    _prevPixels = null;
    _vrRaf      = requestAnimationFrame(_vrLoop);
    _updateBadge();
    showToast('👁 VR PARALLAX ACTIVE');
  }

  function stopVR() {
    _vrActive = false;
    if (_vrRaf) { cancelAnimationFrame(_vrRaf); _vrRaf = null; }
    _vrX = 0; _vrY = 0; _applyParallax();
    _releaseCamera();
    _updateBadge();
  }

  /* ══ WII POINTER ══════════════════════════════════════════════ */
  /* Uses Wiimote accelerometer axes (0=X tilt, 1=Y tilt) exposed
     through the Gamepad API — no IR sensor bar needed.
     The crosshair maps tilt angle to screen position.             */

  const WIIMOTE_RE = /nintendo.*wii|wiimote|rv-s702/i;
  const PSMOVE_RE  = /ps.*move|sony.*motion|motion.*control/i;

  /* Returns first connected Wiimote OR PS Move (both use tilt axes) */
  function _findWiimote() {
    for (const gp of (navigator.getGamepads() || [])) {
      if (gp && (WIIMOTE_RE.test(gp.id) || PSMOVE_RE.test(gp.id))) return gp;
    }
    return null;
  }

  /* Apply calibration curve: (raw - center) / range, clamped to ±1 */
  function _calibrateAxis(raw, center, range) {
    return Math.max(-1, Math.min(1, (raw - center) / Math.max(range, 0.05)));
  }

  /* Synthetic-mouse helpers — same pattern as DSPointer. Lets the Wii
     crosshair drive hover styling, idle reveal, slider drags, and click
     handlers in the player and the rest of the UI.                    */
  let _wiiLastMoveX = -1, _wiiLastMoveY = -1, _wiiLastHover = null;

  function _wiiHitTest(px, py) {
    const cur = _cursor();
    if (cur) cur.style.pointerEvents = 'none';
    const el = document.elementFromPoint(px, py);
    if (cur) cur.style.pointerEvents = '';
    return el;
  }

  function _wiiDispatchMove() {
    const px = _ptrX * window.innerWidth;
    const py = _ptrY * window.innerHeight;
    if (Math.abs(px - _wiiLastMoveX) < 1 && Math.abs(py - _wiiLastMoveY) < 1) return;
    _wiiLastMoveX = px; _wiiLastMoveY = py;
    const target = _wiiHitTest(px, py);
    if (!target) { _wiiLastHover = null; return; }

    // Electron-only: treat the crosshair like a real mouse inside iframes.
    if (target.tagName === 'IFRAME' && window.electronAPI?.sendMouseMove) {
      try { window.electronAPI.sendMouseMove(px, py); } catch {}
      _wiiLastHover = target;
      return;
    }

    const opts = { bubbles: true, cancelable: true, view: window,
                   clientX: px, clientY: py, screenX: px, screenY: py,
                   button: 0, buttons: 0 };
    if (target !== _wiiLastHover) {
      try { _wiiLastHover?.dispatchEvent(new MouseEvent('mouseout', { ...opts, relatedTarget: target })); } catch {}
      try { _wiiLastHover?.dispatchEvent(new PointerEvent('pointerout', { ...opts, pointerType: 'mouse', isPrimary: true, relatedTarget: target })); } catch {}
      try { target.dispatchEvent(new MouseEvent('mouseover', { ...opts, relatedTarget: _wiiLastHover })); } catch {}
      try { target.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerType: 'mouse', isPrimary: true, relatedTarget: _wiiLastHover })); } catch {}
      _wiiLastHover = target;
    }
    try { target.dispatchEvent(new PointerEvent('pointermove', { ...opts, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mousemove', opts)); } catch {}
  }

  function _wiiLoop() {
    if (!_wiiActive) return;
    const gp = _findWiimote();

    if (gp && gp.axes.length >= 2) {
      // Resolve calibration key (Wii or PS Move)
      const calKey = PSMOVE_RE.test(gp.id) ? 'psmove' : 'wii';
      const cal = (typeof CalibrationManager !== 'undefined')
        ? CalibrationManager.get(calKey)
        : { cx:0, cy:0, rx:1, ry:1, sens:1 };

      // Apply calibration: offset center, normalise to ±1, apply sensitivity
      const ax = _calibrateAxis(gp.axes[0], cal.cx ?? 0, cal.rx ?? 1) * (cal.sens ?? 1);
      const ay = _calibrateAxis(gp.axes[1], cal.cy ?? 0, cal.ry ?? 1) * (cal.sens ?? 1);

      // Map calibrated [-1,1] → [0,1] screen fraction, clamped
      const tx = Math.max(0, Math.min(1, (ax + 1) / 2));
      const ty = Math.max(0, Math.min(1, (ay + 1) / 2));
      _ptrX += (tx - _ptrX) * WII_SMOOTH;
      _ptrY += (ty - _ptrY) * WII_SMOOTH;
    } else {
      // Drift back to center when no controller is found
      _ptrX += (0.5 - _ptrX) * 0.03;
      _ptrY += (0.5 - _ptrY) * 0.03;
    }

    const cur = _cursor();
    if (cur) {
      cur.style.left = `${(_ptrX * 100).toFixed(2)}%`;
      cur.style.top  = `${(_ptrY * 100).toFixed(2)}%`;
    }
    _wiiDispatchMove();
    _wiiRaf = requestAnimationFrame(_wiiLoop);
  }

  function startWiiPointer() {
    if (_wiiActive) return;
    _wiiActive = true;
    _ptrX = 0.5; _ptrY = 0.5;
    _wiiLastMoveX = -1; _wiiLastMoveY = -1; _wiiLastHover = null;
    const cur = _cursor();
    if (cur) cur.hidden = false;
    _wiiRaf = requestAnimationFrame(_wiiLoop);
    _updateBadge();
    showToast('🎯 WII POINTER ACTIVE — TILT REMOTE TO AIM');
  }

  function stopWiiPointer() {
    _wiiActive = false;
    if (_wiiRaf) { cancelAnimationFrame(_wiiRaf); _wiiRaf = null; }
    if (_wiiLastHover) {
      try { _wiiLastHover.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, view: window })); } catch {}
      _wiiLastHover = null;
    }
    const cur = _cursor();
    if (cur) cur.hidden = true;
    _updateBadge();
  }

  /* Returns the element currently under the Wii crosshair, or null */
  function getPointerTarget() {
    if (!_wiiActive) return null;
    const x = _ptrX * window.innerWidth;
    const y = _ptrY * window.innerHeight;
    return _wiiHitTest(x, y);
  }

  /* Synthesise a real mouse-button click (mousedown→mouseup→click) at the
     current crosshair position. Mirrors DSPointer.click().               */
  function clickAtPointer() {
    if (!_wiiActive) return false;
    const px = _ptrX * window.innerWidth;
    const py = _ptrY * window.innerHeight;
    const target = _wiiHitTest(px, py);
    if (!target) return false;

    // Electron-only: click inside cross-origin iframes (embed players).
    if (target.tagName === 'IFRAME' && window.electronAPI?.sendMouseClick) {
      try { window.electronAPI.sendMouseClick(px, py); } catch {}
      return true;
    }

    const opts = { bubbles: true, cancelable: true, view: window,
                   clientX: px, clientY: py, screenX: px, screenY: py,
                   button: 0, buttons: 1, detail: 1 };
    try { target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
    try { target.dispatchEvent(new PointerEvent('pointerup',   { ...opts, buttons: 0, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 })); } catch {}
    try { target.dispatchEvent(new MouseEvent('click',   { ...opts, buttons: 0 })); } catch {}
    return true;
  }

  return {
    startVR, stopVR,
    startWiiPointer, stopWiiPointer,
    getPointerTarget, clickAtPointer,
    get vrActive()  { return _vrActive;  },
    get wiiActive() { return _wiiActive; },
  };
})();

/* ══════════════════════════════════════════
   CALIBRATION MANAGER
   Supports: Wii Remote · PS Move · Oculus · PSVR · Xbox Kinect
   Calibration data persisted in localStorage.
══════════════════════════════════════════ */
const CalibrationManager = (() => {
  const STORE = 'kente_calibration';

  /* ── Device registry ── */
  const WIIMOTE_RE = /nintendo.*wii|wiimote|rv-s702/i;
  const PSMOVE_RE  = /ps.*move|sony.*motion|motion.*control/i;

  const DEVICES = [
    { key:'wii',    label:'WII REMOTE', icon:'🕹', type:'gamepad', re: WIIMOTE_RE },
    { key:'psmove', label:'PS MOVE',    icon:'🔵', type:'gamepad', re: PSMOVE_RE  },
    { key:'oculus', label:'OCULUS',     icon:'👓', type:'webxr'                   },
    { key:'psvr',   label:'PSVR',       icon:'🥽', type:'webxr'                   },
    { key:'kinect', label:'KINECT',     icon:'📷', type:'camera'                  },
  ];

  /* ── Defaults ── */
  const DEFAULTS = {
    wii:    { cx:0, cy:0, rx:1, ry:1, sens:1.0 },
    psmove: { cx:0, cy:0, rx:1, ry:1, sens:1.0 },
    oculus: { vrStrength:18, vrSmooth:0.07 },
    psvr:   { vrStrength:18, vrSmooth:0.07 },
    kinect: { zone:'full',   sens:1.0 },
  };

  /* ── Runtime state ── */
  let _data        = {};
  let _activeKey   = null;
  let _step        = 0;
  let _rafId       = null;
  let _capture     = {};   // temp during calibration
  let _rangeTimer  = null;

  /* ── Storage ── */
  function _load() {
    try { const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
      _data = {};
      for (const k of Object.keys(DEFAULTS)) _data[k] = { ...DEFAULTS[k], ...(raw[k] || {}) };
    } catch { _data = {}; for (const k of Object.keys(DEFAULTS)) _data[k] = { ...DEFAULTS[k] }; }
  }
  _load();

  function get(key)      { return _data[key] || { ...DEFAULTS[key] } || {}; }
  function save(key, d)  { _data[key] = { ...(_data[key]||{}), ...d }; try { localStorage.setItem(STORE, JSON.stringify(_data)); } catch {} }
  function reset(key)    { _data[key] = { ...DEFAULTS[key] };           try { localStorage.setItem(STORE, JSON.stringify(_data)); } catch {} }

  /* ── Find connected gamepad for a device def ── */
  function _findPad(def) {
    for (const gp of (navigator.getGamepads() || [])) {
      if (gp && def.re && def.re.test(gp.id)) return gp;
    }
    return null;
  }

  /* ── Live axis loop ── */
  function _stopLive() { if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; } }

  function _liveAxes(def) {
    _stopLive();
    function tick() {
      const gp = _findPad(def);
      if (!gp) return;
      ['x','y'].forEach((axis, i) => {
        const raw = gp.axes[i] || 0;
        const fill = document.getElementById(`cal-fill-${axis}`);
        const val  = document.getElementById(`cal-val-${axis}`);
        if (!fill || !val) return;
        // Track range during sweep
        if (_capture.sweeping) {
          _capture.minX = Math.min(_capture.minX ?? raw, raw);
          _capture.maxX = Math.max(_capture.maxX ?? raw, raw);
          if (i === 1) {
            _capture.minY = Math.min(_capture.minY ?? raw, raw);
            _capture.maxY = Math.max(_capture.maxY ?? raw, raw);
          }
        }
        // Render bar: center is 50%, raw ±1 maps to 0–100%
        const pct = (raw + 1) / 2 * 100;
        const cx  = 50;
        const left  = Math.min(pct, cx);
        const width = Math.abs(pct - cx);
        fill.style.left  = `${left}%`;
        fill.style.width = `${width}%`;
        val.textContent  = raw.toFixed(3);
      });
      _rafId = requestAnimationFrame(tick);
    }
    _rafId = requestAnimationFrame(tick);
  }

  /* ── Axis meter HTML helper ── */
  function _axisMeters() {
    return ['X','Y'].map(a => `
      <div class="cal-axis-row">
        <span class="cal-axis-lbl">${a}</span>
        <div class="cal-axis-track">
          <div class="cal-axis-center-mark"></div>
          <div class="cal-axis-fill" id="cal-fill-${a.toLowerCase()}"></div>
        </div>
        <span class="cal-axis-val" id="cal-val-${a.toLowerCase()}">0.000</span>
      </div>`).join('');
  }

  /* ══ WIZARD RENDERERS ══════════════════════════════════════════ */

  function _renderGamepad(def) {
    const wiz   = document.getElementById('cal-wizard');
    const cal   = get(def.key);
    const gp    = _findPad(def);
    const found = !!gp;

    if (!found) {
      wiz.innerHTML = `
        <div class="cal-status err">NO ${def.label} DETECTED — CONNECT DEVICE AND REOPEN CALIBRATION</div>
        <p class="cal-instruction">Make sure the controller is paired via Bluetooth or USB,<br>
        then click the device chip above again.</p>`;
      return;
    }

    if (_step === 0) {
      wiz.innerHTML = `
        <div class="cal-step-label">STEP 1 OF 3</div>
        <div class="cal-step-title">NEUTRAL POSITION</div>
        <p class="cal-instruction">Hold the ${def.label} flat and still, pointed at the screen.<br>
        Press <strong>CAPTURE NEUTRAL</strong> to record the zero point.</p>
        ${_axisMeters()}
        <div class="cal-step-nav">
          <button class="cal-btn" id="cal-capture-neutral">CAPTURE NEUTRAL</button>
          <button class="cal-btn sec" id="cal-skip-neutral">SKIP</button>
        </div>`;
      _liveAxes(def);
      document.getElementById('cal-capture-neutral').onclick = () => {
        const g = _findPad(def);
        if (!g) return;
        save(def.key, { cx: g.axes[0] || 0, cy: g.axes[1] || 0 });
        showToast(`✓ NEUTRAL CAPTURED (${(g.axes[0]||0).toFixed(3)}, ${(g.axes[1]||0).toFixed(3)})`);
        _step = 1; _stopLive(); _renderGamepad(def);
      };
      document.getElementById('cal-skip-neutral').onclick = () => { _step = 1; _stopLive(); _renderGamepad(def); };

    } else if (_step === 1) {
      _capture = { sweeping: false };
      wiz.innerHTML = `
        <div class="cal-step-label">STEP 2 OF 3</div>
        <div class="cal-step-title">RANGE SWEEP</div>
        <p class="cal-instruction">Click <strong>START SWEEP</strong> then slowly tilt the ${def.label}<br>
        to the edges of your comfortable movement range. You have 4 seconds.</p>
        ${_axisMeters()}
        <div id="cal-sweep-countdown"></div>
        <div class="cal-range-note" id="cal-range-result"></div>
        <div class="cal-step-nav">
          <button class="cal-btn" id="cal-start-sweep">START SWEEP</button>
          <button class="cal-btn sec" id="cal-skip-range">SKIP</button>
        </div>`;
      _liveAxes(def);
      document.getElementById('cal-start-sweep').onclick = () => {
        _capture = { sweeping: true, minX:0, maxX:0, minY:0, maxY:0 };
        let secs = 4;
        const countdown = document.getElementById('cal-sweep-countdown');
        const btn = document.getElementById('cal-start-sweep');
        if (btn) btn.disabled = true;
        const tick = setInterval(() => {
          secs--;
          if (countdown) countdown.innerHTML = `<div class="cal-countdown">${secs}</div>`;
          if (secs <= 0) {
            clearInterval(tick);
            _capture.sweeping = false;
            const rx = Math.max(0.1, Math.max(Math.abs(_capture.maxX), Math.abs(_capture.minX)));
            const ry = Math.max(0.1, Math.max(Math.abs(_capture.maxY), Math.abs(_capture.minY)));
            save(def.key, { rx, ry });
            const note = document.getElementById('cal-range-result');
            if (note) note.innerHTML = `✓ RANGE SAVED — X: ±${rx.toFixed(3)}  Y: ±${ry.toFixed(3)}`;
            if (countdown) countdown.innerHTML = '';
          }
        }, 1000);
      };
      document.getElementById('cal-skip-range').onclick = () => { _step = 2; _stopLive(); _renderGamepad(def); };

    } else {
      _stopLive();
      const cur = get(def.key);
      wiz.innerHTML = `
        <div class="cal-step-label">STEP 3 OF 3</div>
        <div class="cal-step-title">SENSITIVITY</div>
        <p class="cal-instruction">Adjust pointer sensitivity. 1.0 = normal · 0.5 = slow · 2.0 = fast</p>
        <div class="cal-slider-row">
          <span class="cal-axis-lbl">SENS</span>
          <input type="range" id="cal-sens-slider" min="0.3" max="2.5" step="0.05" value="${cur.sens || 1.0}">
          <span class="cal-slider-val" id="cal-sens-val">${(cur.sens||1.0).toFixed(2)}×</span>
        </div>
        <div class="cal-status ok">✓ CALIBRATION COMPLETE — ${def.label}</div>
        <div class="cal-step-nav">
          <button class="cal-btn" id="cal-save-done">SAVE &amp; CLOSE</button>
          <button class="cal-btn danger" id="cal-reset">RESET TO DEFAULT</button>
        </div>`;
      document.getElementById('cal-sens-slider').oninput = e => {
        const v = parseFloat(e.target.value);
        document.getElementById('cal-sens-val').textContent = `${v.toFixed(2)}×`;
        save(def.key, { sens: v });
      };
      document.getElementById('cal-save-done').onclick = () => close();
      document.getElementById('cal-reset').onclick = () => {
        reset(def.key); _step = 0; _renderGamepad(def);
        showToast(`↺ ${def.label} CALIBRATION RESET`);
      };
    }
  }

  function _renderWebXR(def) {
    const wiz = document.getElementById('cal-wizard');
    const cal = get(def.key);
    const xrOk = 'xr' in navigator;

    let statusHtml, xrNote;
    if (!xrOk) {
      statusHtml = `<div class="cal-status err">WEBXR NOT AVAILABLE — USE A COMPATIBLE BROWSER (Chrome/Edge + headset driver)</div>`;
      xrNote = '';
    } else {
      statusHtml = `<div class="cal-status ok">✓ WEBXR API DETECTED</div>`;
      xrNote = `<p class="cal-instruction">Click <strong>CHECK HEADSET</strong> to probe ${def.label} connection.<br>
      When wearing the headset and looking straight ahead, click <strong>RESET CENTER</strong>.</p>`;
    }

    wiz.innerHTML = `
      <div class="cal-step-label">${def.label} — VR PARALLAX CALIBRATION</div>
      ${statusHtml}${xrNote}
      <p class="cal-instruction">Parallax Strength controls how much the room shifts with head movement.<br>
      Higher = more dramatic. Smooth controls follow speed.</p>
      <div class="cal-slider-row">
        <span class="cal-axis-lbl" style="width:60px;font-size:8px">STRENGTH</span>
        <input type="range" id="cal-xr-strength" min="4" max="40" step="1" value="${cal.vrStrength ?? 18}">
        <span class="cal-slider-val" id="cal-xr-str-val">${cal.vrStrength ?? 18}px</span>
      </div>
      <div class="cal-slider-row">
        <span class="cal-axis-lbl" style="width:60px;font-size:8px">SMOOTH</span>
        <input type="range" id="cal-xr-smooth" min="0.02" max="0.25" step="0.01" value="${cal.vrSmooth ?? 0.07}">
        <span class="cal-slider-val" id="cal-xr-smo-val">${(cal.vrSmooth ?? 0.07).toFixed(2)}</span>
      </div>
      <div class="cal-step-nav">
        ${xrOk ? `<button class="cal-btn sec" id="cal-xr-check">CHECK HEADSET</button>
        <button class="cal-btn" id="cal-xr-center">RESET CENTER</button>` : ''}
        <button class="cal-btn" id="cal-xr-save">SAVE &amp; CLOSE</button>
        <button class="cal-btn danger" id="cal-xr-reset">RESET DEFAULT</button>
      </div>
      <div id="cal-xr-status" class="cal-range-note"></div>`;

    document.getElementById('cal-xr-strength').oninput = e => {
      const v = parseInt(e.target.value);
      document.getElementById('cal-xr-str-val').textContent = `${v}px`;
      save(def.key, { vrStrength: v });
    };
    document.getElementById('cal-xr-smooth').oninput = e => {
      const v = parseFloat(e.target.value);
      document.getElementById('cal-xr-smo-val').textContent = v.toFixed(2);
      save(def.key, { vrSmooth: v });
    };
    if (xrOk) {
      document.getElementById('cal-xr-check').onclick = async () => {
        const st = document.getElementById('cal-xr-status');
        try {
          const ok = await navigator.xr.isSessionSupported('immersive-vr');
          if (st) st.innerHTML = ok
            ? '<span style="color:var(--green)">✓ HEADSET READY FOR IMMERSIVE VR</span>'
            : '<span style="color:var(--brand)">⚠ HEADSET NOT IN IMMERSIVE VR MODE — PUT ON HEADSET</span>';
        } catch { if (st) st.innerHTML = '<span style="color:var(--red)">✕ XR CHECK FAILED</span>'; }
      };
      document.getElementById('cal-xr-center').onclick = () => {
        save(def.key, { recalibrated: true });
        showToast(`✓ ${def.label} CENTER LOCKED`);
        const st = document.getElementById('cal-xr-status');
        if (st) st.innerHTML = '<span style="color:var(--green)">✓ CENTER POSITION SAVED</span>';
      };
    }
    document.getElementById('cal-xr-save').onclick  = () => close();
    document.getElementById('cal-xr-reset').onclick = () => { reset(def.key); _renderWebXR(def); showToast(`↺ ${def.label} RESET`); };
  }

  function _renderKinect(def) {
    const wiz  = document.getElementById('cal-wizard');
    const cal  = get(def.key);
    const ZONES = [
      { key:'full',   label:'FULL FRAME'  },
      { key:'center', label:'CENTER ZONE' },
      { key:'left',   label:'LEFT HALF'   },
      { key:'right',  label:'RIGHT HALF'  },
      { key:'upper',  label:'UPPER HALF'  },
      { key:'lower',  label:'LOWER HALF'  },
    ];
    const zoneGrid = ZONES.map(z =>
      `<button class="cal-zone-btn${cal.zone === z.key ? ' active':''}" data-zone="${z.key}">${z.label}</button>`
    ).join('');

    wiz.innerHTML = `
      <div class="cal-step-label">KINECT / DEPTH CAMERA — MOTION ZONE CALIBRATION</div>
      <div class="cal-status warn">⚠ KINECT DEPTH STREAM NOT ACCESSIBLE IN BROWSER — USING RGB CAMERA MODE</div>
      <p class="cal-instruction">Kinect is used as a standard webcam for VR Parallax motion detection.<br>
      Select which region of the camera frame to track. CENTER ZONE reduces false triggers from background motion.</p>
      <div class="cal-zone-grid">${zoneGrid}</div>
      <p class="cal-instruction" style="margin-top:12px">Motion Sensitivity — lower to reduce jitter from ambient movement.</p>
      <div class="cal-slider-row">
        <span class="cal-axis-lbl" style="width:40px;font-size:8px">SENS</span>
        <input type="range" id="cal-kinect-sens" min="0.3" max="2.0" step="0.05" value="${cal.sens ?? 1.0}">
        <span class="cal-slider-val" id="cal-kinect-sens-val">${(cal.sens??1.0).toFixed(2)}×</span>
      </div>
      <div class="cal-step-nav">
        <button class="cal-btn" id="cal-kinect-save">SAVE &amp; CLOSE</button>
        <button class="cal-btn danger" id="cal-kinect-reset">RESET DEFAULT</button>
      </div>`;

    wiz.querySelectorAll('.cal-zone-btn').forEach(btn => {
      btn.onclick = () => {
        wiz.querySelectorAll('.cal-zone-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        save('kinect', { zone: btn.dataset.zone });
      };
    });
    document.getElementById('cal-kinect-sens').oninput = e => {
      const v = parseFloat(e.target.value);
      document.getElementById('cal-kinect-sens-val').textContent = `${v.toFixed(2)}×`;
      save('kinect', { sens: v });
    };
    document.getElementById('cal-kinect-save').onclick  = () => close();
    document.getElementById('cal-kinect-reset').onclick = () => { reset('kinect'); _renderKinect(def); showToast('↺ KINECT CALIBRATION RESET'); };
  }

  /* ── Render dispatcher ── */
  function _renderWizard(key) {
    _stopLive();
    _step = 0;
    _activeKey = key;
    const def = DEVICES.find(d => d.key === key);
    if (!def) return;
    // Highlight device chip
    document.querySelectorAll('.cal-dev-btn').forEach(b => b.classList.toggle('active', b.dataset.key === key));
    if (def.type === 'gamepad') _renderGamepad(def);
    else if (def.type === 'webxr')  _renderWebXR(def);
    else                            _renderKinect(def);
  }

  /* ── Public open / close ── */
  function open(deviceKey) {
    const overlay = document.getElementById('calibration-overlay');
    const devs    = document.getElementById('cal-devices');
    if (!overlay || !devs) return;

    devs.innerHTML = DEVICES.map(d =>
      `<button class="cal-dev-btn${d.key === (deviceKey||DEVICES[0].key) ? ' active':''}" data-key="${d.key}">${d.icon} ${d.label}</button>`
    ).join('');

    devs.querySelectorAll('.cal-dev-btn').forEach(btn => {
      btn.onclick = () => _renderWizard(btn.dataset.key);
    });

    document.getElementById('cal-close').onclick = close;
    overlay.classList.add('active');
    _renderWizard(deviceKey || DEVICES[0].key);
  }

  function close() {
    _stopLive();
    const overlay = document.getElementById('calibration-overlay');
    if (overlay) overlay.classList.remove('active');
    _activeKey = null;
  }

  return { open, close, get, save, reset };
})();
