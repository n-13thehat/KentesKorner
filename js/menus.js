/* Kente's Korner — Menu content rendering (play, collections, sources, memory card). */
'use strict';

/* ══════════════════════════════════════════
   MENU CONTENT RENDERING
══════════════════════════════════════════ */
function renderAllMenus() {
  TV_ZONES.forEach(tv => {
    const el = document.getElementById('menu-' + tv.id);
    if (!el) return;
    el.style.setProperty('--menu-accent', tv.accent);
    el.innerHTML = buildMenuShell(tv) + buildMenuContent(tv);
    el.querySelector('.menu-back-btn')?.addEventListener('click', closeMenu);
    el.appendChild(buildCRTOverlay());
  });
}

function buildCRTOverlay() {
  const d = document.createElement('div');
  d.className = 'crt-overlay';
  return d;
}

function buildMenuShell(tv) {
  return `
    <div class="menu-header">
      <button class="menu-back-btn">◀ BACK</button>
      <div class="menu-title">${tv.icon} ${tv.label}</div>
      <div class="menu-subtitle">${tv.desc.toUpperCase()}</div>
    </div>
    <div class="menu-content" id="content-${tv.id}">
  `;
}

function buildMenuContent(tv) {
  const fn = CONTENT_FNS[tv.id];
  return (fn ? fn() : '') + '</div>';
}

/* ── PLAY MENU ── */
function getActiveGames() {
  const lib = window.KenteLibrary;
  if (!lib) return [];
  const activeSysIds = new Set(SYSTEMS.filter(s => s.active && !s.sacrificed).map(s => s.id));
  // Flash games always included — stream via Ruffle, no ROM or system unlock required.
  // Native games (nativeExe / nativeExeLinux) always included — launched directly by the OS,
  // not gated behind a SYSTEMS tier; launchGame() handles the exe/platform check first.
  return lib.games.filter(g => g.systemId === 'flash' || g.systemId === 'native' || activeSysIds.has(g.systemId));
}

function gameCard(g, extraStyle = '', extraAttrs = '') {
  const colors      = (window.KenteLibrary?.systemColors || {})[g.systemId] || ['#1a1a2e','#0a0a18'];
  const isFlash     = g.systemId === 'flash';

  // A game needs native mode when it has no confirmed EmulatorJS CDN core.
  const needsNative = !isFlash && !CORE_MAP[g.systemId];

  // ROM availability dot — green when the user can play, grey when ROM is missing
  const hasRom    = isFlash || KENTE_SERVER_ONLINE || !!ROM_STATUS[g.id];
  const dotActive = isFlash || KENTE_SERVER_ONLINE || Object.keys(ROM_STATUS).length > 0;
  const dotClass  = dotActive ? (hasRom ? 'game-card-rom-dot found' : 'game-card-rom-dot') : 'game-card-rom-dot hidden';

  // NATIVE badge — shown on cards that can't run in browser mode
  const nativeBadge = needsNative
    ? `<div class="game-card-native-badge" title="REQUIRES NATIVE MODE (KENTE SERVER)">⚙ NATIVE</div>`
    : '';

  // Favorite star — gold when the game is in the favorites list
  const isFav   = getFavorites().includes(g.id);
  const favStar = `<div class="game-card-fav-star${isFav ? ' active' : ''}" title="${isFav ? 'FAVORITED' : 'ADD TO FAVORITES'}">★</div>`;

  // Box art — priority: server URL (auto-fetches online if needed) → local file → gradient
  // When server is online the /boxart/<id> endpoint serves cached files instantly
  // OR fetches from SteamGridDB/TheGamesDB on first request and caches to disk.
  // onerror cascades: server fail → local file → hide (show gradient fallback).
  const _artLocal  = `boxart/${g.id}.jpg`;
  const _artServer = `${KENTE_SERVER_URL}/boxart/${g.id}?title=${encodeURIComponent(g.title)}&sys=${g.systemId}`;
  const _artSrc    = KENTE_SERVER_ONLINE ? _artServer : _artLocal;
  const _artFallback = KENTE_SERVER_ONLINE
    ? `if(this.src.indexOf('localhost')>-1){this.src='${_artLocal}'}else{this.style.display='none'}`
    : `this.style.display='none'`;
  const artImg = `<img class="game-card-boxart" src="${_artSrc}" alt="${escHtml(g.title)}"
        loading="lazy"
        onerror="${_artFallback}"
        onload="this.style.display='block';this.closest('.game-card-art').classList.add('has-boxart')"
        style="display:none">`;

  return `
    <div class="game-card${needsNative ? ' native-only' : ''}" data-id="${g.id}" data-system="${g.systemId}" ${extraAttrs} style="${extraStyle}">
      <div class="game-card-art" style="background:linear-gradient(135deg,${colors[0]},${colors[1]})">
        ${artImg}
        <div class="game-card-cover">
          <div class="game-card-cover-sys">${g.system}</div>
          <div class="game-card-cover-title">${escHtml(g.title)}</div>
          <div class="game-card-cover-year">${g.year}</div>
        </div>
        ${nativeBadge}
        <div class="${dotClass}" title="${hasRom ? 'ROM IN LIBRARY' : 'ROM NOT FOUND'}"></div>
        ${favStar}
      </div>
      <div class="game-card-info">
        <div class="game-card-title">${escHtml(g.title)}</div>
        <div class="game-card-system">${escHtml(g.system)} · ${escHtml(g.year)}</div>
      </div>
    </div>`;
}

