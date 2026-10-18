/* Kente's Korner — Cloud providers, Archive.org search, cloud browser UI. */
'use strict';

/* ══════════════════════════════════════════
   CLOUD PROVIDERS
   Pluggable cloud ROM sources. Each provider
   exposes search + file listing. Downloads
   stream directly to the local library root.
══════════════════════════════════════════ */
const CLOUD_PROVIDERS = {
  archive: {
    id:      'archive',
    name:    'INTERNET ARCHIVE',
    icon:    '🌐',
    desc:    'Free digital preservation archive — millions of titles',
    apiBase: 'https://archive.org',
  },
  vimm: {
    id:   'vimm',
    name: "VIMM'S LAIR",
    icon: '🎮',
    desc: 'Community ROM vault — curated library, fast downloads',
    type: 'link',
    sysMap: {
      nes:        'NES',     snes:       'SNES',    n64:       'N64',
      gameboy:    'GB',      gbc:        'GBC',     gba:       'GBA',
      genesis:    'Genesis', gamecube:   'GC',      wii:       'Wii',
      ps1:        'PS1',     ps2:        'PS2',     psp:       'PSP',
      saturn:     'Saturn',  dreamcast:  'DC',
      atari2600:  'Atari2600', atari7800: 'Atari7800', turbografx: 'TG16',
    },
    buildSearchUrl(sysCode, title) {
      const params = new URLSearchParams({ p: 'list' });
      if (sysCode) params.set('system', sysCode);
      if (title)   params.set('q',      title);
      return `https://vimm.net/vault/?${params}`;
    },
  },
  packs: {
    id:   'packs',
    name: 'ARCHIVE PACKS',
    icon: '📦',
    // Searchable via /api/pack/search — server queries Archive.org metadata API
    // for known per-system pack collections with individual ROM files.
    // Currently covers NES (953 ROMs) and SNES (961 ROMs).
    desc:    'Curated Archive.org ROM packs — individual files, fast results',
    type:    'packs',   // handled separately in runCloudSearch()
    buildSearchUrl(_sysCode, _title) {
      return 'https://archive.org/search?query=ROM+pack&mediatype=software';
    },
  },
  cdromance: {
    id:   'cdromance',
    name: 'CDROMANCE',
    icon: '💿',
    desc: 'Pre-patched, translated and regional ROM variants',
    type: 'link',
    buildSearchUrl(_sysCode, title) {
      return `https://cdromance.org/?s=${encodeURIComponent(title || '')}`;
    },
  },
  romheaven: {
    id:   'romheaven',
    name: 'ROMHEAVEN',
    icon: '🌤',
    desc: 'Decentralized ROM archive — fast downloads, no ads',
    type: 'link',
    buildSearchUrl(_sysCode, title) {
      return `https://romheaven.com/catalog?q=${encodeURIComponent(title || '')}`;
    },
  },
};

// Per-system Archive.org subject query fragments.
// These are matched against the item-level 'subject' field.
// Tags were determined by inspecting how real uploaders tag their archives —
// they often differ from what you'd expect (e.g. PSX not "PlayStation").
const ARCHIVE_SYS_QUERY = {
  nes:        'subject:"Nintendo Entertainment System"',
  gameboy:    'subject:"Game Boy"',
  mastersys:  'subject:"Master System"',
  atari2600:  'subject:"Atari 2600"',
  atari7800:  'subject:"Atari 7800"',
  gamegear:   'subject:"Game Gear"',
  snes:       'subject:"Super Nintendo"',
  genesis:    '(subject:"Mega Drive" OR subject:"Sega Genesis")',
  gbc:        'subject:"Game Boy Color"',
  gba:        'subject:"Game Boy Advance"',
  turbografx: '(subject:"PC Engine" OR subject:"TurboGrafx")',
  neogeo:     '(subject:"Neo-Geo" OR subject:NeoGeo)',
  // Sega CD uploaders use both "Sega CD" and "Mega CD" tags
  segacd:     '(subject:"Sega CD" OR subject:"Mega CD")',
  // 32X uploaders use both "Sega 32X" and bare "32X"
  sega32x:    '(subject:"Sega 32X" OR subject:"32X")',
  n64:        '(subject:"Nintendo 64" OR subject:N64)',
  // PSX uploaders tag with 'PSX', not 'PlayStation' — using PSX hits real disc archives
  ps1:        '(subject:PSX OR subject:"PlayStation 1")',
  // Saturn uploaders use bare 'Saturn', NOT 'Sega Saturn' — confirmed live test
  saturn:     'subject:Saturn',
  // Nintendo DS uploaders use "Nintendo DS" tag
  nds:        'subject:"Nintendo DS"',
  // Dreamcast — both bare and long form used by uploaders
  dreamcast:  '(subject:Dreamcast OR subject:"Sega Dreamcast")',
  // PSP items are often tagged 'PSP' as a bare word, and many use mediatype:data
  psp:        'subject:PSP',
  // PS2 items appear with both "PlayStation 2" and "Sony PlayStation 2" tags
  ps2:        '(subject:"PlayStation 2" OR subject:"Sony PlayStation 2")',
  gamecube:   '(subject:GameCube OR subject:"Nintendo GameCube")',
  // Wii: bare 'Wii' tag is used by uploaders — confirmed live test
  wii:        'subject:Wii',
  // Xbox original: uploaders use bare 'Xbox' tag — confirmed live test
  xbox:       'subject:Xbox',
  // Xbox 360: uploaders use both 'Xbox360' (no space) and 'Xbox 360' (space)
  xbox360:    '(subject:Xbox360 OR subject:"Xbox 360")',
  // PS3: bare 'PS3' tag is used by uploaders — confirmed live test
  ps3:        'subject:PS3',
  // Wii U: subject:"Wii U" (with space) hits real ROM uploads — confirmed live test
  wiiu:       'subject:"Wii U"',
  // Switch: file-format subjects (NSP/XCI/NSZ) are the only reliable tags on
  // Archive.org — "Nintendo Switch" and "Switch" subjects return Thingiverse
  // 3D-printing models named after games. Confirmed live test: Mario Kart 8
  // Deluxe (6.9 GB .nsp) and others are found with this query.
  switch:     '(subject:NSP OR subject:nsp OR subject:XCI OR subject:xci OR subject:NSZ OR subject:nsz)',
};

