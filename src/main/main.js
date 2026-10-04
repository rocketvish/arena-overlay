const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, Menu } = require('electron');
const path = require('path');
const settings = require('./settings');
const tray = require('./tray');
const logWatcher = require('./logWatcher');
const landsData = require('./17landsData');
const appLogger = require('./appLogger');
const controlWindowModule = require('./controlWindow');
const assistantManager = require('./assistantManager');
const testReplay       = require('./testReplay');
const draftLog         = require('./draftLog');

const { isDev, DEV_ORIGIN, isTrustedAppUrl, isAllowedExternalUrl, hardenWindow, hardenSessions, WEB_PREFERENCES } = require('./appSecurity');

// Dev/test hook: run against a separate profile (settings, cache, logs) so a
// test session never touches the real one. Must happen before anything reads userData.
if (!app.isPackaged && process.env.ARENA_OVERLAY_USERDATA) {
  app.setPath('userData', process.env.ARENA_OVERLAY_USERDATA);
}

// One instance only. A second copy (e.g. launched from the Start menu while the
// tray copy is running) used to create a second overlay window — which could
// never be unlocked because the first instance owns the Alt+D hotkey — and a
// second log watcher, doubling every draft event.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let overlayWindow = null;
let isInteractable = false;
const hotkeyStatus = { toggle: null, interact: null }; // { key, ok } per hotkey

const DRAFT_FORMATS = new Set(['PremierDraft', 'QuickDraft', 'TradDraft', 'Sealed']);
const COLOR_PAIRS = new Set(['W', 'U', 'B', 'R', 'G', 'WU', 'WB', 'WR', 'WG', 'UB', 'UR', 'UG', 'BR', 'BG', 'RG']);

const SETTING_VALIDATORS = {
  'overlay.opacity': (v) => typeof v === 'number' && v >= 0.1 && v <= 1,
  'overlay.visible': (v) => typeof v === 'boolean',
  'columns.grade': (v) => typeof v === 'boolean',
  'columns.gihwr': (v) => typeof v === 'boolean',
  'columns.ohwr': (v) => typeof v === 'boolean',
  'columns.gpwr': (v) => typeof v === 'boolean',
  'columns.alsa': (v) => typeof v === 'boolean',
  'columns.iwd': (v) => typeof v === 'boolean',
  'columns.ata': (v) => typeof v === 'boolean',
  'assistant.enabled': (v) => typeof v === 'boolean',
  'assistant.showSignalsInOverlay': (v) => typeof v === 'boolean',
  'assistant.showRecommendationInOverlay': (v) => typeof v === 'boolean',
  'assistant.confidenceThreshold': (v) => Number.isInteger(v) && v >= 1 && v <= 10,
  'assistant.draftStyle': (v) => ['best-card', 'balanced', 'signals'].includes(v),
  'assistant.gameAssistant': (v) => typeof v === 'boolean',
  'display.showRecommendation': (v) => typeof v === 'boolean',
  'display.compactMode': (v) => typeof v === 'boolean',
  'display.sortBy': (v) => ['grade', 'gihwr', 'ohwr', 'gpwr', 'alsa', 'iwd', 'color', 'name'].includes(v),
  'display.colorFilter': (v) => v === 'all' || COLOR_PAIRS.has(v),
  'general.draftFormat': (v) => DRAFT_FORMATS.has(v),
  // Local paths only: a UNC/device path (\\host\share, \\?\…) would make the
  // app reach out over SMB and could leak the user's Windows credentials.
  'general.arenaLogPath': (v) => typeof v === 'string' && v.length > 0 && v.length <= 1000 && !v.includes('\0') && !/^[\\/]{2}/.test(v.trim()),
  'general.hotkey_toggle': (v) => typeof v === 'string' && v.length <= 100,
  'general.hotkey_interact': (v) => typeof v === 'string' && v.length <= 100,
  'general.autoLaunch': (v) => typeof v === 'boolean',
  'general.runOnStartup': (v) => typeof v === 'boolean',
  'general.minimizeToTray': (v) => typeof v === 'boolean',
};

