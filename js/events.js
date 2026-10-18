/* Kente's Korner — Library filters and global click delegation. */
'use strict';

/* Unified Play / Collections filter — composes the active chip selector with
   the search-input value so typing narrows results without unsticking the
   chip filter (and vice-versa). Called from both the chip click handler and
   the search-input listener below. */
function _applyLibraryFilters(scope) {
  if (scope === 'play') {
    const activeChip = document.querySelector('#play-filter-bar .filter-chip.active');
    const sys   = (activeChip?.dataset.system) || 'all';
    const term  = (document.getElementById('play-search')?.value || '').trim().toLowerCase();
    document.querySelectorAll('#play-grid .game-card').forEach(card => {
      const sysOk = (sys === 'all' || card.dataset.system === sys);
      const txtOk = !term || (card.dataset.title || '').toLowerCase().includes(term);
      card.style.display = (sysOk && txtOk) ? '' : 'none';
    });
    return;
  }
  if (scope === 'col') {
    const activeChip = document.querySelector('#col-filter-bar .filter-chip.active');
    const col   = (activeChip?.dataset.col) || 'all';
    const term  = (document.getElementById('col-search')?.value || '').trim().toLowerCase();
    const favSet = (col === 'favorites') ? new Set(getFavorites()) : null;
    document.querySelectorAll('#col-grid .game-card').forEach(card => {
      let chipOk;
      if (col === 'all' || col === 'az') chipOk = true;
      else if (col === 'favorites')      chipOk = favSet.has(card.dataset.id);
      else                                chipOk = (card.dataset.col || '').split(' ').includes(col);
      const txtOk = !term || (card.dataset.title || '').toLowerCase().includes(term);
      card.style.display = (chipOk && txtOk) ? '' : 'none';
    });
  }
}

/* Search input — live-filter the Play / Collections grids while typing. */
document.addEventListener('input', e => {
  if (e.target.id === 'play-search') _applyLibraryFilters('play');
  else if (e.target.id === 'col-search') _applyLibraryFilters('col');
});

