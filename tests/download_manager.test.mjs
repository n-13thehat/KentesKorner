import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/download_manager.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const game = id => ({ id, title: id, systemId: 'nes', system: 'NES' });
const candidate = name => ({ filename: `${name}.nes`, url: `https://archive.org/${name}.nes`, provider: name });
const response = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Length': '3' } });

function setup(fetch, fetchRomSources = async () => []) {
  const saved = [];
  const timers = new Map();
  const ctx = vm.createContext({
    console, URLSearchParams, AbortController, DOMException, fetch, fetchRomSources,
    setTimeout(fn, ms) {
      const timer = setTimeout(fn, ms);
      timer.unref();
      timers.set(timer, ms);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    _abortTimeout: ms => AbortSignal.timeout(ms),
    KENTE_SERVER_URL: 'http://localhost:7777',
    document: { getElementById: () => null }, requestAnimationFrame() {},
    DownloadDB: { add: async record => saved.push(record), remove: async () => {} },
    RomSourceLedger: { onSuccess() {}, onFail() {} },
    ROM_STATUS: {}, refreshGameCardDots() {}, showToast() {}, openDownloadCenter() {},
    _refreshRecentDownloadsShelf() {},
  });
  vm.runInContext(source + '\nglobalThis.api = DownloadManager;', ctx);
  return { manager: ctx.api, saved, timers };
}

test('cancel during source lookup never starts the canceled transfer or records it as complete', async () => {
  const lookup = deferred();
  const fetched = [];
  const { manager, saved } = setup(async url => { fetched.push(url); return response(); },
    async (_, title) => title === 'first' ? lookup.promise : [candidate('second')]);
  const first = await manager.enqueue(game('first'));
  await manager.enqueue(game('second'));
  manager.cancel(first);
  await flush();
  assert.deepEqual(saved.map(item => item.gameId), ['second']);
  lookup.resolve([candidate('first')]);
  await flush();
  assert.equal(fetched.length, 1);
  assert.deepEqual(saved.map(item => item.gameId), ['second']);
});

test('cancel aborts a pending fetch and keeps the next queued transfer independent', async () => {
  const pending = deferred();
  let firstSignal;
  const { manager, saved } = setup(async (url, { signal }) => {
    if (url.includes('first.nes')) { firstSignal = signal; return pending.promise; }
    return response();
  });
  const first = await manager.enqueue(game('first'), { url: candidate('first').url, filename: 'first.nes' });
  await manager.enqueue(game('second'), { url: candidate('second').url, filename: 'second.nes' });
  manager.cancel(first);
  await flush();
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(saved.map(item => item.gameId), ['second']);
  pending.resolve(response());
  await flush();
  assert.deepEqual(saved.map(item => item.gameId), ['second']);
});

test('changing a queued source does not start a second simultaneous download', async () => {
  const pending = deferred();
  const fetched = [];
  const { manager, saved } = setup(async url => {
    fetched.push(url);
    return fetched.length === 1 ? pending.promise : response();
  });
  await manager.enqueue(game('first'), { url: candidate('first').url, filename: 'first.nes' });
  const second = await manager.enqueue(game('second'));
  const queued = manager.getAll().find(item => item.id === second);
  queued._sources = [candidate('source-one'), candidate('source-two')];
  queued._sourceIdx = 0;
  manager.cycleSource(second);
  await flush();
  assert.equal(fetched.length, 1);
  pending.resolve(response());
  await flush();
  assert.equal(fetched.length, 2);
  assert.ok(fetched[1].includes('source-two.nes'));
  assert.deepEqual(saved.map(item => item.gameId), ['first', 'second']);
});

test('switching the active source aborts its old request and records completion once', async () => {
  const pending = deferred();
  const signals = [];
  const { manager, saved } = setup(async (_, { signal }) => {
    signals.push(signal);
    return signals.length === 1 ? pending.promise : response();
  }, async () => [candidate('source-one'), candidate('source-two')]);
  const id = await manager.enqueue(game('first'));
  await flush();
  manager.cycleSource(id);
  await flush();
  assert.equal(signals[0].aborted, true);
  assert.equal(signals.length, 2);
  pending.resolve(response());
  await flush();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].filename, 'source-two.nes');
});

test('successful streaming clears per-chunk and overall timeout timers', async () => {
  const { manager, saved, timers } = setup(async () => response());
  await manager.enqueue(game('first'), { url: candidate('first').url, filename: 'first.nes' });
  await flush();
  assert.equal(saved.length, 1);
  assert.equal(timers.size, 0);
});

test('a transfer missing even the last few bytes is retried without recording a completed ROM', async () => {
  const { manager, saved, timers } = setup(async () => new Response(new Uint8Array(99), {
    headers: { 'Content-Length': '100' },
  }));
  const id = await manager.enqueue(game('first'), { url: candidate('first').url, filename: 'first.nes' });
  await flush();
  assert.equal(saved.length, 0);
  assert.equal(manager.getAll()[0].status, 'queued');
  manager.cancel(id);
  await flush();
  assert.equal(timers.size, 0);
});

test('canceling a response body releases its reader and allows the queue to continue', async () => {
  let bodyCanceled = false;
  const { manager, saved } = setup(async url => url.includes('first.nes')
    ? new Response(new ReadableStream({ cancel() { bodyCanceled = true; } }))
    : response());
  const id = await manager.enqueue(game('first'), { url: candidate('first').url, filename: 'first.nes' });
  await manager.enqueue(game('second'), { url: candidate('second').url, filename: 'second.nes' });
  await flush();
  manager.cancel(id);
  await flush();
  assert.equal(bodyCanceled, true);
  assert.deepEqual(saved.map(item => item.gameId), ['second']);
});
