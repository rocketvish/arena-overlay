const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell } = require('electron');
const path = require('path');
const settings = require('./settings');
const tray = require('./tray');
const logWatcher = require('./logWatcher');
const landsData = require('./17landsData');
const appLogger = require('./appLogger');
const controlWindowModule = require('./controlWindow');
const assistantManager = require('./assistantManager');
const testReplay       = require('./testReplay');

const isDev = process.env.ELECTRON_ENV === 'development' || !app.isPackaged;

let overlayWindow = null;
let isInteractable = false;

// ─── Broadcast helper ────────────────────────────────────────────────────────

function sendToWindows(channel, data) {
  const windows = [
    overlayWindow,
    controlWindowModule.getControlWindow(),
  ];
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

function broadcastToAll(channel, data) {
  // Forward to renderer windows
  sendToWindows(channel, data);
  // Also handle in main process for assistant analysis
  assistantManager.handleEvent(channel, data).catch((e) => {
    console.error('[assistant] handleEvent error:', e.message);
  });
}

// ─── Window Creation ────────────────────────────────────────────────────────

function createOverlayWindow() {
  const s = settings.get();
  const { overlay } = s;

  let x = overlay.x;
  let y = overlay.y;
  if (x === -1) {
    const { workAreaSize } = screen.getPrimaryDisplay();
    x = workAreaSize.width - overlay.width - 10;
  }

  overlayWindow = new BrowserWindow({
    x,
    y,
    width: overlay.width,
    height: overlay.height,
    opacity: overlay.opacity,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setClickThrough(true);

  if (isDev) {
    overlayWindow.loadURL('http://localhost:5173');
  } else {
    overlayWindow.loadFile(
      path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html')
    );
  }

  overlayWindow.once('ready-to-show', () => {
    // Overlay is hidden by default — shows automatically when draft starts
    if (overlay.visible) overlayWindow.show();
  });

  overlayWindow.on('moved', saveWindowBounds);
  overlayWindow.on('resized', saveWindowBounds);
  overlayWindow.on('closed', () => { overlayWindow = null; });

  return overlayWindow;
}

function setClickThrough(clickThrough) {
  if (!overlayWindow) return;
  overlayWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
  isInteractable = !clickThrough;
  // Broadcast to all windows so the control window status bar updates too
  sendToWindows('interactable-changed', isInteractable);
}

function saveWindowBounds() {
  if (!overlayWindow) return;
  const b = overlayWindow.getBounds();
  settings.set('overlay.x', b.x);
  settings.set('overlay.y', b.y);
  settings.set('overlay.width', b.width);
  settings.set('overlay.height', b.height);
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────

function registerIPC() {
  // ── Settings ──────────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => settings.get());

  ipcMain.handle('settings:set', (_event, keyPath, value) => {
    const updated = settings.set(keyPath, value);
    if (keyPath === 'overlay.opacity') overlayWindow?.setOpacity(value);
    if (keyPath === 'overlay.visible') {
      value ? overlayWindow?.show() : overlayWindow?.hide();
      broadcastToAll('overlay-visibility-changed', value);
    }
    // Broadcast to all windows so they update in real-time
    broadcastToAll('settings-changed', updated);
    return updated;
  });

  ipcMain.handle('settings:reset', () => settings.reset());

  // ── Overlay controls ──────────────────────────────────────────────────────
  ipcMain.on('overlay:toggle-interact', () => setClickThrough(isInteractable));
  ipcMain.on('overlay:toggle-visibility', () => {
    if (!overlayWindow) return;
    const nowVisible = !overlayWindow.isVisible();
    nowVisible ? overlayWindow.show() : overlayWindow.hide();
    broadcastToAll('overlay-visibility-changed', nowVisible);
  });
  ipcMain.handle('overlay:get-visible', () => overlayWindow?.isVisible() ?? false);
  ipcMain.handle('overlay:set-visible', (_event, visible) => {
    if (!overlayWindow) return false;
    visible ? overlayWindow.show() : overlayWindow.hide();
    broadcastToAll('overlay-visibility-changed', visible);
    return visible;
  });

  // ── Log watcher ───────────────────────────────────────────────────────────
  ipcMain.on('log-watcher:restart', () => logWatcher.startWatching(broadcastToAll));

  // ── Log watcher start/stop (from control window) ──────────────────────────
  ipcMain.handle('control:start-watcher', () => {
    logWatcher.startWatching(broadcastToAll);
    return { running: true };
  });

  ipcMain.handle('control:stop-watcher', () => {
    logWatcher.stopWatching();
    return { running: false };
  });

  ipcMain.handle('watcher:status', () => {
    return { running: logWatcher.isRunning() };
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  ipcMain.handle('stats:get', () => logWatcher.getStats());

  // ── 17Lands data ──────────────────────────────────────────────────────────
  ipcMain.handle('17lands:fetch-set', async (_event, setCode, format) => {
    const result = await landsData.fetchSetData(setCode, format, { send: broadcastToAll });
    return result;
  });

  ipcMain.handle('17lands:fetch-color-pair', async (_event, setCode, format, colorPair) => {
    const result = await landsData.fetchColorPairData(setCode, format, colorPair, { send: broadcastToAll });
    return result;
  });

  ipcMain.handle('17lands:clear-cache', (_event, setCode, format) => {
    landsData.clearCache(setCode, format);
    return { ok: true };
  });

  // ── Scryfall ID resolution ─────────────────────────────────────────────────
  ipcMain.handle('scryfall:resolve-ids', async (_event, grpIds) => {
    return landsData.resolveArenaIds(grpIds);
  });

  // ── App version ───────────────────────────────────────────────────────────
  ipcMain.handle('app:get-version', () => app.getVersion());

  // ── Open external URL ─────────────────────────────────────────────────────
  ipcMain.on('shell:open-url', (_event, url) => {
    try {
      const parsed = new URL(url);
      const allowed = ['www.17lands.com', '17lands.com', 'scryfall.com', 'www.scryfall.com'];
      if (allowed.includes(parsed.hostname)) {
        shell.openExternal(url);
      }
    } catch {
      console.warn('[main] Invalid URL rejected:', url);
    }
  });

  // ── Recommendation ────────────────────────────────────────────────────────
  ipcMain.handle('draft:get-recommendation', async () => {
    // Recommendation is computed in pack-opened handler and cached
    return null; // Handled via broadcast
  });

  // ── Assistant ─────────────────────────────────────────────────────────────
  ipcMain.handle('assistant:get-state', () => {
    return assistantManager.getState();
  });

  // ── Test replay ───────────────────────────────────────────────────────────
  ipcMain.handle('test:start-replay', async (_event, opts) => {
    // Pause the live log watcher so it doesn't interfere with replay events
    logWatcher.stopWatching();
    const result = await testReplay.startReplay(broadcastToAll, opts ?? {});
    return result;
  });

  ipcMain.handle('test:stop-replay', () => {
    const result = testReplay.stopReplay();
    // Restart the live watcher after stopping replay
    logWatcher.startWatching(broadcastToAll);
    return result;
  });

  ipcMain.handle('test:is-active', () => {
    return { active: testReplay.isActive() };
  });
}

// ─── Global Shortcuts ───────────────────────────────────────────────────────

function registerShortcuts() {
  const s = settings.get();
  const { hotkey_toggle, hotkey_interact } = s.general;

  const tryRegister = (key, fn) => {
    if (!key) return;
    try {
      globalShortcut.register(key, fn);
    } catch {
      console.warn('[main] Could not register hotkey:', key);
    }
  };

  tryRegister(hotkey_toggle, () => {
    if (!overlayWindow) return;
    overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
  });

  tryRegister(hotkey_interact, () => setClickThrough(isInteractable));
}

// ─── Auto updater ────────────────────────────────────────────────────────────

let autoUpdaterInstance = null;
let updateDownloaded = false;

function setupAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdaterInstance = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      appLogger.log('autoUpdater', 'info', 'Update available', info.version);
      broadcastToAll('update-available', { version: info.version });
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateDownloaded = true;
      appLogger.log('autoUpdater', 'info', 'Update downloaded', info.version);
      broadcastToAll('update-downloaded', { version: info.version });
    });
    autoUpdater.on('error', (err) => {
      appLogger.log('autoUpdater', 'warn', 'Update check error', err.message);
      broadcastToAll('update-error', { message: err.message });
    });

    autoUpdater.checkForUpdates().catch((err) => {
      appLogger.log('autoUpdater', 'warn', 'checkForUpdates failed', err.message);
    });
  } catch {
    appLogger.log('main', 'info', 'electron-updater not available (dev mode)');
  }
}

function registerUpdateIPC() {
  ipcMain.handle('updater:check', async () => {
    if (!autoUpdaterInstance) return { error: 'Updater not available' };
    try {
      await autoUpdaterInstance.checkForUpdates();
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.on('updater:quit-and-install', () => {
    if (autoUpdaterInstance && updateDownloaded) {
      autoUpdaterInstance.quitAndInstall();
    }
  });
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  appLogger.init();
  appLogger.log('main', 'info', 'App starting', { isDev, version: app.getVersion() });

  createOverlayWindow();
  assistantManager.init(sendToWindows);
  const controlWindow = controlWindowModule.createControlWindow();
  registerIPC();
  registerUpdateIPC();
  registerShortcuts();
  tray.create(overlayWindow, controlWindow);

  // Start log watcher once overlay is loaded
  overlayWindow.webContents.once('did-finish-load', () => {
    logWatcher.startWatching(broadcastToAll);
  });

  // Auto-show overlay when draft starts (if setting enabled)
  // Auto-hide when draft ends
  // These are handled by the log watcher broadcasting draft-started/draft-ended

  app.on('activate', () => {
    if (!overlayWindow) createOverlayWindow();
  });

  // Setup auto-updater in packaged mode
  if (app.isPackaged) {
    setupAutoUpdater();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  logWatcher.stopWatching();
  tray.destroy();
  appLogger.log('main', 'info', 'App shutting down');
});

// Keep running in tray when all windows are closed
app.on('window-all-closed', () => {});

// Expose broadcastToAll for use by logWatcher/logParser
module.exports = { broadcastToAll, sendToWindows };
