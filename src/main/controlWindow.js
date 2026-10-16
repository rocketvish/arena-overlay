const { BrowserWindow, app, screen } = require('electron');
const path = require('path');

const settings = require('./settings');
const { isDev, DEV_ORIGIN, hardenWindow, WEB_PREFERENCES } = require('./appSecurity');

// The app's only window: a normal, framed window you put beside Arena (or on
// a second screen). Size and position are remembered; "keep on top" holds it
// above Arena when they share a screen.

let controlWindow = null;
let saveTimer = null;

const DEFAULT_SIZE = { width: 520, height: 820 };

/** Saved bounds, or a default size against the right edge of the primary screen. */
function initialBounds() {
  const saved = settings.get().window ?? {};
  const width = Number.isFinite(saved.width) ? saved.width : DEFAULT_SIZE.width;
  const height = Number.isFinite(saved.height) ? saved.height : DEFAULT_SIZE.height;
  const fallback = () => {
    const { workArea: a } = screen.getPrimaryDisplay();
    const w = Math.min(width, a.width), h = Math.min(height, a.height);
    return { x: a.x + a.width - w, y: a.y, width: w, height: h };
  };
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return fallback();
  // The title bar must land on some screen (monitor unplugged, resolution changed…).
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x + 80 > a.x && saved.x < a.x + a.width - 80 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 40);
  return onScreen ? { x: saved.x, y: saved.y, width, height } : fallback();
}

function saveBounds() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!controlWindow || controlWindow.isDestroyed() || controlWindow.isMinimized()) return;
    // Normal bounds, so a maximized window doesn't save the full screen.
    const b = controlWindow.isMaximized() ? controlWindow.getNormalBounds() : controlWindow.getBounds();
    for (const k of ['x', 'y', 'width', 'height']) settings.set(`window.${k}`, b[k]);
  }, 400);
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    ...initialBounds(),
    minWidth: 420,
    minHeight: 400,
    frame: true,
    show: true,
    title: 'Arena Overlay',
    backgroundColor: '#0d0d1a',
    alwaysOnTop: settings.get().window?.alwaysOnTop === true,
    webPreferences: {
      ...WEB_PREFERENCES,
      preload: path.join(__dirname, '..', 'preload.js'),
    },
  });

  hardenWindow(controlWindow);
  if (settings.get().window?.alwaysOnTop === true) setAlwaysOnTop(true);

  if (isDev) {
    controlWindow.loadURL(`${DEV_ORIGIN}/control/`);
  } else {
    controlWindow.loadFile(
      path.join(__dirname, '..', '..', 'dist', 'renderer', 'control', 'index.html')
    );
  }

  controlWindow.on('moved', saveBounds);
  controlWindow.on('resized', saveBounds);

  // Minimize to tray on close instead of quitting
  controlWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      controlWindow.hide();
    }
  });

  controlWindow.on('closed', () => {
    controlWindow = null;
  });

  return controlWindow;
}

function getControlWindow() {
  return controlWindow;
}

function showControlWindow() {
  if (!controlWindow) {
    createControlWindow();
  } else {
    if (controlWindow.isMinimized()) controlWindow.restore();
    controlWindow.show();
    controlWindow.focus();
  }
}

/** Hotkey: hide the window if it's showing, otherwise bring it up. */
function toggleControlWindow() {
  if (controlWindow && controlWindow.isVisible() && !controlWindow.isMinimized()) controlWindow.hide();
  else showControlWindow();
}

/** Keep the window above other windows (Arena) or not. */
function setAlwaysOnTop(onTop) {
  // 'screen-saver' level stays above a borderless-fullscreen game on Windows.
  if (controlWindow && !controlWindow.isDestroyed()) controlWindow.setAlwaysOnTop(onTop, onTop ? 'screen-saver' : 'normal');
}

module.exports = { createControlWindow, getControlWindow, showControlWindow, toggleControlWindow, setAlwaysOnTop };
