const { BrowserWindow, app } = require('electron');
const path = require('path');

const isDev = process.env.ELECTRON_ENV === 'development' || !app.isPackaged;

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
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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
