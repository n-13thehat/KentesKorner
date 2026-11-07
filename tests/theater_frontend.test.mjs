import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = name => fs.readFileSync(new URL(`../js/${name}`, import.meta.url), 'utf8');

test('Theater search ignores results from an older query', async () => {
  const wrap = { innerHTML: '' }, results = { innerHTML: '' }, pending = [], ids = [];
  const ctx = vm.createContext({ console, KENTE_SERVER_ONLINE: true, escHtml: value => String(value),
    document: { getElementById: id => { ids.push(id); return id === 'theater-rows' ? wrap : id === 'theater-row-search' ? results : null; } },
  });
  vm.runInContext(source('theater.js'), ctx);
  ctx._theaterFetch = (_path, query) => new Promise(resolve => pending.push({ query: query.q, resolve }));
  vm.runInContext('TheaterState.searchGeneration = 1', ctx);
  assert.equal(vm.runInContext('TheaterState.searchGeneration', ctx), 1);
  const older = ctx._theaterRunSearch('older query', 1);
  const olderBatch = pending.splice(0);
  vm.runInContext('TheaterState.searchGeneration = 2', ctx);
  assert.equal(vm.runInContext('TheaterState.searchGeneration', ctx), 2);
  const newer = ctx._theaterRunSearch('newer query', 2);
  const newerBatch = pending.splice(0);
  assert.equal(olderBatch.length, 8, JSON.stringify(ids));
  assert.equal(newerBatch.length, 8, JSON.stringify(ids));
  for (const item of olderBatch) item.resolve({ items: [{ title: 'OLD RESULT', slug: 'old' }] });
  await older;
  assert.doesNotMatch(results.innerHTML, /OLD RESULT/);
  for (const item of newerBatch) item.resolve({ items: [{ title: 'NEW RESULT', slug: 'new' }] });
  await newer;
  assert.match(results.innerHTML, /NEW RESULT/);
  assert.doesNotMatch(results.innerHTML, /OLD RESULT/);
});

test('re-entering Theater binds search controls to the newly rendered input', async () => {
  const inputs = [0, 1].map(() => ({ listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } }));
  let inputIndex = 0;
  const ctx = vm.createContext({ console, KENTE_SERVER_ONLINE: true,
    document: { querySelectorAll: () => [], addEventListener() {},
      getElementById: id => id === 'theater-search-input' ? inputs[Math.min(inputIndex++, 1)] : null },
  });
  vm.runInContext(source('theater.js'), ctx);
  await ctx.hydrateTheaterMenu();
  await ctx.hydrateTheaterMenu();
  assert.equal(typeof inputs[0].listeners.input, 'function');
  assert.equal(typeof inputs[1].listeners.input, 'function');
  assert.equal(typeof inputs[1].listeners.focus, 'function');
});

test('a stale Theater detail response cannot replace the current selection', async () => {
  const overlay = { hidden: true, innerHTML: '', listeners: [],
    classList: { add() {}, remove() {} },
    setAttribute() {}, getAttribute: () => 'false',
    querySelector: () => ({ addEventListener() {}, focus() {} }),
    addEventListener(type, fn) { this.listeners.push([type, fn]); },
  };
  const pending = [];
  const ctx = vm.createContext({ console,
    document: { activeElement: null, addEventListener() {}, getElementById: id => id === 'theater-detail-overlay' ? overlay : null },
    requestAnimationFrame: fn => fn(), setTimeout, clearTimeout,
    renderInlineStatus() {},
    KenteAudio: { click() {} }, GamepadManager: { resetFocus() {} },
  });
  vm.runInContext(source('theater_detail.js'), ctx);
  ctx._theaterFetch = (_path, query) => new Promise(resolve => pending.push({ slug: query.slug, resolve }));
  const rendered = [];
  ctx._renderTheaterDetail = (_provider, detail) => rendered.push(detail.slug);
  const oldRequest = ctx.openTheaterDetail('test', 'movie', 'old', 'Old');
  ctx.closeTheaterDetail();
  const currentRequest = ctx.openTheaterDetail('test', 'movie', 'current', 'Current');
  pending.find(item => item.slug === 'old').resolve({ slug: 'old' });
  await oldRequest;
  assert.deepEqual(rendered, []);
  pending.find(item => item.slug === 'current').resolve({ slug: 'current' });
  await currentRequest;
  assert.deepEqual(rendered, ['current']);
  assert.equal(overlay.listeners.filter(([type]) => type === 'click').length, 1);
});
