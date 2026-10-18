/* Kente's Korner — Theater menu, state and TheaterDB. */
'use strict';

/* ── THEATER MENU ──
   Netflix-style browser backed by /api/theater/*.  contentTheater() returns
   the static scaffold (toolbar + skeleton rows); hydrateTheaterMenu() runs
   right after paint and fills each row from the kente-server endpoints.    */
const THEATER_ROWS = [
  // Each row pulls one /api/theater/browse, /search, or /curated request.
  // local: rows are populated from TheaterDB (My List + Continue Watching)
  // and stay hidden until the store has at least one entry.
  // curated rows ignore the movies/shows tab filter — they show in both.
  // Landing rows are anime + game-adaptation focused; universal media is
  // still reachable via the search fan-out.
  { id:'continue',    title:'CONTINUE WATCHING',  sub:'PICK UP WHERE YOU LEFT OFF', local:'continue' },
  { id:'mylist',      title:'MY LIST',            sub:'YOUR SAVED TITLES',          local:'mylist'   },
  // baddieseast.pro is search-only — Baddies USA / Zeus reality shows are
  // surfaced by typing the title into the search bar (provider joins the
  // SEARCH_PROVIDERS fan-out below). No home rows on purpose.
  // Anime — Miruro scrapes direct MP4; embed providers (vidsrc/2embed) carry
  // the films and series via IMDB iframe.
  { id:'miruro-trending',  title:'MIRURO TRENDING',  sub:'LATEST ANIME FROM MIRURO.RO',           provider:'miruro',   curated:'trending' },
  { id:'anime-films',      title:'ANIME FILMS',      sub:'STUDIO GHIBLI · AKIRA · YOUR NAME',      provider:'vidsrc',   curated:'anime-films'  },
  { id:'anime-series',     title:'ANIME SERIES',     sub:'AOT · DEMON SLAYER · JJK · ONE PIECE',   provider:'2embed',   curated:'anime-series' },
  // Game adaptations — live-action films on vidsrc, prestige TV on 2embed.
  { id:'game-movies',      title:'GAME ADAPTATIONS · FILMS', sub:'SONIC · MARIO · TOMB RAIDER · MORTAL KOMBAT', provider:'vidsrc', curated:'game-movies' },
  { id:'game-shows',       title:'GAME ADAPTATIONS · SHOWS', sub:'LAST OF US · ARCANE · CASTLEVANIA · HALO',    provider:'2embed', curated:'game-shows'  },
  // Game walkthroughs — YouTube-sourced, plays inside the embed iframe.
  { id:'walkthroughs',     title:'GAME WALKTHROUGHS', sub:'YOUTUBE · PART 1 GUIDES',               provider:'youtube',  curated:'walkthroughs' },
  // Catalog rows kept for synopsis quality / archive coverage.
  { id:'top-anime',        title:'TOP ANIME',        sub:'GREATEST HITS',                          provider:'lookmovie', curated:'top-anime' },
  { id:'classics',         title:'ANIME CLASSICS',   sub:'INUYASHA · GHOST IN THE SHELL · AKIRA',  provider:'lookmovie', curated:'classics' },
  { id:'franchises',       title:'ACTION FRANCHISES', sub:'NARUTO · DBZ · POKÉMON · BEYBLADE',     provider:'lookmovie', curated:'action-franchises' },
  { id:'archive',          title:'PUBLIC DOMAIN',    sub:'ARCHIVE.ORG',           provider:'archive', kind:'movies', page:1 },
];