// Per-system mediatype overrides for Archive.org searches.
// Most cartridge/disc game archives are tagged mediatype:software, but some
// systems are frequently uploaded as mediatype:data instead.
// The default for any unlisted system is 'mediatype:software'.
const ARCHIVE_MEDIATYPE = {
  // All disc-based systems: ROM sets are frequently uploaded as mediatype:data
  // rather than mediatype:software. Use OR to catch both.
  psp:      '(mediatype:software OR mediatype:data)',
  ps2:      '(mediatype:software OR mediatype:data)',
  saturn:   '(mediatype:software OR mediatype:data)',
  gamecube: '(mediatype:software OR mediatype:data)',
  segacd:   '(mediatype:software OR mediatype:data)',
  sega32x:  '(mediatype:software OR mediatype:data)',
  dreamcast:'(mediatype:software OR mediatype:data)',
  wii:      '(mediatype:software OR mediatype:data)',
  xbox:     '(mediatype:software OR mediatype:data)',
  xbox360:  '(mediatype:software OR mediatype:data)',
  ps3:      '(mediatype:software OR mediatype:data)',
  wiiu:     '(mediatype:software OR mediatype:data)',
  switch:   '(mediatype:software OR mediatype:data)',
};

/* ── ARCHIVE PACK COLLECTION SEARCH ─────────────────────────────────────────
   Calls /api/pack/search on the local server. The server queries the Archive.org
   metadata API for a known per-system pack identifier, lists individual ROM files,
   fuzzy-matches by title, and returns up to 20 results as { name, url, score }.
   Currently has individual-file packs for NES and SNES; other systems return [].  */
async function searchPackCollection(title, systemId) {
  if (!KENTE_SERVER_ONLINE) return [];
  if (!title || !systemId) return [];
  try {
    const params = new URLSearchParams({ systemId, title });
    const res = await fetch(
      `${KENTE_SERVER_URL}/api/pack/search?${params}`,
      { signal: _abortTimeout(20000) },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[Kente/Pack] search error:', e.message);
    return [];
  }
}

/* ── AbortSignal.timeout() polyfill ─────────────────────────────────────────
   AbortSignal.timeout() is native in Chrome 117+, Firefox 123+, Safari 17.4+.
   Older Chromium builds (e.g. the browser bundled with some Batocera versions)
   don't have it.  This shim returns a real AbortSignal regardless of browser
   age so every fetch() call works identically everywhere.                    */
const _abortTimeout = typeof AbortSignal.timeout === 'function'
  ? (ms) => AbortSignal.timeout(ms)
  : (ms) => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(new DOMException('TimeoutError', 'TimeoutError')), ms);
      return ctrl.signal;
    };

/* ── HTML escape utility — use for any API / user data injected into innerHTML ── */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/* ── ARCHIVE.ORG API ──────────────────────────────────────── */

