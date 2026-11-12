'use strict';
/**
 * KenteCorner — Electron Main Process
 *
 * Responsibilities:
 *  1. Spawn kente-server (compiled exe or python script)
 *  2. Poll localhost:7777/api/ping until the server is ready
 *  3. Open a maximised BrowserWindow
 *  4. Handle IPC from the renderer (window focus after Dolphin exits)
 *  5. Kill the server process on quit — no orphan processes left behind
 */

const { app, BrowserWindow, ipcMain, dialog, desktopCapturer } = require('electron');
const { spawn, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');

let macPlayerSurface = null;
let macLibretroHost = null;
let macLaunchGeneration = 0;
if (process.platform === 'darwin') {
  try { macPlayerSurface = require('./native/mac-player.node'); }
  catch (error) { console.error('[kente] Mac native player surface unavailable:', error.message); }
  try { macLibretroHost = require('./native/mac-libretro.node'); }
  catch (error) { console.error('[kente] Mac libretro host unavailable:', error.message); }
}

// Prefer the discrete GPU on hybrid-graphics Windows laptops for the shell
// and EmulatorJS WebGL renderer.
app.commandLine.appendSwitch('force-high-performance-gpu');

const SERVER_PORT    = 7777;
const SERVER_TIMEOUT = 30_000;   // ms to wait for server to boot

let mainWindow    = null;
let serverProcess = null;
let _theaterActive = false;   // legacy renderer state; navigation policy applies unconditionally

// ── Discord Rich Presence ─────────────────────────────────────────────────────
// Requires artkeys.json  →  { "discordAppId": "YOUR_APPLICATION_ID" }
// Create a free app at discord.com/developers/applications, then copy the ID.
// If no ID is configured discord-rpc is silently skipped — app still works fully.

let _rpc    = null;   // discord-rpc Client instance
let _rpcReady = false;

function _readDiscordAppId() {
  try {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'artkeys.json'), 'utf8'));
    return cfg.discordAppId || '';
  } catch { return ''; }
}

function initDiscord() {
  const appId = _readDiscordAppId();
  if (!appId) return;   // no key configured — skip gracefully

  let DiscordRPC;
  try { DiscordRPC = require('discord-rpc'); } catch { return; }

  DiscordRPC.register(appId);
  _rpc = new DiscordRPC.Client({ transport: 'ipc' });

  _rpc.on('ready', () => {
    _rpcReady = true;
    _rpc.setActivity({
      details:        'Browsing the collection',
      state:          "In Kente's Korner",
      startTimestamp: Date.now(),
      largeImageKey:  'kente-icon',
      largeImageText: "Kente's Korner",
      instance:       false,
    }).catch(() => {});
    console.log('[discord] Rich Presence connected');
  });

  _rpc.on('disconnected', () => { _rpcReady = false; });
  _rpc.login({ clientId: appId }).catch(err => {
    console.warn('[discord] Could not connect (Discord may be closed):', err.message);
  });
}

function destroyDiscord() {
  if (_rpc) { try { _rpc.destroy(); } catch {} _rpc = null; }
}

// ── Path helpers ────────────────────────────────────────────────────────────

/** Resolve a path inside `resources/` whether in dev or packaged mode. */
function resourcePath(...parts) {
  const base = app.isPackaged
    ? process.resourcesPath                        // <install>/resources/
    : path.join(__dirname, '..', 'resources');     // workspace/resources/ (dev)
  return path.join(base, ...parts);
}

