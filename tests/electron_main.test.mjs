import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const mainFile = new URL('../electron/main.js', import.meta.url);
const source = fs.readFileSync(mainFile, 'utf8');

function sandbox({ platform = 'win32', taskkillFails = false } = {}) {
  const calls = [];
  const electron = {
    app: { commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }), on() {} },
    ipcMain: { on() {}, handle() {} },
  };
  const context = vm.createContext({
    console, Buffer, setTimeout, clearTimeout,
    __dirname: path.dirname(fileURLToPath(mainFile)),
    process: { platform, env: {} },
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'child_process') return {
        spawn() { throw new Error('No process should launch in this test'); },
        execFileSync(...args) {
          calls.push(args);
          if (taskkillFails) throw new Error('taskkill failed');
        },
      };
      return require(name);
    },
  });
  vm.runInContext(source, context);
  function stop(proc) {
    context.proc = proc;
    vm.runInContext('serverProcess = proc; killServer(); killServer();', context);
  }
  return { calls, stop };
}

test('Windows shutdown terminates the owned backend tree, including a PyInstaller child', () => {
  const { calls, stop } = sandbox();
  let directKills = 0;
  stop({ pid: 1234, exitCode: null, signalCode: null, kill() { directKills++; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'taskkill');
  assert.deepEqual(Array.from(calls[0][1]), ['/PID', '1234', '/T', '/F']);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(directKills, 0);
});

test('shutdown never targets a PID whose backend has already exited', () => {
  const { calls, stop } = sandbox();
  stop({ pid: 1234, exitCode: 0, signalCode: null, kill() { assert.fail('Exited backend must not be killed'); } });
  stop({ pid: undefined, exitCode: null, signalCode: null, kill() { assert.fail('Unstarted backend must not be killed'); } });
  assert.equal(calls.length, 0);
});

test('shutdown falls back to direct termination when taskkill fails or on other platforms', () => {
  for (const options of [{ taskkillFails: true }, { platform: 'linux' }]) {
    const { stop } = sandbox(options);
    let directKills = 0;
    stop({ pid: 1234, exitCode: null, signalCode: null, kill() { directKills++; } });
    assert.equal(directKills, 1);
  }
});
