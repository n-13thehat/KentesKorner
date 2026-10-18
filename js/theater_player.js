/* Kente's Korner — Theater video player (HLS, up-next, wake lock, pause menu, watchdog, mini-player). */
'use strict';

/* ══════════════════════════════════════════
   THEATER VIDEO PLAYER — HLS + custom CRT chrome
══════════════════════════════════════════ */
const TheaterPlayer = {
  hls: null,
  payload: null,    // { streams:{q:url}, qualities:[...] }
  ctx: null,        // canonical item used by TheaterDB.saveProgress
  resumeAt: 0,      // seconds — applied on next MANIFEST_PARSED / loadedmetadata
  resumed:  false,  // becomes true once we've seeked to the resume position
  saveTimer: 0,     // last persist time (epoch ms) — throttles timeupdate writes
  idleTimer: null,
  bound: false,
  embed: false,         // true while iframe player is active
  activeSource: null,   // current embed host key (vidsrc, 2embed, ...)
  prevScreen: null,     // state.screen before player opened — restored on close
  wakeLock: null,       // Screen Wake Lock sentinel — keeps display on while playing
  pauseMenuFocus: 0,    // 0 = RESUME, 1 = NEXT SOURCE, 2 = CLOSE
  embedSources: [],     // current source[] list — drives the pill row + watchdog
  watchdog: null,       // setTimeout handle — auto-advance when no load fires
  loadGen: 0,           // increments per src= write; load handler ignores stale frames
  miniplayer: false,    // true while the floating corner widget is engaged
  ccTracks: [],         // [{lang,label,url}] — currently mounted CC tracks
  ccIndex: -1,          // -1 = off, 0..N-1 = active textTrack index
  epList: [],           // flat episode list for shows ({id,season,number,title})
  epIndex: -1,          // current index in epList; -1 = movie or unknown
  playbackRate: 1,      // current speed; preserved across quality switches
  speedIdx: 2,          // index into _TVP_SPEEDS — kept in sync with playbackRate
  helpOpen: false,      // SELECT-toggled help overlay visibility
  // Up Next countdown state — reset on every episode change / close.
  // visible:   card currently shown on screen
  // dismissed: user clicked CANCEL on the current episode (suppress until next)
  // forEpIdx:  the epIndex the card was last shown for (so dismiss + cancel
  //            scope to one episode)
  upNext: { visible: false, dismissed: false, forEpIdx: -1, fired: false },
};

// Speed-control rungs for the ⏵ button. Index 2 = 1× (default).
const _TVP_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
function _tvpFmtSpeed(r) {
  // 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2× — strip trailing zero on whole numbers.
  return (r % 1 === 0 ? String(r) : String(r)) + '×';
}
function _tvpApplySpeed(rate) {
  const v = document.getElementById('theater-video');
  const btn = document.getElementById('tvp-speed');
  TheaterPlayer.playbackRate = rate;
  if (v) { try { v.playbackRate = rate; } catch {} }
  if (btn) {
    btn.textContent = _tvpFmtSpeed(rate);
    btn.classList.toggle('tvp-btn-active', rate !== 1);
  }
}
function _tvpCycleSpeed() {
  TheaterPlayer.speedIdx = (TheaterPlayer.speedIdx + 1) % _TVP_SPEEDS.length;
  const rate = _TVP_SPEEDS[TheaterPlayer.speedIdx];
  _tvpApplySpeed(rate);
  showToast(`SPEED ${_tvpFmtSpeed(rate)}`);
}

// Help overlay (SELECT button). Toggled on top of playback without changing
// state.screen so the d-pad / scrubber keep working underneath. Auto-clears
// on player close.
function _tvpShowHelp() {
  const el = document.getElementById('tvp-help-overlay');
  if (!el) return;
  el.classList.add('tvp-help-show');
  el.setAttribute('aria-hidden', 'false');
  TheaterPlayer.helpOpen = true;
}
function _tvpHideHelp() {
  const el = document.getElementById('tvp-help-overlay');
  if (!el) return;
  el.classList.remove('tvp-help-show');
  el.setAttribute('aria-hidden', 'true');
  TheaterPlayer.helpOpen = false;
}
function _tvpToggleHelp() {
  if (TheaterPlayer.helpOpen) _tvpHideHelp();
  else _tvpShowHelp();
}

// Title with overflow-aware marquee. The text lives inside a `.tvp-title-track`
// span so the parent (#theater-video-title) keeps clipping; when the track is
// wider than its container we tag the parent with `.tvp-marquee` and the CSS
// alternates a translateX from 0 to -(overflow-px) on a loop.
function _tvpSetTitle(text) {
  const el = document.getElementById('theater-video-title');
  if (!el) return;
  const track = el.querySelector('.tvp-title-track')
             || (() => { const s = document.createElement('span');
                         s.className = 'tvp-title-track'; el.replaceChildren(s); return s; })();
  track.textContent = text || 'PLAYBACK';
  // Defer measurement to next frame so layout is settled.
  requestAnimationFrame(() => {
    const overflow = track.scrollWidth - el.clientWidth;
    if (overflow > 4) {
      el.style.setProperty('--tvp-marq-shift', `-${overflow + 12}px`);
      el.classList.add('tvp-marquee');
    } else {
      el.classList.remove('tvp-marquee');
      el.style.removeProperty('--tvp-marq-shift');
    }
  });
}

