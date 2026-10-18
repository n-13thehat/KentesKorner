/* Kente's Korner — Audio engine, matrix rain, matrix transition. */
'use strict';

/* ══════════════════════════════════════════
   KENTE AUDIO ENGINE  (Web Audio API — no external files)
══════════════════════════════════════════ */
const KenteAudio = (() => {
  let ctx = null;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Chrome auto-suspends AudioContext even inside user-gesture callbacks;
    // resume() immediately to guarantee audio fires on first call.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  let masterVol = 1;

  function tone(freq, dur, vol = 0.08, type = 'sine', attack = 0.005) {
    if (!ctx) return;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol * masterVol, ctx.currentTime + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + dur + 0.01);
  }

  function click()  { tone(700, 0.04, 0.07, 'square'); }
  function focus()  { tone(520, 0.07, 0.05, 'sine'); }
  function back()   { tone(300, 0.10, 0.06, 'sine'); }
  function select() {
    tone(600, 0.06, 0.09, 'sine');
    setTimeout(() => tone(900, 0.12, 0.07, 'sine'), 55);
  }
  function bootSting() {
    // Rising 4-note chord sequence
    [[220,0],[330,90],[440,180],[660,270],[880,380]].forEach(([f,d]) =>
      setTimeout(() => tone(f, 0.35, 0.055, 'sine'), d)
    );
  }

  /* Low CRT ambient hum — white noise through a narrow bandpass at 120Hz */
  let humGain = null;
  function startHum() {
    if (!ctx || humGain) return;
    const buf  = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const src    = ctx.createBufferSource();
    src.buffer   = buf;
    src.loop     = true;

    const bp     = ctx.createBiquadFilter();
    bp.type      = 'bandpass';
    bp.frequency.value = 120;
    bp.Q.value   = 8;

    humGain      = ctx.createGain();
    humGain.gain.value = 0;          // start silent

    src.connect(bp);
    bp.connect(humGain);
    humGain.connect(ctx.destination);
    src.start();

    // Fade hum in gently
    humGain.gain.linearRampToValueAtTime(0.018, ctx.currentTime + 3);
  }

  function setHumVol(v) {
    if (humGain && ctx)
      humGain.gain.linearRampToValueAtTime(v, ctx.currentTime + 0.5);
  }

  function ritualDrone() {
    // Deep ominous hum that builds
    if (!ctx) return;
    [55, 110, 82.4].forEach((f, i) => {
      setTimeout(() => tone(f, 3.5, 0.06 + i * 0.02, 'sine', 0.8), i * 200);
    });
  }
  function powerDown() {
    // Descending tone — TV shutting off
    if (!ctx) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 1.2);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);
    osc.start(); osc.stop(ctx.currentTime + 1.3);
  }
  function powerUp() {
    // Ascending chord — new system coming online
    if (!ctx) return;
    [[220,0],[330,120],[440,240],[660,360],[880,480]].forEach(([f,d]) =>
      setTimeout(() => tone(f, 0.5, 0.07, 'sine', 0.05), d)
    );
  }
  function staticBurst() {
    tone(Math.random()*2000+200, 0.08, 0.06, 'sawtooth');
  }

  function warp() {
    // Rising filtered sweep — TV tunnel sound
    if (!ctx) return;
    const osc    = ctx.createOscillator();
    const filt   = ctx.createBiquadFilter();
    const gain   = ctx.createGain();
    osc.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(55, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.58);
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(150, ctx.currentTime);
    filt.frequency.exponentialRampToValueAtTime(6000, ctx.currentTime + 0.58);
    gain.gain.setValueAtTime(0.14, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(); osc.stop(ctx.currentTime + 0.62);
  }

  function setMasterVol(v) {
    masterVol = Math.max(0, Math.min(1, v));
    if (humGain && ctx) humGain.gain.linearRampToValueAtTime(masterVol * 0.018, ctx.currentTime + 0.3);
  }

  /* ── Wormhole Transition SFX ─────────────────────────────────
     Three sounds timed to the 3 phases of MatrixTransition.run()  */
  function wormholeWipe() {
    // Phase 1 start: digital downward swoosh 800→120 Hz sawtooth
    if (!ctx) return;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(120, ctx.currentTime + 0.38);
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.065 * masterVol, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.42);
    osc.start(); osc.stop(ctx.currentTime + 0.45);
    staticBurst(0.035);
  }

  function wormholeTunnel() {
    // Phase 2 start: rising electrical hum 60→420 Hz + shimmer overtones
    if (!ctx) return;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(60, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 0.65);
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.05 * masterVol, ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.05 * masterVol, ctx.currentTime + 0.55);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.74);
    osc.start(); osc.stop(ctx.currentTime + 0.78);
    setTimeout(() => tone(1200, 0.35, 0.028, 'sine'), 200);
    setTimeout(() => tone(2400, 0.25, 0.016, 'sine'), 450);
  }

  function wormholeEmerge() {
    // Phase 3 start: shock crackle + bright double-ping
    if (!ctx) return;
    staticBurst(0.06);
    setTimeout(() => { tone(880, 0.18, 0.08, 'sine'); tone(1760, 0.12, 0.04, 'sine'); }, 30);
  }

  return { init, click, focus, select, back, bootSting, startHum, setHumVol, setMasterVol,
           ritualDrone, powerDown, powerUp, staticBurst, warp,
           wormholeWipe, wormholeTunnel, wormholeEmerge };
})();

