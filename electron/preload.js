'use strict';
/**
 * KenteCorner — Electron Preload Script
 *
 * Runs in the renderer context BEFORE the page script, with Node.js
 * access. Exposes a minimal, typed API to `window.electronAPI` via
 * contextBridge so kente.js can communicate with the main process
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
   * kente.js uses this to reset Discord presence back to "Browsing".
   */
  onDiscordReset: (cb) => ipcRenderer.on('kente:discord:reset', cb),
});
