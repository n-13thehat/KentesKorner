/* Kente's Korner — EmulatorJS hardening patches (cache wipe, decompression, runtime). */
'use strict';

// One-shot wipe of the EmulatorJS core IndexedDB cache. Earlier builds
// transcoded 7z cores to zip server-side, then served broken zips that
// silently hung the browser's extractzip worker on "Decompress Game Core".
// The server-side fix is in; this wipes any poisoned blobs the browser
// already cached so users don't have to open DevTools. Bump the version
// suffix on the flag key to re-trigger the wipe in future builds.
// Save files (IDBFS at /data/saves) live in different DBs and are untouched.
(function _kenteOneShotEjsCacheWipe() {
  if (typeof indexedDB === 'undefined' || typeof localStorage === 'undefined') return;
  const FLAG = 'kente.ejs.coreCacheWiped.v3';
  try { if (localStorage.getItem(FLAG)) return; } catch { return; }
  try {
    const r = indexedDB.deleteDatabase('EmulatorJS-core');
    // Only mark done on terminal success or error — onblocked means another
    // tab still has the DB open, in which case we want to retry next launch.
    const setFlag = () => { try { localStorage.setItem(FLAG, String(Date.now())); } catch {} };
    r.onsuccess = setFlag;
    r.onerror   = setFlag;
  } catch {}
})();

