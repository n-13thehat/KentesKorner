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

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');

const SERVER_PORT    = 7777;
const SERVER_TIMEOUT = 30_000;   // ms to wait for server to boot

let mainWindow    = null;
let serverProcess = null;
let _theaterActive = false;   // set via IPC; gates the window-open + will-navigate handlers

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
  const exe = resourcePath('kente-server.exe');
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
    KENTE_DATA_DIR:     path.join(app.getPath('userData'), 'KenteCorner'),
    TEMP:               pyiTmp,
    TMP:                pyiTmp,
    KENTE_DOLPHIN_PATH: resourcePath('dolphin', 'Dolphin.exe'),
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
  try { serverProcess.kill(); } catch (_) {}
  serverProcess = null;
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
  mainWindow = new BrowserWindow({
    width:           1280,
    height:          800,
    show:            false,   // shown after ready-to-show to avoid blank flash
    backgroundColor: '#070810',
    icon:            path.join(__dirname, '..', 'resources', 'KenteCorner.ico'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      nodeIntegration:  false,
      contextIsolation: true,
      // Allow EmulatorJS / Archive.org cross-origin fetches
      webSecurity:      true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);

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

  // Open external links in the default browser, not in Electron — but
  // suppress them while the Theater is active. Ad scripts inside embed
  // iframes call window.open(adUrl), which Electron turns into
  // shell.openExternal and pops the user's default browser. The renderer
  // sets _theaterActive via IPC whenever the theater overlay is showing.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (_theaterActive) return { action: 'deny' };
    // Strict protocol check — startsWith('http') alone would also match
    // weird custom schemes like httpfoo:// that a malicious embed could
    // craft to bounce through the OS handler.
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Block ad-driven top-frame redirects while the Theater is active. An
  // iframe ad doing `top.location = adUrl` would otherwise navigate the
  // whole app away from the loaded http://localhost server URL.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!_theaterActive) return;
    try {
      const u = new URL(url);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return;
    } catch {}
    event.preventDefault();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

/** Renderer calls this after a native emulator (Dolphin etc.) exits. */
ipcMain.on('kente:focusWindow', () => {
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
ipcMain.on('kente:hideWindow', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
});

/**
 * Restore and focus the window after the emulator exits.
 * The renderer polls /api/app/status and fires this when running → false.
 */
ipcMain.on('kente:showWindow', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    // Emulator exited — tell renderer to reset Discord presence to "Browsing"
    mainWindow.webContents.send('kente:discord:reset');
  }
});

/**
 * Renderer → main: toggle the "theater is on screen" flag. While true,
 * setWindowOpenHandler refuses to forward URLs to the system browser and
 * will-navigate blocks any non-localhost top-frame navigation. This is
 * what stops embed-iframe ad scripts from popping the user's browser.
 */
ipcMain.on('kente:theater:setActive', (_, active) => {
  _theaterActive = !!active;
});

// ── Window controls ─────────────────────────────────────────────────────────-
ipcMain.on('kente:window:setFullScreen', (_, flag) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setFullScreen(!!flag);
});
ipcMain.on('kente:window:toggleFullScreen', () => {
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

ipcMain.on('kente:input:mouseMove', (_, pos) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { x, y } = _clampToWindow(pos?.x, pos?.y);
  if (!mainWindow.isFocused()) mainWindow.focus();
  mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
});

ipcMain.on('kente:input:mouseClick', (_, pos) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { x, y } = _clampToWindow(pos?.x, pos?.y);
  if (!mainWindow.isFocused()) mainWindow.focus();
  // Ensure the pointer is "at" the target before the click.
  mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
  mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  mainWindow.webContents.sendInputEvent({ type: 'mouseUp',   x, y, button: 'left', clickCount: 1 });
});

// Renderer → main: update Discord Rich Presence activity
ipcMain.on('kente:discord:set', (_, data) => {
  if (!_rpc || !_rpcReady) return;
  _rpc.setActivity(data).catch(() => {});
});

// Renderer → main: clear activity (game ended in browser mode)
ipcMain.on('kente:discord:clear', () => {
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

function setupAutoUpdater() {
  if (!app.isPackaged) return;   // no-op in dev
  try {
    const { autoUpdater } = require('electron-updater');
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
      if (ok) autoUpdater.checkForUpdates().catch(() => {});
    };
    const tid = setTimeout(() => finish(false), 1200);
    dns.lookup('github.com', err => { clearTimeout(tid); finish(!err); });
  } catch (err) {
    console.warn('[kente] electron-updater not available:', err.message);
  }
}

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
  startServer();
  try {
    await waitForServer();
    createWindow();
    setupAutoUpdater();
    // Ensure all emulator OS dependencies are installed.
    // Runs 4 s after window shows so paint isn't blocked.
    setTimeout(ensureEmulatorDeps, 4000);
    // Seed EmulatorJS core cache in the background (enables offline play).
    setTimeout(ensureEmulatorJSOfflinePack, 4500);
    // Copy/configure provided BIOS files into native emulators where applicable.
    setTimeout(ensureBiosSetup, 5500);
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

app.on('will-quit', () => { killServer(); destroyDiscord(); });