/** Find the server executable or fall back to running the .py script. */
function resolveServer() {
  // Dev mode: prefer the Python script so backend edits take effect immediately.
  // Set KENTE_USE_EXE_SERVER=1 to force the bundled exe even in dev.
  if (!app.isPackaged && process.env.KENTE_USE_EXE_SERVER !== '1') {
    const py = path.join(__dirname, '..', 'batocera', 'kente-server.py');
    return { cmd: 'python', args: [py] };
  }
  const exe = resourcePath(process.platform === 'win32' ? 'kente-server.exe' : 'kente-server');
  if (fs.existsSync(exe)) return { cmd: exe, args: [] };
  // Dev fallback — requires Python 3 in PATH
  const py = path.join(__dirname, '..', 'batocera', 'kente-server.py');
  return { cmd: 'python', args: [py] };
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

function startServer() {
  const { cmd, args } = resolveServer();
  // PyInstaller onefile executables unpack to %TEMP% by default. On some
  // kiosk/locked-down setups this can fail. Force a temp dir under userData
  // so the bundled server can always unpack without admin rights.
  const pyiTmp = path.join(app.getPath('userData'), 'pyi-tmp');
  try { fs.mkdirSync(pyiTmp, { recursive: true }); } catch {}
  const env = {
    ...process.env,
    KENTE_APP_MODE:     'electron',
    KENTE_HOST_PID:     String(process.pid),
    KENTE_DATA_DIR:     path.join(app.getPath('userData'), 'KenteCorner'),
    KENTE_RUNTIME_DIR:  resourcePath('emulators'),
    KENTE_RUNTIME_DLL_DIR: resourcePath('runtime-dlls'),
    TEMP:               pyiTmp,
    TMP:                pyiTmp,
    KENTE_DOLPHIN_PATH: resourcePath('emulators', 'dolphin', 'Dolphin.exe'),
    // Web assets live outside the asar so the bundled python server can
    // read them.  In dev (unpackaged) we point at the repo root.
    KENTE_WEB_DIR:      app.isPackaged
                          ? resourcePath('web')
                          : path.join(__dirname, '..'),
  };

  console.log('[kente] Starting server:', cmd, args.join(' '));
  serverProcess = spawn(cmd, args, { env, stdio: 'pipe' });

  serverProcess.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', code => console.log(`[kente] Server exited (code ${code})`));
}

function killServer() {
  if (!serverProcess) return;
  const proc = serverProcess;
  serverProcess = null;
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  // A PyInstaller onefile server has a bootloader parent and a Python child.
  // Killing only the parent on Windows leaves the HTTP server on port 7777.
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      return;
    } catch (_) { /* fall back if the process already exited or taskkill failed */ }
  }
  try { proc.kill(); } catch (_) {}
}

/** Poll /api/ping until the server responds 200 or the timeout elapses. */
function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + SERVER_TIMEOUT;
    const attempt = () => {
      if (Date.now() > deadline) {
        reject(new Error('Server failed to start within 30 s'));
        return;
      }
      const req = http.get(`http://localhost:${SERVER_PORT}/api/ping`, res => {
        if (res.statusCode === 200) { resolve(); }
        else { setTimeout(attempt, 500); }
      });
      req.on('error', () => setTimeout(attempt, 500));
      req.setTimeout(1000, () => { req.destroy(); setTimeout(attempt, 500); });
    };
    attempt();
  });
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  console.log('[kente] Creating main window');
  mainWindow = new BrowserWindow({
    title:           "Kente's Korner",
    width:           1280,
    height:          800,
    show:            false,   // shown after ready-to-show to avoid blank flash
    backgroundColor: '#070810',
    icon:            path.join(__dirname, '..', 'resources', 'KenteCorner.ico'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      nodeIntegration:  false,
      contextIsolation: true,
      backgroundThrottling: false,
      // Allow EmulatorJS / Archive.org cross-origin fetches
      webSecurity:      true,
    },
  });

  let _shown = false;
  const showMainWindow = () => {
    if (_shown || !mainWindow || mainWindow.isDestroyed()) return;
    _shown = true;
    console.log('[kente] Showing main window');
    mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
  };
  mainWindow.once('ready-to-show', showMainWindow);
  mainWindow.webContents.once('did-fail-load', (_event, code, description, url) => {
    console.error(`[kente] Page load failed (${code}): ${description} — ${url}`);
  });
  // Do not leave the app running invisibly if Chromium fails to emit
  // ready-to-show (for example, while recovering from a broken GPU process).
  mainWindow.webContents.once('did-finish-load', showMainWindow);
  setTimeout(showMainWindow, 5000);

  mainWindow.loadURL(`http://localhost:${SERVER_PORT}`).catch(err => {
    console.error('[kente] Could not load app page:', err.message);
  });

  // F11 fullscreen toggle (works even when focus is inside an iframe).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key !== 'F11') return;
    event.preventDefault();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  // Keep renderer state synced when fullscreen changes via F11 or OS controls.
  mainWindow.on('enter-full-screen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('kente:window:fullScreenChanged', true);
  });
  mainWindow.on('leave-full-screen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('kente:window:fullScreenChanged', false);
  });

  // Keep Kente standalone: deny popups instead of opening a system browser.
  // Allow only the local Kente server as a top-level navigation target.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: 'deny' };
  });

  const isKenteLocalUrl = url => {
    try {
      const u = new URL(url);
      return (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
        && Number(u.port || 80) === SERVER_PORT && u.protocol === 'http:';
    } catch {}
    return false;
  };
  const blockExternalTopLevelNavigation = (event, url) => {
    if (!isKenteLocalUrl(url)) event.preventDefault();
  };
  mainWindow.webContents.on('will-navigate', blockExternalTopLevelNavigation);
  mainWindow.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    // Remote game content may redirect inside its embedded frame, but it
    // cannot replace Kente's local app page.
    if (isMainFrame) blockExternalTopLevelNavigation(event, url);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('close', () => {
    if (process.platform !== 'darwin') return;
    stopMacPlayerAndDetach();
  });
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

function nativePlayerRequest(route, body, timeout = 650000) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const request = http.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: route,
      method: payload ? 'POST' : 'GET', headers: payload ? {
        'Content-Type': 'application/json', 'Content-Length': payload.length,
      } : {} }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; if (data.length > 65536) request.destroy(new Error('Invalid player response')); });
      response.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid player response')); }
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('Player request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

function isPlayerSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  const frame = event.senderFrame;
  if (frame && frame !== mainWindow.webContents.mainFrame) return false;
  try {
    const url = new URL(frame?.url || mainWindow.webContents.getURL());
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
      && Number(url.port || 80) === SERVER_PORT;
  } catch { return false; }
}