/* ══════════════════════════════════════════
   MATRIX RAIN
   Custom tape: RSL · NDA · IUI · NHC · GMP · AMOK · NASA8
   • SPEED 1–2 rows/frame per column (feels like real rain)
   • FADE 0.09 → ~13-row trails (crisp, not a smear)
   • Head character ALWAYS near-white regardless of position
   • Per-column speed variation + frequent restarts
══════════════════════════════════════════ */
const MatrixRain = (() => {
  const KANA    = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍｦｲｸｺｿﾁﾄﾉﾌﾔﾖﾙﾛﾝ'.split('');
  const STRINGS = ['RSL', 'NDA', 'IUI', 'NHC', 'GMP', 'AMOK', 'NASA8'];
  const COL_W   = 16;
  const FADE    = 'rgba(10, 6, 0, 0.09)'; // faster fade = shorter, crisper trails
  const LEAD    = '#fffce8';   // near-white gold tip — always the current head character
  const BRIGHT  = '#ffc400';   // bright gold — one step behind the head
  const DIM     = '#b87800';   // dark amber — body of the stream
  const SEP_MIN = 2, SEP_MAX  = 5;

  let _canvas = null, _ctx = null, _raf = null;
  let _drops   = [];   // head row per column
  let _speeds  = [];   // rows-per-frame per column (1 or 2)
  let _tapes   = [];
  let _offsets = [];

  function _randKana() { return KANA[Math.random() * KANA.length | 0]; }

  function _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.random() * (i + 1) | 0;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function _makeTape(minLen) {
    const tape  = [], order = _shuffle([...STRINGS]);
    let   si    = 0;
    while (tape.length < minLen) {
      const str = order[si % order.length]; si++;
      for (const ch of str) {
        const sep = SEP_MIN + (Math.random() * (SEP_MAX - SEP_MIN + 1) | 0);
        for (let k = 0; k < sep; k++) tape.push(_randKana());
        tape.push(ch);
        tape.push(_randKana());
      }
    }
    return tape;
  }

  function _buildColumns(cols) {
    const minLen = Math.ceil((window.innerHeight / COL_W) * 3);
    // Stagger drop starts well above screen so rain arrives at different times
    _drops   = Array.from({ length: cols }, () => (Math.random() * -80 | 0));
    // Alternate speed: roughly half columns fall at 1 row/frame, half at 2
    _speeds  = Array.from({ length: cols }, () => Math.random() > 0.45 ? 2 : 1);
    _tapes   = Array.from({ length: cols }, () => _makeTape(minLen));
    _offsets = Array.from({ length: cols }, (_, i) => Math.random() * _tapes[i].length | 0);
  }

  function _init() {
    _canvas = document.getElementById('matrix-rain');
    if (!_canvas) return false;
    _ctx = _canvas.getContext('2d');
    _resize();
    window.addEventListener('resize', _resize);
    return true;
  }

  function _resize() {
    if (!_canvas) return;
    _canvas.width  = window.innerWidth;
    _canvas.height = window.innerHeight;
    const cols = Math.floor(_canvas.width / COL_W);
    if (_drops.length !== cols) _buildColumns(cols);
  }

  function _draw() {
    if (!_ctx) return;
    // Translucent wash — fades previous characters creating the falling trail
    _ctx.fillStyle = FADE;
    _ctx.fillRect(0, 0, _canvas.width, _canvas.height);
    _ctx.font = `${COL_W - 2}px "Share Tech Mono", monospace`;

    for (let i = 0; i < _drops.length; i++) {
      const sp = _speeds[i];
      // Draw sp characters at the leading edge this frame
      for (let s = 0; s < sp; s++) {
        const row = _drops[i] + s;
        const y   = row * COL_W;
        if (y < 0 || y > _canvas.height + COL_W) continue;
        const tape = _tapes[i];
        const pos  = (((_offsets[i] + row) % tape.length) + tape.length) % tape.length;
        // Very tip = near-white; one behind = bright green; rest handled by FADE
        _ctx.fillStyle = (s === sp - 1) ? LEAD : (s === sp - 2) ? BRIGHT : DIM;
        _ctx.fillText(tape[pos], i * COL_W, y);
      }
      _drops[i] += sp;
      // Reset when fully below screen — more eager (96%) for continuous density
      if (_drops[i] * COL_W > _canvas.height + COL_W) {
        if (Math.random() > 0.04) {
          _drops[i]   = Math.random() * -50 | 0;
          _offsets[i] = Math.random() * _tapes[i].length | 0;
          // Occasionally flip the column speed for variation
          if (Math.random() > 0.65) _speeds[i] = Math.random() > 0.45 ? 2 : 1;
        }
      }
    }
    _raf = requestAnimationFrame(_draw);
  }

  function start() {
    if (_raf) return;
    if (!_canvas && !_init()) return;
    _canvas.hidden = false;
    _draw();
  }

  function stop() {
    if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    if (_canvas) {
      _canvas.hidden = true;
      _ctx?.clearRect(0, 0, _canvas.width, _canvas.height);
    }
  }

  return { start, stop };
})();