function contentTheater() {
  const skeletons = Array.from({ length: 8 }, () => '<div class="theater-skel"></div>').join('');
  const rows = THEATER_ROWS.map(r => `
    <div class="theater-row" data-row="${r.id}">
      <div class="theater-row-header">
        <div class="theater-row-title">${escHtml(r.title)}</div>
        <div class="theater-row-sub">${escHtml(r.sub)}</div>
      </div>
      <div class="theater-row-scroller" id="theater-row-${r.id}">${skeletons}</div>
    </div>`).join('');

  return `
    <div class="theater-hero" id="theater-hero">
      <div class="theater-hero-slide active" style="background:linear-gradient(135deg,#0a0820,#1a1040)"></div>
      <div class="theater-hero-info">
        <h2 class="theater-hero-title">LOADING THEATER&hellip;</h2>
        <div class="theater-hero-meta">FETCHING TODAY&apos;S HIGHLIGHTS</div>
        <div class="theater-hero-synopsis">Streaming library is warming up.</div>
      </div>
      <div class="theater-hero-actions"></div>
      <div class="theater-hero-dots"></div>
    </div>
    <div class="theater-toolbar">
      <button class="filter-chip active" data-theater-tab="movies">MOVIES</button>
      <button class="filter-chip"        data-theater-tab="shows">SHOWS</button>
      <div class="theater-search">
        <span class="theater-search-icon">⌕</span>
        <input type="search" id="theater-search-input" placeholder="SEARCH TITLES…" autocomplete="off">
      </div>
    </div>
    <div id="theater-rows">${rows}</div>`;
}

/* ── Theater state + helpers ── */
const TheaterState = {
  rowItems: {},     // rowId -> [items]
  hero:     [],     // up to 5 hero items
  heroIdx:  0,
  heroTimer: null,
  searchTimer: null,
  activeTab: 'movies',
  currentItem: null,    // last item opened in the detail overlay (used by player)
};

/* ── TheaterDB ──
   IndexedDB-backed persistence for "My List" (favourites) and
   "Continue Watching" (resume positions).  All methods return
   Promises and degrade gracefully if IDB is unavailable.        */
const TheaterDB = (() => {
  const DB_NAME = 'kente_theater';
  const DB_VER  = 1;
  let _dbP = null;

  function _open() {
    if (_dbP) return _dbP;
    if (!('indexedDB' in window)) return Promise.reject(new Error('NO_IDB'));
    _dbP = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('mylist'))
          db.createObjectStore('mylist',   { keyPath: 'key' });
        if (!db.objectStoreNames.contains('progress')) {
          const s = db.createObjectStore('progress', { keyPath: 'key' });
          s.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return _dbP;
  }

  async function _txn(store, mode, fn) {
    try {
      const db = await _open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const os = tx.objectStore(store);
        const out = fn(os);
        tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error);
      });
    } catch (_e) { return null; }
  }

  function keyOf(item) {
    return `${item.provider || 'lookmovie'}:${item.kind || item.type || 'movie'}:${item.slug || item.id}`;
  }

  // Strip an item down to the fields needed to re-render a poster card.
  function _capture(item) {
    return {
      provider: item.provider || 'lookmovie',
      kind:     item.kind || item.type || 'movie',
      type:     item.type || item.kind || 'movie',
      slug:     item.slug || item.id || '',
      id:       item.id   || item.slug || '',
      title:    item.title    || '',
      poster:   item.poster   || '',
      backdrop: item.backdrop || '',
      year:     item.year     || '',
      rating:   item.rating   != null ? item.rating : null,
      quality:  item.quality  || '',
      synopsis: item.synopsis || '',
    };
  }

  // ── My List ───────────────────────────────────────────────
  async function addToList(item) {
    const rec = { ..._capture(item), key: keyOf(item), addedAt: Date.now() };
    await _txn('mylist', 'readwrite', s => s.put(rec));
    document.dispatchEvent(new CustomEvent('theater-mylist-changed'));
    return rec;
  }
  async function removeFromList(item) {
    await _txn('mylist', 'readwrite', s => s.delete(keyOf(item)));
    document.dispatchEvent(new CustomEvent('theater-mylist-changed'));
  }
  async function inList(item) {
    const r = await _txn('mylist', 'readonly', s => s.get(keyOf(item)));
    return !!r;
  }
  async function getList() {
    const out = await _txn('mylist', 'readonly', s => s.getAll());
    if (!out) return [];
    return out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  // ── Continue Watching ─────────────────────────────────────
  // ctx: { provider, kind, slug, title, poster, year, rating,
  //        episodeId?, episodeTitle? }
  // Smart Resume: treat as completed when we're inside the last 90 s (so the
  // 'ended' handler / Up Next card can take over) or past the 95% mark.
  // Both rules clear the saved record so the next launch starts fresh.
  async function saveProgress(ctx, position, duration) {
    if (!ctx || !(position > 0)) return;
    if (duration && (position > 0.95 * duration || (duration - position) <= 90)) {
      return clearProgress(ctx);
    }
    const rec = {
      ..._capture(ctx),
      key: keyOf(ctx),
      episodeId:    ctx.episodeId    || null,
      episodeTitle: ctx.episodeTitle || null,
      position,
      duration: duration || 0,
      updatedAt: Date.now(),
    };
    await _txn('progress', 'readwrite', s => s.put(rec));
    document.dispatchEvent(new CustomEvent('theater-progress-changed'));
  }
  async function getProgress(ctx) {
    if (!ctx) return null;
    return _txn('progress', 'readonly', s => s.get(keyOf(ctx)));
  }
  async function clearProgress(ctx) {
    if (!ctx) return;
    await _txn('progress', 'readwrite', s => s.delete(keyOf(ctx)));
    document.dispatchEvent(new CustomEvent('theater-progress-changed'));
  }
  async function getRecent(limit = 20) {
    const out = await _txn('progress', 'readonly', s => s.getAll());
    if (!out) return [];
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit);
  }

  return { keyOf, addToList, removeFromList, inList, getList,
           saveProgress, getProgress, clearProgress, getRecent };
})();

