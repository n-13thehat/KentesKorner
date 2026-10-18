// End-to-end test for the EmulatorJS hardening patches in js/ejs_patches.js.
// Verifies:
//   1. EJS_COMPRESSION setter trap installs and wraps the assigned class
//   2. decompress() forces decompressFile when the 7z magic is present
//   3. When the worker emits 0 files, the patch fetches the server fallback
//   4. EmulatorJS.downloadFile is hooked to remember the active core name
//   5. initGameCore recovers from the stash when given empty args
//
// The test extracts the three IIFE blocks from js/ejs_patches.js and runs them in a
// minimal mocked-browser sandbox. The fetch against /api/ejs/extract-core
// hits a real running kente-server on localhost:7777.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const KENTE = fs.readFileSync(path.join(ROOT, 'js', 'ejs_patches.js'), 'utf8');

// Slice out the three IIFE blocks so we only run the patch code itself.
function sliceBlock(name) {
  const startMarker = `(function ${name}() {`;
  const idx = KENTE.indexOf(startMarker);
  if (idx === -1) throw new Error(`block ${name} not found in js/ejs_patches.js`);
  // Find matching close: scan forward, count parens at IIFE depth.
  let depth = 0, i = idx;
  for (; i < KENTE.length; i++) {
    const c = KENTE[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        // Expect "();" right after.
        const tail = KENTE.slice(i, i + 3);
        if (tail === ')()') return KENTE.slice(idx, i + 3) + ';';
        if (tail.startsWith(')();')) return KENTE.slice(idx, i + 4);
      }
    }
  }
  throw new Error(`could not find end of block ${name}`);
}

function makeSandbox({ workerEmitsFiles = false }) {
  const lsStore = new Map();
  const idbStore = new Map();
  let lastWorkerInstance = null;

  class FakeWorker {
    constructor(_url) {
      lastWorkerInstance = this;
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
      this._terminated = false;
    }
    postMessage(_data) {
      // Defer like a real worker.
      setImmediate(() => {
        if (this._terminated) return;
        if (workerEmitsFiles) {
          this.onmessage && this.onmessage({ data: { t: 2, file: 'core.json',
            data: new Uint8Array([1, 2, 3]) } });
        }
        this.onmessage && this.onmessage({ data: { t: 1 } });
      });
    }
    terminate() { this._terminated = true; }
  }

  const fakeIndexedDB = {
    deleteDatabase(_n) {
      const r = {};
      setImmediate(() => r.onsuccess && r.onsuccess({}));
      return r;
    }
  };

  const URL_ = {
    createObjectURL: (_b) => 'blob:fake/' + Math.random().toString(36).slice(2),
    revokeObjectURL: () => {},
  };

  const document_ = {
    createElement: () => ({
      addEventListener: () => {},
      removeEventListener: () => {},
      _listeners: {},
    }),
    body: { appendChild: () => {} },
    head: { appendChild: () => {} },
  };

  const win = {
    KENTE_DEBUG: true,
    indexedDB: fakeIndexedDB,
    localStorage: {
      getItem: (k) => lsStore.has(k) ? lsStore.get(k) : null,
      setItem: (k, v) => lsStore.set(k, String(v)),
      removeItem: (k) => lsStore.delete(k),
    },
    URL: URL_,
    Worker: FakeWorker,
    Blob: class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    // Resolve same-origin relative URLs against the live server, mirroring
    // browser behavior where the page itself is served from localhost:7777.
    fetch: (u, opts) => {
      if (typeof u === 'string' && u.startsWith('/'))
        u = 'http://localhost:7777' + u;
      return globalThis.fetch(u, opts);
    },
    atob: globalThis.atob,
    document: document_,
    TextDecoder: globalThis.TextDecoder,
    setTimeout, clearTimeout, setImmediate, clearImmediate,
    console,
  };
  win.window = win;

  const ctx = vm.createContext(win);
  // Explicit globals that some patch code reaches via bareword.
  ctx.globalThis = ctx;

  return { ctx, win, getLastWorker: () => lastWorkerInstance };
}

function loadPatches(ctx) {
  const blocks = [
    sliceBlock('_kenteOneShotEjsCacheWipe'),
    sliceBlock('_kenteHardenEjsCompression'),
    sliceBlock('_kenteHardenEjsRuntime'),
  ];
  for (const code of blocks) vm.runInContext(code, ctx);
}

// Minimal upstream-like EJS_COMPRESSION class so the patch has something to
// extend.  Mirrors the real class's surface: isCompressed, getWorkerFile,
// decompress, decompressFile, EJS reference.
function defineUpstreamCompression(ctx) {
  vm.runInContext(`
    class EJS_COMPRESSION {
      constructor(EJS) { this.EJS = EJS; }
      isCompressed(d) {
        if (d[0]===0x37 && d[1]===0x7A && d[2]===0xBC && d[3]===0xAF && d[4]===0x27 && d[5]===0x1C) return '7z';
        if (d[0]===0x50 && d[1]===0x4B) return 'zip';
        return null;
      }
      async getWorkerFile(_m) { return new Blob([''], {type:'application/javascript'}); }
      decompress(data, updateMsg, cb) {
        const c = this.isCompressed(data.slice(0, 10));
        if (c === null) return Promise.resolve({ '!!notCompressedData': data });
        return this.decompressFile(c, data, updateMsg, cb);
      }
      decompressFile(method, data, updateMsg, cb) {
        return new Promise(async (resolve) => {
          const file = await this.getWorkerFile(method);
          const w = new Worker(URL.createObjectURL(file));
          const files = {};
          w.onmessage = (ev) => {
            if (!ev.data) return;
            if (ev.data.t === 2) files[ev.data.file] = ev.data.data;
            if (ev.data.t === 1) resolve(files);
          };
          w.postMessage(data);
        });
      }
    }
    window.EJS_COMPRESSION = EJS_COMPRESSION;
  `, ctx);
}