async function searchArchive(query, systemId) {
  const sysQ = ARCHIVE_SYS_QUERY[systemId] || '';

  // Strip characters that break Archive.org's Lucene query parser
  // (apostrophes in "Tony Hawk's", periods in "Super Mario Bros.", parens, quotes, colons)
  const cleanQ = query
    .replace(/['"():[\]{}.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const doSearch = async (parts) => {
    const q   = encodeURIComponent(parts.join(' AND '));
    const url = `https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=year&rows=40&output=json`;
    if (DEBUG) console.log(`[Kente/search] Query: ${decodeURIComponent(q)}`);
    const res = await fetch(url, { signal: _abortTimeout(12000) });
    if (!res.ok) throw new Error(`SEARCH_HTTP_${res.status}`);
    const data = await res.json();
    const docs = data.response?.docs || [];
    if (DEBUG) console.log(`[Kente/search] → ${docs.length} results`);
    return docs;
  };

  // Use the per-system mediatype override if one exists, otherwise default to
  // 'mediatype:software'.  PSP items are often tagged as 'mediatype:data'.
  const mediatype = ARCHIVE_MEDIATYPE[systemId] || 'mediatype:software';

  // Phase 1 — precise: title + system subject tag
  const phase1 = [mediatype];
  if (cleanQ) phase1.push(`title:(${cleanQ})`);
  if (sysQ)   phase1.push(sysQ);
  const r1 = await doSearch(phase1);
  if (r1.length) return r1;

  // Phase 2 — drop subject tag; keep system mediatype.
  // Many Archive.org ROM collections use collection tags instead of subject tags,
  // so removing the subject filter catches well-maintained No-Intro / Redump sets.
  if (cleanQ) {
    const phase2 = [mediatype, `title:(${cleanQ})`];
    const r2 = await doSearch(phase2);
    if (r2.length) return r2;
  }

  // Phase 3 — broaden to both mediatype:software and mediatype:data.
  // Archive.org increasingly stores large ROM packs as mediatype:data,
  // not mediatype:software.  This catches those collections for all systems.
  if (cleanQ) {
    const phase3 = ['(mediatype:software OR mediatype:data)', `title:(${cleanQ})`];
    const r3 = await doSearch(phase3);
    if (r3.length) return r3;
  }

  // Phase 4 — shortened title + any mediatype.
  // Catches long / subtitle-heavy names like "The Legend of Zelda: Majora's Mask"
  // where the full title yields no hits but the first 3 words would.
  const words = cleanQ.split(' ').filter(Boolean);
  if (words.length > 2) {
    const shortQ = words.slice(0, 3).join(' ');
    const phase4 = ['(mediatype:software OR mediatype:data)', `title:(${shortQ})`];
    const r4 = await doSearch(phase4);
    if (r4.length) return r4;
  }

  console.warn(`[Kente/search] No results found for "${query}" (${systemId})`);
  return [];
}

// systemId is optional: when provided, only files whose extension matches that
// system's ROM_EXT are returned.  When omitted (e.g. the manual cloud browser)
// the universal set of all known extensions is used as a fallback.
async function getArchiveFiles(identifier, systemId) {
  const url = `https://archive.org/metadata/${identifier}/files`;
  if (DEBUG) console.log(`[Kente/files] Fetching file list: ${identifier}`);
  const res  = await fetch(url, { signal: _abortTimeout(10000) });
  if (!res.ok) throw new Error(`FILES_HTTP_${res.status}`);
  const data = await res.json();
  const validExts = systemId
    ? new Set((ROM_EXT[systemId] || []).map(e => e.toLowerCase()))
    : new Set(Object.values(ROM_EXT).flat());
  const files = (data.result || []).filter(f => {
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    return validExts.has(ext);
  });
  if (DEBUG) console.log(`[Kente/files] ${identifier} → ${(data.result||[]).length} total files, ${files.length} ROM-eligible`);
  return files;
}

/* ── DOWNLOAD TO LIBRARY ──────────────────────────────────── */

async function downloadToLibrary(systemId, filename, url, onProgress) {
  // Helper: record this download in DownloadDB regardless of mode
  const _recordDownload = async (sizeBytes = 0) => {
    const sys = window.KenteLibrary?.games.find(g => g.systemId === systemId);
    const systemName = sys?.system || systemId.toUpperCase();
    await DownloadDB.add({
      id:           'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      filename,
      systemId,
      systemName,
      archiveUrl:   url,
      downloadedAt: Date.now(),
      sizeBytes,
    });
  };

  if (KENTE_SERVER_ONLINE) {
    // Native: server downloads directly to /userdata/roms/<system>/
    const res  = await fetch(`${KENTE_SERVER_URL}/api/download`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ systemId, filename, url }),
      signal:  _abortTimeout(30_000),
    });
    const data = await res.json();
    if (data.success) await _recordDownload();
    return data;
  }

  // ── Browser path ──────────────────────────────────────────────────────────
  // Priority:
  //  1. User-set manual library (FileSystemAccessAPI folder picked via Sources)
  //  2. OPFS auto-library (KenteKorner/roms/{systemId}/ — no prompt, always available)
  // ROMs are always stored in a per-system subfolder for clean organisation.

  const libEntry = await LibraryDB.getRoot();
  let rootHandle;
  let usingOPFS = false;

  if (libEntry?.handle) {
    // User has a manual library — verify permission before writing
    const perm = await libEntry.handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('NO_PERMISSION');
    rootHandle = libEntry.handle;
  } else if (navigator?.storage?.getDirectory) {
    // No manual library — fall back to the OPFS auto-library.
    // OPFS lives inside the browser's private storage for this origin;
    // no OS permission dialog is ever shown to the user.
    rootHandle = await getOPFSLibrary();
    usingOPFS  = true;
  } else {
    throw new Error('NO_LIBRARY');
  }

  // Write ROM to {root}/{systemId}/{filename}
  const sysFolder  = await rootHandle.getDirectoryHandle(systemId, { create: true });
  const fileHandle = await sysFolder.getFileHandle(filename, { create: true });
  const writable   = await fileHandle.createWritable();

  // Guarantee the stream is closed (or aborted) on every exit path.
  // Leaving a FileSystemWritableFileStream open locks the file in Chromium
  // and prevents any subsequent write until the page is reloaded.
  let received = 0;
  try {
    // 4-hour max per file — large ISOs can take a long time on slow links.
    // Chunk-level timeouts are handled by the reader loop.
    const response = await fetch(url, { signal: _abortTimeout(4 * 60 * 60 * 1000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total  = parseInt(response.headers.get('Content-Length') || '0');
    const reader = response.body.getReader();

    const _timedRead = () => Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('STREAM_TIMEOUT')), 45_000)),
    ]);
    while (true) {
      const { done, value } = await _timedRead();
      if (done) break;
      await writable.write(value);
      received += value.length;
      // Pass -1 when Content-Length was absent — signals indeterminate to caller
      if (onProgress) onProgress(total ? received / total : -1);
    }
    await writable.close();
  } catch (err) {
    // abort() discards the incomplete write and releases the file lock
    await writable.abort().catch(() => {});
    throw err;
  }

  // Auto-index the saved file into RomDB + ROM_STATUS
  // Same fuzzy matcher used by the library scanner — handles Archive.org filenames
  // like "Super Mario Bros. (USA).nes" → "Super Mario Bros."
  const matchedGame = findGameForDownload(systemId, filename);
  if (matchedGame) {
    await RomDB.set(matchedGame.id, fileHandle, filename);
    ROM_STATUS[matchedGame.id] = true;
    refreshGameCardDots();
  }

  // Record in DownloadDB — note where the file ended up for the downloads panel
  const sys = window.KenteLibrary?.games.find(g => g.systemId === systemId);
  await DownloadDB.add({
    id:           'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    filename,
    systemId,
    systemName:   sys?.system || systemId.toUpperCase(),
    archiveUrl:   url,
    downloadedAt: Date.now(),
    sizeBytes:    received,
    storage:      usingOPFS ? 'opfs' : 'library',
  });

  console.log(`[Kente] ROM saved to ${usingOPFS ? 'OPFS' : 'manual library'}: ${systemId}/${filename}`);
  // Return fileHandle so startCloudDownload can offer PLAY NOW for unlisted ROMs
  return { success: true, fileHandle };
}

