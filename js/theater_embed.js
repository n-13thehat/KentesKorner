/* Kente's Korner — Embedded iframe player and AdShield. */
'use strict';

/* ── Embedded iframe player ──
   Used by VidSrc / 2Embed / VidSrc.pm / MultiEmbed providers.  The remote
   site renders its own controls inside the iframe; we can't poll currentTime
   for progress, so resume / Continue Watching is suppressed.  An "EMBEDDED
   PLAYER" badge replaces the quality selector to make the difference
   visible to the user.                                                     */
/* ── AdShield ───────────────────────────────────────────────────────────
   Layered, sandbox-less popup / hijack mitigation. Engaged for the
   duration of an embed playback session (open → close).

     1. window.open interceptor with a user-gesture grace window.
        Programmatic popups (no recent click) are dropped silently;
        opens within 1 s of a real pointer/key/touch event are allowed.
     2. beforeunload guard. If the host or an ad iframe tries to navigate
        the top window away from the app while playback is active, the
        browser shows the standard "Leave site?" prompt.
     3. document.title watchdog. Some ad scripts mutate the parent title
        ("⚠ Virus detected!" etc.); we restore it every 750 ms.
     4. Counter is surfaced via a toast on deactivate so the user knows
        how many popups were blocked during the session.

   No-op when appSettings.theaterAdShield is false.
   ───────────────────────────────────────────────────────────────────── */
const AdShield = (() => {
  let active = false;
  let originalOpen = null;
  let originalTitle = '';
  let titleTimer = null;
  let lastGesture = 0;
  let blocked = 0;
  const GESTURE_GRACE_MS = 1000;

  const _markGesture = () => { lastGesture = Date.now(); };
  const _onBeforeUnload = (e) => {
    if (!active) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  };

  function activate() {
    if (active) return;
    if (!appSettings.theaterAdShield) return;
    active = true;
    blocked = 0;

    // (1) window.open interceptor — gated by recent-gesture flag.
    originalOpen = window.open;
    window.open = function(url, target, features) {
      const gestureAge = Date.now() - lastGesture;
      if (gestureAge > GESTURE_GRACE_MS) {
        blocked++;
        try { console.info('[AdShield] blocked popup:', url); } catch {}
        return null;
      }
      // Within grace window — allow same-origin opens (rare in this app).
      try {
        const u = new URL(url || '', location.href);
        if (u.origin === location.origin) {
          return originalOpen.call(window, url, target, features);
        }
      } catch {}
      blocked++;
      return null;
    };

    document.addEventListener('pointerdown', _markGesture, true);
    document.addEventListener('keydown',     _markGesture, true);
    document.addEventListener('touchstart',  _markGesture, true);

    // (2) beforeunload — only intercepts top-window unload, ignored by
    // browsers without user activation, so it doesn't fire on legitimate
    // closes (closeTheaterVideo runs deactivate() before any teardown).
    window.addEventListener('beforeunload', _onBeforeUnload);

    // (3) title watchdog.
    originalTitle = document.title;
    titleTimer = setInterval(() => {
      if (document.title !== originalTitle) document.title = originalTitle;
    }, 750);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    // try/finally guarantees the title watchdog interval is cleared even if
    // an earlier teardown step throws — otherwise the 750 ms timer would
    // outlive the AdShield session and keep rewriting document.title.
    try {
      if (originalOpen) { window.open = originalOpen; originalOpen = null; }
      document.removeEventListener('pointerdown', _markGesture, true);
      document.removeEventListener('keydown',     _markGesture, true);
      document.removeEventListener('touchstart',  _markGesture, true);
      window.removeEventListener('beforeunload', _onBeforeUnload);
      if (blocked > 0) {
        try { showToast(`\u{1F6E1} AD SHIELD BLOCKED ${blocked} POPUP${blocked===1?'':'S'}`); } catch {}
      }
      blocked = 0;
    } finally {
      if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
    }
  }

  return { activate, deactivate, isActive: () => active };
})();