function macPcee2ResourcePath(...parts) {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'emulators', 'pcee2')
    : path.join(__dirname, '..', 'resources', 'emulators', 'pcee2');
  return path.join(base, ...parts);
}

function macPcee2Revision() {
  try {
    const revision = fs.readFileSync(macPcee2ResourcePath('PCEE2-REVISION.txt'), 'utf8').trim();
    return /^[a-f\d]{40}$/i.test(revision) ? revision : null;
  } catch { return null; }
}

function stopMacPlayerAndDetach() {
  macLaunchGeneration++;
  try { macLibretroHost?.stop(); } catch (error) { console.warn('[kente] Mac core cleanup:', error.message); }
  try { macLibretroHost?.setPlayerView(null); } catch (error) { console.warn('[kente] Mac frame target cleanup:', error.message); }
  try { macPlayerSurface?.detach(); } catch (error) { console.warn('[kente] Mac surface cleanup:', error.message); }
}

ipcMain.on('kente:mac-player:available', event => {
  if (process.platform !== 'darwin' || !macPlayerSurface || !macLibretroHost) {
    event.returnValue = false;
    return;
  }
  try {
    // Validate the packaged core, runtime-loaded Vulkan dependency, and
    // required PCSX2 resources before advertising PS2 support in the UI.
    const runtimeResources = macPcee2ResourcePath('runtime-resources');
    event.returnValue = !!macPcee2Revision()
      && fs.existsSync(path.join(runtimeResources, 'GameIndex.yaml'))
      && macLibretroHost.probeCore(macPcee2ResourcePath('pcee2_libretro.dylib')) === true;
  } catch (error) {
    console.error('[kente] Packaged Mac emulator core is unavailable:', error.message);
    event.returnValue = false;
  }
});

ipcMain.handle('kente:mac-player:mount', async (event, rect) => {
  if (!isPlayerSender(event) || process.platform !== 'darwin' || !macPlayerSurface) {
    return { success: false, error: 'MAC_PLAYER_UNAVAILABLE' };
  }
  if (!rect || typeof rect !== 'object') return { success: false, error: 'INVALID_PLAYER_BOUNDS' };
  const handle = mainWindow.getNativeWindowHandle();
  const [width, height] = mainWindow.getContentSize();
  try {
    if (!macPlayerSurface.mount(handle, { ...rect, hostWidth: width, hostHeight: height }))
      return { success: false, error: 'MAC_PLAYER_MOUNT_FAILED' };
    if (!macLibretroHost?.setPlayerView(macPlayerSurface.viewHandle())) {
      stopMacPlayerAndDetach();
      return { success: false, error: 'MAC_PLAYER_MOUNT_FAILED' };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: 'MAC_PLAYER_MOUNT_FAILED', message: error.message };
  }
});

