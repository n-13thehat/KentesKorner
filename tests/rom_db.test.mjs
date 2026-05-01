// Minimal test for js/rom_db.js using Node's built-in test runner (no
// vitest install required).  Run from repo root:
//
//     node --test tests/rom_db.test.mjs
//
// We supply a tiny in-memory indexedDB stub so the module loads and we can
// exercise its API surface end-to-end without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROM_DB_SRC = readFileSync(resolve(__dirname, '..', 'js', 'rom_db.js'), 'utf8');


// ── tiny in-memory indexedDB stub ─────────────────────────────────────────
function makeFakeIDB() {
  const stores = new Map();          // storeName -> Map(key -> value)
  function makeRequest(resultProvider) {
    const req = { onsuccess: null, onerror: null, result: undefined };
    queueMicrotask(() => {
      try {
        req.result = resultProvider();
        req.onsuccess && req.onsuccess({ target: req });
      } catch (err) {
        req.error = err;
        req.onerror && req.onerror({ target: req });
      }
    });
    return req;
  }
  function makeTx(storeNames /*, mode */) {
    const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
    const store = {
      get(key) {
        return makeRequest(() => stores.get(storeNames)?.get(key));
      },
      put(value) {
        const m = stores.get(storeNames) || new Map();
        m.set(value.gameId, value);
        stores.set(storeNames, m);
        queueMicrotask(() => tx.oncomplete && tx.oncomplete());
        return makeRequest(() => undefined);
      },
      delete(key) {
        stores.get(storeNames)?.delete(key);
        return makeRequest(() => undefined);
      },
    };
    tx.objectStore = () => store;
    return tx;
  }
  const fakeDB = {
    transaction(storeNames /*, mode */) { return makeTx(storeNames); },
    createObjectStore(name /*, opts */) { stores.set(name, new Map()); return {}; },
  };
  return {
    indexedDB: {
      open(/* name, version */) {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
        queueMicrotask(() => {
          req.onupgradeneeded && req.onupgradeneeded({ target: { result: fakeDB } });
          req.onsuccess && req.onsuccess({ target: { result: fakeDB } });
        });
        return req;
      },
    },
  };
}


function loadRomDb() {
  const sandbox = {
    ...makeFakeIDB(),
    console,
    queueMicrotask,
    Promise,
    Date,
  };
  vm.createContext(sandbox);
  // `const RomDB = ...` is lexically scoped to the script and not exposed
  // on the sandbox global, so append a hoist line that copies it onto
  // globalThis where the test can grab it.
  vm.runInContext(ROM_DB_SRC + '\n;globalThis.RomDB = RomDB;', sandbox);
  return sandbox.RomDB;
}


test('RomDB exposes the expected API surface', () => {
  const RomDB = loadRomDb();
  assert.equal(typeof RomDB, 'object');
  for (const fn of ['get', 'getMeta', 'set', 'remove']) {
    assert.equal(typeof RomDB[fn], 'function', `RomDB.${fn} should be a function`);
  }
});

test('RomDB.set persists a record retrievable by getMeta', async () => {
  const RomDB = loadRomDb();
  await RomDB.set('game-1', { fake: 'handle' }, 'game-1.iso');
  const meta = await RomDB.getMeta('game-1');
  assert.equal(meta.gameId, 'game-1');
  assert.equal(meta.fileName, 'game-1.iso');
  assert.deepEqual(meta.handle, { fake: 'handle' });
  assert.equal(typeof meta.savedAt, 'number');
});

test('RomDB.get returns just the handle, not the wrapper record', async () => {
  const RomDB = loadRomDb();
  await RomDB.set('game-2', { kind: 'opaque' }, 'rom.bin');
  const handle = await RomDB.get('game-2');
  assert.deepEqual(handle, { kind: 'opaque' });
});

test('RomDB.get returns null for unknown gameId', async () => {
  const RomDB = loadRomDb();
  const handle = await RomDB.get('does-not-exist');
  assert.equal(handle, null);
});

test('RomDB.remove deletes the record', async () => {
  const RomDB = loadRomDb();
  await RomDB.set('game-3', { x: 1 }, 'r.iso');
  await RomDB.remove('game-3');
  const meta = await RomDB.getMeta('game-3');
  assert.equal(meta, null);
});
