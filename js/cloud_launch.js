/* Kente's Korner — Cloud launch (mirror collection, single-mirror fetch). */
'use strict';

/* ══════════════════════════════════════════
   CLOUD LAUNCH — stream directly from Archive.org
══════════════════════════════════════════ */

// _currentCloudRomData removed — cloud ROM metadata is now passed explicitly
// as the optional third argument cloudRomData to launchWithEmulatorJS.

/* ── Mirror collection ─────────────────────────────────────────────────────
   Builds an ordered list of candidate download URLs for a game so the cloud
   launch path can fall through to the next mirror when one returns 5xx
   (typically archive.org under load) instead of immediately surfacing an
   error to the user. Order:
     1. Multi-provider /api/roms/sources (when kente-server is reachable) —
        already cross-provider ranked, ledger-biased.
     2. Legacy archive.org sweep — collects every region-acceptable file
        across the first several search hits, not just the single best one,
        so each archive.org item exposes all its file variants as mirrors.
   Deduplicates by URL. Returns [] if nothing was found.                    */
function _guessFilenameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'rom'); }
  catch { return 'rom'; }
}

async function _collectCloudMirrors(game) {
  const mirrors = [];
  const seen    = new Set();
  const _push = (m) => {
    if (!m?.url || seen.has(m.url)) return;
    seen.add(m.url);
    mirrors.push(m);
  };

  // Phase A — multi-provider via kente-server. Already ranked + ledger-biased
  // by fetchRomSources(); we just dedupe and forward them as-is.
  if (KENTE_SERVER_ONLINE) {
    try {
      const sources = await fetchRomSources(game.systemId, game.title);
      for (const s of sources) {
        _push({
          url:      s.url,
          filename: s.filename || _guessFilenameFromUrl(s.url),
          provider: s.provider || 'unknown',
          size:     Number(s.size) || 0,
        });
      }
    } catch (_) { /* fall through to archive sweep */ }
  }

  // Phase B — legacy archive.org sweep. Skipped when Phase A already returned
  // a healthy set (≥3 candidates) so we don't double-search archive.org on
  // every launch — the sweep is expensive (1 search + up to 8 metadata calls)
  // and only valuable as a fallback when /api/roms/sources gave us little.
  // Threshold of 3 keeps at least two backup mirrors in reserve.
  if (mirrors.length >= 3) return mirrors;
  try {
    let results = await searchArchive(game.title, game.systemId);
    if (!results.length) {
      const packHits = await searchPackCollection(game.title, game.systemId);
      for (const f of packHits || []) {
        if (!f?.url) continue;
        _push({ url: f.url, filename: f.name || _guessFilenameFromUrl(f.url),
                provider: 'archive_packs', size: 0 });
      }
    }
    const validExts = new Set((ROM_EXT[game.systemId] || []).map(e => e.toLowerCase()));
    const _normWords = s => s.toLowerCase().replace(/[^a-z0-9 ]/g,' ')
                                           .split(/\s+/).filter(w => w.length > 2);
    const titleWords = new Set(_normWords(game.title));
    const RGN_USA = /\((usa|world|en)\b/i;
    const RGN_EU  = /\((europe|eur|eu)\b/i;
    const RGN_JP  = /\((japan|jpn|jp)\b/i;
    // Per-system extension preference (mirrors rom_providers.py _EXT_RANK).
    // Single-file/archive formats sorted before raw .cue/.bin so disc systems
    // pick .chd/.zip over an orphan .cue that the emulator can't open.
    const EXT_RANK = EXT_RANK_BY_SYS[game.systemId] || null;
    const extScore = (name) => {
      if (!EXT_RANK) return 0;
      const nl = name.toLowerCase();
      for (let i = 0; i < EXT_RANK.length; i++) {
        if (nl.endsWith(EXT_RANK[i])) return EXT_RANK.length - i;
      }
      return 0;
    };
    // True iff `name` is a .cue/.ccd with at least one sibling .bin/.img/.sub
    // in the same item. Orphan cues (no companion data tracks) are unusable.
    const hasCompanion = (name, all) => {
      const nl = name.toLowerCase();
      if (!nl.endsWith('.cue') && !nl.endsWith('.ccd')) return true;
      const stem = nl.replace(/\.(cue|ccd)$/, '');
      return all.some(o => {
        const ol = o.name.toLowerCase();
        if (ol === nl) return false;
        if (!ol.endsWith('.bin') && !ol.endsWith('.img') && !ol.endsWith('.sub')) return false;
        const oStem = ol.replace(/\.[^.]+$/, '');
        return oStem.startsWith(stem) || stem.includes(oStem) || oStem.includes(stem);
      });
    };
    for (const result of (results || []).slice(0, 8)) {
      let files;
      try { files = await getArchiveFiles(result.identifier, game.systemId); }
      catch (_) { continue; }
      const valid = files.filter(f => {
        const ext = '.' + f.name.split('.').pop().toLowerCase();
        if (!validExts.has(ext)) return false;
        if (CONTAINER_FORMATS.has(ext)) {
          const sz = parseInt(f.size || '0');
          return sz === 0 || sz >= CONTAINER_MIN_BYTES;
        }
        return true;
      });
      if (!valid.length) continue;
      const byTitle = valid.filter(f => _normWords(f.name).some(w => titleWords.has(w)));
      const pool = byTitle.length ? byTitle : valid;
      // Composite score: orphan-cue penalty → ext rank → region → file size.
      pool.sort((a, b) => {
        const orphan = n => (hasCompanion(n, valid) ? 0 : -10);
        const region = n => RGN_USA.test(n) ? 3
                          : !RGN_EU.test(n) && !RGN_JP.test(n) ? 2
                          : RGN_EU.test(n) ? 1 : 0;
        return (orphan(b.name) - orphan(a.name))
            || (extScore(b.name) - extScore(a.name))
            || (region(b.name)   - region(a.name))
            || ((Number(b.size)||0) - (Number(a.size)||0));
      });
      for (const f of pool) {
        const url = `https://archive.org/download/${result.identifier}/${encodeURIComponent(f.name)}`;
        _push({ url, filename: f.name, provider: 'archive', size: Number(f.size) || 0 });
      }
    }
  } catch (e) {
    if (DEBUG) console.warn('[Kente/cloud/mirrors] archive sweep failed:', e.message);
  }

  return mirrors;
}

/* ── Single-mirror fetch ───────────────────────────────────────────────────
   Downloads one candidate URL through the best-available transport and
   streams the body into a blob with progress updates. Throws on failure
   (UPSTREAM_/HTTP_/NO_BODY/network) so the caller's mirror loop can advance
   to the next candidate. Transport selection mirrors the original cloud
   launch path: native-server proxy first, then dev-server proxy, then
   direct fetch with two public CORS proxies as last resort.

   `allowCorsProxies` (default true) lets the caller suppress the corsproxy.io
   / allorigins.win fallback when there are more mirrors to try — advancing to
   the next URL is cheaper than bouncing a failed URL through two public
   proxies. Only the final mirror in the loop should pass true.            */
async function _streamMirror(mirror, game, statusEl, allowCorsProxies = true) {
  let fetchUrl = mirror.url;
  let savedBatoceraPath = null;

  if (KENTE_SERVER_ONLINE) {
    const pp = new URLSearchParams({
      url:      mirror.url,
      save:     '1',
      systemId: game.systemId,
      filename: mirror.filename,
    });
    fetchUrl = `${KENTE_SERVER_URL}/api/rom-proxy?${pp}`;
  } else {
    try {
      const ping = await fetch(`${KENTE_SERVER_URL}/api/ping`,
        { signal: _abortTimeout(1500), cache: 'no-store' });
      if (ping.ok) {
        fetchUrl = `${KENTE_SERVER_URL}/api/rom-proxy?url=${encodeURIComponent(mirror.url)}`;
      }
    } catch (_) { /* server not running — try direct then CORS proxies */ }
  }

  const _streamRom = async (url) => {
    const r = await fetch(url);
    if (!r.ok)   throw new Error(await _proxyErrorTag(r));
    if (!r.body) throw new Error('NO_BODY');
    return r;
  };

  let resp;
  if (fetchUrl !== mirror.url) {
    if (DEBUG) console.log(`[Kente/dl] proxy: ${fetchUrl.slice(0, 80)}...`);
    resp = await _streamRom(fetchUrl);
    savedBatoceraPath = resp.headers.get('X-Kente-Saved-Path');
  } else {
    let lastErr = null;
    try {
      if (DEBUG) console.log('[Kente/dl] Trying direct fetch...');
      resp = await _streamRom(mirror.url);
    } catch (e) {
      lastErr = e;
      console.warn('[Kente/dl] direct fetch failed:', e.message);
    }
    if (!resp && allowCorsProxies) {
      const CORS_PROXIES = [
        u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
        u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      ];
      for (const buildProxy of CORS_PROXIES) {
        const proxiedUrl = buildProxy(mirror.url);
        try {
          if (statusEl && statusEl()) statusEl().textContent = 'RETRYING VIA CORS PROXY...';
          resp = await _streamRom(proxiedUrl);
          break;
        } catch (e) {
          lastErr = e;
          console.warn(`[Kente/dl] proxy failed (${proxiedUrl.slice(0, 40)}):`, e.message);
        }
      }
    }
    if (!resp) throw lastErr || new Error('ALL_PROXIES_FAILED');
  }

  // Stream body with live progress
  const total  = Number(resp.headers.get('Content-Length')) || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (statusEl && statusEl()) {
      const mb     = (received / 1_048_576).toFixed(1);
      const pctStr = total ? ` · ${Math.round(received / total * 100)}%` : '';
      statusEl().textContent = `DOWNLOADING ROM... ${mb} MB${pctStr}`;
    }
  }

  return {
    blobUrl: URL.createObjectURL(new Blob(chunks)),
    savedBatoceraPath,
  };
}

async function launchFromCloud(game) {
  const core = CORE_MAP[game.systemId];
  if (!core) {
    showToast(`⚠ ${game.system} NOT SUPPORTED IN BROWSER MODE`);
    return;
  }

  // Cloud ROM metadata accumulated during this launch — passed explicitly to
  // launchWithEmulatorJS and the save button instead of through a global variable.
  let _cloudRomData = null;

  // Show overlay immediately with search status
  const overlay   = document.getElementById('emulator-overlay');
  const container = document.getElementById('ejs-container');
  document.getElementById('ejs-game-title').textContent   = game.title;
  document.getElementById('ejs-system-badge').textContent = game.system.toUpperCase();
  document.getElementById('ejs-loader')?.remove();
  container.innerHTML = `
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
                justify-content:center;gap:16px;color:#555;font-family:var(--font-mono);font-size:12px;
                letter-spacing:0.2em">
      <div id="ejs-load-spinner" style="width:36px;height:36px;border:2px solid #222;border-top-color:#e8a000;
           border-radius:50%;animation:ejs-spin 0.8s linear infinite"></div>
      <div id="ejs-load-status">SEARCHING CLOUD...</div>
    </div>
    <style>@keyframes ejs-spin{to{transform:rotate(360deg)}}</style>`;
  overlay.classList.add('active');
  state.screen = 'playing';
  KenteAudio.setHumVol(0);
  document.getElementById('ejs-exit').onclick = showIngameMenu;

  const statusEl = () => document.getElementById('ejs-load-status');

  try {
    // 1 — Build a ranked mirror list across all available providers. We hit
    //     kente-server's /api/roms/sources for cross-provider ranking when
    //     reachable, then sweep archive.org directly so single-provider
    //     outages still leave fallback URLs to try. Mirror loop below cycles
    //     through these on UPSTREAM/HTTP 5xx before surfacing the error UI.
    if (statusEl()) statusEl().textContent = 'SEARCHING MIRRORS...';
    const mirrors = await _collectCloudMirrors(game);
    if (!mirrors.length) throw new Error('NO_RESULTS');
    if (DEBUG) console.log(`[Kente/cloud] ${mirrors.length} mirrors collected`);

    // Seed _cloudRomData with the first archive.org mirror so the OPEN ON
    // ARCHIVE.ORG fallback link in the error UI works even if every download
    // attempt fails. Updated again to the actual mirror that succeeds.
    {
      const _archHost = m => { try { return /(^|\.)archive\.org$/i.test(new URL(m.url).hostname); } catch { return false; } };
      const seed = mirrors.find(_archHost) || mirrors[0];
      _cloudRomData = { url: seed.url, filename: seed.filename, systemId: game.systemId };
    }

    // 2 — Walk the mirror list. On UPSTREAM_/HTTP_5xx/NO_BODY/network failures
    //     advance to the next mirror before surfacing the error UI. Each
    //     attempt's outcome is recorded in RomSourceLedger so future searches
    //     re-rank away from chronically-failing hosts.
    let blobUrl = null, savedBatoceraPath = null, lastErr = null;
    let usedMirror = null;

    for (let i = 0; i < mirrors.length; i++) {
      const mirror    = mirrors[i];
      const provLabel = (mirror.provider || 'unknown').toUpperCase().replace(/_/g, ' ');
      const sizeMb    = mirror.size ? ` (${(mirror.size / 1_048_576).toFixed(0)} MB)` : '';
      if (statusEl()) {
        const prefix = mirrors.length > 1
          ? `MIRROR ${i + 1}/${mirrors.length} · ${provLabel} — `
          : '';
        statusEl().textContent = `${prefix}DOWNLOADING ROM${sizeMb}...`;
      }

      // In browser-only mode each failed mirror would otherwise cost 3 fetches
      // (direct + 2 CORS proxies). When more mirrors remain to try, advancing
      // to the next URL is faster than bouncing this one through CORS proxies
      // — reserve the proxy fallback for the final mirror only.
      const allowCorsProxies = KENTE_SERVER_ONLINE || (i === mirrors.length - 1);

      try {
        const out = await _streamMirror(mirror, game, statusEl, allowCorsProxies);
        blobUrl           = out.blobUrl;
        savedBatoceraPath = out.savedBatoceraPath;
        usedMirror        = mirror;
        RomSourceLedger.onSuccess(mirror.provider);
        if (DEBUG) console.log(`[Kente/cloud] mirror ${i + 1}/${mirrors.length} (${provLabel}) succeeded`);
        break;
      } catch (mirrorErr) {
        lastErr = mirrorErr;
        RomSourceLedger.onFail(mirror.provider);
        console.warn(`[Kente/cloud] mirror ${i + 1}/${mirrors.length} (${provLabel}) failed: ${mirrorErr.message}`);
      }
    }

    if (!blobUrl) {
      console.error('[KenteKorner] all mirrors exhausted:', lastErr?.message);
      // Preserve the actual cause (HTTP_<n> / UPSTREAM_<n>_<HOST> / NO_BODY)
      // so the renderer can show "DOWNLOAD FAILED (UPSTREAM 503 ARCHIVE.ORG)".
      throw new Error((lastErr && lastErr.message) || 'DOWNLOAD_FAILED');
    }

    // Update _cloudRomData to the mirror that actually succeeded so the Save
    // button re-fetches from a known-good URL.
    _cloudRomData = { url: usedMirror.url, filename: usedMirror.filename, systemId: game.systemId };

    // If the native server saved a copy to Batocera, mark it as locally available
    if (savedBatoceraPath) {
      ROM_STATUS[game.id] = true;
      refreshGameCardDots();
      console.log(`[Kente] ROM persisted to Batocera: ${savedBatoceraPath}`);
    }

    if (statusEl()) statusEl().textContent = 'ROM READY — STARTING EMULATOR...';

    // 5 — Pass the local blob URL to EmulatorJS (treated as a "cloud" URL in the UI
    //     since it came from the cloud — save button and cloud badge stay visible).
    await launchWithEmulatorJS(game, blobUrl, _cloudRomData);

  } catch (err) {
    // Snapshot the found ROM url — used for the "Open on Archive.org" fallback
    const failedRomUrl = _cloudRomData?.url || null;

    // Classify the error for the user-facing message
    let errLine1, errLine2, showArchiveLink = false;
    if (err.message === 'NO_RESULTS' || err.message === 'NO_ROM_FILE') {
      errLine1 = 'ROM NOT FOUND';
      errLine2 = `COULD NOT FIND A FILE FOR<br><span style="color:#777">${escHtml(game.title)}</span><br>ON ARCHIVE.ORG`;
    } else if (err.message === 'DOWNLOAD_FAILED' ||
               err.message?.startsWith('HTTP_') ||
               err.message?.startsWith('UPSTREAM_')) {
      // UPSTREAM_<status>_<HOST> => " (UPSTREAM 503 ARCHIVE.ORG)"
      // HTTP_<status>            => " (502)"
      let code = '';
      if (err.message.startsWith('UPSTREAM_')) {
        code = ' (' + err.message.replace(/^UPSTREAM_/, 'UPSTREAM ').replace(/_/g, ' ') + ')';
      } else if (err.message.startsWith('HTTP_')) {
        code = ` (${err.message.slice(5)})`;
      }
      errLine1 = `DOWNLOAD FAILED${code}`;
      // CORS on Archive.org CDN redirects is the most common cause in browser-only mode.
      // Offer a direct link so the user can grab the file manually and load it.
      errLine2 = err.message.startsWith('UPSTREAM_')
        ? 'THE SOURCE SITE RETURNED AN ERROR.<br>OPEN THE FILE DIRECTLY TO DOWNLOAD MANUALLY,<br>THEN USE "LOAD ROM FILE" BELOW.'
        : 'THE ROM WAS FOUND BUT COULD NOT BE FETCHED.<br>OPEN THE FILE ON ARCHIVE.ORG TO DOWNLOAD MANUALLY,<br>THEN USE "LOAD ROM FILE" BELOW.';
      showArchiveLink = !!failedRomUrl;
    } else {
      errLine1 = 'SEARCH FAILED';
      errLine2 = 'CHECK YOUR INTERNET CONNECTION<br>AND TRY AGAIN';
    }

    // Keep the emulator overlay open — inject an inline error state so the user
    // stays in the full-screen flow and can retry or manually load a file.
    // Do NOT call showRomOptions() — that breaks the immersion with a separate screen.
    const con = document.getElementById('ejs-container');
    if (con) {
      const archiveLinkBtn = showArchiveLink
        ? `<a id="ejserr-archive" href="${escHtml(failedRomUrl)}" target="_blank" rel="noopener"
             style="display:block;background:#0a1a0a;border:1px solid #1a3a1a;color:#30d880;
                    font-family:var(--font-mono);font-size:10px;letter-spacing:0.2em;
                    padding:13px 0;cursor:pointer;text-decoration:none;text-align:center">
             ↗ &nbsp;OPEN ON ARCHIVE.ORG
           </a>`
        : '';

      con.innerHTML = `
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
                    justify-content:center;gap:14px;color:#555;font-family:var(--font-mono);
                    font-size:11px;letter-spacing:0.15em;text-align:center;padding:32px">
          <div style="font-size:28px;opacity:0.25;margin-bottom:2px">◎</div>
          <div style="color:var(--brand,#e8a000);letter-spacing:0.25em">${errLine1}</div>
          <div style="color:#3a3a3a;font-size:10px;line-height:2.2;max-width:300px">${errLine2}</div>
          <div style="display:flex;flex-direction:column;gap:10px;width:260px;margin-top:10px">
            ${archiveLinkBtn}
            <button id="ejserr-retry"
              style="background:#111;border:1px solid #2a2a2a;color:#aaa;font-family:var(--font-mono);
                     font-size:10px;letter-spacing:0.2em;padding:13px 0;cursor:pointer">
              ↺ &nbsp;RETRY SEARCH
            </button>
            <button id="ejserr-pick"
              style="background:transparent;border:1px solid #181818;color:#3a3a3a;font-family:var(--font-mono);
                     font-size:10px;letter-spacing:0.2em;padding:11px 0;cursor:pointer">
              🗂 &nbsp;LOAD ROM FILE MANUALLY
            </button>
          </div>
        </div>`;

      document.getElementById('ejserr-retry').addEventListener('click', () => {
        launchFromCloud(game);
      });
      document.getElementById('ejserr-pick').addEventListener('click', () => {
        // exitEmulator resets overlay, state.screen, and audio cleanly
        exitEmulator();
        openRomPickerForGame(game);
      });
    } else {
      // Fallback: container gone — reset to room state
      overlay.classList.remove('active');
      state.screen = 'room';
      KenteAudio.setHumVol(0.018);
    }
  }
}
