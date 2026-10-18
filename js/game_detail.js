/* Kente's Korner — Game detail panel, launch sequence, source detail. */
'use strict';

/* ══════════════════════════════════════════
   GAME DETAIL PANEL
══════════════════════════════════════════ */
function getFavorites() { try { return JSON.parse(localStorage.getItem('kente_favs')||'[]'); } catch{ return []; } }
function saveFavorites(favs) { localStorage.setItem('kente_favs', JSON.stringify(favs)); }

/* Recently-played ring — capped at 12 entries, most-recent first */
function getRecents() { try { return JSON.parse(localStorage.getItem('kente_recents')||'[]'); } catch{ return []; } }
function addRecentPlay(gameId) {
  const r = [gameId, ...getRecents().filter(id => id !== gameId)].slice(0, 12);
  try { localStorage.setItem('kente_recents', JSON.stringify(r)); } catch {}
}

/* Recently-downloaded shelf — sourced from DownloadManager.
   Returns up to `limit` library game objects, most-recent completion first,
   deduped by gameId. Falls back to a minimal shim when the download's game
   isn't in the active library (e.g. a system was re-sacrificed). */
function getRecentDownloads(limit = 8) {
  if (typeof DownloadManager === 'undefined') return [];
  const items = DownloadManager.getAll()
    .filter(i => i.status === 'complete' && i.game && i._dlAt)
    .sort((a, b) => (b._dlAt || 0) - (a._dlAt || 0));
  const lib = window.KenteLibrary?.games || [];
  const out = []; const seen = new Set();
  for (const it of items) {
    const gid = it.game.id;
    if (!gid || seen.has(gid)) continue;
    seen.add(gid);
    const g = lib.find(x => x.id === gid) || {
      id: gid, title: it.game.title || it.filename || gid,
      systemId: it.game.systemId || 'unknown',
      system:   it.game.system   || (it.game.systemId || '').toUpperCase(),
      year: it.game.year || '', tags: [],
    };
    // Stamp the DownloadManager item id so the shelf card can route directly
    // to launchFromDownloadCenter even when the game isn't in the active
    // library (e.g. its system was sacrificed after the download finished).
    out.push({ ...g, _dlId: it.id });
    if (out.length >= limit) break;
  }
  return out;
}

/* Re-render the Recently Downloaded shelf in-place when a download completes
   while the user is browsing Play or Collections. If the menu isn't open or
   the shelf section doesn't exist yet, full-rebuild via openMenu() on next
   navigation will pick it up — so this is a best-effort live update. */
function _refreshRecentDownloadsShelf() {
  if (state.screen !== 'menu') return;
  const id = state.activeMenu;
  if (id !== 'play' && id !== 'collections') return;
  const contentEl = document.querySelector(`#menu-${id} #content-${id}`);
  if (!contentEl || !CONTENT_FNS[id]) return;
  contentEl.innerHTML = CONTENT_FNS[id]();
  refreshGameCardDots();
  requestAnimationFrame(() => GamepadManager.applyFocus(0));
}

function toggleFavorite(gameId) {
  const favs   = getFavorites();
  const idx    = favs.indexOf(gameId);
  if (idx >= 0) favs.splice(idx, 1); else favs.push(gameId);
  saveFavorites(favs);
  KenteAudio.click();
  const nowFav = idx < 0;
  // Refresh detail panel button
  const btn = document.querySelector('.gdp-fav-btn');
  if (btn) { btn.classList.toggle('active', nowFav); btn.textContent = nowFav ? '★ FAVORITED' : '☆ FAVORITE'; }
  // Refresh favorite star on every visible game card that matches
  document.querySelectorAll(`.game-card[data-id="${gameId}"] .game-card-fav-star`).forEach(star => {
    star.classList.toggle('active', nowFav);
    star.title = nowFav ? 'FAVORITED' : 'ADD TO FAVORITES';
  });
}

// Monotonic token bumped every open/close so async ROM lookups can detect
// they've been superseded and skip mutating a row that no longer matches.
let _gdpOpenToken = 0;