/* ══════════════════════════════════════════
   MATRIX TRANSITION  —  3-Phase Wormhole
   Phase 1 WIPE  : fast rain falls top-to-bottom, covering screen (~380 ms)
   Phase 2 TUNNEL: rings of matrix chars converge to center — telephone-line
                   wormhole effect. Core brightens as you rush toward the exit.
   Phase 3 FLASH : expanding ring of light bursts from center → callback → fade
══════════════════════════════════════════ */
const MatrixTransition = (() => {
  const KANA    = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍｦｲｸｺｿﾁﾄﾉﾌﾔﾖﾙﾛﾝ'.split('');
  const STRINGS = ['RSL', 'NDA', 'IUI', 'NHC', 'GMP', 'AMOK', 'NASA8'];
  const COL_W   = 16;
  const T_TUNNEL = 700;   // ms for tunnel phase
  const T_FLASH  = 260;   // ms for flash phase
  const RING_LIFE = 430;  // ms for one ring to travel edge→center
  const RING_GAP  = 52;   // ms between new ring spawns

  let _canvas = null, _ctx = null, _raf = null;
  let _callback = null, _phase = 0, _t0 = 0;
  let _drops = [], _tapes = [], _offsets = [];   // wipe state
  let _rings = [], _lastRing = 0;                 // tunnel state

  function _randKana() { return KANA[Math.random() * KANA.length | 0]; }
  function _randChar() {
    if (Math.random() > 0.65) { const s = STRINGS[Math.random() * STRINGS.length | 0]; return s[Math.random() * s.length | 0]; }
    return _randKana();
  }
  function _makeTape(n) {
    const t = []; let si = 0;
    while (t.length < n) {
      const s = STRINGS[si++ % STRINGS.length];
      for (const ch of s) { for (let k = 2 + (Math.random() * 4 | 0); k--;) t.push(_randKana()); t.push(ch); t.push(_randKana()); }
    }
    return t;
  }

  function _init() {
    _canvas = document.getElementById('matrix-exit-rain');
    if (!_canvas) return false;
    _ctx = _canvas.getContext('2d');
    return true;
  }

  // ── Phase 1: rain wipe ───────────────────────────────────────────
  function _setupWipe() {
    _canvas.width  = window.innerWidth;
    _canvas.height = window.innerHeight;
    const cols = Math.floor(_canvas.width / COL_W);
    const min  = Math.ceil(_canvas.height / COL_W) + 20;
    _drops   = Array.from({ length: cols }, () => -(Math.random() * 5 | 0));
    _tapes   = Array.from({ length: cols }, () => _makeTape(min));
    _offsets = Array.from({ length: cols }, (_, i) => Math.random() * _tapes[i].length | 0);
    _ctx.fillStyle = '#0a0600';
    _ctx.fillRect(0, 0, _canvas.width, _canvas.height);
  }

  function _drawWipe() {
    const SP = 4;
    _ctx.font = `${COL_W - 2}px "Share Tech Mono", monospace`;
    let done = 0;
    for (let i = 0; i < _drops.length; i++) {
      if (_drops[i] * COL_W > _canvas.height + COL_W * SP) { done++; continue; }
      for (let s = 0; s < SP; s++) {
        const row = _drops[i] + s; if (row < 0) continue;
        const y   = (row + 1) * COL_W; if (y > _canvas.height + COL_W) break;
        const tp  = ((_offsets[i] + row) % _tapes[i].length + _tapes[i].length) % _tapes[i].length;
        _ctx.fillStyle = s === SP - 1 ? '#fffce8' : Math.random() > 0.88 ? '#ffc400' : '#b07800';
        _ctx.fillText(_tapes[i][tp], i * COL_W, y);
      }
      _drops[i] += SP;
      if (_drops[i] * COL_W > _canvas.height + COL_W * SP) done++;
    }
    return done >= _drops.length;   // true = screen fully covered
  }

  // ── Phase 2: wormhole tunnel ─────────────────────────────────────
  function _drawTunnel(now) {
    const { width: w, height: h } = _canvas;
    const cx = w / 2, cy = h / 2;
    const overallT = Math.min((now - _t0) / T_TUNNEL, 1);
    const maxR = Math.sqrt(cx * cx + cy * cy) * 1.12;

    // Semi-transparent wash — lets rings accumulate without fully erasing
    _ctx.fillStyle = 'rgba(10, 6, 0, 0.16)';
    _ctx.fillRect(0, 0, w, h);

    // Spawn new rings from the screen edges, converging inward
    if (now - _lastRing > RING_GAP) {
      _rings.push({ birth: now, spin: Math.random() > 0.5 ? 1 : -1, phase: Math.random() * Math.PI * 2 });
      _lastRing = now;
    }

    _rings = _rings.filter(ring => {
      const age  = now - ring.birth;
      const t    = age / RING_LIFE; if (t >= 1) return false;
      // ease-in-quad: rings accelerate as they rush toward center
      const ease = 1 - (1 - t) * (1 - t);
      const radius  = maxR * (1 - ease);
      const charSz  = Math.max(7, 15 * (1 - ease * 0.55));
      const numCh   = Math.max(3, Math.floor(2 * Math.PI * radius / (charSz * 1.6)));
      const alpha   = 0.45 + ease * 0.55;
      const spinAng = ring.phase + ring.spin * ease * Math.PI * 2.8;
      for (let c = 0; c < numCh; c++) {
        const ang = spinAng + (c / numCh) * Math.PI * 2;
        const x   = cx + Math.cos(ang) * radius;
        const y   = cy + Math.sin(ang) * radius;
        const gr  = (200 + (55 * ease)) | 0;   // red:   200 → 255 (warm gold)
        const gg  = (150 + (70 * ease)) | 0;   // green: 150 → 220 (gold, not white)
        _ctx.font      = `${charSz}px "Share Tech Mono", monospace`;
        _ctx.fillStyle = `rgba(${gr},${gg},0,${alpha})`;
        _ctx.fillText(_randChar(), x - charSz * 0.4, y + charSz * 0.4);
      }
      return true;
    });

    // Core glow: grows brighter as we approach the tunnel exit
    if (overallT > 0.25) {
      const ct = (overallT - 0.25) / 0.75;
      const cr = 10 + ct * 135;
      const grd = _ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
      grd.addColorStop(0,    `rgba(255,255,255,${ct * 0.97})`);
      grd.addColorStop(0.35, `rgba(255,200,30,${ct * 0.75})`);
      grd.addColorStop(1,    'rgba(180,100,0,0)');
      _ctx.fillStyle = grd;
      _ctx.beginPath(); _ctx.arc(cx, cy, cr, 0, Math.PI * 2); _ctx.fill();
    }
    return overallT >= 1;
  }

  // ── Phase 3: light emerge ────────────────────────────────────────
  function _drawFlash(now) {
    const { width: w, height: h } = _canvas;
    const cx = w / 2, cy = h / 2;
    const t   = Math.min((now - _t0) / T_FLASH, 1);
    const maxR = Math.sqrt(cx * cx + cy * cy) * 1.5;
    // Expanding ring of light
    const rr = t * maxR, rw = maxR * 0.28 * (1 - t);
    if (rw > 0) {
      const gr = _ctx.createRadialGradient(cx, cy, Math.max(0, rr - rw), cx, cy, rr + rw);
      gr.addColorStop(0,   'rgba(180,100,0,0)');
      gr.addColorStop(0.3, `rgba(255,210,60,${0.75 * (1 - t)})`);
      gr.addColorStop(0.6, `rgba(255,255,255,${0.95 * (1 - t)})`);
      gr.addColorStop(1,   'rgba(180,100,0,0)');
      _ctx.fillStyle = gr;
      _ctx.beginPath(); _ctx.arc(cx, cy, rr + rw, 0, Math.PI * 2); _ctx.fill();
    }
    // Fading central bloom
    const gc = _ctx.createRadialGradient(cx, cy, 0, cx, cy, 80 + t * 60);
    gc.addColorStop(0,   `rgba(255,255,255,${1 - t})`);
    gc.addColorStop(0.5, `rgba(255,200,60,${(1 - t) * 0.5})`);
    gc.addColorStop(1,   'rgba(220,150,0,0)');
    _ctx.fillStyle = gc; _ctx.beginPath(); _ctx.arc(cx, cy, 140 + t * 60, 0, Math.PI * 2); _ctx.fill();
    return t >= 1;
  }

  // ── Main animation loop ──────────────────────────────────────────
  function _loop(now) {
    let done = false;
    if      (_phase === 1) { done = _drawWipe();      if (done) { _phase = 2; _t0 = now; _lastRing = now; _rings = []; KenteAudio.wormholeTunnel(); } }
    else if (_phase === 2) { done = _drawTunnel(now); if (done) { _phase = 3; _t0 = now; KenteAudio.wormholeEmerge(); } }
    else if (_phase === 3) {
      done = _drawFlash(now);
      if (done) {
        if (_callback) { const cb = _callback; _callback = null; cb(); }
        _canvas.style.transition = 'opacity 0.35s ease';
        _canvas.style.opacity    = '0';
        setTimeout(() => {
          _canvas.hidden           = true;
          _canvas.style.opacity    = '1';
          _canvas.style.transition = '';
          _raf = null;
        }, 370);
        return;   // stop the loop
      }
    }
    _raf = requestAnimationFrame(_loop);
  }

  function run(callback) {
    if (!_canvas && !_init()) { callback?.(); return; }
    _canvas.style.transition = 'none';
    _canvas.style.opacity    = '1';
    _canvas.hidden = false;
    _callback = callback;
    _phase = 1;
    _setupWipe();
    KenteAudio.wormholeWipe();
    if (_raf) cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(_loop);
  }

  return { run };
})();