// EmulatorJS compression worker hardening. compression.js (upstream) creates
// a Web Worker for 7z/zip/rar extraction but installs only `worker.onmessage`,
// no `onerror` and no timeout. If the worker silently crashes (OOM, WASM
// init failure, postMessage throws), the decompress promise never resolves
// and the UI hangs forever on "Decompress Game Core" with no diagnostics.
// We trap the assignment of window.EJS_COMPRESSION and wrap decompressFile
// to add error/timeout handling that surfaces failures via startGameError.
(function _kenteHardenEjsCompression() {
  if (typeof window === 'undefined') return;
  const TIMEOUT_MS = 90000;
  function patch(C) {
    if (!C || C._kentePatched) return C;
    C.prototype.decompressFile = function(method, data, updateMsg, fileCbFunc) {
      return new Promise(async (resolve) => {
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; resolve(v); };
        const fail = (reason, detail) => {
          console.error('[EJS-patch]', method, 'decompress failed:', reason, detail || '');
          try {
            this.EJS && this.EJS.startGameError &&
              this.EJS.startGameError('Decompress failed: ' + reason + ' — see DevTools console');
          } catch {}
          done({});
        };
        try {
          const file   = await this.getWorkerFile(method);
          const worker = new Worker(URL.createObjectURL(file));
          const files  = {};
          const watchdog = setTimeout(() => {
            try { worker.terminate(); } catch {}
            fail('timeout after ' + (TIMEOUT_MS / 1000) + 's',
                 { method, byteLength: data && data.byteLength });
          }, TIMEOUT_MS);
          worker.onerror = (ev) => {
            clearTimeout(watchdog);
            try { worker.terminate(); } catch {}
            fail((ev && ev.message) || 'worker error', ev);
          };
          worker.onmessageerror = (ev) => {
            console.warn('[EJS-patch] postMessage error in', method, 'worker:', ev);
          };
          worker.onmessage = (ev) => {
            if (!ev.data) return;
            const m = ev.data;
            if (m.t === 4) {
              const num = Math.floor(m.current / m.total * 100);
              if (!isNaN(num)) updateMsg(' ' + num + '%', true);
            } else if (m.t === 2) {
              if (typeof fileCbFunc === 'function') {
                fileCbFunc(m.file, m.data);
                files[m.file] = true;
              } else {
                files[m.file] = m.data;
              }
            } else if (m.t === 1) {
              clearTimeout(watchdog);
              try {
                const names = Object.keys(files);
                const sizes = names.map(n => (files[n] && files[n].byteLength) || 0);
                console.log('[EJS-patch]', method, 'extracted', names.length, 'file(s):',
                  names.map((n, i) => `${n} (${sizes[i]}B)`).join(', '));
              } catch {}
              // Stash a reference for initGameCore's recovery fallback in
              // case upstream's filename matcher misses the .js/.wasm files.
              try { if (this.EJS) this.EJS._kenteLastDecompressed = files; } catch {}
              done(files);
            }
          };
          worker.postMessage(data);
        } catch (e) {
          fail('worker setup threw: ' + (e && e.message), e);
        }
      });
    };
    // Wrap decompress() too. Upstream's isCompressed() peeks bytes 0-9 for
    // zip/7z/rar magic; if it misses, decompress() returns the raw bytes
    // under the key "!!notCompressedData" and decompressFile never runs —
    // which means our stash never gets set and downstream sees no .js/.wasm.
    // We re-check the magic ourselves and force decompressFile when needed,
    // and always stash whatever comes back so initGameCore can recover.
    const origDecompress = C.prototype.decompress;
    C.prototype.decompress = function(data, updateMsg, fileCbFunc) {
      const head = (data && data.slice) ? data.slice(0, 10) : new Uint8Array(0);
      const is7z = head[0] === 0x37 && head[1] === 0x7A && head[2] === 0xBC &&
                   head[3] === 0xAF && head[4] === 0x27 && head[5] === 0x1C;
      const isZip = head[0] === 0x50 && head[1] === 0x4B;
      const upstreamSays = (typeof this.isCompressed === 'function')
        ? this.isCompressed(head) : null;
      const len = (data && data.byteLength) || 0;
      console.log('[EJS-patch] decompress: len=' + len + 'B head=' +
        Array.from(head).map(b => b.toString(16).padStart(2,'0')).join(' ') +
        ' upstream=' + upstreamSays + ' force=' +
        (is7z ? '7z' : (isZip ? 'zip' : 'none')));
      // Force decompressFile when we recognize magic but upstream missed it.
      let p;
      if (!upstreamSays && (is7z || isZip)) {
        p = this.decompressFile(is7z ? '7z' : 'zip', data, updateMsg, fileCbFunc);
      } else {
        p = origDecompress.call(this, data, updateMsg, fileCbFunc);
      }
      return p.then(async (files) => {
        const keys = files ? Object.keys(files) : [];
        const empty = keys.length === 0 ||
          (keys.length === 1 && keys[0] === '!!notCompressedData');
        // Server-side fallback. The upstream WASM 7z worker silently emits
        // zero files for some archives (likely an emscripten/p7zip bug); when
        // that happens, fetch the pre-extracted contents from kente-server's
        // /api/ejs/extract-core endpoint and synthesize the result dict.
        if (empty && is7z && this.EJS && this.EJS._kenteLastCoreName) {
          const name = this.EJS._kenteLastCoreName;
          try {
            console.warn('[EJS-patch] worker returned 0 files for', name,
              '\u2014 falling back to server extraction');
            updateMsg && updateMsg(' (server fallback)', false);
            const r = await fetch('/api/ejs/extract-core?name=' + encodeURIComponent(name));
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            if (!j || !j.success || !Array.isArray(j.files)) throw new Error('bad payload');
            files = {};
            for (const ent of j.files) {
              const bin = atob(ent.data);
              const buf = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
              if (typeof fileCbFunc === 'function') {
                fileCbFunc(ent.name, buf);
                files[ent.name] = true;
              } else {
                files[ent.name] = buf;
              }
            }
            console.log('[EJS-patch] server fallback extracted', j.files.length, 'file(s) for', name);
          } catch (e) {
            console.error('[EJS-patch] server fallback failed for', name, ':', e);
          }
        }
        try { if (this.EJS) this.EJS._kenteLastDecompressed = files; } catch {}
        return files;
      });
    };
    C._kentePatched = true;
    console.log('[EJS-patch] EJS_COMPRESSION patched');
    return C;
  }
  // If EJS already loaded (race), patch in place. Otherwise install a setter
  // so the wrap applies the moment compression.js assigns the class.
  if (window.EJS_COMPRESSION) { patch(window.EJS_COMPRESSION); return; }
  let _stored;
  try {
    Object.defineProperty(window, 'EJS_COMPRESSION', {
      configurable: true,
      get() { return _stored; },
      set(v)  { _stored = patch(v); }
    });
    console.log('[EJS-patch] EJS_COMPRESSION setter trap installed');
  } catch (e) {
    console.warn('[EJS-patch] could not install setter trap:', e);
  }
})();