function assertTrustedSender(event) {
  const url = event?.senderFrame?.url ?? '';
  if (!isTrustedAppUrl(url)) {
    throw new Error('Rejected IPC from untrusted renderer');
  }
}

/** For fire-and-forget ipcMain.on handlers: ignore (don't throw) untrusted senders. */
function fromTrustedSender(event) {
  if (isTrustedAppUrl(event?.senderFrame?.url ?? '')) return true;
  console.warn('[main] Ignored IPC from untrusted renderer');
  return false;
}

function sanitizeSetCode(setCode) {
  if (typeof setCode !== 'string') throw new Error('Invalid set code');
  const normalized = setCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(normalized)) throw new Error('Invalid set code');
  return normalized;
}

function sanitizeFormat(format) {
  if (format == null || format === '') return 'PremierDraft';
  if (!DRAFT_FORMATS.has(format)) throw new Error('Invalid draft format');
  return format;
}

function sanitizeArenaIds(grpIds) {
  if (!Array.isArray(grpIds) || grpIds.length > 100) throw new Error('Invalid Arena ID list');
  return grpIds.map((id) => {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid Arena ID');
    return n;
  });
}

function sanitizeReplayOptions(opts) {
  const safe = {};
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'pickDelayMs')) {
    const delay = Number(opts.pickDelayMs);
    if (!Number.isFinite(delay) || delay < 100 || delay > 30000) throw new Error('Invalid replay delay');
    safe.pickDelayMs = delay;
  }
  return safe;
}

function sanitizeSetting(keyPath, value) {
  if (typeof keyPath !== 'string' || keyPath.includes('__proto__') || keyPath.includes('constructor') || keyPath.includes('prototype')) {
    throw new Error('Invalid setting key');
  }
  const validate = SETTING_VALIDATORS[keyPath];
  if (!validate || !validate(value)) throw new Error(`Invalid setting value for ${keyPath}`);
  return { keyPath, value };
}


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

/** Saved position, or a default top-right spot if it's unset or off every screen. */
function initialOverlayBounds(overlay) {
  const width = overlay.width;
  const height = overlay.height;
  const defaultPos = () => {
    const { workArea } = screen.getPrimaryDisplay();
    return { x: workArea.x + workArea.width - width - 10, y: workArea.y + 50 };
  };
  if (overlay.x === -1) return { ...defaultPos(), width, height };
  // Require the title strip to be on some display (monitor unplugged, resolution changed…).
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    overlay.x + 40 > a.x && overlay.x < a.x + a.width - 40 &&
    overlay.y >= a.y - 10 && overlay.y < a.y + a.height - 30);
  return visible ? { x: overlay.x, y: overlay.y, width, height } : { ...defaultPos(), width, height };
}

/** Show the overlay without taking keyboard focus away from Arena. */
function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.showInactive();
  // Windows can drop TOPMOST when a fullscreen app activates; re-assert it.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
}

function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
}

function createOverlayWindow() {
  const s = settings.get();
  const { overlay } = s;

  overlayWindow = new BrowserWindow({
    ...initialOverlayBounds(overlay),
    opacity: overlay.opacity,
    frame: false,
    transparent: true,
    // Start locked: click-through, can't take focus, can't be moved/resized.
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      ...WEB_PREFERENCES,
      preload: path.join(__dirname, '..', 'preload.js'),
    },
  });

  hardenWindow(overlayWindow);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  setOverlayLocked(true);

  if (isDev) {
    overlayWindow.loadURL(DEV_ORIGIN);
  } else {
    overlayWindow.loadFile(
      path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html')
    );
  }

  overlayWindow.once('ready-to-show', () => {
    if (overlay.visible) {
      showOverlay();
      // The control window may have asked before the overlay was shown.
      sendToWindows('overlay-visibility-changed', true);
    }
  });

  overlayWindow.on('moved', saveWindowBounds);
  overlayWindow.on('resized', saveWindowBounds);
  overlayWindow.on('closed', () => { overlayWindow = null; });

  return overlayWindow;
}