function openGameDetail(gameId) {
  const lib = window.KenteLibrary;
  const g   = lib?.games.find(g => g.id === gameId);
  if (!g) return;
  _gdpOpenToken++;
  KenteAudio.click();

  const colors = (lib.systemColors || {})[g.systemId] || ['#1a1a2e','#0a0a18'];
  const isFav  = getFavorites().includes(g.id);
  const tv     = TV_ZONES.find(t => t.id === state.activeMenu);
  const accent = tv?.accent || 'var(--brand)';

  // ROM status for the detail panel
  const isFlashGdp  = g.systemId === 'flash';
  const romFound    = isFlashGdp || KENTE_SERVER_ONLINE || !!ROM_STATUS[g.id];
  const romStatus   = isFlashGdp ? 'STREAMING (FLASH)' : (romFound ? 'ROM IN LIBRARY' : 'NOT IN LIBRARY');
  const romColor    = (isFlashGdp || romFound) ? 'var(--green)' : 'var(--text-dim)';

  document.getElementById('gdp-inner').innerHTML = `
    <div class="gdp-cover" style="background:linear-gradient(135deg,${colors[0]},${colors[1]})">
      <img class="gdp-cover-art" src="boxart/${g.id}.jpg" alt="${escHtml(g.title)}"
        onerror="this.style.display='none'"
        onload="this.style.display='block';this.closest('.gdp-cover').classList.add('has-boxart')"
        style="display:none">
      <div class="gdp-cover-overlay"></div>
      <div class="gdp-cover-text">
        <div class="gdp-cover-sys">${escHtml(g.system)} · TIER ${g.tier}</div>
        <div class="gdp-cover-title">${escHtml(g.title)}</div>
        <div class="gdp-cover-year">${escHtml(g.year)} · ${escHtml(g.developer)}</div>
      </div>
      <button class="gdp-close" id="gdp-close">✕</button>
    </div>
    <div class="gdp-body">
      <div class="gdp-meta">
        <div class="gdp-meta-row"><span>DEVELOPER</span><span>${escHtml(g.developer)}</span></div>
        <div class="gdp-meta-row"><span>YEAR</span><span>${escHtml(g.year)}</span></div>
        <div class="gdp-meta-row"><span>PLAYERS</span><span>${escHtml(String(g.players))}</span></div>
        <div class="gdp-meta-row"><span>GENRE</span><span>${g.genre.map(escHtml).join(' · ')}</span></div>
        <div class="gdp-meta-row"><span>ROM</span><span style="color:${romColor}">${romStatus}</span></div>
      </div>
      <div class="gdp-desc">${escHtml(g.desc)}</div>
      <div class="gdp-tags">${g.tags.map(t=>`<span class="gdp-tag">${escHtml(t)}</span>`).join('')}</div>
      <div class="gdp-actions">
        <button class="gdp-launch-btn" style="background:${accent}" data-gameid="${g.id}">▶  LAUNCH GAME</button>
        <div class="gdp-secondary-actions">
          <button class="gdp-fav-btn ${isFav?'active':''}" data-gameid="${g.id}">${isFav?'★ FAVORITED':'☆ FAVORITE'}</button>
          <button class="gdp-secondary-btn" id="gdp-preview-btn">▶ PREVIEW</button>
          <button class="gdp-secondary-btn" id="gdp-manual-btn">📖 MANUAL</button>
          ${g.hasMods ? `<button class="gdp-secondary-btn" id="gdp-mods-btn" style="border-color:var(--brand);color:var(--brand)">🎨 MODS</button>` : ''}
          <button class="gdp-secondary-btn" id="gdp-pin-btn">${_getZonePinLabel(g.id)}</button>
        </div>
      </div>
      ${!isFlashGdp ? `
      <div class="gdp-rom-mgmt">
        <div class="gdp-rom-mgmt-title">ROM MANAGEMENT</div>
        <div id="gdp-rom-status-row" class="gdp-rom-status-row">
          <span style="color:var(--text-dim);font-size:11px">Checking library…</span>
        </div>
      </div>` : ''}
    </div>`;

  const panel = document.getElementById('game-detail-panel');
  panel.style.setProperty('--menu-accent', accent);
  panel.classList.add('open');
  panel.querySelector('#gdp-close').addEventListener('click', closeGameDetail);
  panel.querySelector('.gdp-launch-btn').addEventListener('click', () => launchGame(g));
  panel.querySelector('.gdp-fav-btn').addEventListener('click', () => toggleFavorite(g.id));
  // Preview — opens YouTube search for a trailer
  panel.querySelector('#gdp-preview-btn').addEventListener('click', () => {
    const q = encodeURIComponent(`${g.title} ${g.system} trailer gameplay`);
    window.open(`https://www.youtube.com/results?search_query=${q}`, '_blank', 'noopener');
  });
  // Manual — opens GameFAQs search
  panel.querySelector('#gdp-manual-btn').addEventListener('click', () => {
    const q = encodeURIComponent(g.title);
    window.open(`https://gamefaqs.gamespot.com/search?game=${q}`, '_blank', 'noopener');
  });
  // Mods — opens the mod manager (only present for hasMods games)
  panel.querySelector('#gdp-mods-btn')?.addEventListener('click', () => showModManager(g));
  // Pin to TV zone
  panel.querySelector('#gdp-pin-btn')?.addEventListener('click', () => showZonePinPicker(g, panel.querySelector('#gdp-pin-btn')));
  // Async: populate ROM management section
  if (!isFlashGdp) _loadGdpRomSection(g.id);
  requestAnimationFrame(() => GamepadManager.applyFocus(0));
}