function _tvpFmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`
    : `${m}:${String(r).padStart(2,'0')}`;
}

// Called from launchGame() right before any emulator/native-app dispatch.
// Previously this fully tore down the theater overlay; now it shrinks the
// player into the miniplayer widget so playback survives the launch. The
// widget sits at z-index 1200, above #emulator-overlay (900) and
// #launch-overlay (600), so iframe / Flash / EmulatorJS sessions render the
// game underneath while the corner player keeps running. Native game
// launches (Dolphin, .exe, etc.) take focus at the OS level — the player
// keeps playing in the background and is right there when the user returns.
function _silenceTheaterForLaunch() {
  const ov = document.getElementById('theater-video-overlay');
  if (!ov || !ov.classList.contains('active')) return;
  if (TheaterPlayer.miniplayer) return;       // already a corner widget — nothing to do
  try {
    enterMiniplayer();
    showToast('THEATER → MINI-PLAYER');
  } catch {
    try { closeTheaterVideo(); } catch {}
  }
}

function _tvpResolveUrl(rel) {
  // Server returns root-relative '/api/theater/proxy?url=...' — prepend the
  // server origin so cross-origin range requests carry the right base.
  if (!rel) return '';
  return /^https?:/i.test(rel) ? rel : `${KENTE_SERVER_URL}${rel}`;
}

function _tvpPickInitialQuality(qualities) {
  // Prefer 720p, then 1080p, then 480p, then whatever's first.
  const order = ['720p','720','1080p','1080','480p','480','360p','360'];
  for (const q of order) if (qualities.includes(q)) return q;
  return qualities[0];
}

function _tvpAttachSource(quality) {
  const v   = document.getElementById('theater-video');
  const url = _tvpResolveUrl(TheaterPlayer.payload.streams[quality]);
  if (!v || !url) return;
  // Pick the seek-to time: a saved resume position takes priority on the
  // first manifest of a session; later quality switches keep the live
  // playhead so the user doesn't lose their place.
  const startTime = (!TheaterPlayer.resumed && TheaterPlayer.resumeAt > 0)
    ? TheaterPlayer.resumeAt
    : (v.currentTime || 0);

  // Tear down previous Hls instance, if any.
  if (TheaterPlayer.hls) { try { TheaterPlayer.hls.destroy(); } catch {} TheaterPlayer.hls = null; }

  const Hls = window.Hls;
  const isM3u8 = /\.m3u8($|\?)/i.test(url) || url.includes('mpegurl');
  if (isM3u8 && Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
    TheaterPlayer.hls = hls;
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      v.currentTime = startTime;
      if (startTime > 0) TheaterPlayer.resumed = true;
      try { v.playbackRate = TheaterPlayer.playbackRate; } catch {}
      v.play().catch(()=>{});
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      console.warn('[TheaterPlayer] HLS error:', data.type, data.details);
      if (data.fatal) _tvpShowError('STREAM ERROR — TRY A DIFFERENT QUALITY');
    });
  } else {
    // Native HLS (Safari) or direct mp4.
    v.src = url;
    v.currentTime = startTime;
    if (startTime > 0) TheaterPlayer.resumed = true;
    try { v.playbackRate = TheaterPlayer.playbackRate; } catch {}
    v.play().catch(()=>{});
  }
  _tvpRefreshCCTracks();
}

// ── Closed captions ──────────────────────────────────────────────────────
// Subtitle URLs come pre-proxied through /api/theater/proxy by the server,
// so we don't need to worry about CORS for the .vtt fetches. We always start
// in OFF state on a fresh source attach; the user opts in via the CC button.
function _tvpRefreshCCTracks() {
  const v   = document.getElementById('theater-video');
  const btn = document.getElementById('tvp-cc');
  if (!v || !btn) return;
  // Strip previously-injected tracks. Hardcoded `data-tvp-cc` so any pre-existing
  // <track> elements declared in HTML (none today, but safe-by-default) are kept.
  v.querySelectorAll('track[data-tvp-cc]').forEach(t => t.remove());
  const subs = (TheaterPlayer.payload?.source?.subtitles)
            || TheaterPlayer.payload?.subtitles
            || [];
  TheaterPlayer.ccTracks = subs;
  TheaterPlayer.ccIndex  = -1;
  btn.hidden = false;
  btn.textContent = 'CC';
  btn.classList.remove('tvp-btn-active');
  btn.classList.toggle('tvp-btn-disabled', !subs.length);
  if (!subs.length) return;
  subs.forEach((s, i) => {
    const t = document.createElement('track');
    t.kind     = 'subtitles';
    t.src      = s.url || '';
    t.srclang  = (s.lang || 'en').slice(0, 5);
    t.label    = (s.label || s.lang || `Track ${i+1}`);
    t.default  = false;
    t.setAttribute('data-tvp-cc', '1');
    v.appendChild(t);
  });
  // textTracks are populated synchronously after appendChild; force them off
  // so nothing renders until the user toggles CC on.
  Array.from(v.textTracks || []).forEach(tt => { tt.mode = 'disabled'; });
}

function _tvpCycleCC() {
  const v = document.getElementById('theater-video');
  const btn = document.getElementById('tvp-cc');
  if (!v || !btn) return;
  const subs = TheaterPlayer.ccTracks || [];
  if (!subs.length) {
    // Button stays visible even when nothing's bundled — flash a hint so the
    // user knows the click registered and the source just doesn't ship subs.
    _tvpShowError('NO SUBTITLES AVAILABLE FOR THIS SOURCE');
    return;
  }
  // Cycle: -1 (off) -> 0 -> 1 -> ... -> N-1 -> -1
  const next = TheaterPlayer.ccIndex + 1 >= subs.length ? -1 : TheaterPlayer.ccIndex + 1;
  TheaterPlayer.ccIndex = next;
  Array.from(v.textTracks || []).forEach((tt, i) => {
    tt.mode = (i === next) ? 'showing' : 'disabled';
  });
  if (next < 0) {
    btn.textContent = 'CC';
    btn.classList.remove('tvp-btn-active');
  } else {
    const lang = (subs[next].lang || subs[next].label || 'EN').toString().toUpperCase().slice(0, 4);
    btn.textContent = `CC: ${lang}`;
    btn.classList.add('tvp-btn-active');
  }
}

// ── Episode skip ────────────────────────────────────────────────────────
// Drives the ⏮ / ⏭ buttons when the active ctx is a TV show. We keep the
// flat episode list on TheaterPlayer.epList (sourced from ctx._episodes,
// which the detail overlay assembled). Buttons hide for movies and go
// disabled at the boundaries.
function _tvpRefreshEpButtons() {
  const prev = document.getElementById('tvp-prev-ep');
  const next = document.getElementById('tvp-next-ep');
  if (!prev || !next) return;
  const list = TheaterPlayer.epList || [];
  const idx  = TheaterPlayer.epIndex;
  const isShow = (TheaterPlayer.ctx?.kind === 'show'
               || TheaterPlayer.ctx?.type === 'show')
               && list.length > 0;
  prev.hidden = next.hidden = !isShow;
  if (!isShow) return;
  prev.classList.toggle('tvp-btn-disabled', idx <= 0);
  next.classList.toggle('tvp-btn-disabled', idx < 0 || idx >= list.length - 1);
  prev.title = idx > 0
    ? `Previous Episode (S${list[idx-1].season} · E${list[idx-1].number})`
    : 'Previous Episode';
  next.title = (idx >= 0 && idx < list.length - 1)
    ? `Next Episode (S${list[idx+1].season} · E${list[idx+1].number})`
    : 'Next Episode';
}

function _tvpJumpEpisode(delta) {
  const list = TheaterPlayer.epList || [];
  const idx  = TheaterPlayer.epIndex;
  const ctx  = TheaterPlayer.ctx;
  if (!ctx || !list.length) return;
  const target = idx + delta;
  if (target < 0 || target >= list.length) return;
  const ep = list[target];
  const epId = (ep && ep.id != null) ? String(ep.id) : '';
  if (!epId) return;
  _tvpUpNextHide();   // tear down any active Up Next card before swapping
  // Re-issue the same flow as a fresh episode click in the detail overlay.
  // _theaterStartStream picks the right player (HLS vs embed) so the user
  // gets a seamless swap without going back to detail.
  _theaterStartStream(
    ctx.provider, 'show', ctx.slug || ctx.id, epId,
    `${ctx.title || ''} — ${ep.title}`,
    { ...ctx, episodeId: epId, episodeTitle: ep.title, _episodes: list }
  );
}

/* ── UP NEXT CARD ─────────────────────────────────────────
   Auto-shown in the last 15 s of an episode when there's a next entry
   in epList and we're on the native HLS path. Auto-fires PLAY NOW when
   the countdown hits zero; CANCEL suppresses for the rest of the episode.
   Embed-mode sessions skip Up Next entirely (no native tail to detect). */
const _TVP_UP_NEXT_WINDOW = 15;   // seconds before end to surface the card

function _tvpUpNextShow(nextEp) {
  const root = document.getElementById('tvp-up-next');
  if (!root) return;
  const ctx     = TheaterPlayer.ctx || {};
  const poster  = nextEp.thumbnail || nextEp.poster || ctx.poster || '';
  const epLine  = (nextEp.season != null && nextEp.number != null)
    ? `S${nextEp.season} · E${nextEp.number}`
    : (nextEp.label || `EPISODE ${TheaterPlayer.epIndex + 2}`);
  const titleEl = document.getElementById('tvp-un-title');
  const epEl    = document.getElementById('tvp-un-ep');
  const posEl   = document.getElementById('tvp-un-poster');
  if (epEl)    epEl.textContent    = epLine.toUpperCase();
  if (titleEl) titleEl.textContent = (nextEp.title || epLine).toUpperCase();
  if (posEl)   posEl.style.backgroundImage = poster ? `url("${poster}")` : '';
  root.classList.add('tvp-un-show');
  root.setAttribute('aria-hidden', 'false');
  TheaterPlayer.upNext.visible  = true;
  TheaterPlayer.upNext.forEpIdx = TheaterPlayer.epIndex;
}

function _tvpUpNextHide() {
  const root = document.getElementById('tvp-up-next');
  if (!root) return;
  root.classList.remove('tvp-un-show');
  root.setAttribute('aria-hidden', 'true');
  TheaterPlayer.upNext.visible = false;
}

function _tvpUpNextResetForEpisode() {
  TheaterPlayer.upNext.dismissed = false;
  TheaterPlayer.upNext.forEpIdx  = -1;
  TheaterPlayer.upNext.fired     = false;
  _tvpUpNextHide();
}

/* Per-tick update — called from the timeupdate listener. Drives both the
   show / hide decision and the countdown ring + seconds label. */
function _tvpUpNextTick(currentTime, duration) {
  if (TheaterPlayer.embed || TheaterPlayer.miniplayer) {
    if (TheaterPlayer.upNext.visible) _tvpUpNextHide();
    return;
  }
  const list = TheaterPlayer.epList || [];
  const nextIdx = TheaterPlayer.epIndex + 1;
  if (!list.length || nextIdx <= 0 || nextIdx >= list.length) return;
  if (!duration || duration <= 0) return;
  const remaining = duration - currentTime;
  const inWindow  = remaining > 0 && remaining <= _TVP_UP_NEXT_WINDOW;

  // Out of window — hide and clear the per-episode dismiss so a rewind +
  // re-entry doesn't get blocked by a stale dismissal.
  if (!inWindow) {
    if (TheaterPlayer.upNext.visible) _tvpUpNextHide();
    return;
  }
  // Dismissed for this episode — never re-show until the episode changes.
  if (TheaterPlayer.upNext.dismissed &&
      TheaterPlayer.upNext.forEpIdx === TheaterPlayer.epIndex) return;

  // First entry into the window — render the card.
  if (!TheaterPlayer.upNext.visible) {
    _tvpUpNextShow(list[nextIdx]);
  }
  // Update countdown text + ring.
  const secs = Math.max(0, Math.ceil(remaining));
  const secsEl = document.getElementById('tvp-un-secs');
  if (secsEl) secsEl.textContent = String(secs);
  const ring = document.querySelector('.tvp-un-ring-fg');
  if (ring) {
    const pct = Math.max(0, Math.min(1, remaining / _TVP_UP_NEXT_WINDOW));
    ring.style.strokeDashoffset = String(100 * (1 - pct));
  }
  // Auto-fire when countdown hits zero. The native 'ended' handler also
  // calls _tvpJumpEpisode, but firing slightly early (≤ 0.4 s remaining)
  // keeps the card responsive on streams that stall right at the tail.
  if (remaining <= 0.4) _tvpUpNextFire();
}

function _tvpUpNextFire() {
  if (!TheaterPlayer.upNext.visible) return;
  TheaterPlayer.upNext.fired = true;   // gate the 'ended' handler's auto-jump
  _tvpUpNextHide();
  _tvpJumpEpisode(+1);
}

function _tvpUpNextCancel() {
  TheaterPlayer.upNext.dismissed = true;
  TheaterPlayer.upNext.forEpIdx  = TheaterPlayer.epIndex;
  _tvpUpNextHide();
}

function _tvpShowError(msg) {
  const el = document.getElementById('theater-video-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 5000);
}

function _tvpBindControlsOnce() {
  if (TheaterPlayer.bound) return;
  TheaterPlayer.bound = true;

  const v       = document.getElementById('theater-video');
  const stage   = document.getElementById('theater-video-stage');
  const playBtn = document.getElementById('tvp-play');
  const backBtn = document.getElementById('tvp-back');
  const fwdBtn  = document.getElementById('tvp-fwd');
  const cur     = document.getElementById('tvp-cur');
  const dur     = document.getElementById('tvp-dur');
  const scrub   = document.getElementById('tvp-scrub');
  const fill    = scrub.querySelector('.tvp-scrub-fill');
  const buf     = scrub.querySelector('.tvp-scrub-buf');
  const handle  = scrub.querySelector('.tvp-scrub-handle');
  const muteBtn = document.getElementById('tvp-mute');
  const volSl   = document.getElementById('tvp-vol-slider');
  const qSel    = document.getElementById('tvp-quality');
  const fullBtn = document.getElementById('tvp-full');
  const pipBtn  = document.getElementById('tvp-pip');
  const ccBtn   = document.getElementById('tvp-cc');
  const loading = document.getElementById('theater-video-loading');

  if (ccBtn) ccBtn.addEventListener('click', () => { _tvpCycleCC(); KenteAudio.click(); });

  const speedBtn = document.getElementById('tvp-speed');
  speedBtn?.addEventListener('click', () => { _tvpCycleSpeed(); KenteAudio.click(); });

  const prevEp = document.getElementById('tvp-prev-ep');
  const nextEp = document.getElementById('tvp-next-ep');
  prevEp?.addEventListener('click', () => {
    if (prevEp.classList.contains('tvp-btn-disabled')) return;
    KenteAudio.click(); _tvpJumpEpisode(-1);
  });
  nextEp?.addEventListener('click', () => {
    if (nextEp.classList.contains('tvp-btn-disabled')) return;
    KenteAudio.click(); _tvpJumpEpisode(+1);
  });

  // Up Next card buttons — PLAY NOW jumps now, CANCEL suppresses for the ep.
  document.getElementById('tvp-un-play')?.addEventListener('click', () => {
    KenteAudio.click(); _tvpUpNextFire();
  });
  document.getElementById('tvp-un-cancel')?.addEventListener('click', () => {
    KenteAudio.click(); _tvpUpNextCancel();
  });

  playBtn.addEventListener('click', () => v.paused ? v.play() : v.pause());
  backBtn.addEventListener('click', () => { v.currentTime = Math.max(0, v.currentTime - 10); });
  fwdBtn .addEventListener('click', () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); });
  v.addEventListener('play',  () => { playBtn.textContent = '❚❚'; stage.classList.remove('tvp-paused'); });
  v.addEventListener('pause', () => { playBtn.textContent = '▶';  stage.classList.add('tvp-paused'); });
  v.addEventListener('waiting', () => { loading.hidden = false; });
  v.addEventListener('playing', () => { loading.hidden = true;  });
  v.addEventListener('canplay', () => { loading.hidden = true;  });
  v.addEventListener('click', () => v.paused ? v.play() : v.pause());

  v.addEventListener('timeupdate', () => {
    const d = v.duration || 0;
    cur.textContent = _tvpFmt(v.currentTime);
    dur.textContent = _tvpFmt(d);
    const pct = d ? (v.currentTime / d) * 100 : 0;
    fill.style.width = pct + '%';
    handle.style.left = pct + '%';
    try {
      const tr = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      buf.style.width = (d ? (tr / d) * 100 : 0) + '%';
    } catch {}
    // Persist resume position every ~5 s.  Skipped while the resume seek is
    // still pending so we don't overwrite the saved position with 0.
    const ctx = TheaterPlayer.ctx;
    if (ctx && v.currentTime > 1 && (TheaterPlayer.resumed || TheaterPlayer.resumeAt === 0)) {
      const now = Date.now();
      if (now - (TheaterPlayer.saveTimer || 0) > 5000) {
        TheaterPlayer.saveTimer = now;
        TheaterDB.saveProgress(ctx, v.currentTime, d);
      }
    }
    // Up Next countdown tick — show / hide / advance the bottom-right card.
    try { _tvpUpNextTick(v.currentTime, d); } catch {}
  });
  v.addEventListener('ended', () => {
    if (TheaterPlayer.ctx) TheaterDB.clearProgress(TheaterPlayer.ctx);
    // If the Up Next card already triggered the jump, don't double-fire.
    if (TheaterPlayer.upNext.fired) return;
    // Auto-advance to the next episode when we have one. Embed-mode
    // sessions can't fire `ended` (no native <video> source), so this
    // path is HLS-only — embed users still rely on the manual ⏭ button.
    const list = TheaterPlayer.epList || [];
    const nextIdx = TheaterPlayer.epIndex + 1;
    if (list.length && nextIdx >= 0 && nextIdx < list.length) {
      const ep = list[nextIdx];
      showToast(`▶ NEXT EPISODE — ${(ep.title || `S${ep.season}E${ep.number}`).toUpperCase()}`);
      _tvpJumpEpisode(+1);
    }
  });
  // Scrub bar — pointer-driven so cursor-mode (DSPointer / Wii) drags work
  // alongside real mouse drags. Also keeps a click-to-seek fallback. Skipped
  // entirely while in embed mode (the native <video> has no source then).
  let _scrubDragging = false;
  let _scrubWasPaused = false;
  const _scrubSeekTo = (clientX) => {
    if (!v.duration || stage.classList.contains('tvp-embed-mode')) return;
    const r = scrub.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    v.currentTime = p * v.duration;
    fill.style.width   = (p * 100) + '%';
    handle.style.left  = (p * 100) + '%';
  };
  scrub.addEventListener('pointerdown', e => {
    if (stage.classList.contains('tvp-embed-mode')) return;
    _scrubDragging = true;
    _scrubWasPaused = v.paused;
    try { v.pause(); } catch {}
    try { scrub.setPointerCapture(e.pointerId); } catch {}
    _scrubSeekTo(e.clientX);
    e.preventDefault();
  });
  scrub.addEventListener('pointermove', e => {
    if (!_scrubDragging) return;
    _scrubSeekTo(e.clientX);
  });
  const _scrubEnd = (e) => {
    if (!_scrubDragging) return;
    _scrubDragging = false;
    if (e && e.pointerId !== undefined) {
      try { scrub.releasePointerCapture(e.pointerId); } catch {}
    }
    if (!_scrubWasPaused) { try { v.play(); } catch {} }
  };
  scrub.addEventListener('pointerup',     _scrubEnd);
  scrub.addEventListener('pointercancel', _scrubEnd);
  // Window-level safety net for drags that leave the bar before release.
  window.addEventListener('pointerup', _scrubEnd);

  muteBtn.addEventListener('click', () => {
    v.muted = !v.muted;
    muteBtn.textContent = v.muted ? '🔇' : '🔊';
  });
  volSl.addEventListener('input', e => {
    v.volume = parseFloat(e.target.value);
    if (v.volume > 0) v.muted = false;
    muteBtn.textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
  });

  qSel.addEventListener('change', () => _tvpAttachSource(qSel.value));

  fullBtn.addEventListener('click', () => {
    // Target the overlay shell so the header, watermark, source dropdown,
    // and pause menu all remain inside the fullscreen surface. Falls back
    // to the panel/stage if the browser refuses (e.g. iframe sandbox).
    const target = document.getElementById('theater-video-overlay')
                || document.getElementById('theater-video-panel')
                || document.getElementById('theater-video-stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else (target.requestFullscreen?.() || Promise.reject()).catch(() => {
      document.getElementById('theater-video-stage')?.requestFullscreen?.().catch(()=>{});
    });
  });
  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    fullBtn.textContent = fs ? '⛶✕' : '⛶';
    fullBtn.classList.toggle('tvp-btn-active', fs);
    document.getElementById('theater-video-overlay')?.classList.toggle('tvp-fullscreen', fs);
  });
  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v.requestPictureInPicture) await v.requestPictureInPicture();
    } catch (_e) {}
  });

  // Idle-hide cursor + chrome after 2.5s of no movement.
  // We also toggle .tvp-show so that synthetic mousemove events (DSPointer /
  // Wii pointer) can reveal the controls — CSS :hover doesn't fire for
  // JS-dispatched events.
  const armIdle = () => {
    stage.classList.remove('tvp-idle');
    stage.classList.add('tvp-show');
    clearTimeout(TheaterPlayer.idleTimer);
    TheaterPlayer.idleTimer = setTimeout(() => {
      if (!v.paused) {
        stage.classList.add('tvp-idle');
        stage.classList.remove('tvp-show');
      }
    }, 2500);
  };
  stage.addEventListener('mousemove', armIdle);
  stage.addEventListener('mouseleave', () => {
    stage.classList.remove('tvp-idle');
    stage.classList.remove('tvp-show');
  });
}

/* ── Screen Wake Lock — keeps the display on while a film/episode plays.
     Browser auto-releases on tab blur / fullscreen change, so we re-acquire
     on visibilitychange while the overlay is open. */
async function _tvpAcquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (TheaterPlayer.wakeLock) return;
    TheaterPlayer.wakeLock = await navigator.wakeLock.request('screen');
    TheaterPlayer.wakeLock.addEventListener?.('release', () => {
      // Cleared by the browser — drop our reference so the visibilitychange
      // handler can re-acquire if the overlay is still open.
      TheaterPlayer.wakeLock = null;
    });
  } catch (_e) { /* user may deny or unsupported — quietly degrade */ }
}
function _tvpReleaseWakeLock() {
  const wl = TheaterPlayer.wakeLock;
  TheaterPlayer.wakeLock = null;
  if (wl && typeof wl.release === 'function') {
    try { wl.release(); } catch {}
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const ov = document.getElementById('theater-video-overlay');
  if (ov?.classList.contains('active')) _tvpAcquireWakeLock();
});

/* ── Theater pause menu ─────────────────────────────────────
   Mirrors the in-game pause menu but lives inside the theater
   overlay.  Pauses the native <video> when present.  For the
   iframe path we can't actually pause cross-origin playback;
   the overlay simply hides the iframe behind the menu. */
function _tpmUpdateFocus() {
  const btns = _tpmButtons();
  btns.forEach((b, i) => b.classList.toggle('tpm-focused', i === TheaterPlayer.pauseMenuFocus));
}
function _tpmButtons() {
  // Visible buttons only (NEXT SOURCE is hidden for native-stream sessions).
  return [...document.querySelectorAll('#tpm-btns .tpm-btn')]
    .filter(b => !b.hidden && b.offsetParent !== null);
}
function showTheaterPauseMenu() {
  const menu = document.getElementById('theater-pause-menu');
  if (!menu) return;
  // Pause native video (no-op for iframe — cross-origin can't be paused).
  const v = document.getElementById('theater-video');
  if (v && !TheaterPlayer.embed) { try { v.pause(); } catch {} }
  // Title from the player header.
  const title = document.getElementById('theater-video-title')?.textContent || '';
  const titleEl = document.getElementById('tpm-title');
  if (titleEl) titleEl.textContent = title;

  // Episode actions (shows only).
  const prevEpBtn = document.getElementById('tpm-prev-ep');
  const nextEpBtn = document.getElementById('tpm-next-ep');
  const list = TheaterPlayer.epList || [];
  const idx  = TheaterPlayer.epIndex;
  const isShow = (TheaterPlayer.ctx?.kind === 'show'
               || TheaterPlayer.ctx?.type === 'show')
               && list.length > 0;
  if (prevEpBtn) {
    prevEpBtn.hidden   = !isShow;
    prevEpBtn.disabled = !(idx > 0);
    prevEpBtn.title    = (isShow && idx > 0)
      ? `Previous Episode (S${list[idx-1].season} · E${list[idx-1].number})`
      : 'Previous Episode';
  }
  if (nextEpBtn) {
    nextEpBtn.hidden   = !isShow;
    nextEpBtn.disabled = !(idx >= 0 && idx < list.length - 1);
    nextEpBtn.title    = (isShow && idx >= 0 && idx < list.length - 1)
      ? `Next Episode (S${list[idx+1].season} · E${list[idx+1].number})`
      : 'Next Episode';
  }
  // NEXT SOURCE only meaningful when 2+ embed sources are available.
  const srcBtn  = document.getElementById('tpm-source');
  const sources = (TheaterPlayer.payload?.source?.sources) || TheaterPlayer.payload?.sources || [];
  if (srcBtn) srcBtn.hidden = !(TheaterPlayer.embed && sources.length >= 2);
  TheaterPlayer.pauseMenuFocus = 0;
  menu.classList.add('active');
  _tpmUpdateFocus();
  state.screen = 'theater-paused';
  KenteAudio.click?.();
}
function hideTheaterPauseMenu() {
  const menu = document.getElementById('theater-pause-menu');
  if (!menu) return;
  menu.classList.remove('active');
  // Resume native video; iframe playback was never actually paused.
  const v = document.getElementById('theater-video');
  if (v && !TheaterPlayer.embed) { try { v.play().catch(()=>{}); } catch {} }
  state.screen = 'theater-playing';
}
function _tpmCycleSource() {
  // Click the next option in the source dropdown — same flow as the user
  // selecting from the menu. Keeps localStorage / badge updates consistent.
  const opts = [...document.querySelectorAll('#theater-source-switcher .tss-option')];
  if (opts.length < 2) return;
  let idx = opts.findIndex(p => p.classList.contains('active'));
  if (idx < 0) idx = -1;
  const next = opts[(idx + 1) % opts.length];
  next?.click();
}

/* ── Embed watchdog ─────────────────────────────────────────────────────
   Several iframe hosts (vidsrcpm, multiembed, 2embedstream, …) occasionally
   fail to render anything at all — DNS hiccup, CSP block, Cloudflare 5xx.
   In those cases the iframe never fires `load`, so we arm a 12 s timer per
   src= write and auto-advance to the next pill if it expires. Manual pill
   clicks reset the auto-advance tracker so the user always trumps the
   watchdog.                                                              */
const _TVP_WATCHDOG_MS = 12000;

// Per-host reliability ledger — increments on load / decrements on watchdog
// timeout. Used to bias the initial source pick on cold launches when the
// user has no explicit preference yet. Capped at ±20 so a single bad day
// for a host doesn't permanently sink it.
const _TVP_SCORE_KEY = 'kente.theater.sourceScores';
function _tvpReadScores() {
  try { return JSON.parse(localStorage.getItem(_TVP_SCORE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function _tvpWriteScores(map) {
  try { localStorage.setItem(_TVP_SCORE_KEY, JSON.stringify(map)); } catch {}
}
function _tvpBumpScore(key, delta) {
  if (!key) return;
  const m = _tvpReadScores();
  const cur = (m[key] && typeof m[key].score === 'number') ? m[key].score : 0;
  m[key] = { score: Math.max(-20, Math.min(20, cur + delta)), at: Date.now() };
  _tvpWriteScores(m);
}

function _tvpClearWatchdog() {
  if (TheaterPlayer.watchdog) {
    clearTimeout(TheaterPlayer.watchdog);
    TheaterPlayer.watchdog = null;
  }
}

function _tvpArmWatchdog(frame, key, gen) {
  _tvpClearWatchdog();
  TheaterPlayer.watchdog = setTimeout(() => {
    if (gen !== TheaterPlayer.loadGen) return;       // a newer src= already won
    if (!TheaterPlayer.embed) return;                // player closed in the meantime
    if (!TheaterPlayer.autoAdvanceTried) TheaterPlayer.autoAdvanceTried = new Set();
    if (TheaterPlayer.autoAdvanceTried.has(key)) return;
    TheaterPlayer.autoAdvanceTried.add(key);
    // Penalize the host that just timed out so future cold launches skip it.
    _tvpBumpScore(key, -2);
    const sources = TheaterPlayer.embedSources || [];
    if (sources.length < 2) { _tvpHideEmbedLoading(); return; }
    const idx = sources.findIndex(s => s.name === key);
    let next = null;
    for (let i = 1; i <= sources.length; i++) {
      const cand = sources[(idx + i) % sources.length];
      if (!TheaterPlayer.autoAdvanceTried.has(cand.name)) { next = cand; break; }
    }
    if (!next) { _tvpHideEmbedLoading(); return; }   // every host already tried
    try {
      showToast(`⚠ ${String(key).toUpperCase()} UNRESPONSIVE — TRYING ${String(next.label || next.name).toUpperCase()}`);
    } catch {}
    _tvpLoadEmbedSource(frame, next, { auto: true });
  }, _TVP_WATCHDOG_MS);
}

// Loading overlay — covers the iframe while a host is initializing so the
// user sees progress instead of a blank black rectangle. Hidden on the
// frame's `load` event or when the watchdog gives up.
function _tvpShowEmbedLoading(label) {
  const el = document.getElementById('theater-embed-loading');
  if (!el) return;
  const lbl = el.querySelector('.tel-label');
  if (lbl) lbl.textContent = `LOADING ${String(label || 'SOURCE').toUpperCase()}…`;
  el.hidden = false;
}
function _tvpHideEmbedLoading() {
  const el = document.getElementById('theater-embed-loading');
  if (el) el.hidden = true;
}

function _tvpLoadEmbedSource(frame, src, opts) {
  if (!frame || !src || !src.url) return;
  const key = src.name;
  const lab = src.label || src.name || '';
  const gen = ++TheaterPlayer.loadGen;
  _tvpClearWatchdog();
  _tvpShowEmbedLoading(lab || key);
  try { frame.src = 'about:blank'; } catch {}
  // Tiny gap forces the iframe to remount cleanly on hosts that ignore
  // same-origin src updates; matches the previous manual-pill behavior.
  setTimeout(() => {
    if (gen !== TheaterPlayer.loadGen) return;
    try { frame.src = src.url; } catch {}
    _tvpArmWatchdog(frame, key, gen);
  }, 30);
  // UI updates fire immediately so the click feels responsive.
  const switcher = document.getElementById('theater-source-switcher');
  if (switcher) {
    switcher.querySelectorAll('.tss-option').forEach(p => {
      p.classList.toggle('active', p.getAttribute('data-key') === key);
    });
    const trig = switcher.querySelector('.tss-trigger-label');
    if (trig) trig.textContent = String(lab || key || 'SOURCE').toUpperCase();
  }
  const badge = document.getElementById('theater-embed-badge');
  if (badge) badge.textContent = `EMBEDDED PLAYER · ${String(lab || key || 'EXTERNAL').toUpperCase()}`;
  TheaterPlayer.activeSource = key;
  if (!opts || !opts.auto) {
    try { localStorage.setItem('kente.theater.embedSource', key); } catch {}
  }
}
/* ── Mini-player ────────────────────────────────────────────────────────
   A floating corner widget that re-frames `#theater-video-overlay` as a
   draggable mini view. The DOM stays put — we only toggle `.miniplayer-
   mode`, restore `state.screen` so the underlying screen drives gamepad
   nav, and bind drag handlers to the header. Position + size persist per-
   session in localStorage.                                              */