/* ── CLOUD BROWSER UI ─────────────────────────────────────── */

let _cloudState = { providerId: 'archive', systemId: null, activeResult: null };

function openCloudBrowser(providerId = 'archive', preTitle = '', preSystemId = null) {
  const provider = CLOUD_PROVIDERS[providerId];
  if (!provider) return;
  _cloudState = { providerId, systemId: preSystemId, activeResult: null };

  const overlay = document.getElementById('cloud-overlay');
  document.getElementById('cloud-provider-icon').textContent = provider.icon;
  document.getElementById('cloud-provider-name').textContent = provider.name;
  document.getElementById('cloud-provider-desc').textContent = provider.desc;
  document.getElementById('cloud-close').onclick = () => overlay.classList.remove('active');
  overlay.classList.add('active');
  requestAnimationFrame(() => GamepadManager.applyFocus(0));

  // Link-type providers (e.g. Vimm's Lair) — no API; show a manual search/redirect UI
  if (provider.type === 'link') {
    _openLinkProviderBrowser(provider, preTitle, preSystemId);
    return;
  }

  // ── Archive.org API provider ──────────────────────────────────────────────

  // Build system chips from systems that have a query mapping
  const systemsEl = document.getElementById('cloud-systems');
  const chipSystems = SYSTEMS.filter(s => ARCHIVE_SYS_QUERY[s.id] && !s.sacrificed);
  systemsEl.innerHTML = chipSystems.map(s => `
    <button class="cloud-sys-chip${preSystemId === s.id ? ' active' : ''}"
            data-sys="${s.id}">${s.name.toUpperCase()}</button>`).join('');

  systemsEl.querySelectorAll('.cloud-sys-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      systemsEl.querySelectorAll('.cloud-sys-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      _cloudState.systemId = chip.dataset.sys;
      runCloudSearch();
    });
  });

  // Search bar
  const input = document.getElementById('cloud-search-input');
  input.value = preTitle;
  document.getElementById('cloud-search-btn').onclick = runCloudSearch;
  input.onkeydown = e => { if (e.key === 'Enter') runCloudSearch(); };

  // Reset panes
  document.getElementById('cloud-results-list').innerHTML = '<p class="cloud-empty">SELECT A SYSTEM OR SEARCH.</p>';
  document.getElementById('cloud-files-list').innerHTML   = '<p class="cloud-empty">SELECT A RESULT TO SEE FILES.</p>';

  // Fully reset the download bar so state from a previous session doesn't bleed through
  const _bar  = document.getElementById('cloud-download-bar');
  const _fill = document.getElementById('cloud-progress-fill');
  const _pnb  = document.getElementById('cloud-play-now-btn');
  _bar.classList.add('hidden');
  _fill.style.width = '0%';
  _fill.classList.remove('indeterminate');
  document.getElementById('cloud-download-pct').textContent   = '0%';
  document.getElementById('cloud-download-label').textContent = 'DOWNLOADING...';
  _pnb.hidden      = true;
  _pnb.textContent = '▶ PLAY NOW';
  _pnb.onclick     = null;

  if (preTitle || preSystemId) runCloudSearch();
}

