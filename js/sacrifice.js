/* Kente's Korner — Sacrifice chamber. */
'use strict';

/* ══════════════════════════════════════════
   SACRIFICE CHAMBER
══════════════════════════════════════════ */
const sacState = {
  selectedSacrifice: null,
  selectedUnlock: null,
  phase: 'select'   // select | confirm | ritual | result
};

function openChamber() {
  sacState.selectedSacrifice = null;
  sacState.selectedUnlock    = null;
  sacState.phase = 'select';
  document.querySelectorAll('.menu-screen').forEach(m => m.classList.remove('active'));
  KenteAudio.ritualDrone();
  setScreen('sacrifice-screen');
  state.screen = 'sacrifice';   // keep state machine consistent with closeChamber()
  renderChamberSelect();
}

function closeChamber() {
  KenteAudio.back();
  document.getElementById('sacrifice-screen').classList.remove('active');
  setScreen('room');
  state.screen = 'room';
  KenteAudio.setHumVol(0.018);
}

/* ── SELECT SCREEN ── */
function renderChamberSelect() {
  const activeSystems    = SYSTEMS.filter(s => s.active && !s.sacrificed);
  const sacrificeable    = sacState.selectedSacrifice
    ? SYSTEMS.filter(s => !s.active && !s.sacrificed && s.tier === sacState.selectedSacrifice.tier + 1)
    : [];

  const leftCards = activeSystems.map(s => {
    const sel = sacState.selectedSacrifice?.id === s.id ? ' selected' : '';
    return `<div class="sys-card sacrifice-candidate${sel}" data-id="${s.id}">
      <div class="sys-card-tier">TIER ${s.tier}</div>
      <div class="sys-card-icon">${s.icon}</div>
      <div class="sys-card-name">${s.name}</div>
      <div class="sys-card-tag">ACTIVE</div>
    </div>`;
  }).join('');

  const rightCards = sacState.selectedSacrifice
    ? (sacrificeable.length
        ? sacrificeable.map(s => {
            const sel = sacState.selectedUnlock?.id === s.id ? ' selected' : '';
            return `<div class="sys-card unlock-candidate${sel}" data-id="${s.id}">
              <div class="sys-card-tier">TIER ${s.tier}</div>
              <div class="sys-card-icon">${s.icon}</div>
              <div class="sys-card-name">${s.name}</div>
              <div class="sys-card-tag unlock">UNLOCKABLE</div>
            </div>`;
          }).join('')
        : '<p class="sac-empty">NO SYSTEMS AVAILABLE AT THE NEXT TIER.<br>ALL HAVE BEEN UNLOCKED OR SACRIFICED.</p>'
      )
    : '<p class="sac-empty">← SELECT A SYSTEM TO SACRIFICE<br>TO SEE WHAT YOU CAN UNLOCK</p>';

  const canProceed = sacState.selectedSacrifice && sacState.selectedUnlock;

  document.getElementById('sac-content').innerHTML = `
    <div class="sac-header">
      <button class="sac-back-btn" id="sac-back">◀ BACK</button>
      <div class="sac-title">⚠ SACRIFICE CHAMBER</div>
      <div class="sac-warning">ACTIONS TAKEN HERE ARE PERMANENT AND CANNOT BE UNDONE</div>
    </div>
    <div class="sac-columns">
      <div class="sac-panel">
        <div class="sac-panel-title red">SACRIFICE</div>
        <div class="sac-panel-sub">Choose a system to permanently disable</div>
        <div class="sys-grid" id="sac-left">${leftCards}</div>
      </div>
      <div class="sac-divider">
        <div class="sac-arrow">→</div>
      </div>
      <div class="sac-panel">
        <div class="sac-panel-title gold">UNLOCK</div>
        <div class="sac-panel-sub">Choose a system to bring online</div>
        <div class="sys-grid" id="sac-right">${rightCards}</div>
      </div>
    </div>
    <div class="sac-footer">
      <button class="sac-proceed-btn${canProceed ? ' ready' : ''}" id="sac-proceed" ${canProceed?'':' disabled'}>
        PROCEED TO RITUAL
      </button>
    </div>
  `;

  document.getElementById('sac-back').addEventListener('click', closeChamber);
  document.getElementById('sac-left').addEventListener('click', e => {
    const card = e.target.closest('.sys-card');
    if (!card) return;
    sacState.selectedSacrifice = SYSTEMS.find(s => s.id === card.dataset.id) || null;
    sacState.selectedUnlock = null;
    KenteAudio.click();
    renderChamberSelect();
  });
  document.getElementById('sac-right').addEventListener('click', e => {
    const card = e.target.closest('.sys-card');
    if (!card) return;
    sacState.selectedUnlock = SYSTEMS.find(s => s.id === card.dataset.id) || null;
    KenteAudio.click();
    renderChamberSelect();
  });
  document.getElementById('sac-proceed').addEventListener('click', () => {
    if (canProceed) renderChamberConfirm();
  });
}

