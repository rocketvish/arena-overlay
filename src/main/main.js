const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const settings = require('./settings');
const tray = require('./tray');
const logWatcher = require('./logWatcher');

const isDev = process.env.ELECTRON_ENV === 'development' || !app.isPackaged;

let overlayWindow = null;
let isInteractable = false;

// ─── Window Creation ────────────────────────────────────────────────────────

function createOverlayWindow() {
  const s = settings.get();
  const { overlay } = s;

  // Resolve position: if x === -1, place at right edge of primary display
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

  // Click-through by default
  setClickThrough(true);

  if (isDev) {
    overlayWindow.loadURL('http://localhost:5173');
    // overlayWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    overlayWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
  }

  overlayWindow.once('ready-to-show', () => {
    if (overlay.visible) overlayWindow.show();
  });

  // Save position/size on move or resize
  overlayWindow.on('moved', saveWindowBounds);
  overlayWindow.on('resized', saveWindowBounds);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

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
  const bounds = overlayWindow.getBounds();
  settings.set('overlay.x', bounds.x);
  settings.set('overlay.y', bounds.y);
  settings.set('overlay.width', bounds.width);
  settings.set('overlay.height', bounds.height);
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────

function registerIPC() {
  ipcMain.handle('settings:get', () => settings.get());

  ipcMain.handle('settings:set', (_event, keyPath, value) => {
    const updated = settings.set(keyPath, value);
    // Apply certain settings immediately
    if (keyPath.startsWith('overlay.opacity')) {
      overlayWindow?.setOpacity(value);
    }
    if (keyPath === 'overlay.visible') {
      value ? overlayWindow?.show() : overlayWindow?.hide();
    }
    return updated;
  });

  ipcMain.on('overlay:toggle-interact', () => {
    setClickThrough(isInteractable); // toggle
  });

  ipcMain.on('overlay:toggle-visibility', () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) {
      overlayWindow.hide();
    } else {
      overlayWindow.show();
    }
  });

  ipcMain.on('log-watcher:restart', () => {
    logWatcher.startWatching(overlayWindow);
  });
}

// ─── Global Shortcuts ───────────────────────────────────────────────────────

function registerShortcuts() {
  const s = settings.get();
  const { hotkey_toggle, hotkey_interact } = s.general;

  try {
    globalShortcut.register(hotkey_toggle, () => {
      if (!overlayWindow) return;
      if (overlayWindow.isVisible()) {
        overlayWindow.hide();
      } else {
        overlayWindow.show();
      }
    });
  } catch {
    console.warn('[main] Could not register hotkey:', hotkey_toggle);
  }

  try {
    globalShortcut.register(hotkey_interact, () => {
      setClickThrough(isInteractable);
    });
  } catch {
    console.warn('[main] Could not register hotkey:', hotkey_interact);
  }
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createOverlayWindow();
  registerIPC();
  registerShortcuts();

  const t = tray.create(overlayWindow);

  // Start log watcher after window is ready
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

app.on('window-all-closed', () => {
  // Keep running in tray on all platforms
  // Do NOT quit the app when all windows are closed
});