ipcMain.handle('kente:mac-player:resize', (event, rect) => {
  if (!isPlayerSender(event) || process.platform !== 'darwin' || !macPlayerSurface) return false;
  return macPlayerSurface.resize(rect);
});

ipcMain.handle('kente:mac-player:present', (event, rgba, width, height) => {
  if (!isPlayerSender(event) || process.platform !== 'darwin' || !macPlayerSurface
      || !Buffer.isBuffer(rgba)) return false;
  return macPlayerSurface.present(rgba, width, height);
});

ipcMain.handle('kente:mac-player:detach', event => {
  if (!isPlayerSender(event) || process.platform !== 'darwin' || !macPlayerSurface) return false;
  stopMacPlayerAndDetach();
  return true;
});

ipcMain.handle('kente:mac-player:import-bios', async (event, payload) => {
  if (!isPlayerSender(event) || process.platform !== 'darwin')
    return { success: false, error: 'MAC_PLAYER_UNAVAILABLE' };
  let bytes = null;
  if (payload instanceof ArrayBuffer) bytes = Buffer.from(payload);
  else if (ArrayBuffer.isView(payload))
    bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (!bytes || bytes.length < 1_000_000 || bytes.length > 16 * 1024 * 1024)
    return { success: false, error: 'INVALID_PS2_BIOS', message: 'Choose a PS2 BIOS file between 1 MB and 16 MB.' };

  const biosRoot = path.join(app.getPath('userData'), 'KenteCorner', 'bios');
  const target = path.join(biosRoot, 'scph39001.bin');
  const temporary = path.join(biosRoot, `.scph39001-${randomUUID()}.tmp`);
  try {
    await fs.promises.mkdir(biosRoot, { recursive: true });
    await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, target);
    return { success: true, filename: path.basename(target) };
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    return { success: false, error: 'PS2_BIOS_IMPORT_FAILED', message: error.message };
  }
});