/* Renders the manual search / redirect UI for link-type providers (Vimm's Lair, etc.).
   System chips come from the provider's own sysMap.
   Search button opens the provider's site in a new tab — no API calls made.          */
function _openLinkProviderBrowser(provider, preTitle = '', preSystemId = null) {
  const systemsEl = document.getElementById('cloud-systems');
  const entries   = Object.entries(provider.sysMap || {});

  systemsEl.innerHTML = entries.map(([sysId, sysCode]) => {
    const sys = SYSTEMS.find(s => s.id === sysId);
    const label = sys ? sys.name.toUpperCase() : sysId.toUpperCase();
    return `<button class="cloud-sys-chip${preSystemId === sysId ? ' active' : ''}"
              data-sys="${sysId}" data-syscode="${escHtml(sysCode)}">${label}</button>`;
  }).join('');

  systemsEl.querySelectorAll('.cloud-sys-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      systemsEl.querySelectorAll('.cloud-sys-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      _cloudState.systemId  = chip.dataset.sys;
      _cloudState._sysCode  = chip.dataset.syscode;
    });
  });

  const input = document.getElementById('cloud-search-input');
  input.value = preTitle;

  const openSite = () => {
    const title      = input.value.trim();
    const activeChip = systemsEl.querySelector('.cloud-sys-chip.active');
    const sysCode    = activeChip ? activeChip.dataset.syscode : '';
    const url        = provider.buildSearchUrl(sysCode, title);
    window.open(url, '_blank', 'noopener');
    showToast(`↗ OPENED ${provider.name.toUpperCase()} IN NEW TAB`);
  };

  document.getElementById('cloud-search-btn').onclick = openSite;
  input.onkeydown = e => { if (e.key === 'Enter') openSite(); };

  // Replace the two-pane search layout with a single instruction + open button
  document.getElementById('cloud-results-list').innerHTML = `
    <div style="padding:28px 20px;text-align:center;font-family:var(--font-mono)">
      <div style="color:#2a2a2a;font-size:10px;letter-spacing:0.15em;line-height:2.4;max-width:260px;margin:0 auto 20px">
        SELECT A SYSTEM ABOVE AND ENTER A TITLE,<br>
        THEN CLICK OPEN TO SEARCH ${escHtml(provider.name.toUpperCase())} IN YOUR BROWSER.
      </div>
      <button id="link-provider-open-btn"
        style="width:100%;background:#0a1a0a;border:1px solid #1a3a1a;color:#30d880;
               font-family:var(--font-mono);font-size:10px;letter-spacing:0.2em;
               padding:16px 0;cursor:pointer;margin-bottom:12px">
        ↗ &nbsp;OPEN ON ${escHtml(provider.name.toUpperCase())}
      </button>
      <div style="color:#1a1a1a;font-size:9px;letter-spacing:0.1em;line-height:2.2">
        DOWNLOAD THE ROM FILE FROM THEIR SITE.<br>
        THEN PRESS ✕ EXIT AND USE<br>
        LOAD ROM FILE TO PLAY.
      </div>
    </div>`;

  document.getElementById('cloud-files-list').innerHTML = `
    <div style="padding:28px 20px;text-align:center;font-family:var(--font-mono);
                color:#1e1e1e;font-size:9px;letter-spacing:0.12em;line-height:2.5">
      ${escHtml(provider.name.toUpperCase())} IS A MANUAL DOWNLOAD SITE.<br>
      THEIR LIBRARY IS WELL-CURATED AND FAST.<br>
      NO ACCOUNT REQUIRED FOR MOST TITLES.
    </div>`;

  document.getElementById('cloud-download-bar').classList.add('hidden');
  document.getElementById('link-provider-open-btn').addEventListener('click', openSite);
}

// Monotonically-incrementing counter — lets concurrent searches detect staleness.
// If the user clicks Search twice quickly, the first response is discarded.
let _cloudSearchGen = 0;

