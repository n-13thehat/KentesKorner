'use strict';
/**
 * KenteCorner — Electron Preload Script
 *
 * Runs in the renderer context BEFORE the page script, with Node.js
 * access. Exposes a minimal, typed API to `window.electronAPI` via
 * contextBridge so the renderer (js/) can communicate with the main process
 * without nodeIntegration being enabled (security-safe pattern).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** True when KenteCorner is running as a packaged desktop app. */
  isElectron: true,

  /** Bring the KenteCorner window to the foreground. */
  focusWindow: () => ipcRenderer.send('kente:focusWindow'),

  /**
   * Hide the KenteCorner window so a native emulator can take over the
   * full screen. Call this just before the emulator process starts.
   */
  hideWindow: () => ipcRenderer.send('kente:hideWindow'),

  /**
   * Restore and focus the window after the emulator exits.
   * Call this when /api/app/status reports running → false.
   */
  showWindow: () => ipcRenderer.send('kente:showWindow'),

  // ── Window controls ──────────────────────────────────────────────────────
  /** Toggle the app window fullscreen state. */
  toggleFullScreen: () => ipcRenderer.send('kente:window:toggleFullScreen'),

  /** Set fullscreen explicitly. */
  setFullScreen: (flag) => ipcRenderer.send('kente:window:setFullScreen', !!flag),

  /** Subscribe to fullscreen state changes (F11, OS controls, etc.). */
  onFullScreenChanged: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('kente:window:fullScreenChanged', (_, fs) => cb(!!fs));
  },

  // ── Discord Rich Presence ────────────────────────────────────────────────
  /**
   * Push a new Discord activity. Pass a standard discord-rpc activity object:
   *   { details, state, startTimestamp, largeImageKey, smallImageKey, ... }
   * Silently no-ops if Discord is not connected or app ID is not configured.
   */
  setDiscordPresence: (data) => ipcRenderer.send('kente:discord:set', data),

  /**
   * Clear the game activity and revert to "Browsing the collection".
   * Call this when a browser-emulated game exits.
   */
  clearDiscordPresence: () => ipcRenderer.send('kente:discord:clear'),

  /**
   * Register a callback fired when a native emulator exits (kente:showWindow).
   * js/room.js uses this to reset Discord presence back to "Browsing".
   */
  onDiscordReset: (cb) => ipcRenderer.on('kente:discord:reset', cb),

  // ── Theater popup guard ───────────────────────────────────────────────────
  /**
   * Tell the main process whether the Theater overlay is on screen. While
   * active, ad scripts inside embed iframes that call window.open(adUrl)
   * are silently denied instead of being forwarded to the system browser,
   * and ad-driven top-frame redirects are blocked.
   */
  setTheaterActive: (active) => ipcRenderer.send('kente:theater:setActive', !!active),

  // ── Cursor-mode input injection (Electron only) ──────────────────────────
  /** Move the Chromium mouse pointer (helps control cross-origin iframes). */
  sendMouseMove: (x, y) => ipcRenderer.send('kente:input:mouseMove', { x, y }),

  /** Click at (x, y) using Chromium-level input events. */
  sendMouseClick: (x, y) => ipcRenderer.send('kente:input:mouseClick', { x, y }),
});