ipcMain.handle('kente:mac-player:launch', async (event, game, rect) => {
  if (!isPlayerSender(event) || process.platform !== 'darwin' || !macLibretroHost || !macPlayerSurface)
    return { success: false, error: 'MAC_PLAYER_UNAVAILABLE' };
  if (!game || game.systemId !== 'ps2' || typeof game.title !== 'string'
      || typeof game.sessionId !== 'string')
    return { success: false, error: 'UNSUPPORTED_MAC_SYSTEM' };
  if (!rect || typeof rect !== 'object') return { success: false, error: 'INVALID_PLAYER_BOUNDS' };
  const launchGeneration = ++macLaunchGeneration;
  const isCancelled = () => launchGeneration !== macLaunchGeneration;
  const coreRevision = macPcee2Revision();
  if (!coreRevision) return { success: false, error: 'MAC_CORE_MISSING', message: 'The packaged PS2 core revision is invalid.' };
  const corePath = macPcee2ResourcePath('pcee2_libretro.dylib');
  if (!fs.existsSync(corePath)) return { success: false, error: 'MAC_CORE_MISSING' };
  try {
    const dataRoot = path.resolve(app.getPath('userData'), 'KenteCorner');
    const biosSource = path.join(dataRoot, 'bios');
    const validBios = fs.existsSync(biosSource) && fs.readdirSync(biosSource).some(name => {
      const file = path.join(biosSource, name);
      return name.toLowerCase().endsWith('.bin') && fs.statSync(file).isFile()
        && fs.statSync(file).size >= 1_000_000;
    });
    if (!validBios) return { success: false, error: 'PS2_BIOS_MISSING' };
    let resolved = await nativePlayerRequest(`/api/rom/resolve?${new URLSearchParams({
      systemId: game.systemId, title: game.title, ...(game.filename ? { filename: game.filename } : {}),
    })}`, null, 5000);
    if (isCancelled()) return { success: false, error: 'MAC_PLAYER_CANCELLED' };
    if (!resolved.found || !resolved.filename) return { success: false, error: 'ROM_NOT_FOUND' };
    const prepared = await nativePlayerRequest('/api/rom/prepare', {
      systemId: game.systemId, filename: resolved.filename,
    }, 30 * 60 * 1000);
    if (isCancelled()) return { success: false, error: 'MAC_PLAYER_CANCELLED' };
    if (!prepared.success || !prepared.path)
      return { success: false, error: prepared.error || 'ROM_NOT_FOUND', message: prepared.message };
    const romPath = path.resolve(prepared.path);
    if (!romPath.startsWith(dataRoot + path.sep))
      return { success: false, error: 'ROM_NOT_FOUND' };
    // PCSX2 resources are version-matched to the core. Isolate them per pinned
    // revision so an app update cannot silently reuse stale resources.
    const systemDir = path.join(dataRoot, 'system', `pcee2-${coreRevision}`);
    const saveDir = path.join(dataRoot, 'saves', 'ps2');
    const biosDir = path.join(systemDir, 'pcsx2', 'bios');
    const pcsx2Dir = path.join(systemDir, 'pcsx2');
    const runtimeResources = path.join(pcsx2Dir, 'resources');
    const bundledResources = macPcee2ResourcePath('runtime-resources');
    fs.mkdirSync(pcsx2Dir, { recursive: true });
    // Merge on every launch: a prior partial resource install must not leave
    // PCEE2 without required files. Existing user-provided files remain intact.
    fs.cpSync(bundledResources, runtimeResources, { recursive: true, force: false, errorOnExist: false });
    fs.mkdirSync(path.dirname(biosDir), { recursive: true });
    fs.mkdirSync(runtimeResources, { recursive: true });
    fs.mkdirSync(biosDir, { recursive: true });
    for (const name of fs.readdirSync(biosSource)) {
      const source = path.join(biosSource, name);
      const target = path.join(biosDir, name);
      if (name.toLowerCase().endsWith('.bin') && fs.statSync(source).isFile()
          && (!fs.existsSync(target) || name.toLowerCase() === 'scph39001.bin'))
        fs.copyFileSync(source, target);
    }
    if (isCancelled()) return { success: false, error: 'MAC_PLAYER_CANCELLED' };
    if (!macPlayerSurface.mount(mainWindow.getNativeWindowHandle(), rect))
      return { success: false, error: 'MAC_PLAYER_MOUNT_FAILED' };
    const frameTarget = macPlayerSurface.viewHandle();
    if (!Buffer.isBuffer(frameTarget) || !macLibretroHost.setPlayerView(frameTarget)) {
      stopMacPlayerAndDetach();
      return { success: false, error: 'MAC_PLAYER_MOUNT_FAILED' };
    }
    const started = macLibretroHost.start({ corePath, gamePath: romPath, systemDir, saveDir });
    if (!started) {
      stopMacPlayerAndDetach();
      return { success: false, error: 'MAC_PLAYER_START_FAILED' };
    }
    return { success: true, filename: resolved.filename };
  } catch (error) {
    if (isCancelled()) return { success: false, error: 'MAC_PLAYER_CANCELLED' };
    stopMacPlayerAndDetach();
    return { success: false, error: 'MAC_PLAYER_START_FAILED', message: error.message };
  }
});

ipcMain.handle('kente:mac-player:status', event => {
  if (!isPlayerSender(event) || !macLibretroHost) return { running: false };
  return macLibretroHost.status();
});

ipcMain.handle('kente:mac-player:control', (event, action, rect) => {
  if (!isPlayerSender(event) || !macLibretroHost) return { success: false };
  if (action === 'stop') {
    stopMacPlayerAndDetach();
    return { success: true };
  }
  if (action === 'pause' || action === 'resume') {
    const success = macLibretroHost.setPaused(action === 'pause');
    if (!success) return { success: false };
    if (macPlayerSurface?.setVisible(action === 'resume')) return { success: true };
    // Do not report a successful transition if the AppKit surface could not
    // reveal the HUD or restore the video. Best-effort rollback keeps the core
    // and shared menu state aligned with the visible native surface.
    macLibretroHost.setPaused(action === 'resume');
    return { success: false };
  }
  if (action === 'resize') return { success: !!macPlayerSurface?.resize(rect) };
  return { success: false };
});

ipcMain.on('kente:mac-player:input', (event, buttons, axes) => {
  if (!isPlayerSender(event) || !macLibretroHost || !Number.isInteger(buttons) || !Array.isArray(axes)) return;
  macLibretroHost.setInput(buttons, axes);
});

