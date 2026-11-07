import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL(`../js/${name}`, import.meta.url), 'utf8');

function directory(entries = {}) {
  return {
    kind: 'directory',
    async *entries() { yield* Object.entries(entries); },
    async getDirectoryHandle(name) {
      if (entries[name]?.kind !== 'directory') throw new Error('NotFoundError');
      return entries[name];
    },
    async getFileHandle(name) {
      if (entries[name]?.kind !== 'file') throw new Error('NotFoundError');
      return entries[name];
    },
  };
}

function setup(downloads = []) {
  const file = { kind: 'file', name: 'Super Mario Bros. (USA).nes' };
  const root = directory({
    KenteKorner: directory({ roms: directory({ nes: directory({ [file.name]: file }) }) }),
  });
  const records = new Map();
  const removed = [];
  const warnings = [];
  const ctx = vm.createContext({
    console: { ...console, warn: (...args) => warnings.push(args) },
    navigator: { storage: { getDirectory: async () => root } },
    window: { KenteLibrary: { games: [{ id: 'smb', title: 'Super Mario Bros.', systemId: 'nes' }] } },
    document: { getElementById: () => null, querySelectorAll: () => [] }, requestAnimationFrame: () => {},
    RomDB: { set: async (id, handle) => { records.set(id, handle); } },
    refreshGameCardDots() {},
  });
  for (const name of ['config.js', 'storage.js', 'rom_library.js', 'rom_tools.js', 'download_manager.js']) {
    vm.runInContext(source(name), ctx, { filename: name });
  }
  ctx.downloads = downloads;
  ctx.removeDownload = id => removed.push(id);
  vm.runInContext(`
    DownloadDB.getAll = async () => downloads;
    DownloadDB.remove = async id => removeDownload(id);
    globalThis.api = {
      scanOPFSLibrary, initRomLibrary, DownloadManager,
      status: () => ROM_STATUS,
      failManualLibrary() { LibraryDB.getRoot = async () => { throw new Error('IDB unavailable'); }; },
    };
  `, ctx);
  return { ...ctx.api, records, removed, file, warnings };
}

test('OPFS scan indexes ROMs by the matched game ID and preserves existing links', async () => {
  const api = setup();
  await api.scanOPFSLibrary();
  assert.equal(api.records.get('smb'), api.file);
  assert.equal(api.records.has(undefined), false);
  assert.equal(api.status().smb, true);
  assert.equal(Object.hasOwn(api.status(), 'undefined'), false);
  api.records.clear();
  await api.scanOPFSLibrary();
  assert.equal(api.records.size, 0);
});

test('OPFS scan still runs when the saved manual library cannot be read', async () => {
  const api = setup();
  api.failManualLibrary();
  await api.initRomLibrary();
  assert.equal(api.records.get('smb'), api.file);
  assert.equal(api.warnings.length, 1);
});

test('download cleanup retains existing OPFS files and native/manual library records', async () => {
  const game = { id: 'smb', title: 'Super Mario Bros.', systemId: 'nes' };
  const api = setup([
    { id: 'opfs', game, filename: 'Super Mario Bros. (USA).nes', storage: 'opfs' },
    { id: 'missing-opfs', game: { ...game, id: 'missing' }, filename: 'missing.nes', storage: 'opfs' },
    { id: 'manual', game, filename: 'manual.nes', storage: 'library' },
    { id: 'native', game, filename: 'native.nes' },
  ]);
  await api.DownloadManager.init();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(api.removed, ['missing-opfs']);
  assert.deepEqual(Array.from(api.DownloadManager.getAll(), item => item.id), ['opfs', 'manual', 'native']);
});
