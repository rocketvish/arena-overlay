const { BrowserWindow, app, shell } = require('electron');
const path = require('path');

const isDev = process.env.ELECTRON_ENV === 'development' || !app.isPackaged;

let controlWindow = null;

function isTrustedAppUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (isDev) return parsed.origin === 'http://localhost:5173';
    return parsed.protocol === 'file:';
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && [
      'www.17lands.com',
      '17lands.com',
      'scryfall.com',
      'www.scryfall.com',
    ].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function hardenWindowNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedAppUrl(url)) {
      event.preventDefault();
      if (isAllowedExternalUrl(url)) shell.openExternal(url);
    }
  });
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    frame: true,
    show: true,
    title: 'Arena Overlay — Control',
    backgroundColor: '#0d0d1a',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  hardenWindowNavigation(controlWindow);

  if (isDev) {
    controlWindow.loadURL('http://localhost:5173/control/');
  } else {
    controlWindow.loadFile(
      path.join(__dirname, '..', '..', 'dist', 'renderer', 'control', 'index.html')
    );
  }

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
    controlWindow.show();
    controlWindow.focus();
  }
}

module.exports = { createControlWindow, getControlWindow, showControlWindow };