function contentPlay() {
  const games = getActiveGames();
  if (!games.length) return `
    <div class="section-label">GAME LIBRARY — 0 TITLES</div>
    <p class="menu-empty">NO ACTIVE SYSTEMS. USE THE SACRIFICE CHAMBER TO UNLOCK MORE SYSTEMS.</p>`;

  const uniqueSystems = [...new Set(games.map(g => g.system))];
  const chips = ['ALL', ...uniqueSystems].map((s, i) => {
    const sid = i === 0 ? 'all' : games.find(g => g.system === s)?.systemId || '';
    return `<button class="filter-chip${i===0?' active':''}" data-system="${sid}">${s}</button>`;
  }).join('');

  // Recently Played shelf
  const recentIds   = getRecents();
  const recentGames = recentIds.map(id => games.find(g => g.id === id)).filter(Boolean);
  const recentShelf = recentGames.length ? `
    <div class="section-label">RECENTLY PLAYED</div>
    <div class="play-shelf-row" id="recents-shelf">
      ${recentGames.map(g => gameCard(g, 'width:120px;flex-shrink:0;aspect-ratio:3/4')).join('')}
    </div>` : '';

  // Recently Downloaded shelf — sourced from DownloadManager completions
  const dlGames = getRecentDownloads(8);
  const dlShelf = dlGames.length ? `
    <div class="section-label" style="display:flex;align-items:center">
      <span>RECENTLY DOWNLOADED</span>
      <button class="dl-clear-btn" data-dlaction="clearCompleted" title="Clear download history">CLEAR</button>
    </div>
    <div class="play-shelf-row" id="recent-dl-shelf">
      ${dlGames.map(g => gameCard(g, 'width:120px;flex-shrink:0;aspect-ratio:3/4',
        g._dlId ? `data-dl-id="${escHtml(g._dlId)}"` : '')).join('')}
    </div>` : '';

  // Favorites shelf
  const favIds   = getFavorites();
  const favGames = favIds.map(id => games.find(g => g.id === id)).filter(Boolean);
  const favShelf = favGames.length ? `
    <div class="section-label">FAVORITES</div>
    <div class="play-shelf-row" id="favs-shelf">
      ${favGames.map(g => gameCard(g, 'width:120px;flex-shrink:0;aspect-ratio:3/4')).join('')}
    </div>` : '';

  return `
    ${recentShelf}${dlShelf}${favShelf}
    <div class="section-label">GAME LIBRARY — ${games.length} TITLE${games.length!==1?'S':''} ACTIVE</div>
    <div class="filter-bar" id="play-filter-bar">${chips}
      <input type="search" class="library-search" id="play-search"
             placeholder="SEARCH TITLES…" autocomplete="off" spellcheck="false">
    </div>
    <div class="game-grid" id="play-grid">${games.map(g => gameCard(g, '',
      `data-title="${escHtml(g.title)}"`)).join('')}</div>`;
}