async function openTheaterEmbed(payload, title, ctx) {
  const overlay = document.getElementById('theater-video-overlay');
  const stage   = document.getElementById('theater-video-stage');
  const label   = document.getElementById('theater-video-title');
  if (!overlay || !stage) return;
  // Tell the Electron main process the theater is on screen so it stops
  // forwarding iframe window.open() calls to the system browser. Without
  // this, every popunder ad inside vidsrc/2embed/etc. launches Chrome.
  try { window.electronAPI?.setTheaterActive?.(true); } catch {}
  AdShield.activate();
  // Mark embed mode on the stage so CSS can hide controls that have no
  // meaning for a cross-origin iframe (scrub bar, time display, ±10 s).
  stage.classList.add('tvp-embed-mode');

  // Tear down any prior native-video session before swapping in the iframe.
  const prevV = document.getElementById('theater-video');
  if (prevV) { try { prevV.pause(); prevV.removeAttribute('src'); prevV.load(); } catch {} }
  if (TheaterPlayer.hls) { try { TheaterPlayer.hls.destroy(); } catch {} TheaterPlayer.hls = null; }

  TheaterPlayer.payload  = payload;
  TheaterPlayer.ctx      = ctx || null;
  TheaterPlayer.resumed  = false;
  TheaterPlayer.resumeAt = 0;
  TheaterPlayer.embed    = true;
  TheaterPlayer.epList   = (ctx && Array.isArray(ctx._episodes)) ? ctx._episodes : [];
  const _curEpId = (ctx && ctx.episodeId != null) ? String(ctx.episodeId) : null;
  TheaterPlayer.epIndex  = _curEpId
    ? TheaterPlayer.epList.findIndex(ep => String(ep?.id ?? '') === _curEpId)
    : -1;
  if (state.screen !== 'theater-playing' && state.screen !== 'theater-paused') {
    TheaterPlayer.prevScreen = state.screen;
  }
  state.screen = 'theater-playing';
  AttractMode.onLeaveRoom();
  _tvpAcquireWakeLock();
  _tvpSetTitle(title);
  _tvpSetHeaderMeta([_fmtRuntime(ctx?.runtime)]);
  _tvpRefreshEpButtons();

  // Hide the native video element + quality selector; show an iframe instead.
  // The original DOM structure is restored on close so future MP4 / HLS
  // playback paths continue to work.
  if (prevV) prevV.style.display = 'none';
  document.getElementById('theater-video-loading').hidden = true;
  document.getElementById('theater-video-error').hidden   = true;
  const qWrap = document.getElementById('tvp-quality')?.closest('label, .tvp-quality-wrap')
                ?? document.getElementById('tvp-quality');
  if (qWrap) qWrap.style.visibility = 'hidden';
  // CC tracks live on the (now-hidden) <video>; the host iframe owns its own
  // caption UI. Keep the CC button visible but disabled-styled so the user
  // can still see captions are theoretically supported — clicking flashes a
  // "NO SUBTITLES AVAILABLE" toast via the existing _tvpCycleCC path.
  const ccBtn = document.getElementById('tvp-cc');
  if (ccBtn) {
    ccBtn.hidden = false;
    ccBtn.textContent = 'CC';
    ccBtn.classList.remove('tvp-btn-active');
    ccBtn.classList.add('tvp-btn-disabled');
  }
  TheaterPlayer.ccTracks = [];
  TheaterPlayer.ccIndex  = -1;

  let frame = document.getElementById('theater-video-iframe');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = 'theater-video-iframe';
    frame.allow = 'autoplay; fullscreen; picture-in-picture';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'no-referrer';
    Object.assign(frame.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      border: '0', background: '#000',
    });
    // Cancel the watchdog as soon as the host renders something. The load
    // event fires for cross-origin frames too (we just can't read the
    // body), so this is enough to know the network round-trip succeeded.
    // Skip the about:blank reset that precedes every src= write.
    frame.addEventListener('load', () => {
      try { if ((frame.src || '').startsWith('about:')) return; } catch {}
      _tvpClearWatchdog();
      _tvpHideEmbedLoading();
      // Reward the host that just rendered; biases future cold-launch picks.
      if (TheaterPlayer.activeSource) _tvpBumpScore(TheaterPlayer.activeSource, +1);
    });
    stage.appendChild(frame);
  }
  // Loading overlay sibling — sits inside the stage so it's clipped + scaled
  // alongside the iframe. Created once, reused for every source switch.
  let loading = document.getElementById('theater-embed-loading');
  if (!loading) {
    loading = document.createElement('div');
    loading.id = 'theater-embed-loading';
    loading.className = 'tel-loading';
    loading.hidden = true;
    loading.innerHTML =
      '<div class="tel-spinner"></div>' +
      '<div class="tel-label">LOADING SOURCE…</div>' +
      '<div class="tel-hint">↻ AUTO-ADVANCES IF UNRESPONSIVE</div>';
    stage.appendChild(loading);
  }
  // Sandbox is re-applied per-launch so toggling the Settings switch takes
  // effect on the next title without a page reload.
  //   OFF (default)       — attribute omitted entirely. Several hosts
  //                          (vidsrc family, embed.su, multiembed) probe for
  //                          window.frameElement.sandbox and abort with
  //                          "sandboxing is not allowed" / "media unavailable"
  //                          regardless of which tokens are granted, so the
  //                          only way to keep them playable is to not set
  //                          the attribute at all. Acceptable on a closed
  //                          single-user retro box.
  //   PERMISSIVE          — broad token set; works for most hosts that don't
  //                          actively probe.
  //   STRICT              — blocks popups + top-nav for max ad isolation.
  //   ULTRA               — also drops allow-same-origin so the host gets
  //                          a unique origin (kills cross-site cookies and
  //                          most tracking; breaks roughly half the hosts).
  const _sandboxMode = appSettings.theaterSandbox || 'OFF';
  if (_sandboxMode === 'OFF') {
    frame.removeAttribute('sandbox');
  } else {
    const _sandboxTokens = _sandboxMode === 'ULTRA' ? [
      'allow-scripts',
      'allow-forms',
      'allow-presentation',
    ] : _sandboxMode === 'STRICT' ? [
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-presentation',
    ] : [
      'allow-scripts',
      'allow-same-origin',
      'allow-forms',
      'allow-presentation',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-top-navigation-by-user-activation',
      'allow-modals',
      'allow-orientation-lock',
      'allow-pointer-lock',
    ];
    frame.setAttribute('sandbox', _sandboxTokens.join(' '));
  }

  // Source switcher — when the backend ships a `sources[]` fallback chain,
  // render pills so the user can cycle through hosts (vidsrc/2embed/embed.su/
  // multiembed/etc.) until one of them actually has a working stream. Many
  // iframe aggregators show "No sources available" inside their player when
  // their CDN doesn't have a particular IMDB id; switching hosts is the
  // standard workaround. Persists the last-good host per session in
  // localStorage so the next launch starts on the user's preferred edge.
  const sources = (payload.source && payload.source.sources) || payload.sources || [];
  let initialUrl = payload.embed;
  let initialKey = payload.provider;
  if (sources.length) {
    let preferred = null;
    try { preferred = localStorage.getItem('kente.theater.embedSource') || null; } catch {}
    if (preferred) {
      const hit = sources.find(s => s.name === preferred);
      if (hit) { initialUrl = hit.url; initialKey = hit.name; }
    } else {
      // No explicit preference yet — pick the highest-scored host the user
      // has seen succeed before. Ties fall back to the backend's order
      // (which already biases anime to anime-aware hosts via `primary`).
      const scores = _tvpReadScores();
      let best = null, bestScore = -Infinity;
      sources.forEach((s, i) => {
        const sc = (scores[s.name] && typeof scores[s.name].score === 'number')
                   ? scores[s.name].score : 0;
        if (sc > bestScore) { best = s; bestScore = sc; }
      });
      if (best && bestScore > 0) { initialUrl = best.url; initialKey = best.name; }
    }
  }
  // Cache the source list on TheaterPlayer so the watchdog + cycle helpers
  // can resolve URLs without re-parsing the DOM. Falls back to a one-entry
  // list when the backend ships a single embed URL with no `sources[]`.
  TheaterPlayer.embedSources = sources.length
    ? sources
    : (initialUrl ? [{ name: initialKey, url: initialUrl, label: initialKey }] : []);
  TheaterPlayer.autoAdvanceTried = new Set();
  frame.style.display = 'block';

  // Provider badge — replaces the quality dropdown's affordance.
  let badge = document.getElementById('theater-embed-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'theater-embed-badge';
    badge.className = 'theater-embed-badge';
    stage.parentElement?.insertBefore(badge, stage);
  }
  badge.style.display = 'block';

  // Source dropdown — lives inside the controls bar so it auto-fades with
  // the rest of the chrome and never floats over the video. The slot is a
  // placeholder div in index.html; we just (re)mount the switcher into it.
  const sourceSlot = document.getElementById('tvp-source-slot');
  let switcher = document.getElementById('theater-source-switcher');
  if (!switcher) {
    switcher = document.createElement('div');
    switcher.id = 'theater-source-switcher';
    switcher.className = 'theater-source-switcher';
  }
  if (sourceSlot && switcher.parentElement !== sourceSlot) sourceSlot.appendChild(switcher);
  if (sources.length >= 2) {
    const activeSrc = sources.find(s => s.name === initialKey) || sources[0];
    const triggerLabel = (activeSrc?.label || activeSrc?.name || 'SOURCE').toUpperCase();
    // Sources scraped from third-party host pages (currently `baddies`) hand
    // back raw iframe URLs from ad-heavy mirrors — flag them in the picker
    // so the user can self-select away before clicking.
    const _isHighRisk = (name) => name === 'baddies';
    switcher.innerHTML =
        `<button type="button" class="tss-trigger" aria-haspopup="listbox" aria-expanded="false" title="Switch source">`
      +   `<span class="tss-trigger-label">${escHtml(triggerLabel)}</span>`
      +   `<span class="tss-trigger-caret">▾</span>`
      + `</button>`
      + `<div class="tss-menu" role="listbox" hidden>`
      +   sources.map(s => {
            const baseLabel = String(s.label || s.name || '');
            const display   = _isHighRisk(s.name) ? `${baseLabel} ⚠ AD-HEAVY` : baseLabel;
            return `<button type="button" class="tss-option${s.name === initialKey ? ' active' : ''}" `
              + `role="option" data-key="${escHtml(s.name)}" `
              + `data-label="${escHtml(baseLabel)}"`
              + `${_isHighRisk(s.name) ? ' title="This source pulls iframes from ad-heavy mirrors."' : ''}`
              + `>${escHtml(display)}</button>`;
          }).join('')
      + `</div>`;
    switcher.style.display = 'inline-flex';
    const trigger = switcher.querySelector('.tss-trigger');
    const menu    = switcher.querySelector('.tss-menu');
    const closeMenu = () => {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      switcher.classList.remove('tss-open');
    };
    const openMenu = () => {
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      switcher.classList.add('tss-open');
    };
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden ? openMenu() : closeMenu();
    });
    // Click outside closes — single doc listener, removed when switcher dies.
    const onDocClick = (ev) => { if (!switcher.contains(ev.target)) closeMenu(); };
    document.addEventListener('click', onDocClick);
    switcher._tssOff = () => document.removeEventListener('click', onDocClick);
    menu.querySelectorAll('.tss-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-key');
        const src = (TheaterPlayer.embedSources || []).find(s => s.name === key);
        closeMenu();
        if (!src) return;
        // User just intervened — drop the auto-advance ledger so the next
        // host gets a clean watchdog window instead of being skipped.
        TheaterPlayer.autoAdvanceTried = new Set();
        _tvpLoadEmbedSource(frame, src, { auto: false });
      });
    });
  } else {
    switcher.innerHTML = '';
    switcher.style.display = 'none';
    if (switcher._tssOff) { switcher._tssOff(); switcher._tssOff = null; }
  }

  // Initial load goes through the same helper as manual pill clicks so
  // the watchdog / badge / activeSource state stays consistent.
  const _initial = TheaterPlayer.embedSources.find(s => s.name === initialKey)
                || TheaterPlayer.embedSources[0];
  if (_initial) {
    _tvpLoadEmbedSource(frame, _initial, { auto: false });
  } else {
    // No usable source at all — fall back to whatever the payload had.
    try { frame.src = initialUrl || 'about:blank'; } catch {}
    if (badge) badge.textContent = `EMBEDDED PLAYER · ${(initialKey || 'EXTERNAL').toUpperCase()}`;
    TheaterPlayer.activeSource = initialKey;
  }

  overlay.classList.add('active');
  KenteAudio.setHumVol(0);
  closeTheaterDetail();
}