async function runCloudSearch() {
  const gen     = ++_cloudSearchGen;
  const input   = document.getElementById('cloud-search-input');
  const resList = document.getElementById('cloud-results-list');
  const query   = input.value.trim();

  if (!query && !_cloudState.systemId) {
    resList.innerHTML = '<p class="cloud-empty">PICK A SYSTEM CHIP ABOVE OR TYPE A TITLE TO SEARCH.</p>';
    return;
  }

  resList.innerHTML = '<p class="cloud-empty">SEARCHING...</p>';
  document.getElementById('cloud-files-list').innerHTML = '<p class="cloud-empty">SELECT A RESULT TO SEE FILES.</p>';

  // ── Archive Pack Collections: direct file results, no two-step flow ──
  if (_cloudState.providerId === 'packs') {
    try {
      if (!KENTE_SERVER_ONLINE) {
        resList.innerHTML = '<p class="cloud-empty">KENTE SERVER REQUIRED FOR PACK SEARCH.</p>'; return;
      }
      const files = await searchPackCollection(query, _cloudState.systemId);
      if (_cloudSearchGen !== gen) return;
      if (!files.length) {
        resList.innerHTML = '<p class="cloud-empty">NO RESULTS IN PACK. NES AND SNES ARE SUPPORTED — TRY ARCHIVE.ORG FOR OTHER SYSTEMS.</p>';
        return;
      }
      resList.innerHTML = files.map(f => `
        <div class="cloud-result-row" data-direct-url="${escHtml(f.url)}" data-fname="${escHtml(f.name)}">
          <div class="cloud-result-title">${escHtml(f.name)}</div>
          <div class="cloud-result-meta">ARCHIVE PACK · DIRECT DOWNLOAD</div>
        </div>`).join('');

      resList.querySelectorAll('.cloud-result-row').forEach(row => {
        row.addEventListener('click', () => {
          resList.querySelectorAll('.cloud-result-row').forEach(r => r.classList.remove('active'));
          row.classList.add('active');
          const url   = row.dataset.directUrl;
          const fname = row.dataset.fname;
          const sid   = _cloudState.systemId || 'nes';
          const filesEl = document.getElementById('cloud-files-list');
          filesEl.innerHTML = `
            <div class="cloud-file-row" data-fname="${escHtml(fname)}" data-direct-url="${escHtml(url)}">
              <span class="cloud-file-name">${escHtml(fname)}</span>
              <span class="cloud-file-size">—</span>
              <button class="cloud-dl-btn">↓ SAVE</button>
            </div>`;
          filesEl.querySelector('.cloud-dl-btn')?.addEventListener('click', () => {
            startCloudDownload(sid, fname, url,
              filesEl.querySelector('.cloud-dl-btn'));
          });
        });
      });
    } catch {
      resList.innerHTML = '<p class="cloud-empty">ARCHIVE PACKS SEARCH FAILED — CHECK CONNECTION.</p>';
    }
    return;
  }

  // ── Multi-source fan-out (preferred when server is online) ────
  // Hits /api/roms/sources which queries archive, archive_packs,
  // archive_redump, and archive_tosec in parallel and ranks candidates.
  // Renders a flat list of direct-download files (no two-step item ▸ files
  // drill-down) so any source the backend supports is one click away.
  if (KENTE_SERVER_ONLINE && _cloudState.systemId && query) {
    try {
      const cands = await fetchRomSources(_cloudState.systemId, query);
      if (_cloudSearchGen !== gen) return;
      if (cands.length) {
        const _provLabel = (p) => {
          const u = String(p || '').toUpperCase();
          if (u === 'ARCHIVE')         return 'ARCHIVE.ORG';
          if (u === 'ARCHIVE_PACKS')   return 'ARCHIVE · PACKS';
          if (u === 'ARCHIVE_REDUMP')  return 'ARCHIVE · REDUMP';
          if (u === 'ARCHIVE_TOSEC')   return 'ARCHIVE · TOSEC';
          return u || 'SOURCE';
        };
        resList.innerHTML = cands.map(c => {
          const sizeMB = c.size ? (Number(c.size) / 1048576).toFixed(1) + ' MB' : '—';
          const region = (c.region || '').toUpperCase();
          const meta   = [_provLabel(c.provider), region, sizeMB].filter(Boolean).join(' · ');
          return `<div class="cloud-result-row" data-direct-url="${escHtml(c.url)}" data-fname="${escHtml(c.filename)}">
            <div class="cloud-result-title">${escHtml(c.filename)}</div>
            <div class="cloud-result-meta">${escHtml(meta)}</div>
          </div>`;
        }).join('');
        document.getElementById('cloud-files-list').innerHTML = cands.map(c => {
          const sizeMB = c.size ? (Number(c.size) / 1048576).toFixed(1) + ' MB' : '—';
          return `<div class="cloud-file-row" data-fname="${escHtml(c.filename)}" data-direct-url="${escHtml(c.url)}">
            <span class="cloud-file-name">${escHtml(c.filename)}</span>
            <span class="cloud-file-size">${sizeMB}</span>
            <button class="cloud-dl-btn">↓ SAVE</button>
          </div>`;
        }).join('');
        document.querySelectorAll('#cloud-files-list .cloud-file-row').forEach(row => {
          row.querySelector('.cloud-dl-btn').addEventListener('click', () => {
            startCloudDownload(_cloudState.systemId, row.dataset.fname,
                               row.dataset.directUrl, row.querySelector('.cloud-dl-btn'));
          });
        });
        // Result-row click mirrors the selection to the files pane (filter to
        // just that file) so the existing right-pane interaction stays familiar.
        resList.querySelectorAll('.cloud-result-row').forEach(row => {
          row.addEventListener('click', () => {
            resList.querySelectorAll('.cloud-result-row').forEach(r => r.classList.remove('active'));
            row.classList.add('active');
          });
        });
        return;
      }
    } catch {
      // Fall through to the legacy Archive item-list flow below.
    }
  }

  // ── Archive.org (default / fallback) ──────────────────────────
  try {
    const results = await searchArchive(query, _cloudState.systemId);
    if (_cloudSearchGen !== gen) return;
    if (!results.length) {
      resList.innerHTML = '<p class="cloud-empty">NO RESULTS ON ARCHIVE.ORG. TRY THE ARCHIVE PACKS SOURCE (NES/SNES), VIMM\'S LAIR, CDROMANCE, OR ROMHEAVEN.</p>';
      return;
    }
    resList.innerHTML = results.map(r => `
      <div class="cloud-result-row" data-id="${escHtml(r.identifier)}">
        <div class="cloud-result-title">${escHtml(r.title || r.identifier)}</div>
        <div class="cloud-result-meta">${escHtml(r.identifier)}${r.year ? ' · ' + escHtml(r.year) : ''}</div>
      </div>`).join('');

    resList.querySelectorAll('.cloud-result-row').forEach(row => {
      row.addEventListener('click', async () => {
        resList.querySelectorAll('.cloud-result-row').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        _cloudState.activeResult = row.dataset.id;
        await loadCloudFiles(row.dataset.id);
      });
    });
  } catch {
    resList.innerHTML = '<p class="cloud-empty">SEARCH FAILED — CHECK CONNECTION.</p>';
  }
}