/* ── COLLECTIONS MENU ── */
function contentCollections() {
  const lib = window.KenteLibrary;
  if (!lib) return '<p class="menu-empty">LIBRARY NOT LOADED.</p>';
  const games = getActiveGames();
  if (!games.length) return `
    <div class="section-label">COLLECTIONS — 0 TITLES</div>
    <p class="menu-empty">NO ACTIVE SYSTEMS. UNLOCK MORE IN THE SACRIFICE CHAMBER.</p>`;

  // Only include collections that have at least one game
  const cols = lib.collections.filter(col => games.some(g => g.tags.includes(col.id)));

  // Filter chips — ALL GAMES, A–Z, ★ FAVORITES, then each collection
  const chips = [
    `<button class="filter-chip active" data-col="all">ALL GAMES</button>`,
    `<button class="filter-chip" data-col="az">A–Z</button>`,
    `<button class="filter-chip" data-col="favorites">★ FAVORITES</button>`,
    ...cols.map(col => {
      const count = games.filter(g => g.tags.includes(col.id)).length;
      // Escape all library-sourced values that end up in attribute values or
      // innerHTML so a collection name/desc containing " or < can't break the
      // attribute or inject markup when the strip reads from dataset.
      return `<button class="filter-chip"
        data-col="${escHtml(col.id)}"
        data-col-icon="${escHtml(col.icon)}"
        data-col-name="${escHtml(col.name)}"
        data-col-desc="${escHtml(col.desc)}"
        data-col-count="${escHtml(String(count))}">${escHtml(col.icon)} ${escHtml(col.name)}</button>`;
    }),
  ].join('');

  // Game cards — data-title and data-orig-idx allow A-Z sort + restore
  const cards = games.map((g, i) =>
    gameCard(g, '', `data-col="${g.tags.join(' ')}" data-title="${escHtml(g.title)}" data-orig-idx="${i}"`)
  ).join('');

  // Recently Downloaded shelf — sourced from DownloadManager completions
  const dlGames = getRecentDownloads(8);
  const dlShelf = dlGames.length ? `
    <div class="section-label" style="display:flex;align-items:center">
      <span>RECENTLY DOWNLOADED</span>
      <button class="dl-clear-btn" data-dlaction="clearCompleted" title="Clear download history">CLEAR</button>
    </div>
    <div class="play-shelf-row" id="col-recent-dl-shelf">
      ${dlGames.map(g => gameCard(g, 'width:120px;flex-shrink:0;aspect-ratio:3/4',
        g._dlId ? `data-dl-id="${escHtml(g._dlId)}"` : '')).join('')}
    </div>` : '';

  return `
    ${dlShelf}
    <div class="section-label">COLLECTIONS — ${games.length} TITLE${games.length!==1?'S':''} · ${cols.length} COLLECTION${cols.length!==1?'S':''}</div>
    <div class="filter-bar" id="col-filter-bar">${chips}
      <input type="search" class="library-search" id="col-search"
             placeholder="SEARCH TITLES…" autocomplete="off" spellcheck="false">
    </div>
    <div id="col-info-strip" class="col-info-strip" hidden></div>
    <div class="game-grid" id="col-grid">${cards}</div>`;
}