function _theaterUrl(path, qs) {
  const p = new URLSearchParams(qs || {});
  return `${KENTE_SERVER_URL}${path}?${p}`;
}

async function _theaterFetch(path, qs, timeout = 15000) {
  const res = await fetch(_theaterUrl(path, qs), { signal: _abortTimeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Render integer minutes as a compact, all-caps chip:
//   < 60  -> "25 MIN"
//   ≥ 60  -> "2H 5M" (omits trailing minutes when zero -> "2H")
function _fmtRuntime(min) {
  const n = Number(min);
  if (!n || !isFinite(n) || n <= 0) return '';
  if (n < 60) return `${Math.round(n)} MIN`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return m ? `${h}H ${m}M` : `${h}H`;
}

// Populate / clear the player header meta chip (runtime / source / etc.).
// Hides the chip when there's nothing to show so the layout collapses cleanly.
function _tvpSetHeaderMeta(parts) {
  const el = document.getElementById('theater-video-meta');
  if (!el) return;
  const text = (parts || []).filter(Boolean).join('  ·  ');
  el.textContent = text;
  el.hidden = !text;
}

function _theaterPosterCard(it, provider) {
  const poster  = it.poster ? escHtml(it.poster) : '';
  const title   = escHtml(it.title || '');
  const year    = it.year   ? escHtml(String(it.year))    : '';
  const quality = it.quality ? escHtml(it.quality)        : '';
  const rating  = it.rating != null ? escHtml(String(it.rating)) : '';
  const sub     = [year, rating ? '★ ' + rating : ''].filter(Boolean).join(' · ');
  const badge   = quality ? `<div class="theater-poster-badge">${quality}</div>` : '';
  const img     = poster
    ? `<img src="${poster}" alt="${title}" loading="lazy" onerror="this.style.display='none'">`
    : '';
  // Resume progress bar — only rendered for Continue Watching cards
  // where _progressPct is set by the local-row loader (0–100).
  const progressBar = (it._progressPct != null)
    ? `<div class="theater-poster-progress"><div class="theater-poster-progress-fill"
        style="width:${Math.max(2, Math.min(100, it._progressPct)).toFixed(1)}%"></div></div>`
    : '';
  const prov = it.provider || provider || 'lookmovie';
  const kind = it.kind || it.type || 'movie';
  return `<div class="theater-poster" tabindex="0"
              data-provider="${escHtml(prov)}"
              data-kind="${escHtml(kind)}"
              data-slug="${escHtml(it.slug || it.id || '')}"
              data-title="${title}">
            ${img}${badge}${progressBar}
            <div class="theater-poster-meta">
              <div class="theater-poster-title">${title}</div>
              <div class="theater-poster-sub">${sub}</div>
            </div>
          </div>`;
}

async function hydrateTheaterMenu() {
  if (!KENTE_SERVER_ONLINE) {
    const wrap = document.getElementById('theater-rows');
    if (wrap) wrap.innerHTML =
      '<p class="theater-empty">⚠ KENTE SERVER OFFLINE — START kente-server.py TO BROWSE THE THEATER.</p>';
    return;
  }
  // Wire toolbar (search + tabs).  Tabs filter the visible rows by kind.
  const tabs = document.querySelectorAll('[data-theater-tab]');
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    TheaterState.activeTab = t.dataset.theaterTab;
    document.querySelectorAll('#theater-rows .theater-row').forEach(rowEl => {
      const cfg = THEATER_ROWS.find(r => r.id === rowEl.dataset.row);
      if (!cfg) return;
      // Local rows (mylist/continue) only show when populated — preserve
      // whatever state the loader picked.  Curated + archive rows show in
      // both tabs (mixed-kind content).  Single-kind rows are filtered.
      if (cfg.local) {
        const items = TheaterState.rowItems[cfg.id] || [];
        rowEl.style.display = items.length ? '' : 'none';
        return;
      }
      const visible = cfg.curated || cfg.provider === 'archive'
                   || cfg.kind === TheaterState.activeTab;
      rowEl.style.display = visible ? '' : 'none';
    });
  }));

  // Live-refresh the local rows whenever a write to TheaterDB occurs.
  if (!hydrateTheaterMenu._idbBound) {
    hydrateTheaterMenu._idbBound = true;
    document.addEventListener('theater-mylist-changed',  _theaterRefreshLocalRows);
    document.addEventListener('theater-progress-changed', _theaterRefreshLocalRows);
  }

  const input = document.getElementById('theater-search-input');
  if (input && !hydrateTheaterMenu._searchBound) {
    hydrateTheaterMenu._searchBound = true;
    input.addEventListener('input', e => {
      clearTimeout(TheaterState.searchTimer);
      const q = e.target.value.trim();
      TheaterState.searchTimer = setTimeout(() => _theaterRunSearch(q), 320);
    });
    // Open the themed virtual keyboard whenever the search box is engaged.
    // While open, KenteOSK gates global keyboard / gamepad menu nav so arrow
    // keys, A/B, etc. drive the OSK instead of the surrounding rows.
    const launchOSK = () => {
      if (!KenteOSK.active()) KenteOSK.open(input);
    };
    input.addEventListener('focus', launchOSK);
    input.addEventListener('click', launchOSK);
  }

  // Fire all rows in parallel — first one back also seeds the hero rotator.
  await Promise.all(THEATER_ROWS.map(_theaterLoadRow));
  _theaterBuildHero();
}