const _MP_POS_KEY = 'kente.theater.mpPos';
const _MP_MIN_W = 240, _MP_MIN_H = 150;
const _MP_MAX_W = 960, _MP_MAX_H = 600;

function _tvpMpReadPos() {
  try { return JSON.parse(localStorage.getItem(_MP_POS_KEY) || 'null'); }
  catch { return null; }
}
function _tvpMpWritePos(pos) {
  try { localStorage.setItem(_MP_POS_KEY, JSON.stringify(pos)); } catch {}
}
function _tvpMpApplyPos(overlay) {
  const p = _tvpMpReadPos();
  // Default — bottom-right corner via the CSS variable fallbacks.
  overlay.style.setProperty('--mp-top',    p?.top    != null ? p.top + 'px'    : 'auto');
  overlay.style.setProperty('--mp-left',   p?.left   != null ? p.left + 'px'   : 'auto');
  overlay.style.setProperty('--mp-right',  p?.right  != null ? p.right + 'px'  : (p ? 'auto' : '18px'));
  overlay.style.setProperty('--mp-bottom', p?.bottom != null ? p.bottom + 'px' : (p ? 'auto' : '18px'));
  // Size variables — default 360x220 matches the CSS fallback.
  overlay.style.setProperty('--mp-w', (p?.w != null ? p.w : 360) + 'px');
  overlay.style.setProperty('--mp-h', (p?.h != null ? p.h : 220) + 'px');
}