ipcMain.handle('kente:mac-player:change-disc', (event, direction) => {
  if (!isPlayerSender(event) || process.platform !== 'darwin' || !macLibretroHost
      || !Number.isInteger(direction) || (direction !== -1 && direction !== 1))
    return { success: false };
  return { success: macLibretroHost.changeDisc(direction) === true };
});

ipcMain.handle('kente:native:launch', async (event, game, rect) => {
  if (!isPlayerSender(event) || process.platform !== 'win32') return { success: false, error: 'NATIVE_UNAVAILABLE' };
  if (!game || typeof game.systemId !== 'string' || typeof game.title !== 'string') return { success: false, error: 'INVALID_GAME' };
  const handle = mainWindow.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
  try {
    return await nativePlayerRequest('/api/native/start', {
      systemId: game.systemId, title: game.title, filename: game.filename || null,
      exePath: game.exePath || null, host: { hwnd, rect, sessionId: game.sessionId },
    });
  } catch (error) { return { success: false, error: 'PLAYER_CONNECTION', message: error.message }; }
});

ipcMain.handle('kente:native:status', async event => {
  if (!isPlayerSender(event)) return { running: false };
  return nativePlayerRequest('/api/native/status', null, 3000);
});

ipcMain.handle('kente:native:import', async (event, engine) => {
  if (!isPlayerSender(event) || !['pcsx2', 'dolphin', 'rpcs3', 'cemu', 'flycast', 'xemu', 'xenia', 'ryujinx'].includes(engine)) return { success: false };
  const chosen = await dialog.showOpenDialog(mainWindow, { title: 'Add a portable game engine to Kente',
    properties: ['openDirectory'], buttonLabel: 'Add to Kente' });
  if (chosen.canceled || !chosen.filePaths.length) return { success: false, cancelled: true };
  return nativePlayerRequest('/api/native/import', { engine, source: chosen.filePaths[0] });
});

ipcMain.handle('kente:native:control', async (event, action, rect, sessionId) => {
  if (!isPlayerSender(event) || !['stop', 'resize', 'menu', 'resume'].includes(action)) return { success: false };
  const result = await nativePlayerRequest('/api/native/control', { action, rect, sessionId }, 6000);
  if (action === 'menu' || action === 'stop') {
    mainWindow.focus();
    mainWindow.webContents.focus();
  }
  return result;
});

ipcMain.handle('kente:lobby:captureSources', async event => {
  if (!isPlayerSender(event)) return [];
  const sources = await desktopCapturer.getSources({ types: ['window'], fetchWindowIcons: false });
  return sources.filter(source => /kente/i.test(source.name))
    .map(source => ({ id: source.id, name: source.name }));
});

ipcMain.handle('kente:lobby:remoteKey', async (event, key, down, sessionId) => {
  if (!isPlayerSender(event) || typeof key !== 'string' || typeof down !== 'boolean') return { success: false };
  return nativePlayerRequest('/api/native/remote-key', { key, down, sessionId }, 4000);
});

/** Renderer calls this after a native emulator (Dolphin etc.) exits. */
ipcMain.on('kente:focusWindow', event => {
  if (!isPlayerSender(event)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.restore();
    mainWindow.focus();
  }
});

/**
 * Hide the KenteCorner window so a native emulator (Dolphin, PCSX2, etc.)
 * can take over the full screen seamlessly — no Electron chrome visible.
 * Called just before the emulator process is spawned.
 */