/* ══════════════════════════════════════════
   GLOBAL CLICK DELEGATION
══════════════════════════════════════════ */
document.addEventListener('click', e => {
  // ── Theater poster cards (Netflix-style detail open) ──
  const theaterPoster = e.target.closest('.theater-poster');
  if (theaterPoster) {
    KenteAudio.click();
    const { provider, kind, slug, title } = theaterPoster.dataset;
    if (provider && slug) openTheaterDetail(provider, kind || 'movie', slug, title);
    return;
  }

  // ── Game cards ──
  const gameCard = e.target.closest('.game-card[data-id]');
  if (gameCard && !e.target.closest('#game-detail-panel')) {
    const gid   = gameCard.dataset.id;
    const dlId  = gameCard.dataset.dlId;
    const inLib = !!window.KenteLibrary?.games.find(g => g.id === gid);
    // Recently Downloaded shelf cards stamp data-dl-id so a download whose
    // game isn't in the active library (e.g. its system was sacrificed) can
    // still launch directly through the DownloadManager pipeline instead of
    // hitting openGameDetail's silent early-return.
    if (!inLib && dlId) { launchFromDownloadCenter(dlId); return; }
    openGameDetail(gid); return;
  }

  // ── Source cards ──
  const srcCard = e.target.closest('.source-card[data-src]');
  if (srcCard) {
    openSourceDetail(srcCard.dataset.name, srcCard.dataset.icon, srcCard.dataset.status, Number(srcCard.dataset.count));
    return;
  }

  // ── Filter chips ──
  if (e.target.classList.contains('filter-chip')) {
    KenteAudio.click();
    const bar = e.target.closest('.filter-bar');
    if (bar) bar.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    e.target.classList.add('active');
    if (bar?.id === 'play-filter-bar') {
      _applyLibraryFilters('play');
    }
    if (bar?.id === 'col-filter-bar') {
      const col   = e.target.dataset.col || 'all';
      const strip = document.getElementById('col-info-strip');
      const grid  = document.getElementById('col-grid');

      // Restore original DOM order before every filter operation so
      // switching away from A-Z (or between collections) always starts clean.
      if (grid) {
        [...grid.children]
          .sort((a, b) => Number(a.dataset.origIdx || 0) - Number(b.dataset.origIdx || 0))
          .forEach(c => grid.appendChild(c));
      }

      if (col === 'az') {
        // Sort the DOM nodes alphabetically by title; visibility is then
        // resolved by _applyLibraryFilters (which honours the search term).
        if (grid) {
          [...grid.children]
            .sort((a, b) => (a.dataset.title || '').localeCompare(b.dataset.title || ''))
            .forEach(c => grid.appendChild(c));
        }
        if (strip) {
          const total = grid ? grid.childElementCount : 0;
          strip.hidden = false;
          strip.innerHTML = `
            <span class="col-info-icon">🔤</span>
            <div class="col-info-text">
              <div class="col-info-name">A–Z</div>
              <div class="col-info-desc">ALL TITLES SORTED ALPHABETICALLY · ${total} GAME${total !== 1 ? 'S' : ''}</div>
            </div>`;
        }
      } else if (col === 'favorites') {
        if (strip) {
          const favCount = getFavorites().length;
          strip.hidden = false;
          strip.innerHTML = `
            <span class="col-info-icon">★</span>
            <div class="col-info-text">
              <div class="col-info-name">FAVORITES</div>
              <div class="col-info-desc">YOUR STARRED GAMES · ${favCount} TITLE${favCount !== 1 ? 'S' : ''}</div>
            </div>`;
        }
      } else {
        // Info strip — hide for ALL, show details for a specific collection
        if (strip) {
          if (col === 'all') {
            strip.hidden = true;
          } else {
            // dataset read-back decodes HTML entities (e.g. &quot; → "), so
            // re-escape before injecting into innerHTML.
            const { colIcon: icon, colName: name, colDesc: desc, colCount: count } = e.target.dataset;
            strip.hidden = false;
            strip.innerHTML = `
              <span class="col-info-icon">${escHtml(icon)}</span>
              <div class="col-info-text">
                <div class="col-info-name">${escHtml(name)}</div>
                <div class="col-info-desc">${escHtml(desc)} · ${escHtml(count)} TITLE${Number(count)!==1?'S':''}</div>
              </div>`;
          }
        }
      }
      _applyLibraryFilters('col');
    }
    // Theater chips are wired in hydrateTheaterMenu() — leave them alone here.
    return;
  }

  // ── Interactive settings items ──
  const settingItem = e.target.closest('.settings-item[data-setting]');
  if (settingItem) {
    const key  = settingItem.dataset.setting;
    const type = settingItem.dataset.type;
    if (type === 'toggle') {
      appSettings[key] = !appSettings[key];
    } else if (type === 'cycle') {
      const opts = JSON.parse(settingItem.dataset.opts);
      const cur  = opts.indexOf(appSettings[key]);
      appSettings[key] = opts[(cur + 1) % opts.length];
    }
    saveSettings();
    applySetting(key);
    KenteAudio.click();
    // Refresh just this value
    const valEl = settingItem.querySelector('.settings-item-value');
    const cfg   = SETTINGS_CONFIG.flatMap(g=>g.items).find(i=>i.key===key);
    if (valEl && cfg) {
      const v = appSettings[key];
      valEl.textContent = cfg.type === 'toggle' ? (v?'ON':'OFF') : (typeof v==='number' ? v+'%' : v);
    }
    return;
  }

  // ── Network action items ──
  const netItem = e.target.closest('[data-net-action]');
  if (netItem) {
    const na = netItem.dataset.netAction;
    if (na === 'scan')       { KenteAudio.click(); wifiScanAndShow(); return; }
    if (na === 'disconnect') { KenteAudio.click(); wifiDisconnect(); return; }
    if (na === 'refresh')    { KenteAudio.click(); hydrateNetworkStatus(); return; }
  }
  // ── WiFi network list item click ──
  const wifiItem = e.target.closest('.wifi-item');
  if (wifiItem) {
    KenteAudio.click();
    wifiConnect(wifiItem.dataset.ssid, wifiItem.dataset.secured === '1');
    return;
  }

  // ── Settings action items ──
  const actionItem = e.target.closest('[data-action]');
  if (actionItem) {
    const action = actionItem.dataset.action;
    if (action === 'openChamber') openChamber();
    if (action === 'resetSystems') {
      if (confirm('Factory reset all sacrificed systems? This cannot be undone.')) {
        resetSystemState();
        showToast('✓ SYSTEMS RESTORED TO FACTORY DEFAULT');
      }
    }
    if (action === 'addSource') {
      KenteAudio.click();
      // Custom source linking is a planned V2 feature.
      // For now, direct the user to the Cloud Browser — the current way to
      // stream and save ROMs from Archive.org without any local source config.
      showToast('⚡ USE THE CLOUD BROWSER TO ADD ROMS — OPEN IT FROM ANY GAME ZONE');
    }
    if (action === 'openCloud') {
      KenteAudio.click();
      openCloudBrowser(actionItem.dataset.provider || 'archive');
    }
    if (action === 'setLibrary') {
      KenteAudio.click();
      setRomLibraryRoot(); // async, fire-and-forget — shows its own toast on complete
    }
    if (action === 'openDownloads') {
      openDownloadCenter();
    }
    if (action === 'openKenteRepo') {
      openKenteRepo();
    }
    if (action === 'calibrate') {
      KenteAudio.click();
      CalibrationManager.open();
    }
    if (action === 'usbGuide') {
      KenteAudio.click();
      openGuide('usb');
    }
    if (action === 'ps4Guide') {
      KenteAudio.click();
      openGuide('ps4');
    }
  }

  // ── Generic launch-overlay dismiss (covers showNativeModeRequired + any unnamed dismiss btn) ──
  if (e.target.classList.contains('launch-dismiss')) {
    document.getElementById('launch-overlay')?.classList.remove('active');
    return;
  }

  // ── Download Control Center panel buttons ──
  const dlAction = e.target.dataset.dlaction;
  const dlId     = e.target.dataset.dlid;
  if (dlAction) {
    if (dlAction === 'clearCompleted') { DownloadManager.clearCompleted(); return; }
    if (dlId) {
      if (dlAction === 'cancel')      { DownloadManager.cancel(dlId);      return; }
      if (dlAction === 'remove')      { DownloadManager.remove(dlId);      return; }
      if (dlAction === 'retry')       { DownloadManager.retry(dlId);       return; }
      if (dlAction === 'cycleSource') { DownloadManager.cycleSource(dlId); return; }
      if (dlAction === 'launch')      { launchFromDownloadCenter(dlId);    return; }
    }
  }

  // ── In-game pause menu ──
  if (e.target.closest('#igm-resume')) {
    KenteAudio.click();
    hideIngameMenu();
    return;
  }
  if (e.target.closest('#igm-close')) {
    KenteAudio.click();
    closeGame();
    return;
  }
  if (e.target.closest('#igm-mainmenu')) {
    KenteAudio.click();
    exitEmulator();
    return;
  }

  // ── Memory Card profile selection ──
  const profCard = e.target.closest('.profile-card');
  if (profCard) {
    KenteAudio.click();
    state.activeProfile = profCard.dataset.profile || 'player1';
    document.querySelectorAll('.profile-card').forEach(c =>
      c.classList.toggle('active', c.dataset.profile === state.activeProfile)
    );
    try { localStorage.setItem('kente_profile', state.activeProfile); } catch {}
    showToast(`✓ PROFILE: ${(profCard.querySelector('.profile-name')?.textContent || state.activeProfile).toUpperCase()}`);
  }
});
