/* Kente's Korner — Download manager. */
'use strict';

/* ══════════════════════════════════════════
   DOWNLOAD MANAGER
   Background download queue — fans out across rom_providers via
   /api/roms/sources, streams each ROM through kente-server's proxy
   (which saves it to disk), and auto-falls-back to the next source on
   any download error. Adaptive ledger learns which hosts are reliable.
   One download at a time; completed items persist to DownloadDB.
══════════════════════════════════════════ */
const DownloadManager = (() => {
  // item shape: { id, game, status, progress, total, filename, archiveUrl, error,
  //              _reader, _attempt, _speedMBs, _etaSec, _lastBytes, _lastTime, _dlAt }
  // status: 'queued' | 'searching' | 'downloading' | 'complete' | 'error'
  let _items      = [];
  let _busy       = false;
  let _rafPending = false;  // throttle panel re-renders to one per animation frame

  const MAX_AUTO_RETRIES = 2;
  const RETRY_DELAY_MS   = 3000;
  const STREAM_CHUNK_TIMEOUT_MS = 45_000;   // 45s no-data → retry
  // Large ISOs (PS2/PS3/WiiU/Switch) can take a long time on slow links.
  // Allow multi-hour transfers; stalled-chunk handling is enforced separately.
  const PROXY_FETCH_TIMEOUT_MS  = 4 * 60 * 60 * 1000;  // 4 hours total per file

  function _uid() {
    return 'dl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  }

  function _mkItem(id, game) {
    return { id, game, status: 'queued', progress: 0, total: 0,
             filename: null, archiveUrl: null, sourceName: null, error: null, _reader: null, _controller: null,
             _sources: null, _sourceIdx: null, _activeSource: null,
             _directUrl: null, _directFilename: null, autoLaunch: false,
             _attempt: 0, _speedMBs: 0, _etaSec: null, _lastBytes: 0, _lastTime: 0, _dlAt: null };
  }

  const _pendingKey = 'kente_pending_downloads_v1';
  function _pendingGames() {
    try {
      const rows = JSON.parse(localStorage.getItem(_pendingKey) || '[]');
      return Array.isArray(rows) ? rows.filter(row => row && typeof row.id === 'string'
        && typeof row.title === 'string' && typeof row.systemId === 'string') : [];
    } catch { return []; }
  }
  function _persistPending() {
    const pending = _items.filter(item => item.status !== 'complete'
      && !item._directUrl && !item._directFilename && item.game?.id)
      .map(item => ({ id: String(item.game.id), title: String(item.game.title || item.game.id),
        systemId: String(item.game.systemId || ''), system: String(item.game.system || ''),
        year: String(item.game.year || '') }));
    try { localStorage.setItem(_pendingKey, JSON.stringify(pending.slice(0, 100))); } catch {}
  }

  /* ── classify errors into user-readable messages ── */
  function _classifyError(err, httpStatus) {
    if (err.name === 'AbortError') return null;          // caller handles cancelled
    if (httpStatus === 403)  return 'BLOCKED BY ARCHIVE.ORG';
    if (httpStatus === 404)  return 'FILE NOT FOUND ON ARCHIVE.ORG';
    if (httpStatus === 429)  return 'RATE LIMITED — TRY AGAIN LATER';
    if (httpStatus === 502 || httpStatus === 503) return 'PROXY ERROR — ARCHIVE UNREACHABLE';
    if (httpStatus >= 400)   return `SERVER ERROR HTTP ${httpStatus}`;
    const msg = err.message || '';
    if (msg.includes('TIMEOUT') || msg.includes('timeout')) return 'DOWNLOAD STALLED — RETRYING';
    if (msg.includes('NO_STREAM'))   return 'PROXY RETURNED NO DATA STREAM';
    if (msg.includes('INCOMPLETE'))  return `TRANSFER INCOMPLETE — RETRYING`;
    if (msg.includes('HTTP_'))       return `PROXY ERROR — ${msg}`;
    return 'NETWORK ERROR — CHECK CONNECTION';
  }

  /* ── enqueue: add a game to the background download queue ── */
  async function enqueue(game, urlOrOpts, filenameMaybe, optsMaybe) {
    // Signature:
    //   enqueue(game)
    //   enqueue(game, { url, filename, autoLaunch })
    //   enqueue(game, url, filename, { autoLaunch })
    let opts = {};
    if (typeof urlOrOpts === 'string') {
      opts = (optsMaybe && typeof optsMaybe === 'object') ? optsMaybe : {};
      opts.url = urlOrOpts;
      opts.filename = filenameMaybe || opts.filename;
    } else if (urlOrOpts && typeof urlOrOpts === 'object') {
      opts = urlOrOpts;
    }

    if (_items.find(i => i.game.id === game.id && i.status !== 'error')) {
      showToast(`⬇ ${game.title.toUpperCase()} IS ALREADY IN THE QUEUE`);
      openDownloadCenter();
      return;
    }
    const id = _uid();
    const item = _mkItem(id, game);
    if (opts.url) item._directUrl = String(opts.url);
    if (opts.filename) item._directFilename = String(opts.filename);
    if (opts.sourceName) item.sourceName = String(opts.sourceName);
    if (opts.autoLaunch) item.autoLaunch = true;
    _items.push(item);
    _persistPending();
    _notify();
    showToast(`⬇ QUEUED — ${game.title.toUpperCase()}`);
    _tick();
    return id;
  }

  /* ── cancel: stop and remove any item ── */
  function cancel(id) {
    const item = _items.find(i => i.id === id);
    if (!item) return;
    _items = _items.filter(i => i.id !== id);
    _persistPending();
    item._controller?.abort(new DOMException('Download canceled', 'AbortError'));
    // The queue worker owns _busy until its task has unwound. Starting another
    // worker here lets the canceled task clear the next task's busy flag.
    _tick();
    _notify();
  }

  /* ── remove: delete a completed/errored entry from panel + IndexedDB ── */
  async function remove(id) {
    cancel(id);
    await DownloadDB.remove(id).catch(() => {});
    _notify();
  }

  /* ── retry (manual): re-queue a failed item ── */
  function retry(id) {
    const item = _items.find(i => i.id === id && i.status === 'error');
    if (!item) return;
    Object.assign(item, {
      status: 'queued', progress: 0, total: 0, error: null, _attempt: 0,
      _sources: null, _sourceIdx: null, _activeSource: null, sourceName: null,
    });
    _persistPending();
    _notify();
    _tick();
  }

  /* ── cycleSource: user pressed the SOURCE pill on an active/errored card ──
     Advances to the next ranked candidate, restarts the download.            */
  function cycleSource(id) {
    const item = _items.find(i => i.id === id);
    if (!item || !item._sources?.length) return;
    item._sourceIdx = ((item._sourceIdx || 0) + 1) % item._sources.length;
    item._controller?.abort(new DOMException('Source changed', 'AbortError'));
    Object.assign(item, { status: 'queued', progress: 0, total: 0, error: null, _attempt: 0 });
    _persistPending();
    _notify();
    _tick();
  }

  /* ── clearCompleted: remove all READY TO PLAY entries ── */
  async function clearCompleted() {
    const done = _items.filter(i => i.status === 'complete');
    if (!done.length) return;
    _items = _items.filter(i => i.status !== 'complete');
    await Promise.all(done.map(i => DownloadDB.remove(i.id).catch(() => {})));
    _notify();
    try { _refreshRecentDownloadsShelf(); } catch {}
    try { showToast(`✕ CLEARED ${done.length} DOWNLOAD${done.length!==1?'S':''}`); } catch {}
  }

  /* ── _tick: start next queued item ── */
  async function _tick() {
    if (_busy) return;
    const next = _items.find(i => i.status === 'queued');
    if (!next) return;
    _busy = true;
    try {
      await _download(next);
    } catch (err) {
      if (_items.includes(next)) {
        next.status = 'error';
        next.error = _classifyError(err, null) || 'DOWNLOAD INTERRUPTED';
        _notify();
      }
      console.error('[DownloadManager]', err);
    } finally {
      // Always clear the flag — even if _download() throws an unexpected exception
      // that wasn't caught internally.  Without this the queue freezes permanently.
      _busy = false;
      _tick();
    }
  }

  /* ── Shared helpers for stream + completion (used by both new fast path
        and legacy archive-only path inside _download)                    */
  function _withAbort(promise, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      }, err => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  }

  function _pause(ms, signal) {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  async function _streamBodyInto(item, resp, signal) {
    const expected = Number(resp.headers.get('Content-Length')) || 0;
    item.total = expected || item.total || 0;
    const reader = resp.body.getReader();
    item._reader = reader;
    let complete = false;
    try {
      while (true) {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('STREAM_TIMEOUT')), STREAM_CHUNK_TIMEOUT_MS);
        });
        let chunk;
        try {
          chunk = await _withAbort(Promise.race([reader.read(), timeout]), signal);
        } finally {
          clearTimeout(timer);
        }
        const { done, value } = chunk;
        if (done) break;
        item.progress += value.length;
        const now = Date.now();
        if (now - item._lastTime >= 800) {
          const dt = (now - item._lastTime) / 1000;
          const db = item.progress - item._lastBytes;
          item._speedMBs = db / dt / 1_048_576;
          item._lastBytes = item.progress;
          item._lastTime = now;
          if (item._speedMBs > 0 && item.total)
            item._etaSec = (item.total - item.progress) / (item._speedMBs * 1_048_576);
        }
        _notify();
      }
      if (expected > 0 && item.progress !== expected) {
        throw new Error(`INCOMPLETE (${item.progress}/${expected} bytes)`);
      }
      if (!item.progress) throw new Error('NO_STREAM');
      complete = true;
    } finally {
      if (item._reader === reader) item._reader = null;
      if (!complete) reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch {}
    }
  }

  async function _markDownloadComplete(item) {
    item.status    = 'complete';
    item._speedMBs = 0; item._etaSec = null; item._dlAt = Date.now();
    _persistPending();
    ROM_STATUS[item.game.id] = true;
    refreshGameCardDots();
    if (item.sourceName) RomSourceLedger.onSuccess(item.sourceName);
    _notify();
    // Live-refresh the Recently Downloaded shelf if the user is on Play/Collections
    try { _refreshRecentDownloadsShelf(); } catch {}
    showToast(`✓ SAVED TO ROMS FOLDER — ${item.game.title.toUpperCase()}`);
    await DownloadDB.add({
      id: item.id, gameId: item.game.id, game: item.game,
      filename: item.filename, systemId: item.game.systemId,
      systemName: item.game.system || item.game.systemId.toUpperCase(),
      archiveUrl: item.archiveUrl, downloadedAt: item._dlAt, sizeBytes: item.progress,
      sourceName: item.sourceName || null,
      storage: 'server',
    }).catch(() => {});
    if (!_items.includes(item)) {
      await DownloadDB.remove(item.id).catch(() => {});
      return;
    }

    // Auto-launch once (used when the user clicked a game that wasn't on disk yet).
    if (item.autoLaunch) {
      item.autoLaunch = false;
      _notify();
      let blocked = false;
      try { blocked = !!_launchInProgress; } catch {}
      try { blocked = blocked || (state?.screen === 'playing' || state?.screen === 'paused'); } catch {}
      if (!blocked) {
        setTimeout(() => { try { launchFromDownloadCenter(item.id); } catch {} }, 250);
      }
    }
  }

  /* ── _download: search + stream with auto-retry + multi-source fallback ── */
  async function _download(item) {
    if (!_items.includes(item)) return;
    const controller = new AbortController();
    item._controller = controller;
    const signal = controller.signal;
    const wait = promise => _withAbort(promise, signal);
    const deadline = setTimeout(() => controller.abort(
      new DOMException('DOWNLOAD_TIMEOUT', 'TimeoutError')), PROXY_FETCH_TIMEOUT_MS);
    const RGN_USA  = /\((usa|world|en)\b/i;
    const RGN_EU   = /\((europe|eur|eu)\b/i;
    const RGN_JP   = /\((japan|jpn|jp)\b/i;
    const CONT_EXT = new Set(['.zip', '.rar', '.7z']);
    let   httpStatus = null;

    item._attempt += 1;

    try {
      // ── 0. Direct URL mode (known URL + filename) ───────────────────────
      // Used by the Cloud Browser "SAVE" button and any other entry point that
      // already has an exact download URL. Skips the source-search layer.
      if (item._directUrl) {
        const rawName = (() => {
          try {
            const tail = (item._directUrl.split('/').pop() || '').split('?')[0];
            return decodeURIComponent(tail);
          } catch { return ''; }
        })();
        item.filename   = item._directFilename || rawName || item.filename;
        item.archiveUrl = item._directUrl;
        item.sourceName = item.sourceName || 'direct';

        item.status = 'downloading'; item.progress = 0;
        item.total = 0;
        item._speedMBs = 0; item._etaSec = null;
        item._lastBytes = 0; item._lastTime = Date.now();
        _notify();

        if (!item.game?.systemId || !item.filename) throw new Error('MISSING_METADATA');

        const pp = new URLSearchParams({
          url: item._directUrl, save: '1',
          systemId: item.game.systemId, filename: item.filename,
        });
        const resp = await wait(fetch(`${KENTE_SERVER_URL}/api/rom-proxy?${pp}`, { signal }));
        httpStatus = resp.status;
        if (!resp.ok)   throw new Error(await _proxyErrorTag(resp));
        if (!resp.body) throw new Error('NO_STREAM');
        await _streamBodyInto(item, resp, signal);
        await _markDownloadComplete(item);
        return;
      }

      // ── 1a. Multi-source resolve via /api/roms/sources ─────────────────
      // Cached on the item so a retry / source-cycle reuses the ranked list
      // instead of re-querying the backend.
      if (!item._sources) {
        item.status = 'searching'; _notify();
        item._sources   = await wait(fetchRomSources(item.game.title && item.game.systemId
                                                ? item.game.systemId : null,
                                                item.game.title));
        item._sourceIdx = item._sources?.length ? 0 : null;
      }

      // Fast path — use the picked source's direct URL (no per-item file scan).
      if (item._sources?.length && item._sourceIdx != null && item._sources[item._sourceIdx]) {
        const pick = item._sources[item._sourceIdx];
        item.filename     = pick.filename;
        item.archiveUrl   = pick.url;
        item.sourceName   = pick.provider;
        item._activeSource = pick;

        item.status = 'downloading'; item.progress = 0;
        item.total = pick.size || 0;
        item._speedMBs = 0; item._etaSec = null;
        item._lastBytes = 0; item._lastTime = Date.now();
        _notify();

        const pp = new URLSearchParams({
          url: pick.url, save: '1',
          systemId: item.game.systemId, filename: pick.filename,
        });
        const resp = await wait(fetch(`${KENTE_SERVER_URL}/api/rom-proxy?${pp}`, { signal }));
        httpStatus = resp.status;
        if (!resp.ok)   throw new Error(await _proxyErrorTag(resp));
        if (!resp.body) throw new Error('NO_STREAM');
        await _streamBodyInto(item, resp, signal);
        await _markDownloadComplete(item);
        return;
      }

      // ── 1b. Legacy fallback — Archive.org subject search + pack scan ───
      item.status = 'searching'; _notify();
      let results = await wait(searchArchive(item.game.title, item.game.systemId));

      if (!results.length) {
        const packs = await wait(searchPackCollection(item.game.title, item.game.systemId));
        const vExts = new Set((ROM_EXT[item.game.systemId] || []).map(e => e.toLowerCase()));
        const valid = packs.filter(f => {
          const ext = '.' + f.name.split('.').pop().toLowerCase();
          return !vExts.size || vExts.has(ext);
        });
        const bp = valid.find(f => RGN_USA.test(f.name)) ||
                   valid.find(f => !RGN_EU.test(f.name) && !RGN_JP.test(f.name)) || valid[0];
        if (bp) results = [{ _packUrl: bp.url, _packName: bp.name }];
      }
      if (!results.length) {
        item.status = 'error'; item.error = 'NOT FOUND ON ARCHIVE.ORG'; _notify(); return;
      }

      // ── 2. Pick best ROM file ──────────────────────────────────────────
      const vExts   = new Set((ROM_EXT[item.game.systemId] || []).map(e => e.toLowerCase()));
      const _norm   = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
      const _tWords = new Set(_norm(item.game.title));
      let romUrl = null, romFilename = null;

      for (const result of results.slice(0, 15)) {
        if (result._packUrl) { romUrl = result._packUrl; romFilename = result._packName; break; }
        let files;
        try { files = await wait(getArchiveFiles(result.identifier, item.game.systemId)); }
        catch (err) { if (signal.aborted) throw err; continue; }
        const valid = files.filter(f => {
          const ext = '.' + f.name.split('.').pop().toLowerCase();
          if (!vExts.has(ext)) return false;
          if (CONT_EXT.has(ext)) { const sz = parseInt(f.size || '0'); return sz === 0 || sz >= 10_000_000; }
          return true;
        });
        if (!valid.length) continue;
        const byTitle = valid.filter(f => _norm(f.name).some(w => _tWords.has(w)));
        const pool    = byTitle.length ? byTitle : valid;
        const match   = pool.find(f => RGN_USA.test(f.name)) ||
                        pool.find(f => !RGN_EU.test(f.name) && !RGN_JP.test(f.name)) || pool[0];
        romFilename = match.name;
        romUrl = `https://archive.org/download/${result.identifier}/${encodeURIComponent(match.name)}`;
        break;
      }
      if (!romUrl) { item.status = 'error'; item.error = 'ROM FILE NOT FOUND'; _notify(); return; }
      item.filename = romFilename; item.archiveUrl = romUrl;

      // ── 3. Stream via proxy ────────────────────────────────────────────
      item.status = 'downloading'; item.progress = 0;
      item._speedMBs = 0; item._etaSec = null;
      item._lastBytes = 0; item._lastTime = Date.now();
      _notify();

      const pp   = new URLSearchParams({ url: romUrl, save: '1', systemId: item.game.systemId, filename: romFilename });
      const resp = await wait(fetch(`${KENTE_SERVER_URL}/api/rom-proxy?${pp}`, { signal }));
      httpStatus = resp.status;
      if (!resp.ok)   throw new Error(await _proxyErrorTag(resp));
      if (!resp.body) throw new Error('NO_STREAM');

      await _streamBodyInto(item, resp, signal);
      await _markDownloadComplete(item);

    } catch (err) {
      // If item was removed by cancel() while we were awaiting, just exit
      if (!_items.find(i => i.id === item.id)) return;
      item._reader = null;
      if (signal.aborted) err = signal.reason;

      const classified = _classifyError(err, httpStatus);
      if (!classified) return;   // AbortError from user cancel — item removed above handles it

      // Penalize the active source so the ledger biases away on next launch.
      if (item.sourceName) RomSourceLedger.onFail(item.sourceName);

      // ── Multi-source fallback: try the next ranked source before giving up ──
      // Doesn't consume an _attempt slot — switching hosts is cheaper than
      // a full network retry, and most failures here are host-specific.
      if (item._sources?.length && item._sourceIdx != null
          && item._sourceIdx + 1 < item._sources.length) {
        item._sourceIdx += 1;
        item.progress   = 0; item.total = 0;
        item.error      = null;
        item.status     = 'queued';
        _notify();
        await _pause(600, signal);
        if (!signal.aborted && _items.includes(item)) {
          item._attempt -= 1;  // un-charge the attempt counter for this fallback
          await _download(item);
        }
        return;
      }

      // Transient errors (network / timeout / incomplete) get auto-retried
      const isTransient = !httpStatus || httpStatus >= 500 ||
        err.message?.includes('TIMEOUT') || err.message?.includes('INCOMPLETE') ||
        (!httpStatus && err.name !== 'AbortError');

      if (isTransient && item._attempt < MAX_AUTO_RETRIES) {
        const wait = RETRY_DELAY_MS * item._attempt;
        // A retry starts a fresh HTTP body; don't count bytes from its failed
        // predecessor against the next response's Content-Length.
        item.progress = 0;
        item.total = 0;
        item._lastBytes = 0;
        item._lastTime = Date.now();
        item.status = 'queued';  // show as queued again while waiting
        item.error  = null;
        _notify();
        await _pause(wait, signal);
        if (!signal.aborted && _items.includes(item)) await _download(item);
        return;
      }

      item.status = 'error';
      item.error  = classified;
      _notify();
      console.error('[DownloadManager]', err.message, { httpStatus });
    } finally {
      clearTimeout(deadline);
      if (item._controller === controller) item._controller = null;
    }
  }

  /* ── init: restore completed downloads from IndexedDB at boot ── */
  async function init() {
    const completedIds = new Set();
    const saved = await DownloadDB.getAll().catch(() => []);
    saved.sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0));
    for (const dl of saved) {
      if (dl.gameId) completedIds.add(String(dl.gameId));
      if (_items.find(i => i.id === dl.id)) continue;
      _items.push({
        ...(_mkItem(dl.id, dl.game || { id: dl.gameId || dl.id, title: dl.filename,
                                        systemId: dl.systemId, system: dl.systemName })),
        status: 'complete',
        progress: dl.sizeBytes || 0, total: dl.sizeBytes || 0,
        filename: dl.filename, archiveUrl: dl.archiveUrl || null,
        _dlAt: dl.downloadedAt || null,
        _storage: dl.storage || null,
      });
      if (dl.gameId) ROM_STATUS[dl.gameId] = true;
    }
    for (const game of _pendingGames()) {
      if (completedIds.has(game.id) || _items.some(item => String(item.game?.id) === game.id)) continue;
      const item = _mkItem(`recovered_${game.id}`, game);
      item.status = 'error';
      item.error = 'DOWNLOAD INTERRUPTED — SELECT RETRY TO RESUME';
      _items.push(item);
    }
    _persistPending();
    _notify();
    // Background: prune OPFS-stored entries whose files have gone missing.
    // Runs after the UI is already painted so boot latency is unaffected.
    _pruneStaleOpfsEntries();
  }

  /* Check every restored 'complete' entry that was saved to OPFS.
   * If the OPFS file is gone and there is no fallback archive URL, the entry
   * is silently removed so the user doesn't see a "READY TO PLAY" card that
   * can never actually play. Items with an archiveUrl are left intact because
   * launchFromDownloadCenter() will stream from archive instead. */
  async function _pruneStaleOpfsEntries() {
    if (!navigator?.storage?.getDirectory) return;
    let opfsRoot;
    try { opfsRoot = await getOPFSLibrary(); }
    catch { return; }  // OPFS unavailable — skip

    let changed = false;
    for (const item of [..._items]) {
      if (item.status !== 'complete' || item._storage !== 'opfs') continue;
      if (!item.game?.systemId || !item.filename) continue;
      try {
        const sysDir = await opfsRoot.getDirectoryHandle(item.game.systemId, { create: false });
        await sysDir.getFileHandle(item.filename, { create: false });
        // File still present — nothing to do
      } catch {
        // File missing
        if (item.archiveUrl) {
          // Can still stream from archive — leave the entry but don't mark stale
          console.info(`[DL] OPFS file gone for ${item.filename} — will re-stream from archive if launched`);
        } else {
          // No fallback — remove the dead entry to prevent ghost "READY TO PLAY" cards
          console.info(`[DL] Pruning stale entry ${item.filename} (OPFS file missing, no archiveUrl)`);
          _items = _items.filter(i => i.id !== item.id);
          if (item.game?.id) ROM_STATUS[item.game.id] = false;
          DownloadDB.remove(item.id).catch(() => {});
          changed = true;
        }
      }
    }
    if (changed) {
      refreshGameCardDots();
      _notify();
    }
  }

  /* ── _notify: immediate HUD badge + subtitle, throttled panel render ── */
  function _notify() {
    const active = _items.filter(i => ['queued','searching','downloading'].includes(i.status));
    const badge  = document.getElementById('hud-dl-count');
    const btn    = document.getElementById('hud-dl-btn');
    if (badge) {
      badge.textContent = active.length;
      badge.classList.toggle('visible', active.length > 0);
      btn?.classList.toggle('active', active.length > 0);
    }
    const sub  = document.getElementById('dl-subtitle');
    const comp = _items.filter(i => i.status === 'complete').length;
    if (sub) {
      sub.textContent = (active.length || comp)
        ? [active.length ? `${active.length} DOWNLOADING` : '', comp ? `${comp} READY` : ''].filter(Boolean).join(' · ')
        : 'Background downloads · Ready to play';
    }
    // Throttle panel re-render to one DOM update per animation frame
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      const panel = document.getElementById('downloads-overlay');
      if (panel?.classList.contains('active')) render();
    });
  }

  /* ── render: three-section panel (active, failed, ready) ── */
  function render() {
    const listEl = document.getElementById('dl-list');
    if (!listEl) return;
    const active    = _items.filter(i => ['queued','searching','downloading'].includes(i.status));
    const errored   = _items.filter(i => i.status === 'error');
    const completed = _items.filter(i => i.status === 'complete');

    if (!_items.length) {
      listEl.innerHTML = `<p class="dl-empty">NO DOWNLOADS YET<br>
        <span style="font-size:9px;opacity:0.5;display:block;margin-top:8px">CLICK ANY GAME TO DOWNLOAD IT IN THE BACKGROUND</span></p>`;
      return;
    }

    const _fmtEta = s => {
      if (!s || !isFinite(s) || s < 0) return '';
      return s < 60 ? `~${Math.round(s)}s` : `~${Math.floor(s/60)}m${String(Math.round(s%60)).padStart(2,'0')}s`;
    };

    const _renderSourcePill = (item) => {
      const total = item._sources?.length || 0;
      if (!total) return '';
      const pos    = (item._sourceIdx || 0) + 1;
      const active = item._sources[item._sourceIdx || 0];
      const label  = (active?.provider || '').replace(/_/g, ' ').toUpperCase() || 'SOURCE';
      const more   = total > 1 ? ` ${pos}/${total} ▾` : '';
      return ` <button class="dl-source-pill" data-dlid="${item.id}" data-dlaction="cycleSource"
                title="Tap to cycle source — ${total} available">SRC: ${escHtml(label)}${more}</button>`;
    };

    let html = '';

    if (active.length) {
      html += `<div class="dl-section-hdr">DOWNLOADING</div>`;
      html += active.map(item => {
        const pct  = item.total ? Math.round(item.progress / item.total * 100) : 0;
        const mb   = (item.progress / 1_048_576).toFixed(1);
        const tot  = item.total ? `${(item.total / 1_048_576).toFixed(0)} MB` : '';
        const spd  = item._speedMBs > 0.05 ? `${item._speedMBs.toFixed(1)} MB/s` : '';
        const eta  = _fmtEta(item._etaSec);
        const col  = DL_SYS_COLORS[item.game.systemId] || 'var(--text-dim)';
        const spin = item.status !== 'downloading';
        const tryBadge = item._attempt > 1 ? ` · RETRY ${item._attempt - 1}` : '';
        const meta = item.status === 'searching' ? 'Scanning sources...' :
                     item.status === 'queued'    ? 'Waiting in queue...' :
                     [`${mb} MB${tot ? ` / ${tot}` : ''}`, spd, eta].filter(Boolean).join(' · ') + tryBadge;
        const srcPill = _renderSourcePill(item);
        return `<div class="dl-card dl-card--active">
          <div class="dl-card-row">
            <span class="dl-sys-pill" style="color:${col};border-color:${col}40">${escHtml((item.game.system||item.game.systemId||'').toUpperCase())}</span>
            <span class="dl-card-title">${escHtml(item.game.title)}</span>
            ${spd && !spin ? `<span class="dl-speed-badge">${spd}</span>` : ''}
            <button class="dl-card-x" data-dlid="${item.id}" data-dlaction="cancel">✕</button>
          </div>
          <div class="dl-prog-track"><div class="dl-prog-fill${spin?' dl-prog-spin':''}" style="width:${spin?30:pct}%"></div></div>
          <div class="dl-card-meta">${escHtml(meta)}${srcPill}</div>
        </div>`;
      }).join('');
    }

    if (errored.length) {
      html += `<div class="dl-section-hdr dl-section-hdr--err">FAILED</div>`;
      html += errored.map(item => {
        const col = DL_SYS_COLORS[item.game.systemId] || 'var(--text-dim)';
        const srcPill = _renderSourcePill(item);
        return `<div class="dl-card dl-card--err">
          <div class="dl-card-row">
            <span class="dl-sys-pill" style="color:${col};border-color:${col}40">${escHtml((item.game.system||item.game.systemId||'').toUpperCase())}</span>
            <span class="dl-card-title">${escHtml(item.game.title)}</span>
            <button class="dl-card-retry" data-dlid="${item.id}" data-dlaction="retry">↺</button>
            <button class="dl-card-x" data-dlid="${item.id}" data-dlaction="cancel">✕</button>
          </div>
          <div class="dl-card-meta" style="color:var(--red)">⚠ ${escHtml(item.error||'ERROR')}${srcPill}</div>
        </div>`;
      }).join('');
    }

    if (completed.length) {
      html += `<div class="dl-section-hdr dl-section-hdr--ok">
        READY TO PLAY · ${completed.length}
        <button class="dl-clear-btn" data-dlaction="clearCompleted">CLEAR ALL</button>
      </div>`;
      html += completed.map(item => {
        const col   = DL_SYS_COLORS[item.game.systemId] || 'var(--text-dim)';
        const szMB  = item.total ? `${(item.total/1_048_576).toFixed(0)} MB` : '';
        const date  = item._dlAt
          ? new Date(item._dlAt).toLocaleDateString('en-US', { month:'short', day:'numeric' })
          : '';
        return `<div class="dl-card dl-card--ok">
          <div class="dl-card-row">
            <span class="dl-sys-pill" style="color:${col};border-color:${col}40">${escHtml((item.game.system||item.game.systemId||'').toUpperCase())}</span>
            <span class="dl-card-title">${escHtml(item.game.title)}</span>
            <span class="dl-card-size">${szMB}</span>
            <button class="dl-launch-btn" data-dlid="${item.id}" data-dlaction="launch">▶ LAUNCH</button>
            <button class="dl-card-x" data-dlid="${item.id}" data-dlaction="remove">✕</button>
          </div>
          <div class="dl-card-meta">${escHtml(item.filename||'')}${date ? ' · '+date : ''}</div>
        </div>`;
      }).join('');
    }

    listEl.innerHTML = html;
  }

  return { enqueue, cancel, remove, retry, cycleSource, clearCompleted, init, getAll: () => [..._items], render };
})();