/* ── SOURCES MENU ── */
function contentSources() {
  const totalGames   = getActiveGames().length;
  const totalSystems = SYSTEMS.filter(s => s.active && !s.sacrificed).length;

  // ── ROM count from library scan ──
  const romCount   = Object.values(ROM_STATUS).filter(Boolean).length;
  const romTotal   = Object.keys(ROM_STATUS).length;
  const librarySet = romTotal > 0;

  // ── Built-in metadata catalog card (always present) ──
  const builtinCard = `
    <div class="source-card" data-src="1" data-name="BUILT-IN CATALOG" data-icon="📖" data-status="local" data-count="${totalGames}" style="cursor:pointer">
      <span class="source-card-icon">📖</span>
      <div class="source-card-name">BUILT-IN CATALOG</div>
      <div class="source-card-path">Metadata · ${totalGames} titles · ${totalSystems} systems</div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
        <div class="source-status local"><div class="source-status-dot"></div>INTERNAL</div>
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim)">${totalGames} TITLES</span>
      </div>
    </div>`;

  // ── ROM Library directory card (browser mode) ──
  const romLibCard = !KENTE_SERVER_ONLINE ? `
    <div class="source-card" id="rom-lib-card" style="cursor:pointer" data-action="setLibrary">
      <span class="source-card-icon">📂</span>
      <div class="source-card-name">ROM LIBRARY</div>
      <div class="source-card-path" id="rom-lib-path">
        ${librarySet ? `${romCount} / ${romTotal} ROMs INDEXED` : 'NOT CONFIGURED'}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
        <div class="source-status ${librarySet ? 'local' : 'offline'}">
          <div class="source-status-dot"></div>
          ${librarySet ? 'ACTIVE' : 'NOT SET'}
        </div>
        ${librarySet ? `<button class="sdp-action-btn" id="rom-lib-rescan"
          style="margin:0;padding:4px 10px;font-size:9px">↺ RESCAN</button>` : ''}
      </div>
    </div>` : '';

  // ── Physical drives section (native: hydrated; browser: stub) ──
  const liveSection = KENTE_SERVER_ONLINE
    ? `<div class="section-label">PHYSICAL DRIVES
         <span id="sources-scan-status" style="font-size:9px;color:var(--text-dim);margin-left:8px;letter-spacing:0.1em">SCANNING...</span>
       </div>
       <div class="source-grid" id="sources-live-grid">
         <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);letter-spacing:0.15em;padding:16px 0">READING DRIVES...</div>
       </div>`
    : '';

  return `
    <div class="section-label">CONNECTED SOURCES — ${totalSystems} SYSTEM${totalSystems!==1?'S':''} · ${totalGames} TITLES</div>
    <div class="source-grid">${builtinCard}${romLibCard}</div>
    ${liveSection}

    <div class="section-label">KENTE'S REPOSITORY</div>
    <div class="source-grid">
      <div class="source-card" data-action="openKenteRepo" style="cursor:pointer">
        <span class="source-card-icon">⭐</span>
        <div class="source-card-name">KENTE'S REPO</div>
        <div class="source-card-path">n-13thehat/KentesKorner</div>
        <div style="margin-top:8px">
          <div class="source-status local"><div class="source-status-dot" style="background:var(--brand)"></div>GITHUB · ROMS · EMULATORS</div>
        </div>
        <div class="source-card-repo-badge">PRESS R TO OPEN</div>
      </div>
    </div>

    <div class="section-label">ARCHIVE DOWNLOADS</div>
    <div class="source-grid">
      <div class="source-card" id="dl-count-card" data-action="openDownloads" style="cursor:pointer">
        <span class="source-card-icon">⬇</span>
        <div class="source-card-name">DOWNLOADED ROMS</div>
        <div class="source-card-path" id="dl-count-path">LOADING...</div>
        <div style="margin-top:8px">
          <div class="source-status local"><div class="source-status-dot"></div>ARCHIVE.ORG</div>
        </div>
      </div>
    </div>

    <div class="section-label">CLOUD PROVIDERS</div>
    <div class="source-grid">
      ${Object.values(CLOUD_PROVIDERS).map(p => `
        <div class="source-card" data-action="openCloud" data-provider="${p.id}" style="cursor:pointer">
          <span class="source-card-icon">${p.icon}</span>
          <div class="source-card-name">${p.name}</div>
          <div class="source-card-path">${p.desc}</div>
          <div style="margin-top:8px">
            <div class="source-status local"><div class="source-status-dot"></div>AVAILABLE</div>
          </div>
        </div>`).join('')}
      <div class="source-card" style="opacity:0.4;cursor:default">
        <span class="source-card-icon">☁️</span>
        <div class="source-card-name">KENTE CLOUD</div>
        <div class="source-card-path">Self-hosted cloud server</div>
        <div style="margin-top:8px">
          <div class="source-status offline"><div class="source-status-dot"></div>COMING SOON</div>
        </div>
      </div>
    </div>

    <div class="section-label">ADD SOURCE</div>
    <div class="source-grid">
      <div class="source-card" data-action="addSource" style="border-style:dashed;display:flex;align-items:center;justify-content:center;gap:10px;aspect-ratio:unset;padding:24px;cursor:pointer">
        <span style="font-size:20px;opacity:0.4">＋</span>
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);letter-spacing:0.15em">ADD NEW SOURCE</span>
      </div>
    </div>`;
}

