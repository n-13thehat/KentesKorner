/* Kente's Korner — Theater detail overlay. */
'use strict';

/* ── Detail overlay ──────────────────────────────────────────────────────
   `title` is an optional hint passed by the caller (e.g. from a saved
   My-List entry).  Embed providers (vidsrc / 2embed / vidsrcpm /
   multiembed) use it to resolve metadata when their in-memory reverse-
   lookup cache is cold (server restart, fresh worker, etc).             */
async function openTheaterDetail(provider, kind, slug, title) {
  if (!provider || !slug) return;
  const overlay = document.getElementById('theater-detail-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  overlay.innerHTML = `
    <button type="button" class="theater-detail-close" id="theater-detail-close">✕ CLOSE</button>
    <div class="theater-detail-backdrop"></div>
    <div class="theater-detail-scrim"></div>
    <div class="theater-detail-panel">
      <div class="theater-detail-poster"></div>
      <div class="theater-detail-body">
        <div class="theater-empty">LOADING DETAILS…</div>
      </div>
    </div>`;
  requestAnimationFrame(() => overlay.classList.add('active'));
  overlay.querySelector('#theater-detail-close')
    .addEventListener('click', closeTheaterDetail);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeTheaterDetail();
  });
  KenteAudio.click();

  try {
    const detailQs = { provider, kind, slug };
    if (title) detailQs.title = title;
    const d = await _theaterFetch('/api/theater/details', detailQs, 18000);
    _renderTheaterDetail(provider, d);
  } catch (e) {
    console.warn('[Kente/theater] details failed:', e);
    const body = overlay.querySelector('.theater-detail-body');
    if (body) body.innerHTML = '<div class="theater-error">⚠ COULD NOT LOAD DETAILS</div>';
  }
}

function closeTheaterDetail() {
  const overlay = document.getElementById('theater-detail-overlay');
  if (!overlay) return;
  overlay.classList.remove('active');
  setTimeout(() => { overlay.hidden = true; overlay.innerHTML = ''; }, 280);
  // Hand focus back to the underlying theater rows so controller nav resumes there.
  requestAnimationFrame(() => GamepadManager.resetFocus());
}

function _renderTheaterDetail(provider, d) {
  const overlay = document.getElementById('theater-detail-overlay');
  if (!overlay || !d) return;
  const bd = overlay.querySelector('.theater-detail-backdrop');
  if (bd && (d.backdrop || d.poster)) bd.style.backgroundImage = `url("${d.backdrop || d.poster}")`;
  const posterEl = overlay.querySelector('.theater-detail-poster');
  if (posterEl && d.poster) posterEl.style.backgroundImage = `url("${d.poster}")`;

  const meta = [d.year, _fmtRuntime(d.runtime), d.quality,
                d.rating != null ? '★ ' + d.rating : '']
                  .filter(Boolean).map(escHtml).join('  ·  ');
  const genres = (d.genres || []).map(g =>
    `<span class="theater-detail-genre">${escHtml(g)}</span>`).join('');
  // Treat backend kind=='show' as show even when seasons is null (offline fallback).
  const isShow = d.type === 'show' || d.kind === 'show' || Array.isArray(d.seasons);
  const offline = !!d.unavailable;
  // Backend may redirect (e.g. lookmovie -> vidsrc when upstream is down). Use
  // the response-provided provider/slug so PLAY and episode clicks hit the new
  // route. Falls back to the closure-captured provider for legacy responses.
  const effProvider = d.provider || provider;
  const slug = d.slug || d.id;

  // Stash the canonical item for the player (used by resume + My List).
  const item = {
    provider: effProvider, kind: isShow ? 'show' : 'movie', type: isShow ? 'show' : 'movie',
    slug, id: slug, title: d.title || '', poster: d.poster || '',
    backdrop: d.backdrop || '', year: d.year || '', rating: d.rating ?? null,
    quality: d.quality || '', synopsis: d.synopsis || '',
    runtime: (typeof d.runtime === 'number' ? d.runtime : null),
  };
  TheaterState.currentItem = item;

  // ▶ PLAY for movies; both branches get a "+ MY LIST" toggle.
  // When the upstream is down (offline), suppress play and show a banner.
  const playBtn = (isShow || offline) ? '' :
    `<button class="theater-detail-btn primary" type="button" id="theater-play-btn">▶ PLAY</button>`;
  const offlineBanner = offline
    ? `<div class="theater-unavailable">⚠ STREAMING SOURCE TEMPORARILY UNAVAILABLE — SHOWING SUMMARY ONLY</div>`
    : '';
  const actionsHtml = `
    <div class="theater-detail-actions">
      ${playBtn}
      <button class="theater-detail-btn" type="button" id="theater-mylist-btn">+ MY LIST</button>
    </div>`;

  const epsHtml = (isShow && !offline) ? `
    <div class="theater-eps-section" id="theater-eps-section">
      <div class="theater-eps-tabs" id="theater-eps-tabs">
        ${(d.seasons || []).map((s, i) =>
          `<button class="theater-eps-tab${i===0?' active':''}" data-season="${i}">SEASON ${escHtml(String(s.number || i+1))}</button>`).join('')}
      </div>
      <div class="theater-eps-list" id="theater-eps-list"></div>
    </div>` : '';

  overlay.querySelector('.theater-detail-body').innerHTML = `
    <h2 class="theater-detail-title">${escHtml(d.title || '')}</h2>
    <div class="theater-detail-meta">${meta}</div>
    <div class="theater-detail-genres">${genres}</div>
    ${offlineBanner}
    <div class="theater-detail-synopsis">${escHtml(d.synopsis || '')}</div>
    ${actionsHtml}${epsHtml}`;

  // Wire the My List toggle and reflect current state.
  const myBtn = overlay.querySelector('#theater-mylist-btn');
  const setMyBtn = on => {
    if (!myBtn) return;
    myBtn.textContent = on ? '✓ IN MY LIST' : '+ MY LIST';
    myBtn.classList.toggle('active', !!on);
  };
  TheaterDB.inList(item).then(setMyBtn);
  myBtn?.addEventListener('click', async () => {
    const on = await TheaterDB.inList(item);
    if (on) { await TheaterDB.removeFromList(item); setMyBtn(false); showToast('REMOVED FROM MY LIST'); }
    else    { await TheaterDB.addToList(item);      setMyBtn(true);  showToast('+ ADDED TO MY LIST'); }
    KenteAudio.click();
  });

  if (!isShow && !offline) {
    overlay.querySelector('#theater-play-btn').addEventListener('click', () =>
      _theaterStartStream(effProvider, 'movie', slug, null, d.title, item));
  } else if (isShow && !offline) {
    const seasons = d.seasons || [];
    // Flatten seasons -> single episode list once; attached to ctx so the
    // player can drive prev/next without re-fetching the detail payload.
    const epsFlat = [];
    seasons.forEach((s, si) => {
      (s.episodes || []).forEach((ep, ei) => {
        // Episode ids come back as ints for some providers and strings for others.
        // Normalize to string so epIndex matching + prev/next works reliably.
        const epId = String(ep.id || ep.slug || '');
        epsFlat.push({
          id:     epId,
          season: s.number || si + 1,
          number: ep.number || ei + 1,
          title:  ep.title  || ('Episode ' + (ei + 1)),
          thumbnail: ep.thumbnail || ep.thumb || ep.image || '',
        });
      });
    });
    item._episodes = epsFlat;
    const showSeason = (idx) => {
      const list = document.getElementById('theater-eps-list');
      if (!list) return;
      const eps = (seasons[idx] && seasons[idx].episodes) || [];
      list.innerHTML = eps.map((ep, i) => `
        <div class="theater-ep-row" tabindex="0"
             data-ep-id="${escHtml(ep.id || ep.slug || '')}">
          <div class="theater-ep-num">${escHtml(String(ep.number || i+1))}</div>
          <div class="theater-ep-title">${escHtml(ep.title || ('Episode ' + (i+1)))}</div>
        </div>`).join('') || '<div class="theater-empty">NO EPISODES</div>';
      list.querySelectorAll('.theater-ep-row').forEach(row => {
        row.addEventListener('click', () => {
          const epId = row.dataset.epId;
          const epTitle = row.querySelector('.theater-ep-title')?.textContent || d.title;
          _theaterStartStream(effProvider, 'show', slug, epId,
            `${d.title} — ${epTitle}`,
            { ...item, episodeId: epId, episodeTitle: epTitle, _episodes: epsFlat });
        });
      });
    };
    overlay.querySelectorAll('#theater-eps-tabs .theater-eps-tab').forEach(t =>
      t.addEventListener('click', e => {
        overlay.querySelectorAll('#theater-eps-tabs .theater-eps-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        showSeason(parseInt(t.dataset.season, 10));
      }));
    if (seasons.length) showSeason(0);
  }
  // Seed gamepad focus on the first action so controllers can drive the panel.
  requestAnimationFrame(() => GamepadManager.applyFocus(0));
}

async function _theaterStartStream(provider, kind, slug, episodeId, title, ctx) {
  showToast('▶ RESOLVING STREAM…');
  try {
    const qs = { provider, kind, slug };
    if (episodeId) qs.episode_id = episodeId;
    // Title hint lets embed providers prime their reverse-lookup cache for
    // deep-linked / cold-cache calls (drives the anime source-switcher pill).
    if (title) qs.title = title;
    const data = await _theaterFetch('/api/theater/stream', qs, 20000);
    // Embed providers (vidsrc / 2embed / vidsrcpm / multiembed) return a
    // top-level `embed` URL instead of decoded streams. The browser loads
    // it directly inside an <iframe>; CORS-restricted assets resolve client-
    // side without our proxy.
    if (data && data.embed) {
      openTheaterEmbed({ embed: data.embed, source: data, provider },
                       title || 'PLAYBACK',
                       ctx || TheaterState.currentItem);
      return;
    }
    const streams = data && data.streams || {};
    const qualities = Object.keys(streams);
    if (!qualities.length) throw new Error('NO_STREAMS');
    // ctx is the canonical item (with optional episodeId/episodeTitle) so the
    // player can resume / persist progress against the right TheaterDB key.
    openTheaterVideo({ streams, qualities, source: data }, title || 'PLAYBACK',
                     ctx || TheaterState.currentItem);
  } catch (e) {
    console.warn('[Kente/theater] stream failed:', e);
    showToast('⚠ COULD NOT RESOLVE STREAM');
  }
}