async function loadCloudFiles(identifier) {
  const filesEl = document.getElementById('cloud-files-list');
  filesEl.innerHTML = '<p class="cloud-empty">LOADING FILES...</p>';
  try {
    const files = await getArchiveFiles(identifier);
    if (!files.length) {
      filesEl.innerHTML = '<p class="cloud-empty">NO ROM FILES FOUND IN THIS ARCHIVE.</p>';
      return;
    }
    filesEl.innerHTML = files.map(f => {
      const sizeMB = f.size ? (parseInt(f.size) / 1048576).toFixed(1) + ' MB' : '—';
      return `<div class="cloud-file-row" data-fname="${escHtml(f.name)}" data-id="${escHtml(identifier)}">
        <span class="cloud-file-name">${escHtml(f.name)}</span>
        <span class="cloud-file-size">${sizeMB}</span>
        <button class="cloud-dl-btn">↓ SAVE</button>
      </div>`;
    }).join('');

    filesEl.querySelectorAll('.cloud-file-row').forEach(row => {
      row.querySelector('.cloud-dl-btn').addEventListener('click', () => {
        const fname = row.dataset.fname;
        const url   = `https://archive.org/download/${row.dataset.id}/${encodeURIComponent(fname)}`;
        const ext   = '.' + fname.split('.').pop().toLowerCase();
        // Best-guess system from active chip or URL ext match
        const sid   = _cloudState.systemId ||
          Object.entries(ROM_EXT).find(([, exts]) => exts.includes(ext))?.[0] || 'nes';
        startCloudDownload(sid, fname, url, row.querySelector('.cloud-dl-btn'));
      });
    });
  } catch {
    filesEl.innerHTML = '<p class="cloud-empty">COULD NOT LOAD FILES.</p>';
  }
}

/**
 * Fuzzy-match a downloaded filename + systemId to a KenteLibrary game.
 * Returns the game object or null.
 */
function findGameForDownload(systemId, filename) {
  const norm     = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const baseName = norm(filename.replace(/\.[^.]+$/, ''));
  return window.KenteLibrary?.games.find(g => {
    if (g.systemId !== systemId) return false;
    const t = norm(g.title);
    return t === baseName || baseName.includes(t) || t.includes(baseName);
  }) || null;
}

