const { BrowserWindow, app } = require('electron');
const path = require('path');

const { isDev, DEV_ORIGIN, hardenWindow, WEB_PREFERENCES } = require('./appSecurity');

let controlWindow = null;

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
      ...WEB_PREFERENCES,
      preload: path.join(__dirname, '..', 'preload.js'),
    },
  });

  hardenWindow(controlWindow);

  if (isDev) {
    controlWindow.loadURL(`${DEV_ORIGIN}/control/`);
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