function closeTheaterVideo() {
  const overlay = document.getElementById('theater-video-overlay');
  const v       = document.getElementById('theater-video');
  const stage   = document.getElementById('theater-video-stage');
  if (!overlay) return;
  stage?.classList.remove('tvp-embed-mode');
  // Release the Electron-side popup guard now that the theater is going
  // away — outbound links elsewhere in the app should reach the system
  // browser normally again.
  try { window.electronAPI?.setTheaterActive?.(false); } catch {}
  // Drop AdShield first so the beforeunload guard doesn't trip on the
  // user's own close action and the popup-block toast can render.
  AdShield.deactivate();
  // Iframe path: tear down the iframe, restore the native <video>, hide badge.
  const frame = document.getElementById('theater-video-iframe');
  if (frame) { try { frame.src = 'about:blank'; } catch {} frame.style.display = 'none'; }
  const badge = document.getElementById('theater-embed-badge');
  if (badge) badge.style.display = 'none';
  const switcher = document.getElementById('theater-source-switcher');
  if (switcher) {
    // Drop the document-level click listener installed when the menu was
    // built, otherwise it survives across plays and accumulates.
    if (switcher._tssOff) { switcher._tssOff(); switcher._tssOff = null; }
    switcher.innerHTML = '';
    switcher.style.display = 'none';
  }
  _tvpHideEmbedLoading();
  if (v) v.style.display = '';
  const qWrap = document.getElementById('tvp-quality')?.closest('label, .tvp-quality-wrap')
                ?? document.getElementById('tvp-quality');
  if (qWrap) qWrap.style.visibility = '';
  // Tear down CC tracks + reset header meta chip for the next session.
  if (v) v.querySelectorAll('track[data-tvp-cc]').forEach(t => t.remove());
  TheaterPlayer.ccTracks = [];
  TheaterPlayer.ccIndex  = -1;
  const ccBtn = document.getElementById('tvp-cc');
  if (ccBtn) {
    ccBtn.hidden = false;
    ccBtn.textContent = 'CC';
    ccBtn.classList.remove('tvp-btn-active');
    ccBtn.classList.add('tvp-btn-disabled');
  }
  _tvpSetHeaderMeta([]);
  // Final progress save before tearing the player down — only meaningful for
  // the native <video> path; iframe sessions can't be polled.
  if (!TheaterPlayer.embed && v && TheaterPlayer.ctx && v.currentTime > 1 && TheaterPlayer.resumed) {
    try { TheaterDB.saveProgress(TheaterPlayer.ctx, v.currentTime, v.duration || 0); } catch {}
  }
  if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} }
  if (TheaterPlayer.hls) { try { TheaterPlayer.hls.destroy(); } catch {} TheaterPlayer.hls = null; }
  TheaterPlayer.payload = null;
  TheaterPlayer.ctx     = null;
  TheaterPlayer.resumed = false;
  TheaterPlayer.resumeAt = 0;
  TheaterPlayer.embed   = false;
  TheaterPlayer.activeSource = null;
  TheaterPlayer.embedSources = [];
  TheaterPlayer.epList    = [];
  TheaterPlayer.epIndex   = -1;
  TheaterPlayer.autoAdvanceTried = null;
  _tvpUpNextResetForEpisode();
  TheaterPlayer.loadGen++;          // invalidate any in-flight watchdog
  // Reset playback rate to 1× so the next session doesn't inherit the prior
  // speed; the help overlay also collapses on close.
  TheaterPlayer.speedIdx = 2;
  _tvpApplySpeed(1);
  _tvpHideHelp();
  // Hide the prev/next-episode buttons + clear the disabled-state classes
  // so the next playback session opens with clean chrome.
  ['tvp-prev-ep','tvp-next-ep'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.hidden = true; b.classList.add('tvp-btn-disabled'); }
  });
  _tvpClearWatchdog();
  // Drop miniplayer chrome before hiding the overlay — keeps state.screen
  // and the MINI button label consistent for the next playback session.
  if (TheaterPlayer.miniplayer) {
    TheaterPlayer.miniplayer = false;
    overlay.classList.remove('miniplayer-mode', 'mp-dragging');
    const mb = document.getElementById('theater-video-mini');
    if (mb) mb.textContent = '⬓ MINI';
  }
  overlay.classList.remove('active');
  document.getElementById('theater-video-stage')?.classList.remove('tvp-idle','tvp-paused');
  // Tear down pause menu + release wake lock + restore state.screen.
  document.getElementById('theater-pause-menu')?.classList.remove('active');
  _tvpReleaseWakeLock();
  const prev = TheaterPlayer.prevScreen || 'menu';
  TheaterPlayer.prevScreen = null;
  // If we're already on the previous screen (because miniplayer restored
  // it earlier), don't clobber the user's current location.
  if (state.screen === 'theater-playing' || state.screen === 'theater-paused') {
    state.screen = prev;
  }
  if (state.screen === 'menu' || prev === 'menu') KenteAudio.setHumVol(0.018);
}