async function startCloudDownload(systemId, filename, url, btn) {
  const bar        = document.getElementById('cloud-download-bar');
  const fill       = document.getElementById('cloud-progress-fill');
  const pct        = document.getElementById('cloud-download-pct');
  const label      = document.getElementById('cloud-download-label');
  const playNowBtn = document.getElementById('cloud-play-now-btn');

  // Server mode: queue into the Download Control Center so downloads run in the
  // background with real progress + retries (instead of the legacy /api/download
  // fire-and-forget path).
  if (KENTE_SERVER_ONLINE) {
    btn.classList.remove('busy');
    btn.classList.add('queued');
    btn.textContent = '⏳ QUEUED';
    label.textContent = `QUEUED ${filename} — OPEN DOWNLOAD CENTER`;
    fill.classList.remove('indeterminate');
    fill.style.width = '0%';
    pct.textContent = '';
    bar.classList.add('hidden');

    const game = findGameForDownload(systemId, filename) || {
      id:       `dl_${systemId}_${Date.now()}`,
      title:    filename.replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').trim(),
      system:   systemId.toUpperCase(),
      systemId,
      tier:     3,
      img:      null,
    };

    await DownloadManager.enqueue(game, url, filename);
    openDownloadCenter();
    return;
  }

  // Reset play button from any previous download
  playNowBtn.hidden  = true;
  playNowBtn.onclick = null;

  btn.classList.add('busy');
  bar.classList.remove('hidden');
  label.textContent = `DOWNLOADING ${filename}`;
  fill.style.width  = '0%';
  pct.textContent   = '0%';

  try {
    const result = await downloadToLibrary(systemId, filename, url, progress => {
      if (progress < 0) {
        // No Content-Length header — show animated indeterminate bar
        fill.classList.add('indeterminate');
        pct.textContent = '···';
      } else {
        fill.classList.remove('indeterminate');
        const p = Math.round(progress * 100);
        fill.style.width = p + '%';
        pct.textContent  = p + '%';
      }
    });

    btn.classList.remove('busy');
    btn.classList.add('success');
    btn.textContent   = '✓ SAVED';
    label.textContent = `✓ ${filename} SAVED`;
    fill.classList.remove('indeterminate');
    fill.style.width  = '100%';
    pct.textContent   = '100%';

    // ── PLAY NOW logic ────────────────────────────────────────
    const game = findGameForDownload(systemId, filename);
    if (game) {
      // Matched catalog entry — use RomDB handle or returned fileHandle, then stream URL as last resort
      playNowBtn.hidden      = false;
      playNowBtn.textContent = '▶ PLAY NOW';
      playNowBtn.onclick     = async () => {
        document.getElementById('cloud-overlay').classList.remove('active');
        playNowBtn.hidden = true;
        // Native mode: ROM was saved to server disk — hand off to Batocera
        if (KENTE_SERVER_ONLINE) { launchNative(game); return; }
        // Browser mode: prefer indexed handle → downloaded fileHandle → cloud stream
        const handle = await RomDB.get(game.id) || result?.fileHandle || null;
        if (handle) {
          launchWithEmulatorJS(game, handle);
        } else {
          launchWithEmulatorJS(game, url, { url, filename, systemId });
        }
      };
    } else if (result?.fileHandle && CORE_MAP[systemId]) {
      // File saved but not in catalog — build a minimal game object and play from handle
      const unlisted = {
        id:       `dl_${Date.now()}`,
        title:    filename.replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').trim(),
        system:   systemId.toUpperCase(),
        systemId,
      };
      playNowBtn.hidden      = false;
      playNowBtn.textContent = '▶ PLAY (UNLISTED)';
      playNowBtn.onclick     = () => {
        document.getElementById('cloud-overlay').classList.remove('active');
        playNowBtn.hidden = true;
        launchWithEmulatorJS(unlisted, result.fileHandle);
      };
    }

    KenteAudio.powerUp?.();
  } catch (err) {
    btn.classList.remove('busy');
    fill.classList.remove('indeterminate');
    playNowBtn.hidden = true;

    if (err.message === 'NO_LIBRARY' || err.message === 'NO_PERMISSION') {
      // No library folder — offer streaming as fallback instead of a dead end
      const game = findGameForDownload(systemId, filename);
      if (game) {
        bar.classList.remove('hidden');
        fill.style.width  = '0%';
        pct.textContent   = '';
        label.textContent = '⚠ NO LIBRARY — CANNOT SAVE TO DISK';
        playNowBtn.hidden      = false;
        playNowBtn.textContent = '▶ STREAM INSTEAD';
        playNowBtn.onclick     = () => {
          document.getElementById('cloud-overlay').classList.remove('active');
          playNowBtn.hidden = true;
          launchWithEmulatorJS(game, url, { url, filename, systemId });
        };
        showToast('⚠ STORAGE UNAVAILABLE — STREAM INSTEAD OR CHECK BROWSER PERMISSIONS');
      } else {
        bar.classList.add('hidden');
        showToast('⚠ DOWNLOAD FAILED — BROWSER STORAGE UNAVAILABLE');
      }
    } else {
      bar.classList.add('hidden');
      showToast(`⚠ DOWNLOAD FAILED — ${err.message.slice(0, 80)}`);
    }
  }
}