/**
 * Locked (the default): the overlay ignores the mouse entirely — clicks and
 * drags go straight to Arena — it can't take keyboard focus, and it can't be
 * moved or resized. Unlocked: a normal draggable/resizable window.
 *
 * No `{ forward: true }` on setIgnoreMouseEvents: on Windows that installs a
 * global low-level mouse hook just to deliver hover events we never use, and
 * such hooks are a known source of cursor lag in games.
 */
function setOverlayLocked(locked) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  overlayWindow.setIgnoreMouseEvents(locked);
  overlayWindow.setFocusable(!locked);
  overlayWindow.setMovable(!locked);
  // Not toggling `resizable`: transparent windows can't be edge-resized on
  // Windows anyway (the renderer has its own resize grip, see
  // overlay:resize), and toggling it made the window grow 1px per lock/unlock.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  if (locked) {
    // Hand keyboard focus back to whatever is underneath (Arena).
    if (overlayWindow.isFocused()) overlayWindow.blur();
  } else {
    // Unlocking a hidden overlay would look like nothing happened.
    if (!overlayWindow.isVisible()) {
      showOverlay();
      broadcastToAll('overlay-visibility-changed', true);
    }
    overlayWindow.focus();
  }

  isInteractable = !locked;
  // Broadcast to all windows so the control window status bar updates too
  sendToWindows('interactable-changed', isInteractable);
  tray.setLocked?.(locked);
}