function defineUpstreamEmulator(ctx) {
  vm.runInContext(`
    class EmulatorJS {
      constructor() { this.errors = []; }
      createElement(t) { return document.createElement(t); }
      startGameError(m) { this.errors.push(m); }
      initModule() { this.moduleInited = true; }
      getCore() { return 'nestopia'; }
      downloadFile(_p) { return Promise.resolve({ data: new Uint8Array() }); }
      initGameCore(js, wasm, worker) {
        this.gotJs = js; this.gotWasm = wasm; this.gotWorker = worker;
      }
    }
    window.EmulatorJS = EmulatorJS;
  `, ctx);
}

test('EJS_COMPRESSION setter trap installs and patches the class', () => {
  const { ctx, win } = makeSandbox({ workerEmitsFiles: false });
  loadPatches(ctx);
  defineUpstreamCompression(ctx);
  assert.equal(win.EJS_COMPRESSION._kentePatched, true,
    'patch flag should be set after assignment');
  assert.equal(typeof win.EJS_COMPRESSION.prototype.decompress, 'function');
  assert.equal(typeof win.EJS_COMPRESSION.prototype.decompressFile, 'function');
});

test('EmulatorJS setter trap installs and hooks downloadFile + initGameCore', () => {
  const { ctx, win } = makeSandbox({ workerEmitsFiles: false });
  loadPatches(ctx);
  defineUpstreamEmulator(ctx);
  assert.equal(win.EmulatorJS._kentePatched, true);
  const inst = vm.runInContext('new EmulatorJS()', ctx);
  inst.downloadFile('cores/nestopia-wasm.data');
  assert.equal(inst._kenteLastCoreName, 'nestopia-wasm.data');
});

// Probe the live server once; skip the integration test below when nothing
// is listening on 7777 so this file is safe to run in plain `npm test`.
let _serverUp = null;
async function serverReachable() {
  if (_serverUp !== null) return _serverUp;
  try {
    const r = await fetch('http://localhost:7777/api/ping', { signal: AbortSignal.timeout(500) });
    _serverUp = r.ok;
  } catch { _serverUp = false; }
  return _serverUp;
}

test('decompress with 7z magic but failing worker falls back to /api/ejs/extract-core', async (t) => {
  if (!(await serverReachable())) {
    t.skip('kente-server not running on :7777 — start it to exercise this test');
    return;
  }
  const { ctx, win } = makeSandbox({ workerEmitsFiles: false });
  loadPatches(ctx);
  defineUpstreamCompression(ctx);
  defineUpstreamEmulator(ctx);

  // Make a tiny "archive": just the 7z magic header bytes. The worker will
  // emit 0 files and the patch should fall back to the live server endpoint.
  const head = new Uint8Array([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0, 0, 0, 0]);
  const ejs = vm.runInContext('new EmulatorJS()', ctx);
  ejs.downloadFile('cores/nestopia-wasm.data');  // sets _kenteLastCoreName
  const compFactory = vm.runInContext('(ejs) => new window.EJS_COMPRESSION(ejs)', ctx);
  const comp = compFactory(ejs);

  const result = await comp.decompress(head, () => {}, undefined);
  console.log('  patch result keys:', Object.keys(result));
  assert.ok(result['nestopia_libretro.js'], 'should have .js from server fallback');
  assert.ok(result['nestopia_libretro.wasm'], 'should have .wasm from server fallback');
  assert.ok(result['core.json'], 'should have core.json');
  assert.equal(result['nestopia_libretro.js'].byteLength, 278657);
  assert.equal(result['nestopia_libretro.wasm'].byteLength, 5989561);
  assert.equal(ejs._kenteLastDecompressed, result, 'stash should be set on EJS instance');
});

test('initGameCore recovers from stash when given empty args', () => {
  const { ctx, win } = makeSandbox({ workerEmitsFiles: false });
  loadPatches(ctx);
  defineUpstreamEmulator(ctx);
  const ejs = vm.runInContext('new EmulatorJS()', ctx);
  // Pre-populate the stash like decompress() would.
  ejs._kenteLastDecompressed = {
    'nestopia_libretro.js':   new Uint8Array(100),
    'nestopia_libretro.wasm': new Uint8Array(200),
  };
  // Capture the script tag the patch creates.
  const created = [];
  win.document.createElement = () => {
    const el = { addEventListener: () => {}, listeners: {} };
    created.push(el);
    return el;
  };
  ejs.initGameCore(undefined, undefined, undefined);
  assert.equal(ejs.errors.length, 0, 'no startGameError; recovery succeeded');
  assert.equal(created.length, 1, 'should create exactly one <script>');
  assert.ok(created[0].src && created[0].src.startsWith('blob:'),
    'should set blob: src on script');
});