async function _theaterLoadRow(cfg) {
  const el = document.getElementById('theater-row-' + cfg.id);
  if (!el) return;
  // Local rows (My List / Continue Watching) read from IndexedDB and
  // hide their containing .theater-row when the store is empty.
  if (cfg.local) return _theaterLoadLocalRow(cfg, el);
  try {
    let data;
    if (cfg.curated) {
      // Curated slates: server resolves a hand-picked title list to listings.
      // First call may take ~5–10 s while individual searches warm the cache;
      // subsequent loads are instant (24 h cached).
      data = await _theaterFetch('/api/theater/curated',
        { provider: cfg.provider, slate: cfg.curated }, 30000);
    } else {
      const qs = { provider: cfg.provider, kind: cfg.kind, page: cfg.page };
      if (cfg.genre) qs.genre = cfg.genre;
      data = await _theaterFetch('/api/theater/browse', qs);
    }
    const items = (data && data.items) || [];
    TheaterState.rowItems[cfg.id] = items;
    if (!items.length) { el.innerHTML = '<div class="theater-empty">— EMPTY —</div>'; return; }
    el.innerHTML = items.map(it => _theaterPosterCard(it, cfg.provider)).join('');
  } catch (e) {
    console.warn('[Kente/theater] row load failed:', cfg.id, e);
    el.innerHTML = `<div class="theater-error">⚠ ${escHtml(cfg.title)} UNAVAILABLE</div>`;
  }
}