function enterMiniplayer() {
  const overlay = document.getElementById('theater-video-overlay');
  if (!overlay || !overlay.classList.contains('active')) return;
  if (TheaterPlayer.miniplayer) return;
  TheaterPlayer.miniplayer = true;
  overlay.classList.add('miniplayer-mode');
  _tvpMpApplyPos(overlay);
  // Hide pause menu if it was up; widget is too small for it.
  document.getElementById('theater-pause-menu')?.classList.remove('active');
  // Restore the underlying screen so the rest of the UI drives gamepad
  // nav and click handlers normally. closeTheaterVideo will skip the
  // restore on exit because prevScreen is consumed here.
  const prev = TheaterPlayer.prevScreen || 'menu';
  if (state.screen === 'theater-playing' || state.screen === 'theater-paused') {
    state.screen = prev;
  }
  if (prev === 'menu') KenteAudio.setHumVol(0.018);
  // Update the toggle's label.
  const btn = document.getElementById('theater-video-mini');
  if (btn) btn.textContent = '⤡ EXPAND';
}

function exitMiniplayer() {
  const overlay = document.getElementById('theater-video-overlay');
  if (!overlay || !TheaterPlayer.miniplayer) return;
  TheaterPlayer.miniplayer = false;
  overlay.classList.remove('miniplayer-mode', 'mp-dragging');
  state.screen = 'theater-playing';
  KenteAudio.setHumVol(0);
  const btn = document.getElementById('theater-video-mini');
  if (btn) btn.textContent = '⬓ MINI';
}