async function hydrateSourcesMenu() {
  // ── Always: populate download count card ──
  const downloads  = await DownloadDB.getAll();
  const dlCountEl  = document.getElementById('dl-count-path');
  if (dlCountEl) {
    if (downloads.length === 0) {
      dlCountEl.textContent = 'NO ROMS DOWNLOADED YET';
    } else {
      const sysSet = new Set(downloads.map(d => d.systemId));
      dlCountEl.textContent = `${downloads.length} ROM${downloads.length !== 1 ? 'S' : ''} · ${sysSet.size} SYSTEM${sysSet.size !== 1 ? 'S' : ''}`;
    }
  }

  // ── Browser mode: populate ROM library card name + wire rescan ──
  if (!KENTE_SERVER_ONLINE) {
    const entry = await LibraryDB.getRoot();
    const pathEl = document.getElementById('rom-lib-path');
    if (pathEl && entry?.name) {
      const romCount = Object.values(ROM_STATUS).filter(Boolean).length;
      const romTotal = Object.keys(ROM_STATUS).length;
      pathEl.textContent = `📁 ${entry.name}  ·  ${romCount} / ${romTotal} ROMs INDEXED`;
    }
    document.getElementById('rom-lib-rescan')?.addEventListener('click', async e => {
      e.stopPropagation();
      const ent = await LibraryDB.getRoot();
      if (!ent?.handle) { await setRomLibraryRoot(); return; }
      try {
        const perm = await ent.handle.requestPermission({ mode: 'read' });
        if (perm === 'granted') {
          showToast('⚙ RESCANNING LIBRARY...');
          await silentScanLibrary(ent.handle, true);
          hydrateSourcesMenu(); // refresh the card
        }
      } catch(e) {
        console.warn('[hydrateSourcesMenu rescan]', e);
      }
    });
    return;
  }

  // ── Native mode: read physical drives from server ──
  const grid   = document.getElementById('sources-live-grid');
  const status = document.getElementById('sources-scan-status');
  if (!grid) return;
  try {
    const res      = await fetch(`${KENTE_SERVER_URL}/api/sources`, { signal: _abortTimeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sources  = await res.json();
    const external = sources.filter(s => s.type === 'external');
    if (status) status.textContent = external.length
      ? `${external.length} DRIVE${external.length !== 1 ? 'S' : ''} FOUND`
      : 'NO EXTERNAL DRIVES';
    if (!external.length) {
      grid.innerHTML = `<p class="menu-empty">NO EXTERNAL DRIVES DETECTED.<br>INSERT A USB DRIVE AND RESCAN.</p>`;
      return;
    }
    grid.innerHTML = external.map(s => {
      const eName = escHtml(s.name);
      const eIcon = escHtml(s.icon || '🔌');
      const ePath = escHtml(s.path) + (s.free ? ' · ' + escHtml(s.free) : '');
      return `
      <div class="source-card" data-src="1" data-name="${eName}" data-icon="${eIcon}" data-status="local" data-count="0" style="cursor:pointer">
        <span class="source-card-icon">${eIcon}</span>
        <div class="source-card-name">${eName}</div>
        <div class="source-card-path">${ePath}</div>
        <div style="margin-top:8px"><div class="source-status local"><div class="source-status-dot"></div>MOUNTED</div></div>
      </div>`;
    }).join('');
  } catch {
    if (status) status.textContent = 'SCAN FAILED';
    grid.innerHTML = `<p class="menu-empty">COULD NOT READ DRIVES — SERVER UNREACHABLE.</p>`;
  }
}


/* ── MEMORY CARD MENU ── */
function contentMemory() {
  const games          = getActiveGames();
  const activeSystems  = SYSTEMS.filter(s => s.active && !s.sacrificed);
  const sacrificed     = SYSTEMS.filter(s => s.sacrificed);
  const unlocked       = SYSTEMS.filter(s => s.active && s.tier > 1);

  const profiles = [
    { id:'player1', name:'PLAYER 1', avatar:'🎮' },
    { id:'player2', name:'PLAYER 2', avatar:'🕹️' },
    { id:'guest',   name:'GUEST',    avatar:'👤' },
  ];
  const profileCards = profiles.map(p => `
    <div class="profile-card${p.id===state.activeProfile?' active':''}" data-profile="${p.id}" style="cursor:pointer">
      <div class="profile-avatar">${p.avatar}</div>
      <div class="profile-name">${p.name}</div>
    </div>`).join('');

  const stats = [
    { val: games.length,                      label:'TITLES IN LIBRARY'  },
    { val: activeSystems.length,              label:'ACTIVE SYSTEMS'     },
    { val: sacrificed.length,                 label:'SYSTEMS SACRIFICED' },
    { val: unlocked.length,                   label:'SYSTEMS UNLOCKED'   },
  ];
  const statBoxes = stats.map(s => `
    <div class="stat-box">
      <div class="stat-value">${s.val}</div>
      <div class="stat-label">${s.label}</div>
    </div>`).join('');

  const sacrificedList = sacrificed.length
    ? sacrificed.map(s => `
        <div class="settings-item" style="opacity:0.4;cursor:default">
          <span class="settings-item-label" style="text-decoration:line-through">${s.name}</span>
          <span class="settings-item-value" style="color:#553333">SACRIFICED · TIER ${s.tier}</span>
        </div>`).join('')
    : `<p class="menu-empty">NO SACRIFICES MADE.</p>`;

  const storageStats = KENTE_SERVER_ONLINE ? `
    <div class="section-label">STORAGE &amp; HARDWARE</div>
    <div class="stats-grid" id="mem-storage-grid">
      <div class="stat-box"><div class="stat-value" id="mem-disk-free">…</div><div class="stat-label">STORAGE FREE</div></div>
      <div class="stat-box"><div class="stat-value" id="mem-saves-count">…</div><div class="stat-label">SAVE FILES</div></div>
      <div class="stat-box"><div class="stat-value" id="mem-controllers">…</div><div class="stat-label">CONTROLLERS</div></div>
      <div class="stat-box"><div class="stat-value" id="mem-batocera-ver">…</div><div class="stat-label">BATOCERA VER</div></div>
    </div>
    <div class="section-label">SAVE DATA</div>
    <div class="settings-list" id="mem-saves-list">
      <p class="menu-empty" style="padding:12px 0">LOADING SAVE DATA...</p>
    </div>` : '';

  return `
    <div class="section-label">PROFILES</div>
    <div class="profile-bar">${profileCards}</div>
    <div class="section-label">LIBRARY STATISTICS</div>
    <div class="stats-grid">${statBoxes}</div>
    ${storageStats}
    <div class="section-label">SACRIFICE HISTORY</div>
    <div class="settings-list">${sacrificedList}</div>`;
}

async function hydrateMemoryMenu() {
  if (!KENTE_SERVER_ONLINE) return;
  try {
    const [sysRes, savesRes] = await Promise.all([
      fetch(`${KENTE_SERVER_URL}/api/system/info`, { signal: _abortTimeout(8000) }),
      fetch(`${KENTE_SERVER_URL}/api/saves`,       { signal: _abortTimeout(8000) }),
    ]);
    const info  = await sysRes.json();
    const saves = await savesRes.json();

    const el = id => document.getElementById(id);
    if (el('mem-disk-free'))     el('mem-disk-free').textContent     = info.disk_free     || '—';
    if (el('mem-controllers'))   el('mem-controllers').textContent   = info.controllers ?? '—';
    if (el('mem-batocera-ver'))  el('mem-batocera-ver').textContent  = info.batocera_version || '—';
    if (el('mem-saves-count'))   el('mem-saves-count').textContent   = saves.length;

    const savesList = el('mem-saves-list');
    if (!savesList) return;
    if (!saves.length) {
      savesList.innerHTML = `<p class="menu-empty">NO SAVE FILES FOUND IN /userdata/saves/</p>`;
      return;
    }
    // s.file comes from the real filesystem — filenames can contain < > &
    savesList.innerHTML = saves.map(s => `
      <div class="settings-item" style="cursor:default">
        <span class="settings-item-label">
          <span style="opacity:0.5;margin-right:6px">${escHtml(s.systemName)}</span>${escHtml(s.file)}
        </span>
        <span class="settings-item-value" style="font-size:9px">${escHtml(s.size)} · ${escHtml(s.modified)}</span>
      </div>`).join('');
  } catch {
    const el = document.getElementById('mem-saves-list');
    if (el) el.innerHTML = `<p class="menu-empty">COULD NOT LOAD SAVE DATA — SERVER UNREACHABLE.</p>`;
  }
}
