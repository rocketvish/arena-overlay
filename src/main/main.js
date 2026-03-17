const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell } = require('electron');
const path = require('path');
const settings = require('./settings');
const tray = require('./tray');
const logWatcher = require('./logWatcher');
const landsData = require('./17landsData');

const isDev = process.env.ELECTRON_ENV === 'development' || !app.isPackaged;

let overlayWindow = null;
let isInteractable = false;

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
    // overlayWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    overlayWindow.loadFile(
      path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html')
    );
  }

  overlayWindow.once('ready-to-show', () => {
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
  overlayWindow.webContents.send('interactable-changed', isInteractable);
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
    }
    return updated;
  });

  ipcMain.handle('settings:reset', () => settings.reset());

  // ── Overlay controls ──────────────────────────────────────────────────────
  ipcMain.on('overlay:toggle-interact', () => setClickThrough(isInteractable));
  ipcMain.on('overlay:toggle-visibility', () => {
    if (!overlayWindow) return;
    overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
  });

  // ── Log watcher ───────────────────────────────────────────────────────────
  ipcMain.on('log-watcher:restart', () => logWatcher.startWatching(overlayWindow));

  // ── 17Lands data ──────────────────────────────────────────────────────────
  ipcMain.handle('17lands:fetch-set', async (_event, setCode, format) => {
    const result = await landsData.fetchSetData(setCode, format, overlayWindow);
    return result;
  });

  ipcMain.handle('17lands:fetch-color-pair', async (_event, setCode, format, colorPair) => {
    const result = await landsData.fetchColorPairData(setCode, format, colorPair, overlayWindow);
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

  // ── Open external URL ─────────────────────────────────────────────────────
  ipcMain.on('shell:open-url', (_event, url) => {
    // Validate it's a known safe domain before opening
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
}

// ─── Global Shortcuts ───────────────────────────────────────────────────────

function registerShortcuts() {
  const s = settings.get();
  const { hotkey_toggle, hotkey_interact } = s.general;

  const tryRegister = (key, fn) => {
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

// ─── App Lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createOverlayWindow();
  registerIPC();
  registerShortcuts();
  tray.create(overlayWindow);

  overlayWindow.webContents.once('did-finish-load', () => {
    logWatcher.startWatching(overlayWindow);
  });

  app.on('activate', () => {
    if (!overlayWindow) createOverlayWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  logWatcher.stopWatching();
  tray.destroy();
});

// Keep running in tray when window is closed
app.on('window-all-closed', () => {});