function toggleMiniplayer() {
  if (TheaterPlayer.miniplayer) exitMiniplayer();
  else enterMiniplayer();
}

function _tvpBindMpDrag(overlay, header) {
  // Single drag binding shared by mouse + touch. Only active while the
  // overlay is in miniplayer mode; clicks on inner buttons bubble out
  // before this runs because we ignore mousedowns on <button> targets.
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  const onDown = (e) => {
    if (!TheaterPlayer.miniplayer) return;
    if (e.target.closest('button')) return;
    const t = (e.touches && e.touches[0]) || e;
    const r = overlay.getBoundingClientRect();
    dragging = true;
    sx = t.clientX; sy = t.clientY;
    ox = r.left;    oy = r.top;
    overlay.classList.add('mp-dragging');
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const t = (e.touches && e.touches[0]) || e;
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    const w = overlay.offsetWidth, h = overlay.offsetHeight;
    const left = Math.max(0, Math.min(window.innerWidth  - w, ox + dx));
    const top  = Math.max(0, Math.min(window.innerHeight - h, oy + dy));
    overlay.style.setProperty('--mp-left',   left + 'px');
    overlay.style.setProperty('--mp-top',    top  + 'px');
    overlay.style.setProperty('--mp-right',  'auto');
    overlay.style.setProperty('--mp-bottom', 'auto');
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    overlay.classList.remove('mp-dragging');
    const r = overlay.getBoundingClientRect();
    // Preserve the existing size when persisting position.
    const prev = _tvpMpReadPos() || {};
    _tvpMpWritePos({
      left: Math.round(r.left), top: Math.round(r.top),
      w: prev.w, h: prev.h,
    });
  };
  header.addEventListener('mousedown',  onDown);
  header.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('mousemove',  onMove);
  window.addEventListener('touchmove',  onMove, { passive: false });
  window.addEventListener('mouseup',    onUp);
  window.addEventListener('touchend',   onUp);
  window.addEventListener('touchcancel', onUp);
}