// EmulatorJS runtime-script hardening. initGameCore() injects the core's main
// .js as a Blob-URL script tag and only listens for `load` — there is no
// `error` handler, so a parse error or empty/missing .js silently leaves
// window.EJS_Runtime undefined and the user sees the cryptic
// "Error loading EmulatorJS runtime" with no actionable info. We trap the
// EmulatorJS class assignment and wrap initGameCore to (a) log the byte
// length being injected, (b) attach script.onerror, and (c) verify that
// EJS_Runtime got defined after load.
(function _kenteHardenEjsRuntime() {
  if (typeof window === 'undefined') return;
  function patch(C) {
    if (!C || C._kentePatched) return C;
    const orig = C.prototype.initGameCore;
    if (typeof orig !== 'function') return C;
    // Hook downloadFile so we can remember the active core archive name. The
    // compression-side server fallback uses this when the browser's WASM 7z
    // worker silently emits zero files, fetching the pre-extracted contents
    // from /api/ejs/extract-core?name=<...>.
    const origDownloadFile = C.prototype.downloadFile;
    if (typeof origDownloadFile === 'function') {
      C.prototype.downloadFile = function(p, ...rest) {
        try {
          if (typeof p === 'string' && p.startsWith('cores/') && p.endsWith('.data')) {
            this._kenteLastCoreName = p.slice('cores/'.length);
          }
        } catch {}
        return origDownloadFile.call(this, p, ...rest);
      };
    }
    C.prototype.initGameCore = function(jsBytes, wasmBytes, workerBytes) {
      let js = jsBytes, wasm = wasmBytes, worker = workerBytes;
      // Recovery: if upstream's filename matcher missed any of the three core
      // files, scan the stashed decompression result for a key with the right
      // suffix. This makes us robust to upstream regex/ordering changes.
      const stash = this._kenteLastDecompressed;
      if (stash && typeof stash === 'object') {
        const findBy = (pred) => {
          for (const k of Object.keys(stash)) {
            const v = stash[k];
            if (v && v.byteLength && pred(k)) return v;
          }
          return null;
        };
        if (!(js     && js.byteLength))     js     = findBy(k => k.endsWith('.js') && !k.endsWith('.worker.js'));
        if (!(wasm   && wasm.byteLength))   wasm   = findBy(k => k.endsWith('.wasm'));
        if (!(worker && worker.byteLength)) worker = findBy(k => k.endsWith('.worker.js'));
      }
      const jsLen     = (js     && js.byteLength)     || 0;
      const wasmLen   = (wasm   && wasm.byteLength)   || 0;
      const workerLen = (worker && worker.byteLength) || 0;
      console.log('[EJS-patch] initGameCore: js=' + jsLen + 'B wasm=' + wasmLen + 'B worker=' + workerLen + 'B' +
        (stash ? ' (stash keys: ' + Object.keys(stash).join(', ') + ')' : ''));
      // Embed full diagnostics directly in any error message so the user
      // can read it on screen without opening DevTools. Includes whether
      // the EJS_COMPRESSION class was patched, whether decompress() ran,
      // and what files came out of the worker.
      const cls = window.EJS_COMPRESSION;
      const patched = !!(cls && cls._kentePatched);
      const inv = stash
        ? (Object.keys(stash).length === 0
            ? 'EMPTY (worker produced 0 files)'
            : Object.keys(stash).map(k => `${k}=${(stash[k] && stash[k].byteLength) || 0}B`).join(', '))
        : (patched
            ? 'NO STASH (decompress() never called — EJS hit IndexedDB cache or skipped checkCompression)'
            : 'NO STASH (EJS_COMPRESSION patch never installed — setter trap missed)');
      if (!jsLen) {
        try { this.startGameError('Missing runtime .js — extracted: [' + inv + ']'); } catch {}
        return;
      }
      if (!wasmLen) {
        try { this.startGameError('Missing .wasm — extracted: [' + inv + ']'); } catch {}
        return;
      }
      const script = this.createElement('script');
      script.src = URL.createObjectURL(new Blob([js], { type: 'application/javascript' }));
      script.addEventListener('load', () => {
        // Upstream's initModule throws "Error loading EmulatorJS runtime"
        // when EJS_Runtime is undefined — but only logs it to console, so
        // the user sees the cryptic message with no actionable context.
        // Catch it here and surface a diagnostic with a head-of-bytes peek
        // so we can tell at a glance whether the .js was truncated, an
        // HTML 404 page, gzip bytes, or actual JS that failed to register.
        if (typeof window.EJS_Runtime !== 'function') {
          let head = '';
          try { head = new TextDecoder().decode(js.slice(0, 80))
                  .replace(/[^\x20-\x7e]/g, '.'); } catch {}
          const msg = 'Runtime .js loaded (' + jsLen + 'B) but EJS_Runtime undefined. Head: "' + head + '"';
          console.error('[EJS-patch]', msg);
          try { this.startGameError(msg); } catch {}
          return;
        }
        this.initModule(wasm, worker);
      });
      script.addEventListener('error', (ev) => {
        console.error('[EJS-patch] runtime script failed to load:', ev);
        try { this.startGameError('Runtime script tag failed (likely CSP/Blob-URL block). Check console.'); } catch {}
      });
      document.body.appendChild(script);
    };
    C._kentePatched = true;
    return C;
  }
  if (window.EmulatorJS) { patch(window.EmulatorJS); return; }
  let _stored;
  try {
    Object.defineProperty(window, 'EmulatorJS', {
      configurable: true,
      get() { return _stored; },
      set(v)  { _stored = patch(v); }
    });
  } catch (e) {
    console.warn('[EJS-patch] could not install EmulatorJS setter trap:', e);
  }
})();