/** Returns the correct label for the pin button based on current pin state */
function _getZonePinLabel(gameId) {
  const pins = getZonePins();
  const pinned = Object.entries(pins).find(([, gid]) => gid === gameId);
  if (pinned) {
    const zone = TV_ZONES.find(z => z.id === pinned[0]);
    return `📌 PINNED TO ${zone?.label || pinned[0].toUpperCase()}`;
  }
  return '📌 PIN TO TV';
}

/** Async: populates the #gdp-rom-status-row with stored ROM info + controls */
async function _loadGdpRomSection(gameId) {
  const row = document.getElementById('gdp-rom-status-row');
  if (!row) return;
  const token = _gdpOpenToken;
  const meta = await RomDB.getMeta(gameId);
  // Bail if the panel was closed or re-opened for a different game while
  // RomDB.getMeta was in flight — otherwise we'd write into a stale row.
  if (token !== _gdpOpenToken) return;
  if (meta?.handle) {
    const date = meta.savedAt ? new Date(meta.savedAt).toLocaleDateString() : '—';
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="color:var(--green);font-size:11px">✓ ${meta.fileName || 'ROM'}</span>
        <span style="color:var(--text-dim);font-size:10px">saved ${date}</span>
        <button id="gdp-rom-remove" style="margin-left:auto;padding:3px 10px;font-size:10px;
          background:none;border:1px solid #c0392b;color:#c0392b;border-radius:3px;cursor:pointer">
          ✕ REMOVE
        </button>
      </div>`;
    row.querySelector('#gdp-rom-remove').addEventListener('click', async () => {
      await RomDB.remove(gameId);
      ROM_STATUS[gameId] = false;
      refreshGameCardDots();
      showToast('ROM removed from library');
      row.innerHTML = `<span style="color:var(--text-dim);font-size:11px">Not in library</span>`;
    });
  } else {
    row.innerHTML = `<span style="color:var(--text-dim);font-size:11px">Not in library — use SOURCES to download</span>`;
  }
}

function closeGameDetail() {
  document.getElementById('game-detail-panel').classList.remove('open');
  // Bump the token so any in-flight _loadGdpRomSection bails before mutating
  // a row that's about to be torn down.
  _gdpOpenToken++;
  // Drop child nodes (and their event listeners) from the inner panel so the
  // browser can reclaim them promptly instead of waiting for the next open.
  const inner = document.getElementById('gdp-inner');
  if (inner) inner.innerHTML = '';
  GamepadManager.resetFocus();
}

/* ── LAUNCH SEQUENCE ── */
// Flag that blocks re-entrant launches (rapid double-click / gamepad double-press).
// Always reset in the `finally` block so an error never permanently locks the UI.
let _launchInProgress = false;

async function launchGame(g) {
  // Prevent launching a second game while one is already loading or playing.
  // state.screen === 'playing' / 'paused' = emulator is live;
  // _launchInProgress = true             = async launch sequence is in flight.
  if (state.screen === 'playing' || state.screen === 'paused') return;
  if (_launchInProgress) return;
  _launchInProgress = true;
  try {

  closeGameDetail();
  KenteAudio.click();
  addRecentPlay(g.id);  // track for Recently Played shelf

  // Theater audio collision — pause anything currently playing so the
  // emulator's audio isn't fighting an active stream / iframe in the
  // background. The user can re-open the title from Continue Watching.
  _silenceTheaterForLaunch();

  // ── Discord Rich Presence: set "Playing <game>" ─────────────────────────
  window.electronAPI?.setDiscordPresence?.({
    details:        g.title,
    state:          `${g.system} \u00B7 TIER ${g.tier}`,
    startTimestamp: Date.now(),
    largeImageKey:  'kente-icon',
    largeImageText: "Kente's Korner",
    smallImageKey:  g.systemId,
    smallImageText: g.system,
    instance:       false,
  });

  // ── Native desktop exe (Windows) or Linux run.sh (Linux / WSL) ──
  // Preferred over the Ruffle iframe when the server is reachable.
  // Windows  → nativeExe (.exe)       | Linux → nativeExeLinux (run.sh via bash)
  // Windows + no .exe but has Linux   → WSL launch
  const canNativeWin   = g.nativeExe      && serverPlatform === 'Windows';
  const canNativeLin   = g.nativeExeLinux && serverPlatform === 'Linux';
  const canWSL         = g.nativeExeLinux && serverPlatform === 'Windows' && !g.nativeExe;
  if (canNativeWin || canNativeLin || canWSL) { launchNativeApp(g); return; }

  // ── Flash games: Ruffle iframe — no ROM or server needed ──
  if (g.systemId === 'flash') { launchFlashGame(g); return; }

  // ── Routing decision ──────────────────────────────────────────────────────────
  // On real Batocera (serverIsBatocera=true): ALL systems use the native emulator
  // launcher for best performance and compatibility — Batocera manages everything.
  //
  // On a dev machine (serverIsBatocera=false): CORE_MAP systems use EmulatorJS so
  // the developer can test them without real hardware. For native-only systems
  // (PS2, GameCube, etc.) with no CDN core — Dreamcast now plays via flycast-wasm:
  //   • Server reachable  → search Archive.org and download the ROM locally
  //   • Server offline    → show "NATIVE MODE REQUIRED" dead-end screen
  if (serverIsBatocera) { launchNative(g); return; }

  // Not on real Batocera — systems with no WebAssembly core cannot run in browser
  if (!CORE_MAP[g.systemId]) {
    // If the ROM was already downloaded, hand off to launchFromDownloadCenter so
    // the correct Batocera / OPFS / archive chain runs — same as clicking ▶ LAUNCH.
    const dlItem = DownloadManager.getAll().find(i => i.game?.id === g.id && i.status === 'complete');
    if (dlItem) { launchFromDownloadCenter(dlItem.id); return; }

    if (KENTE_SERVER_ONLINE) {
      // Server is reachable on this (non-Batocera) machine.
      // launchNative() → /api/launch → find_rom() checks the local roms/ folder
      // first and opens with the installed emulator (Dolphin, PCSX2, etc.).
      // If the ROM isn't on disk yet it gets ROM_NOT_FOUND and falls back to
      // launchNativeFromCloud() which searches Archive.org and downloads it.
      launchNative(g);
    } else {
      showNativeModeRequired(g);
    }
    return;
  }

  // ── Browser path — EmulatorJS with File System Access ──
  // Check if we have a stored ROM handle for this game
  const handle = await RomDB.get(g.id);
  if (handle) {
    // Verify the handle still has read permission
    try {
      const perm = await handle.queryPermission?.({ mode: 'read' });
      if (perm === 'granted' || perm === undefined) {
        launchWithEmulatorJS(g, handle);
        return;
      }
      // Permission expired — request again
      const newPerm = await handle.requestPermission?.({ mode: 'read' });
      if (newPerm === 'granted') { launchWithEmulatorJS(g, handle); return; }
    } catch {
      await RomDB.remove(g.id);
    }
  }

  // No local ROM — check connectivity and decide
  const online = await checkOnline();
  if (online) {
    // Internet available → stream from cloud
    launchFromCloud(g);
  } else {
    // Offline and no local ROM → inform the user
    showToast('📡 NO NETWORK — ADD ROM TO LOCAL LIBRARY TO PLAY OFFLINE');
    showRomOptions(g);
  }
  // Note: _launchInProgress is cleared in the finally block below.
  // launchWithEmulatorJS / launchNative take over the overlay so
  // clearing on their completion (EJS_onGameStart, ROM_NOT_FOUND, etc.) is handled
  // by those functions; we just need to unblock the guard after dispatch.
  } finally {
    _launchInProgress = false;
  }
}

/* ── SOURCE DETAIL PANEL ── */

/** Format a stored epoch-ms timestamp into a human-readable relative string. */
function _formatScanTs(tsStr) {
  if (!tsStr) return 'NEVER';
  const elapsed = Date.now() - Number(tsStr);
  if (elapsed < 60_000)        return 'JUST NOW';
  if (elapsed < 3_600_000)     return `${Math.round(elapsed / 60_000)}M AGO`;
  if (elapsed < 86_400_000)    return `${Math.round(elapsed / 3_600_000)}H AGO`;
  return `${Math.round(elapsed / 86_400_000)}D AGO`;
}

function openSourceDetail(sourceName, icon, status, count) {
  KenteAudio.click();
  const lastScanned = status === 'local'
    ? _formatScanTs(localStorage.getItem('kente_scan_ts'))
    : '—';
  const isLocal = status === 'local';
  document.getElementById('sdp-inner').innerHTML = `
    <div class="sdp-header">
      <span class="sdp-icon">${icon}</span>
      <span class="sdp-title">${escHtml(sourceName)}</span>
      <button class="sdp-close" id="sdp-close">✕</button>
    </div>
    <div class="sdp-body">
      <div class="sdp-stat-row"><span>STATUS</span><span>${escHtml(status.toUpperCase())}</span></div>
      <div class="sdp-stat-row"><span>TITLES INDEXED</span><span>${count}</span></div>
      <div class="sdp-stat-row"><span>LAST SCANNED</span><span>${lastScanned}</span></div>
      ${isLocal ? `<div class="sdp-stat-row"><span>AUTO-SCAN</span><span>OFF</span></div>
      <button class="sdp-action-btn" id="sdp-action-btn" style="margin-top:8px">↺ SCAN ROM FOLDER</button>`
      : `<p style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);
           letter-spacing:0.1em;line-height:1.8;margin-top:14px">
           EXTERNAL SOURCE DETECTED.<br>
           BROWSE ITS FILES THROUGH YOUR OS<br>
           OR USE THE ⚡ CLOUD BROWSER TO<br>
           STREAM AND SAVE ROMS DIRECTLY.</p>`}
    </div>`;
  const panel = document.getElementById('source-detail-panel');
  panel.classList.add('open');
  document.getElementById('sdp-close').addEventListener('click', () => panel.classList.remove('open'));

  document.getElementById('sdp-action-btn')?.addEventListener('click', () => {
    panel.classList.remove('open');
    if ('showDirectoryPicker' in window) {
      scanRomFolder();
    } else {
      showToast('⚠ FOLDER SCANNING REQUIRES CHROME OR EDGE');
    }
  });
}