function _tvpBindMpResize(overlay, grip) {
  // Bottom-right corner resize. Only active in miniplayer mode. The overlay
  // anchors to top-left during a resize so the grip stays under the cursor
  // even when the widget was previously bottom-right anchored.
  let resizing = false, sx = 0, sy = 0, sw = 0, sh = 0;
  const onDown = (e) => {
    if (!TheaterPlayer.miniplayer) return;
    const t = (e.touches && e.touches[0]) || e;
    const r = overlay.getBoundingClientRect();
    resizing = true;
    sx = t.clientX; sy = t.clientY;
    sw = r.width;   sh = r.height;
    // Lock the widget to its current top-left so the resize doesn't make
    // it appear to "jump" across the screen.
    overlay.style.setProperty('--mp-left',   r.left + 'px');
    overlay.style.setProperty('--mp-top',    r.top  + 'px');
    overlay.style.setProperty('--mp-right',  'auto');
    overlay.style.setProperty('--mp-bottom', 'auto');
    overlay.classList.add('mp-resizing');
    e.preventDefault();
    e.stopPropagation();
  };
  const onMove = (e) => {
    if (!resizing) return;
    const t = (e.touches && e.touches[0]) || e;
    const w = Math.max(_MP_MIN_W, Math.min(_MP_MAX_W, sw + (t.clientX - sx)));
    const h = Math.max(_MP_MIN_H, Math.min(_MP_MAX_H, sh + (t.clientY - sy)));
    overlay.style.setProperty('--mp-w', w + 'px');
    overlay.style.setProperty('--mp-h', h + 'px');
  };
  const onUp = () => {
    if (!resizing) return;
    resizing = false;
    overlay.classList.remove('mp-resizing');
    const r = overlay.getBoundingClientRect();
    _tvpMpWritePos({
      left: Math.round(r.left), top: Math.round(r.top),
      w:    Math.round(r.width), h: Math.round(r.height),
    });
  };
  grip.addEventListener('mousedown',  onDown);
  grip.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('mousemove',  onMove);
  window.addEventListener('touchmove',  onMove, { passive: false });
  window.addEventListener('mouseup',    onUp);
  window.addEventListener('touchend',   onUp);
  window.addEventListener('touchcancel', onUp);
}