async function _theaterLoadLocalRow(cfg, el) {
  const rowEl = el.closest('.theater-row');
  let items = [];
  try {
    if (cfg.local === 'mylist') {
      items = await TheaterDB.getList();
    } else if (cfg.local === 'continue') {
      const recent = await TheaterDB.getRecent(20);
      items = recent.map(r => {
        const dur = r.duration || 0;
        const pct = dur > 0 ? (r.position / dur) * 100 : 0;
        return { ...r, _progressPct: pct };
      });
    }
  } catch (e) {
    console.warn('[Kente/theater] local row failed:', cfg.id, e);
  }
  TheaterState.rowItems[cfg.id] = items;
  if (!items.length) {
    // Hide the entire row container when the store is empty —
    // these rows only appear once the user has interacted.
    if (rowEl) rowEl.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  if (rowEl) {
    // Curated/local rows ignore the movies/shows tab filter.
    const visible = true;
    rowEl.style.display = visible ? '' : 'none';
  }
  el.innerHTML = items.map(it => _theaterPosterCard(it, it.provider || 'lookmovie')).join('');
}

// Refresh just the My List + Continue Watching rows.  Called after
// IDB writes (toggle MY LIST, save/clear progress) so the landing
// reflects new state without a full re-hydrate.
async function _theaterRefreshLocalRows() {
  await Promise.all(THEATER_ROWS
    .filter(r => r.local)
    .map(cfg => {
      const el = document.getElementById('theater-row-' + cfg.id);
      if (el) return _theaterLoadLocalRow(cfg, el);
    }));
}

async function _theaterRunSearch(query) {
  const wrap = document.getElementById('theater-rows');
  if (!wrap) return;
  if (!query) {
    // Restore the standard rows scaffold.
    const skel = Array.from({ length: 8 }, () => '<div class="theater-skel"></div>').join('');
    wrap.innerHTML = THEATER_ROWS.map(r => `
      <div class="theater-row" data-row="${r.id}">
        <div class="theater-row-header">
          <div class="theater-row-title">${escHtml(r.title)}</div>
          <div class="theater-row-sub">${escHtml(r.sub)}</div>
        </div>
        <div class="theater-row-scroller" id="theater-row-${r.id}">${skel}</div>
      </div>`).join('');
    THEATER_ROWS.forEach(_theaterLoadRow);
    return;
  }
  wrap.innerHTML = `
    <div class="theater-row">
      <div class="theater-row-header">
        <div class="theater-row-title">SEARCH RESULTS</div>
        <div class="theater-row-sub">"${escHtml(query)}"</div>
      </div>
      <div class="theater-row-scroller" id="theater-row-search">
        ${Array.from({length:6}, () => '<div class="theater-skel"></div>').join('')}
      </div>
    </div>`;
  // Fan out across all live providers in parallel.  De-duped by lower-cased
  // title + provider + slug so identical titles from different sources can
  // both appear (the user picks which embed to use). Lookmovie is included
  // for completeness even though its streams are gated.
  const opts = { q: query, kind: TheaterState.activeTab };
  // youtube returns walkthroughs; included so search results surface
  // walkthrough videos for any game title typed into the OSK.
  // baddies covers Zeus reality TV (Baddies USA et al.) — search-only.
  const SEARCH_PROVIDERS = ['miruro', 'vidsrc', '2embed', 'vidsrcpm', 'multiembed', 'youtube', 'lookmovie', 'baddies'];
  const results = await Promise.allSettled(SEARCH_PROVIDERS.map(p =>
    _theaterFetch('/api/theater/search', { provider: p, ...opts })));
  const merged = [];
  const seen = new Set();
  results.forEach((r, idx) => {
    const prov = SEARCH_PROVIDERS[idx];
    if (r.status !== 'fulfilled') return;
    for (const it of (r.value && r.value.items) || []) {
      const key = `${it.provider || prov}|${(it.title || '').toLowerCase()}|${it.slug || it.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...it, provider: it.provider || prov });
    }
  });
  const el = document.getElementById('theater-row-search');
  if (!el) return;
  if (!merged.length) {
    const allFailed = results.every(r => r.status === 'rejected');
    el.innerHTML = allFailed
      ? '<div class="theater-error">⚠ SEARCH FAILED</div>'
      : '<div class="theater-empty">NO MATCHES</div>';
    return;
  }
  el.innerHTML = merged.map(it => _theaterPosterCard(it, it.provider)).join('');
}

function _theaterBuildHero() {
  // Pick up to 5 highlights from "trending" first, fall back to any other row.
  const pool = (TheaterState.rowItems.trending || []).slice(0, 5);
  if (!pool.length) return;
  TheaterState.hero = pool;
  TheaterState.heroIdx = 0;

  const hero = document.getElementById('theater-hero');
  if (!hero) return;
  // One slide div per highlight, all stacked. _theaterShowHero toggles .active.
  hero.querySelectorAll('.theater-hero-slide').forEach(n => n.remove());
  pool.forEach((it, i) => {
    const s = document.createElement('div');
    s.className = 'theater-hero-slide' + (i === 0 ? ' active' : '');
    if (it.backdrop || it.poster) s.style.backgroundImage = `url("${it.backdrop || it.poster}")`;
    hero.insertBefore(s, hero.firstChild);
  });
  const dotsEl = hero.querySelector('.theater-hero-dots');
  if (dotsEl) {
    dotsEl.innerHTML = pool.map((_, i) =>
      `<div class="theater-hero-dot${i===0?' active':''}" data-hero-idx="${i}"></div>`).join('');
    dotsEl.querySelectorAll('[data-hero-idx]').forEach(d => d.addEventListener('click', e => {
      _theaterShowHero(parseInt(e.target.dataset.heroIdx, 10));
      _theaterRestartHeroTimer();
    }));
  }
  _theaterShowHero(0);
  _theaterRestartHeroTimer();
}

function _theaterShowHero(idx) {
  const hero = document.getElementById('theater-hero');
  if (!hero || !TheaterState.hero.length) return;
  const i = (idx + TheaterState.hero.length) % TheaterState.hero.length;
  TheaterState.heroIdx = i;
  const it = TheaterState.hero[i];
  const slides = hero.querySelectorAll('.theater-hero-slide');
  slides.forEach((s, k) => s.classList.toggle('active', k === i));
  const dots = hero.querySelectorAll('.theater-hero-dot');
  dots.forEach((d, k) => d.classList.toggle('active', k === i));

  const info = hero.querySelector('.theater-hero-info');
  if (info) {
    const meta = [it.year, it.quality, it.rating != null ? '★ ' + it.rating : '']
      .filter(Boolean).map(escHtml).join('  ·  ');
    info.innerHTML = `
      <h2 class="theater-hero-title">${escHtml(it.title || '')}</h2>
      <div class="theater-hero-meta">${meta}</div>
      <div class="theater-hero-synopsis">${escHtml(it.synopsis || '')}</div>`;
  }
  const actions = hero.querySelector('.theater-hero-actions');
  if (actions) {
    actions.innerHTML = `
      <button class="theater-hero-btn" type="button" data-hero-action="open">▶ DETAILS</button>`;
    actions.querySelector('[data-hero-action="open"]').onclick = () => {
      openTheaterDetail(
        it.provider || 'lookmovie',
        it.kind || it.type || 'movie',
        it.slug || it.id,
        it.title);
    };
  }
}

function _theaterRestartHeroTimer() {
  clearInterval(TheaterState.heroTimer);
  TheaterState.heroTimer = setInterval(() => {
    // Pause rotation if Theater menu is no longer the active screen.
    const menu = document.getElementById('menu-theater');
    if (!menu || !menu.classList.contains('active')) {
      clearInterval(TheaterState.heroTimer); TheaterState.heroTimer = null; return;
    }
    _theaterShowHero(TheaterState.heroIdx + 1);
  }, 7000);
}
