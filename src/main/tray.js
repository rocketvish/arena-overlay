const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

let tray = null;
let statusText = 'Watching for Arena...';

function createTrayIcon() {
  const iconPath = path.join(app.getAppPath(), 'assets', 'tray-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('empty');
  } catch {
    // Fallback: 16x16 colored square as raw RGBA buffer
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      buf[i * 4]     = 80;  // R
      buf[i * 4 + 1] = 130; // G
      buf[i * 4 + 2] = 220; // B
      buf[i * 4 + 3] = 255; // A
    }
    icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  }
  return icon;
}

function create(overlayWindow, controlWindow) {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Arena Overlay');
  updateMenu(overlayWindow, controlWindow);

  // Single left-click: show control window
  tray.on('click', () => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      if (controlWindow.isVisible()) {
        controlWindow.focus();
      } else {
        controlWindow.show();
        controlWindow.focus();
      }
    }
  });

  return tray;
}

function updateStatus(text, overlayWindow, controlWindow) {
  statusText = text;
  if (tray && overlayWindow) updateMenu(overlayWindow, controlWindow);
}

function updateMenu(overlayWindow, controlWindow) {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: statusText,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show Control Window',
      click: () => {
        if (controlWindow && !controlWindow.isDestroyed()) {
          controlWindow.show();
          controlWindow.focus();
        }
      },
    },
    {
      label: 'Show / Hide Overlay',
      click: () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          if (overlayWindow.isVisible()) {
            overlayWindow.hide();
          } else {
            overlayWindow.show();
          }
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => {
        try {
          const { autoUpdater } = require('electron-updater');
          autoUpdater.checkForUpdates();
        } catch {
          // electron-updater not available in dev
          console.log('[tray] Check for updates: electron-updater not available');
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
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