// Wire pause-menu + chrome buttons once on DOM ready.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tpm-resume')?.addEventListener('click', hideTheaterPauseMenu);
  document.getElementById('tpm-prev-ep')?.addEventListener('click', () => {
    const btn = document.getElementById('tpm-prev-ep');
    if (btn?.disabled) return;
    KenteAudio.click?.();
    _tvpJumpEpisode(-1);
    hideTheaterPauseMenu();
  });
  document.getElementById('tpm-next-ep')?.addEventListener('click', () => {
    const btn = document.getElementById('tpm-next-ep');
    if (btn?.disabled) return;
    KenteAudio.click?.();
    _tvpJumpEpisode(+1);
    hideTheaterPauseMenu();
  });
  document.getElementById('tpm-source')?.addEventListener('click', () => {
    _tpmCycleSource();
    hideTheaterPauseMenu();
  });
  document.getElementById('tpm-mini')  ?.addEventListener('click', () => {
    hideTheaterPauseMenu();
    enterMiniplayer();
  });
  document.getElementById('tpm-close') ?.addEventListener('click', closeTheaterVideo);
  // Header MINI / EXPAND toggle + drag binding.
  document.getElementById('theater-video-mini')?.addEventListener('click', toggleMiniplayer);
  const ov = document.getElementById('theater-video-overlay');
  const hd = document.getElementById('theater-video-header');
  if (ov && hd) _tvpBindMpDrag(ov, hd);
  // Resize grip — created lazily so we don't need to touch index.html. The
  // grip is only visible while .miniplayer-mode is active (CSS-controlled).
  if (ov) {
    let grip = document.getElementById('theater-video-resize');
    if (!grip) {
      grip = document.createElement('div');
      grip.id = 'theater-video-resize';
      grip.className = 'mp-resize-grip';
      grip.title = 'Drag to resize';
      ov.appendChild(grip);
    }
    _tvpBindMpResize(ov, grip);
  }
});