function toggleOverlayLock() {
  setOverlayLocked(isInteractable);
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
  ipcMain.handle('settings:get', (event) => {
    assertTrustedSender(event);
    return settings.get();
  });

  ipcMain.handle('settings:set', (event, keyPath, value) => {
    assertTrustedSender(event);
    const safe = sanitizeSetting(keyPath, value);
    const updated = settings.set(safe.keyPath, safe.value);
    if (safe.keyPath === 'overlay.opacity') overlayWindow?.setOpacity(safe.value);
    if (safe.keyPath === 'overlay.visible') {
      safe.value ? showOverlay() : hideOverlay();
      broadcastToAll('overlay-visibility-changed', safe.value);
    }
    if (safe.keyPath === 'general.hotkey_toggle' || safe.keyPath === 'general.hotkey_interact') {
      registerShortcuts();
    }
    // Broadcast to all windows so they update in real-time
    broadcastToAll('settings-changed', updated);
    return updated;
  });

  ipcMain.handle('settings:reset', (event) => {
    assertTrustedSender(event);
    return settings.reset();
  });

  // ── Overlay controls ──────────────────────────────────────────────────────
  ipcMain.on('overlay:toggle-interact', (event) => {
    if (!fromTrustedSender(event)) return;
    toggleOverlayLock();
  });
  ipcMain.handle('overlay:set-locked', (event, locked) => {
    assertTrustedSender(event);
    if (typeof locked !== 'boolean') throw new Error('Invalid lock value');
    setOverlayLocked(locked);
    return !isInteractable;
  });
  // Resize grip in the overlay (only while unlocked).
  let saveBoundsTimer = null;
  ipcMain.on('overlay:resize', (event, width, height) => {
    if (!fromTrustedSender(event)) return;
    if (!overlayWindow || overlayWindow.isDestroyed() || !isInteractable) return;
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    const { x, y } = overlayWindow.getBounds();
    overlayWindow.setBounds({ x, y, width: Math.min(Math.max(w, 260), 1600), height: Math.min(Math.max(h, 160), 2000) });
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(saveWindowBounds, 300);
  });
  ipcMain.handle('overlay:get-locked', (event) => {
    assertTrustedSender(event);
    return !isInteractable;
  });
  ipcMain.handle('hotkeys:status', (event) => {
    assertTrustedSender(event);
    return hotkeyStatus;
  });
  ipcMain.on('overlay:toggle-visibility', (event) => {
    if (!fromTrustedSender(event)) return;
    if (!overlayWindow) return;
    const nowVisible = !overlayWindow.isVisible();
    nowVisible ? showOverlay() : hideOverlay();
    broadcastToAll('overlay-visibility-changed', nowVisible);
  });
  ipcMain.handle('overlay:get-visible', (event) => {
    assertTrustedSender(event);
    return overlayWindow?.isVisible() ?? false;
  });
  ipcMain.handle('overlay:set-visible', (event, visible) => {
    assertTrustedSender(event);
    if (typeof visible !== 'boolean') throw new Error('Invalid visibility value');
    if (!overlayWindow) return false;
    visible ? showOverlay() : hideOverlay();
    broadcastToAll('overlay-visibility-changed', visible);
    return visible;
  });

  // ── Log watcher ───────────────────────────────────────────────────────────
  ipcMain.on('log-watcher:restart', (event) => {
    if (!fromTrustedSender(event)) return;
    logWatcher.startWatching(broadcastToAll);
  });

  // ── Log watcher start/stop (from control window) ──────────────────────────
  ipcMain.handle('control:start-watcher', (event) => {
    assertTrustedSender(event);
    logWatcher.startWatching(broadcastToAll);
    return { running: true };
  });

  ipcMain.handle('control:stop-watcher', (event) => {
    assertTrustedSender(event);
    logWatcher.stopWatching();
    return { running: false };
  });

  ipcMain.handle('watcher:status', (event) => {
    assertTrustedSender(event);
    return { running: logWatcher.isRunning() };
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  ipcMain.handle('stats:get', (event) => {
    assertTrustedSender(event);
    return logWatcher.getStats();
  });

  // ── 17Lands data ──────────────────────────────────────────────────────────
  ipcMain.handle('17lands:fetch-set', async (event, setCode, format) => {
    assertTrustedSender(event);
    const result = await landsData.fetchSetData(sanitizeSetCode(setCode), sanitizeFormat(format), { send: broadcastToAll });
    return result;
  });

  // Force a fresh download (bypasses the 12h cache). The renderer re-applies
  // the result when the 17lands-status 'loaded' broadcast arrives.
  ipcMain.handle('17lands:refresh', async (event, setCode) => {
    assertTrustedSender(event);
    const sc = sanitizeSetCode(setCode);
    const result = await landsData.fetchSetData(sc, 'PremierDraft', { send: broadcastToAll }, { force: true });
    await landsData.fetchColorRatings(sc, { force: true }).catch(() => {});
    assistantManager.reloadSetMetrics(sc);
    return result;
  });

  ipcMain.handle('17lands:clear-cache', (event, setCode) => {
    assertTrustedSender(event);
    const safeSetCode = setCode == null || setCode === '' ? null : sanitizeSetCode(setCode);
    landsData.clearCache(safeSetCode);
    return { ok: true };
  });

  // ── Scryfall ID resolution ─────────────────────────────────────────────────
  ipcMain.handle('scryfall:resolve-ids', async (event, grpIds) => {
    assertTrustedSender(event);
    return landsData.resolveArenaIds(sanitizeArenaIds(grpIds));
  });

  // ── Saved drafts (post-draft review) ───────────────────────────────────────
  ipcMain.handle('drafts:list', (event) => {
    assertTrustedSender(event);
    return draftLog.listDrafts();
  });
  ipcMain.handle('drafts:get', (event, file) => {
    assertTrustedSender(event);
    return draftLog.getDraft(file);
  });

  // ── App version ───────────────────────────────────────────────────────────
  ipcMain.handle('app:get-version', (event) => {
    assertTrustedSender(event);
    return app.getVersion();
  });

  // ── Open external URL ─────────────────────────────────────────────────────
  ipcMain.on('shell:open-url', (event, url) => {
    if (!fromTrustedSender(event)) return;
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
    } else {
      console.warn('[main] Invalid URL rejected:', url);
    }
  });

  // ── Recommendation ────────────────────────────────────────────────────────
  ipcMain.handle('draft:get-recommendation', async (event) => {
    assertTrustedSender(event);
    // Recommendation is computed in pack-opened handler and cached
    return null; // Handled via broadcast
  });

  // ── Assistant ─────────────────────────────────────────────────────────────
  ipcMain.handle('assistant:get-state', (event) => {
    assertTrustedSender(event);
    return assistantManager.getState();
  });
  ipcMain.handle('game:get-state', (event) => {
    assertTrustedSender(event);
    return assistantManager.getGameState();
  });

  // ── Test replay ───────────────────────────────────────────────────────────
  ipcMain.handle('test:start-replay', async (event, opts) => {
    assertTrustedSender(event);
    // Pause the live log watcher so it doesn't interfere with replay events
    logWatcher.stopWatching();
    const result = await testReplay.startReplay(broadcastToAll, sanitizeReplayOptions(opts));
    return result;
  });

  ipcMain.handle('test:stop-replay', (event) => {
    assertTrustedSender(event);
    const result = testReplay.stopReplay();
    // Restart the live watcher after stopping replay
    logWatcher.startWatching(broadcastToAll);
    return result;
  });

  ipcMain.handle('test:is-active', (event) => {
    assertTrustedSender(event);
    return { active: testReplay.isActive() };
  });
}

// ─── Global Shortcuts ───────────────────────────────────────────────────────

function registerShortcuts() {
  const s = settings.get();
  const { hotkey_toggle, hotkey_interact } = s.general;

  globalShortcut.unregisterAll();

  // globalShortcut.register() returns false (it doesn't throw) when another
  // app already owns the combination — previously that failed silently and
  // left the overlay impossible to unlock from the keyboard.
  const tryRegister = (key, fn) => {
    if (!key) return null;
    let ok = false;
    try {
      ok = globalShortcut.register(key, fn);
    } catch (e) {
      appLogger.log('main', 'warn', `Invalid hotkey "${key}"`, e.message);
    }
    if (!ok) appLogger.log('main', 'warn', `Could not register hotkey "${key}" (in use by another app?)`);
    return { key, ok };
  };

  hotkeyStatus.toggle = tryRegister(hotkey_toggle, () => {
    if (!overlayWindow) return;
    const nowVisible = !overlayWindow.isVisible();
    nowVisible ? showOverlay() : hideOverlay();
    broadcastToAll('overlay-visibility-changed', nowVisible);
  });

  hotkeyStatus.interact = tryRegister(hotkey_interact, toggleOverlayLock);
  sendToWindows('hotkeys-status', hotkeyStatus);
}

// ─── Auto updater ────────────────────────────────────────────────────────────

let autoUpdaterInstance = null;
let updateDownloaded = false;

function setupAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdaterInstance = autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

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
  ipcMain.handle('updater:check', async (event) => {
    assertTrustedSender(event);
    if (!autoUpdaterInstance) return { error: 'Updater not available' };
    try {
      await autoUpdaterInstance.checkForUpdates();
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('updater:download', async (event) => {
    assertTrustedSender(event);
    if (!autoUpdaterInstance) return { error: 'Updater not available' };
    try {
      await autoUpdaterInstance.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.on('updater:quit-and-install', (event) => {
    if (!fromTrustedSender(event)) return;
    if (autoUpdaterInstance && updateDownloaded) {
      autoUpdaterInstance.quitAndInstall();
    }
  });
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────

app.on('second-instance', () => {
  // Someone launched the app again — surface the running copy instead.
  controlWindowModule.showControlWindow();
});

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  hardenSessions();
  // Release builds: no default menu (it carries "Toggle Developer Tools").
  if (!isDev) Menu.setApplicationMenu(null);
  appLogger.init();
  appLogger.log('main', 'info', 'App starting', { isDev, version: app.getVersion() });

  // Every 17Lands fetch reports its status to all windows, and human-draft
  // packs that never named their set can be recognised from cached card IDs.
  landsData.setStatusSink(broadcastToAll);
  require('./logParser').setSetCodeResolver(landsData.inferSetFromGrpIds);
  require('./logParser').setGameHandler(assistantManager.handleGameMessage);

  createOverlayWindow();
  assistantManager.init(sendToWindows);
  const controlWindow = controlWindowModule.createControlWindow();
  registerIPC();
  registerUpdateIPC();
  registerShortcuts();
  tray.create(overlayWindow, controlWindow, {
    toggleLock: toggleOverlayLock,
    showOverlay,
    hideOverlay,
    onVisibilityChanged: (v) => broadcastToAll('overlay-visibility-changed', v),
  });

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
