/* Kente's Korner — Attract mode and boot kick-off. */
'use strict';

/* ══════════════════════════════════════════
   ATTRACT MODE
   Triggers after 30 s of inactivity while on
   the room screen. Cycles through game titles.
   Any input dismisses it.
══════════════════════════════════════════ */
const AttractMode = (() => {
  const IDLE_MS  = 30_000;   // 30 s before attract fires
  const CYCLE_MS = 3_000;    // rotate title every 3 s

  let _idleTimer  = null;
  let _cycleTimer = null;
  let _active     = false;
  let _gameIdx    = 0;

  function _allGames() {
    // SYSTEMS is the global array declared in js/systems.js.
    // window.KenteLibrary has no .systems property — that caused every game to be
    // filtered out, leaving attract mode permanently stuck on the fallback title.
    return (window.KenteLibrary?.games || []).filter(g => {
      const sys = SYSTEMS.find(s => s.id === g.systemId);
      return sys && sys.active && !sys.sacrificed;
    });
  }

  function _cycleTitle() {
    const games = _allGames();
    if (!games.length) return;
    _gameIdx = (_gameIdx + 1) % games.length;
    const g  = games[_gameIdx];
    const el = document.getElementById('attract-title');
    const sys = document.getElementById('attract-sys');
    if (el)  { el.style.opacity  = '0'; setTimeout(() => { if (el)  { el.textContent  = g.title.toUpperCase();  el.style.opacity  = '1'; }}, 300); }
    if (sys) { sys.style.opacity = '0'; setTimeout(() => { if (sys) { sys.textContent = (g.system || g.systemId).toUpperCase() + ' · ' + g.year; sys.style.opacity = '1'; }}, 300); }
  }

  function enter() {
    if (_active || state.screen !== 'room') return;
    _active  = true;
    _gameIdx = 0;
    document.body.classList.add('attract-mode');
    const games   = _allGames();
    const g       = games[0] || { title: "KENTE'S KORNER", system: 'READY', year: '' };
    const overlay = document.getElementById('attract-overlay');
    if (overlay) {
      const titleEl = overlay.querySelector('#attract-title');
      const sysEl   = overlay.querySelector('#attract-sys');
      if (titleEl) titleEl.textContent = g.title.toUpperCase();
      if (sysEl)   sysEl.textContent   = (g.system || g.systemId || '').toUpperCase() + (g.year ? ' · ' + g.year : '');
      overlay.classList.add('active');
    }
    _cycleTimer = setInterval(_cycleTitle, CYCLE_MS);
  }

  function exit() {
    if (!_active) return;
    _active = false;
    document.body.classList.remove('attract-mode');
    const overlay = document.getElementById('attract-overlay');
    if (overlay) overlay.classList.remove('active');
    clearInterval(_cycleTimer);
    _cycleTimer = null;
    _resetIdleTimer();
  }

  function _resetIdleTimer() {
    clearTimeout(_idleTimer);
    if (state.screen === 'room') {
      _idleTimer = setTimeout(enter, IDLE_MS);
    }
  }

  function _onActivity() {
    if (_active) { exit(); return; }
    _resetIdleTimer();
  }

  function init() {
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'click', 'gamepadconnected']
      .forEach(ev => document.addEventListener(ev, _onActivity, { passive: true }));
  }

  function onEnterRoom() { _resetIdleTimer(); }
  function onLeaveRoom() { clearTimeout(_idleTimer); if (_active) exit(); }

  return { init, enter, exit, onEnterRoom, onLeaveRoom };
})();

/* ══════════════════════════════════════════
   KICK IT OFF
══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', boot);
