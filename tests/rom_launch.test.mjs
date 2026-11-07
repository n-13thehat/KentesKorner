import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = name => fs.readFileSync(new URL(`../js/${name}`, import.meta.url), 'utf8');
const ctx = vm.createContext({ console });
vm.runInContext(source('rom_tools.js'), ctx);
const { romTitleMatches, matchRomToGame, validatePs1Content } = ctx;

test('ROM matching preserves sequel numbers for PS1 and PS2, including Roman numerals', () => {
  for (const [filename, title, expected] of [
    ['Tony Hawk S Pro Skater 4.7z', "Tony Hawk's Pro Skater 2", false],
    ['Tony Hawk S Pro Skater 4 (Disc 2).7z', "Tony Hawk's Pro Skater 2", false],
    ["Tony Hawk's Pro Skater 2 (USA).bin", "Tony Hawk's Pro Skater 2", true],
    ['God of War III [SLUS-20002].iso', 'God of War II', false],
    ['God of War 2 (USA).iso', 'God of War II', true],
    ['Final Fantasy 7 (Disc 1).bin', 'Final Fantasy VII', true],
  ]) assert.equal(romTitleMatches(filename, title), expected, filename);
});

test('the library scanner does not link another numbered sequel to a featured game', () => {
  const games = [{ id: 'thps2', title: "Tony Hawk's Pro Skater 2" }];
  assert.equal(matchRomToGame('Tony Hawk S Pro Skater 4.7z', games), null);
  assert.equal(matchRomToGame('Tony Hawk S Pro Skater 2.zip', games).game.id, 'thps2');
});

function fakeFS(files) {
  return {
    analyzePath: path => ({ exists: Object.hasOwn(files, path) }),
    stat: path => ({ size: typeof files[path] === 'number' ? files[path] : files[path].length }),
    readFile: path => files[path],
    writeFile: (path, value) => { files[path] = value; },
    readdir: dir => [...new Set(Object.keys(files).filter(path => path.startsWith(dir === '/' ? '/' : dir + '/'))
      .map(path => path.slice(dir === '/' ? 1 : dir.length + 1).split('/')[0]))],
  };
}

test('PS1 cue sheets require all referenced tracks, with relative archive directories', () => {
  const files = {
    '/disc/game.cue': 'FILE "tracks\\game.bin" BINARY\n  TRACK 01 MODE2/2352\n',
    '/disc/tracks/game.bin': 500000000,
  };
  assert.equal(validatePs1Content(fakeFS(files), 'disc/game.cue'), null);
  delete files['/disc/tracks/game.bin'];
  assert.match(validatePs1Content(fakeFS(files), 'disc/game.cue'), /Missing disc track/);
});

test('ECM-only and empty PS1 payloads are rejected before RetroArch starts', () => {
  const files = { '/game.cue': 'FILE "game.BIN" BINARY\n', '/game.BIN.ecm': 400000000, '/stub.bin': 28 };
  assert.match(validatePs1Content(fakeFS(files), 'game.cue'), /ECM/);
  assert.match(validatePs1Content(fakeFS(files), 'stub.bin'), /too small/);
  assert.match(validatePs1Content(fakeFS(files), undefined), /no playable disc/);
});

test('PS1 playlists cannot loop indefinitely', () => {
  assert.match(validatePs1Content(fakeFS({ '/a.m3u': 'a.m3u' }), 'a.m3u'), /circular/);
});

test('PS1 cue paths are repaired to match the extracted track names', () => {
  const files = { '/disc/game.cue': 'FILE "tracks\\game.bin" BINARY\n', '/disc/Tracks/Game.BIN': 100000000 };
  assert.equal(validatePs1Content(fakeFS(files), 'disc/game.cue'), null);
  assert.equal(files['/disc/game.cue'], 'FILE "Tracks/Game.BIN" BINARY\n');
});

test('cloud mirrors exclude wrong sequels even when an older server returns them', async () => {
  const sandbox = vm.createContext({
    console, URL, KENTE_SERVER_ONLINE: true,
    fetchRomSources: async () => [2, 4, 2, 3, 2].map((sequel, i) => ({
      filename: `Tony Hawk S Pro Skater ${sequel} (${i}).zip`, url: `https://example.org/${i}.zip`,
    })),
  });
  vm.runInContext(source('rom_tools.js') + '\n' + source('cloud_launch.js'), sandbox);
  const mirrors = await sandbox._collectCloudMirrors({ systemId: 'ps1', title: "Tony Hawk's Pro Skater 2" });
  assert.equal(mirrors.length, 3);
  assert.ok(mirrors.every(mirror => mirror.filename.includes('Skater 2')));
});

test('an archive that cannot boot falls through to another mirror before recording success', async () => {
  const succeeded = [], failed = [], launched = [];
  const overlay = { classList: { add() {}, remove() {} } };
  const sandbox = vm.createContext({
    console, URL: { revokeObjectURL() {} },
    CORE_MAP: { ps1: 'pcsx_rearmed' }, KENTE_SERVER_ONLINE: true, DEBUG: false,
    document: { getElementById: id => id === 'emulator-overlay' ? overlay : { innerHTML: '', textContent: '', onclick: null, remove() {} } },
    state: { screen: 'room' }, KenteAudio: { setHumVol() {} }, showIngameMenu() {}, refreshGameCardDots() {}, ROM_STATUS: {},
    RomSourceLedger: { onSuccess: value => succeeded.push(value), onFail: value => failed.push(value) },
    exitEmulator() { sandbox.state.screen = 'room'; },
    launchWithEmulatorJS: async (_game, _url, meta) => {
      launched.push(meta.filename);
      return meta.filename === 'encoded.zip'
        ? { success: false, error: 'PS1 DISC ERROR: ECM track' } : { success: true };
    },
  });
  vm.runInContext(source('cloud_launch.js'), sandbox);
  sandbox._collectCloudMirrors = async () => ['encoded', 'playable'].map(name => ({
    filename: name + '.zip', provider: name, url: `https://example.org/${name}.zip`,
  }));
  sandbox._streamMirror = async mirror => ({ blobUrl: 'blob:' + mirror.filename });
  await sandbox.launchFromCloud({ id: 'thps2', title: "Tony Hawk's Pro Skater 2", systemId: 'ps1', system: 'PS1' });
  assert.deepEqual(launched, ['encoded.zip', 'playable.zip']);
  assert.deepEqual(failed, ['encoded']);
  assert.deepEqual(succeeded, ['playable']);
});