/* ── CONFIRM SCREEN ── */
function renderChamberConfirm() {
  const sac = sacState.selectedSacrifice;
  const unl = sacState.selectedUnlock;
  let countdown = 3;

  document.getElementById('sac-content').innerHTML = `
    <div class="sac-header">
      <button class="sac-back-btn" id="sac-back-confirm">◀ RECONSIDER</button>
      <div class="sac-title">⚠ CONFIRM THE RITUAL</div>
      <div class="sac-warning">THIS CANNOT BE UNDONE — ONLY A FACTORY RESET WILL RESTORE SACRIFICED SYSTEMS</div>
    </div>
    <div class="sac-confirm-panel">
      <div class="confirm-exchange">
        <div class="confirm-sys sacrifice">
          <div class="confirm-sys-label">YOU SACRIFICE</div>
          <div class="confirm-sys-icon">${sac.icon}</div>
          <div class="confirm-sys-name">${sac.name}</div>
          <div class="confirm-sys-tier">TIER ${sac.tier}</div>
        </div>
        <div class="confirm-arrow">⟶</div>
        <div class="confirm-sys unlock">
          <div class="confirm-sys-label">YOU UNLOCK</div>
          <div class="confirm-sys-icon">${unl.icon}</div>
          <div class="confirm-sys-name">${unl.name}</div>
          <div class="confirm-sys-tier">TIER ${unl.tier}</div>
        </div>
      </div>
      <div class="confirm-notice">
        <span class="confirm-skull">☠</span>
        ALL GAMES ASSOCIATED WITH <strong>${sac.name.toUpperCase()}</strong>
        WILL BE PERMANENTLY REMOVED FROM YOUR LIBRARY.
      </div>
      <button class="sac-commit-btn" id="sac-commit" disabled>
        INITIATING RITUAL IN <span id="commit-countdown">3</span>...
      </button>
    </div>
  `;

  const btn     = document.getElementById('sac-commit');
  const countEl = document.getElementById('commit-countdown');
  // Keep interval ID in a var that both the RECONSIDER handler and the
  // interval itself can reach, so whichever fires first cleans up properly.
  let interval = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(interval);
      interval = null;
      btn.disabled = false;
      btn.textContent = '☠  CONFIRM SACRIFICE  ☠';
      btn.classList.add('ready');
    } else {
      countEl.textContent = countdown;
    }
  }, 1000);

  document.getElementById('sac-back-confirm').addEventListener('click', () => {
    // Always kill the running countdown before navigating away so there is
    // never more than one active interval when the user reopens this screen.
    if (interval) { clearInterval(interval); interval = null; }
    KenteAudio.back(); renderChamberSelect();
  });

  btn.addEventListener('click', () => {
    if (!btn.disabled) startRitual();
  });
}