async function openTheaterVideo(payload, title, ctx) {
  const overlay = document.getElementById('theater-video-overlay');
  const v       = document.getElementById('theater-video');
  const stage   = document.getElementById('theater-video-stage');
  const label   = document.getElementById('theater-video-title');
  const qSel    = document.getElementById('tvp-quality');
  if (!overlay || !v) return;

  // Match openTheaterEmbed: pre-emptively engage the popup guard. Native
  // HLS playback rarely produces window.open spam, but a single flag flip
  // keeps the close-on-exit invariant simple regardless of which path ran.
  try { window.electronAPI?.setTheaterActive?.(true); } catch {}
  _tvpBindControlsOnce();
  // Native HLS path — clear any leftover embed-mode flag so the scrub bar
  // and time display reappear after switching from an embed session.
  stage?.classList.remove('tvp-embed-mode');

  TheaterPlayer.payload   = payload;
  TheaterPlayer.ctx       = ctx || null;
  TheaterPlayer.resumed   = false;
  TheaterPlayer.resumeAt  = 0;
  TheaterPlayer.saveTimer = 0;
  TheaterPlayer.embed     = false;
  TheaterPlayer.epList    = (ctx && Array.isArray(ctx._episodes)) ? ctx._episodes : [];
  // Normalize episode ids to string so providers that use numeric ids still match
  // the dataset-string episodeId we carry in ctx.
  const _curEpId = (ctx && ctx.episodeId != null) ? String(ctx.episodeId) : null;
  TheaterPlayer.epIndex   = _curEpId
    ? TheaterPlayer.epList.findIndex(ep => String(ep?.id ?? '') === _curEpId)
    : -1;
  _tvpUpNextResetForEpisode();   // fresh episode → re-arm the Up Next card
  // Capture the previous screen so closeTheaterVideo can restore it.
  if (state.screen !== 'theater-playing' && state.screen !== 'theater-paused') {
    TheaterPlayer.prevScreen = state.screen;
  }
  state.screen = 'theater-playing';
  AttractMode.onLeaveRoom();
  _tvpAcquireWakeLock();
  // Look up a saved resume position for this title/episode. Smart Resume:
  // skip the resume offer when the saved spot is in the last 90 s of the
  // runtime or past the 95% mark — those count as 'finished', and any stale
  // record that snuck past the saveProgress filter is cleared on the spot.
  if (ctx) {
    try {
      const rec  = await TheaterDB.getProgress(ctx);
      const dur  = rec?.duration || 0;
      const pos  = rec?.position || 0;
      const tail = dur > 0 && (dur - pos) <= 90;
      const past = dur > 0 && pos > 0.95 * dur;
      if (rec && (tail || past)) {
        try { await TheaterDB.clearProgress(ctx); } catch {}
      } else if (rec && pos > 5) {
        TheaterPlayer.resumeAt = pos;
        showToast(`▶ RESUMING AT ${_tvpFmt(pos)}`);
      }
    } catch {}
  }
  _tvpSetTitle(title);
  _tvpSetHeaderMeta([_fmtRuntime(ctx?.runtime)]);
  _tvpRefreshEpButtons();

  // Build quality dropdown
  const qualities = payload.qualities || Object.keys(payload.streams || {});
  qSel.innerHTML = qualities.map(q => `<option value="${q}">${q.toUpperCase()}</option>`).join('');
  const initial = _tvpPickInitialQuality(qualities);
  qSel.value = initial;

  document.getElementById('theater-video-error').hidden = true;
  document.getElementById('theater-video-loading').hidden = false;
  overlay.classList.add('active');
  KenteAudio.setHumVol(0);
  closeTheaterDetail();
  _tvpAttachSource(initial);
}