ipcMain.on('kente:hideWindow', event => {
  if (!isPlayerSender(event)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
});

/**
 * Restore and focus the window after the emulator exits.
 * The renderer polls /api/app/status and fires this when running → false.
 */
ipcMain.on('kente:showWindow', event => {
  if (!isPlayerSender(event)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    // Emulator exited — tell renderer to reset Discord presence to "Browsing"
    mainWindow.webContents.send('kente:discord:reset');
  }
});

/**
 * Renderer compatibility state. Popup denial and localhost-only top-frame
 * navigation are enforced unconditionally by the BrowserWindow handlers.
 */
ipcMain.on('kente:theater:setActive', (event, active) => {
  if (!isPlayerSender(event)) return;
  _theaterActive = !!active;
});

// ── Window controls ─────────────────────────────────────────────────────────-
ipcMain.on('kente:window:setFullScreen', (event, flag) => {
  if (!isPlayerSender(event)) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setFullScreen(!!flag);
});
ipcMain.on('kente:window:toggleFullScreen', event => {
  if (!isPlayerSender(event)) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// ── Cursor-mode input injection (Electron only) ─────────────────────────────
function _clampToWindow(x, y) {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0 };
  const [w, h] = mainWindow.getContentSize();
  const nx = Number.isFinite(Number(x)) ? Number(x) : 0;
  const ny = Number.isFinite(Number(y)) ? Number(y) : 0;
  const cx = Math.max(0, Math.min(Math.max(0, w - 1), nx));
  const cy = Math.max(0, Math.min(Math.max(0, h - 1), ny));
  return { x: cx, y: cy };
}

ipcMain.on('kente:input:mouseMove', (event, pos) => {
  if (!isPlayerSender(event)) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { x, y } = _clampToWindow(pos?.x, pos?.y);
  if (!mainWindow.isFocused()) mainWindow.focus();
  mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
});

ipcMain.on('kente:input:mouseClick', (event, pos) => {
  if (!isPlayerSender(event)) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { x, y } = _clampToWindow(pos?.x, pos?.y);
  if (!mainWindow.isFocused()) mainWindow.focus();
  // Ensure the pointer is "at" the target before the click.
  mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
  mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  mainWindow.webContents.sendInputEvent({ type: 'mouseUp',   x, y, button: 'left', clickCount: 1 });
});

// Renderer → main: update Discord Rich Presence activity
ipcMain.on('kente:discord:set', (event, data) => {
  if (!isPlayerSender(event)) return;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  if (!_rpc || !_rpcReady) return;
  _rpc.setActivity(data).catch(() => {});
});

// Renderer → main: clear activity (game ended in browser mode)
ipcMain.on('kente:discord:clear', event => {
  if (!isPlayerSender(event)) return;
  if (!_rpc || !_rpcReady) return;
  _rpc.setActivity({
    details:        'Browsing the collection',
    state:          "In Kente's Korner",
    largeImageKey:  'kente-icon',
    largeImageText: "Kente's Korner",
    instance:       false,
  }).catch(() => {});
});

// ── Auto-updater (packaged builds only) ──────────────────────────────────────
// Checks GitHub releases for a newer version on every launch.
// In dev mode (app.isPackaged === false) this block is skipped entirely.

let _autoUpdater = null;
let _updateCheck = null;

function checkForAppUpdates() {
  if (!app.isPackaged) return Promise.resolve({ success: false, message: 'Updates are available in an installed build.' });
  if (!_autoUpdater) return Promise.resolve({ success: false, message: 'The updater is not available for this build.' });
  if (_updateCheck) return _updateCheck;
  _updateCheck = _autoUpdater.checkForUpdates().then(result => {
    const version = result?.updateInfo?.version || app.getVersion();
    const current = app.getVersion().split(/[.+-]/).map(Number);
    const next = String(version).split(/[.+-]/).map(Number);
    let available = false;
    for (let i = 0; i < Math.max(current.length, next.length); i++) {
      if ((next[i] || 0) === (current[i] || 0)) continue;
      available = (next[i] || 0) > (current[i] || 0);
      break;
    }
    return { success: true, available, version };
  }).finally(() => { _updateCheck = null; });
  return _updateCheck;
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;   // no-op in dev
  try {
    const { autoUpdater } = require('electron-updater');
    _autoUpdater = autoUpdater;
    autoUpdater.autoDownload    = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', info => {
      console.log(`[kente] Update available: v${info.version} — downloading...`);
    });

    autoUpdater.on('update-downloaded', info => {
      // Show a non-blocking notification so the user knows what happened
      dialog.showMessageBox(mainWindow, {
        type:    'info',
        title:   "Kente's Korner — Update Ready",
        message: `Version ${info.version} downloaded.\nIt will be installed when you close the app.`,
        buttons: ['Install Now', 'Later'],
        icon:    path.join(__dirname, '..', 'resources', 'KenteCorner.ico'),
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    });

    autoUpdater.on('error', err => {
      console.warn('[kente] Auto-update check failed (continuing):', err.message);
    });

    // Offline-friendly: only attempt an update check when we appear to have WAN.
    // Prevents noisy Chromium TLS handshake errors on offline cabinets.
    const dns = require('dns');
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok) checkForAppUpdates().catch(() => {});
    };
    const tid = setTimeout(() => finish(false), 1200);
    dns.lookup('github.com', err => { clearTimeout(tid); finish(!err); });
  } catch (err) {
    console.warn('[kente] electron-updater not available:', err.message);
  }
}

