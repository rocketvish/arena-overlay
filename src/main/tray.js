const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

let tray = null;
let statusText = 'Watching for Arena...';

function createTrayIcon() {
  // Create a simple 16x16 colored icon using nativeImage
  // Replace with a real icon file (assets/tray-icon.png) for production
  const iconPath = path.join(app.getAppPath(), 'assets', 'tray-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('empty');
  } catch {
    // Fallback: 16x16 red square as a data URI
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      buf[i * 4] = 180;     // R
      buf[i * 4 + 1] = 40; // G
      buf[i * 4 + 2] = 40; // B
      buf[i * 4 + 3] = 255; // A
    }
    icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  }
  return icon;
}

function create(overlayWindow) {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Arena Overlay');
  updateMenu(overlayWindow);
  return tray;
}

function updateStatus(text, overlayWindow) {
  statusText = text;
  if (tray && overlayWindow) updateMenu(overlayWindow);
}

function updateMenu(overlayWindow) {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: statusText,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show / Hide Overlay',
      click: () => {
        if (overlayWindow.isVisible()) {
          overlayWindow.hide();
        } else {
          overlayWindow.show();
        }
      },
    },
    {
      label: 'Settings',
      click: () => {
        overlayWindow.show();
        overlayWindow.webContents.send('open-settings');
      },
    },
    {
      label: 'Restart Log Watcher',
      click: () => {
        overlayWindow.webContents.send('restart-log-watcher');
        const { startWatching } = require('./logWatcher');
        startWatching(overlayWindow);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function destroy() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { create, updateStatus, updateMenu, destroy };