/* ── RITUAL ANIMATION ── */
function startRitual() {
  const sac = sacState.selectedSacrifice;
  const unl = sacState.selectedUnlock;

  document.getElementById('sac-content').innerHTML = `
    <div class="ritual-stage">
      <div class="ritual-red-pulse"></div>
      <div class="ritual-text" id="ritual-text">SACRIFICE PROTOCOL INITIATED</div>
      <div class="ritual-exchange">
        <div class="ritual-sys dying" id="ritual-sac">
          <div class="ritual-sys-icon">${sac.icon}</div>
          <div class="ritual-sys-name">${sac.name}</div>
        </div>
        <div class="ritual-bolt" id="ritual-bolt">⚡</div>
        <div class="ritual-sys incoming" id="ritual-unl">
          <div class="ritual-sys-icon">${unl.icon}</div>
          <div class="ritual-sys-name">${unl.name}</div>
        </div>
      </div>
      <div class="ritual-bar-wrap">
        <div class="ritual-bar" id="ritual-bar"></div>
      </div>
      <div class="ritual-status" id="ritual-status">PROCESSING...</div>
    </div>
  `;

  KenteAudio.ritualDrone();

  let progress = 0;
  const bar = document.getElementById('ritual-bar');
  const statusEl = document.getElementById('ritual-status');
  const textEl  = document.getElementById('ritual-text');

  const statuses = [
    [20,  'SEVERING SYSTEM BINDINGS...'],
    [45,  'ERASING EMULATOR CORE...'],
    [65,  'PURGING LIBRARY ENTRIES...'],
    [80,  'CHANNELING RESOURCES...'],
    [95,  'FINALIZING TRANSFER...'],
  ];
  const firedStatuses = new Set();

  const fill = setInterval(() => {
    progress = Math.min(100, progress + 0.6);
    bar.style.width = progress + '%';
    const pct = Math.floor(progress);
    const hit = statuses.find(([p]) => p === pct);
    if (hit && !firedStatuses.has(pct)) {
      firedStatuses.add(pct);
      statusEl.textContent = hit[1];
      KenteAudio.staticBurst();
    }
    if (progress >= 100) {
      clearInterval(fill);
      completeRitual(sac, unl, textEl, statusEl);
    }
  }, 18);
}

function completeRitual(sac, unl, textEl, statusEl) {
  KenteAudio.powerDown();

  // Apply state change
  const sacSys = SYSTEMS.find(s => s.id === sac.id);
  const unlSys = SYSTEMS.find(s => s.id === unl.id);
  if (sacSys) { sacSys.active = false; sacSys.sacrificed = true; }
  if (unlSys) { unlSys.active = true; }
  saveSystemState();

  // Kill the dying card
  const sacEl = document.getElementById('ritual-sac');
  if (sacEl) sacEl.classList.add('dead');

  setTimeout(() => {
    textEl.textContent  = `${sac.name.toUpperCase()} HAS BEEN SACRIFICED`;
    statusEl.textContent = 'SYSTEM OFFLINE — PERMANENTLY';
    textEl.style.color   = '#cc2222';

    setTimeout(() => {
      KenteAudio.powerUp();
      const unlEl = document.getElementById('ritual-unl');
      if (unlEl) unlEl.classList.add('online');
      textEl.textContent   = `${unl.name.toUpperCase()} IS NOW ONLINE`;
      statusEl.textContent = 'TRANSFER COMPLETE';
      textEl.style.color   = '#e8a000';

      setTimeout(() => renderChamberResult(sac, unl), 1800);
    }, 1600);
  }, 800);
}

/* ── RESULT SCREEN ── */
function renderChamberResult(sac, unl) {
  document.getElementById('sac-content').innerHTML = `
    <div class="sac-result">
      <div class="result-title">RITUAL COMPLETE</div>
      <div class="result-row">
        <div class="result-dead">
          <div class="result-label">SACRIFICED</div>
          <div class="result-name struck">${sac.name}</div>
          <div class="result-badge offline">OFFLINE FOREVER</div>
        </div>
        <div class="result-arrow">⟶</div>
        <div class="result-live">
          <div class="result-label">UNLOCKED</div>
          <div class="result-name glow">${unl.name}</div>
          <div class="result-badge online">NOW AVAILABLE</div>
        </div>
      </div>
      <div class="result-note">
        Find <strong>${unl.name}</strong> in your PLAY library.<br>
        <strong>${sac.name}</strong> has been removed permanently.
      </div>
      <button class="sac-back-btn" id="result-done" style="margin-top:32px;padding:12px 32px">
        ◀ RETURN TO THE ROOM
      </button>
    </div>
  `;
  document.getElementById('result-done').addEventListener('click', () => {
    document.getElementById('sacrifice-screen').classList.remove('active');
    setScreen('room');
    state.screen = 'room';
    KenteAudio.setHumVol(0.018);
  });
}