// Wire close button + backdrop close on DOM ready.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('theater-video-close')?.addEventListener('click', closeTheaterVideo);
  document.getElementById('theater-video-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'theater-video-overlay') closeTheaterVideo();
  });
  document.addEventListener('keydown', e => {
    const ovActive = document.getElementById('theater-video-overlay')?.classList.contains('active');
    if (!ovActive) return;
    // Escape: route through pause menu — first press pauses, second closes.
    if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      if (state.screen === 'theater-paused') hideTheaterPauseMenu();
      else if (state.screen === 'theater-playing') showTheaterPauseMenu();
      else closeTheaterVideo();
      return;
    }
    // Pause-menu keyboard navigation
    if (state.screen === 'theater-paused') {
      const btns = _tpmButtons();
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        TheaterPlayer.pauseMenuFocus = (TheaterPlayer.pauseMenuFocus + 1) % btns.length;
        _tpmUpdateFocus();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        TheaterPlayer.pauseMenuFocus = (TheaterPlayer.pauseMenuFocus - 1 + btns.length) % btns.length;
        _tpmUpdateFocus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        btns[TheaterPlayer.pauseMenuFocus]?.click();
      }
      return;
    }
    // Lightweight player shortcuts while playing (native <video> only).
    if (state.screen === 'theater-playing' && !TheaterPlayer.embed) {
      const v = document.getElementById('theater-video');
      if (!v) return;
      if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); }
      else if (e.key === 'ArrowUp')    { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.05); }
      else if (e.key === 'ArrowDown')  { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.05); }
    }
  });
});