ipcMain.handle('kente:update:check', async event => {
  if (!isPlayerSender(event)) return { success: false, message: 'Update check is unavailable.' };
  try { return await checkForAppUpdates(); }
  catch (error) { return { success: false, message: error.message || 'Could not check for updates.' }; }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

/**
 * Trigger the OS-level emulator dependency installer in the background.
 * The server checks what's already installed and only downloads what's missing.
 * Fire-and-forget — the UI can poll /api/emulators/install/status for progress.
 */
function ensureEmulatorDeps() {
  const body = '{}';
  const req  = http.request(
    { hostname: 'localhost', port: SERVER_PORT, path: '/api/emulators/install',
      method: 'POST', headers: { 'Content-Type': 'application/json',
                                  'Content-Length': Buffer.byteLength(body) } },
    res => { res.resume(); console.log(`[kente] emulator dep-check started (${res.statusCode})`); }
  );
  req.on('error', () => {}); // non-critical
  req.end(body);
}

/**
 * Prefetch EmulatorJS stable assets + cores into the local cache so
 * browser-based systems (SNES/GBA/etc.) work offline after the first run.
 * Safe to call repeatedly; the server skips files already on disk.
 */
function ensureEmulatorJSOfflinePack() {
  const body = '{}';
  const req  = http.request(
    { hostname: 'localhost', port: SERVER_PORT, path: '/api/ejs/prefetch',
      method: 'POST', headers: { 'Content-Type': 'application/json',
                                  'Content-Length': Buffer.byteLength(body) } },
    res => { res.resume(); console.log(`[kente] EJS prefetch started (${res.statusCode})`); }
  );
  req.on('error', () => {}); // non-critical
  req.end(body);
}

/**
 * Verify BIOS presence and (where possible) auto-configure native emulators.
 * Does NOT download BIOS files — it only uses what the user already provided.
 */
function ensureBiosSetup() {
  // By default, do not attempt any network downloads at startup (offline-friendly).
  // PS3 firmware download (PS3UPDAT.PUP) is only attempted when the user tries
  // to launch a PS3 title and opts into setup.
  const body = JSON.stringify({ allowDownload: false });
  const req  = http.request(
    { hostname: 'localhost', port: SERVER_PORT, path: '/api/bios/download',
      method: 'POST', headers: { 'Content-Type': 'application/json',
                                  'Content-Length': Buffer.byteLength(body) } },
    res => { res.resume(); console.log(`[kente] BIOS check started (${res.statusCode})`); }
  );
  req.on('error', () => {}); // non-critical
  req.end(body);
}

app.whenReady().then(async () => {
  console.log('[kente] Electron ready');
  startServer();
  try {
    await waitForServer();
    console.log('[kente] Server ready; opening window');
    createWindow();
    setupAutoUpdater();
    // Ensure all emulator OS dependencies are installed.
    // Runs 4 s after window shows so paint isn't blocked.
    // Native engines are provisioned inside Kente when their game is launched.
    // A fresh app must not install unrelated OS applications in the background.
    // Seed EmulatorJS core cache in the background (enables offline play).
    setTimeout(ensureEmulatorJSOfflinePack, 4500);
    // Copy/configure provided BIOS files into native emulators where applicable.
    // Firmware and BIOS paths are configured when their private engine starts.
    setTimeout(initDiscord, 2000);   // after window is visible, connect Discord
  } catch (err) {
    console.error('[kente] Could not start server:', err.message);
    app.quit();
  }
});

// macOS: re-create window when dock icon clicked with no windows open
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let _gracefulQuit = false;
app.on('before-quit', event => {
  if (_gracefulQuit || !serverProcess || serverProcess.exitCode !== null) return;
  event.preventDefault();
  _gracefulQuit = true;
  nativePlayerRequest('/api/native/control', { action: 'stop' }, 5000)
    .catch(() => {}).finally(() => app.quit());
});
app.on('will-quit', () => {
  stopMacPlayerAndDetach();
  killServer();
  destroyDiscord();
});
