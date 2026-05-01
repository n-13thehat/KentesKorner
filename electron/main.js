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
  const exe = resourcePath('kente-server.exe');
  if (fs.existsSync(exe)) return { cmd: exe, args: [] };
  // Dev fallback — requires Python 3 in PATH
  const py = path.join(__dirname, '..', 'batocera', 'kente-server.py');
  return { cmd: 'python', args: [py] };
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

function startServer() {
  const { cmd, args } = resolveServer();
  const env = {
    ...process.env,
    KENTE_APP_MODE:     'electron',
    KENTE_DATA_DIR:     path.join(app.getPath('userData'), 'KenteCorner'),
    KENTE_DOLPHIN_PATH: resourcePath('dolphin', 'Dolphin.exe'),
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

  // Open external links in the default browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
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

    autoUpdater.checkForUpdates().catch(() => {});
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

app.whenReady().then(async () => {
  startServer();
  try {
    await waitForServer();
    createWindow();
    setupAutoUpdater();
    // Ensure all emulator OS dependencies are installed.
    // Runs 4 s after window shows so paint isn't blocked.
    setTimeout(ensureEmulatorDeps, 4000);
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
