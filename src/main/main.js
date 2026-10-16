const { app, ipcMain, globalShortcut, shell, Menu } = require('electron');
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

const { isDev, isTrustedAppUrl, isAllowedExternalUrl, hardenSessions } = require('./appSecurity');

// Dev/test hook: run against a separate profile (settings, cache, logs) so a
// test session never touches the real one. Must happen before anything reads userData.
if (!app.isPackaged && process.env.ARENA_OVERLAY_USERDATA) {
  app.setPath('userData', process.env.ARENA_OVERLAY_USERDATA);
}

// One instance only. A second copy (e.g. launched from the Start menu while the
// tray copy is running) would start a second log watcher, doubling every
// draft event.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

const hotkeyStatus = { toggle: null }; // { key, ok }

const DRAFT_FORMATS = new Set(['PremierDraft', 'QuickDraft', 'TradDraft', 'Sealed']);
const COLOR_PAIRS = new Set(['W', 'U', 'B', 'R', 'G', 'WU', 'WB', 'WR', 'WG', 'UB', 'UR', 'UG', 'BR', 'BG', 'RG']);

const SETTING_VALIDATORS = {
  'window.alwaysOnTop': (v) => typeof v === 'boolean',
  'columns.win': (v) => typeof v === 'boolean',
  'columns.grade': (v) => typeof v === 'boolean',
  'columns.gihwr': (v) => typeof v === 'boolean',
  'columns.ohwr': (v) => typeof v === 'boolean',
  'columns.gpwr': (v) => typeof v === 'boolean',
  'columns.alsa': (v) => typeof v === 'boolean',
  'columns.iwd': (v) => typeof v === 'boolean',
  'columns.ata': (v) => typeof v === 'boolean',
  'assistant.enabled': (v) => typeof v === 'boolean',
  'assistant.confidenceThreshold': (v) => Number.isInteger(v) && v >= 1 && v <= 10,
  'assistant.draftStyle': (v) => ['best-card', 'balanced', 'signals'].includes(v),
  'assistant.gameAssistant': (v) => typeof v === 'boolean',
  'display.showRecommendation': (v) => typeof v === 'boolean',
  'display.compactMode': (v) => typeof v === 'boolean',
  'display.packSort': (v) => ['arena', 'win', 'grade', 'gihwr', 'ohwr', 'color', 'name'].includes(v),
  'display.sortBy': (v) => ['grade', 'gihwr', 'ohwr', 'gpwr', 'alsa', 'iwd', 'color', 'name'].includes(v),
  'display.colorFilter': (v) => v === 'all' || COLOR_PAIRS.has(v),
  'general.draftFormat': (v) => DRAFT_FORMATS.has(v),
  // Local paths only: a UNC/device path (\\host\share, \\?\…) would make the
  // app reach out over SMB and could leak the user's Windows credentials.
  'general.arenaLogPath': (v) => typeof v === 'string' && v.length > 0 && v.length <= 1000 && !v.includes('\0') && !/^[\\/]{2}/.test(v.trim()),
  'general.hotkey_toggle': (v) => typeof v === 'string' && v.length <= 100,
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
  const win = controlWindowModule.getControlWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function broadcastToAll(channel, data) {
  // Forward to renderer windows
  sendToWindows(channel, data);
  // Also handle in main process for assistant analysis
  assistantManager.handleEvent(channel, data).catch((e) => {
    console.error('[assistant] handleEvent error:', e.message);
  });
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
    if (safe.keyPath === 'window.alwaysOnTop') controlWindowModule.setAlwaysOnTop(safe.value);
    if (safe.keyPath === 'general.hotkey_toggle') registerShortcuts();
    // Broadcast to all windows so they update in real-time
    broadcastToAll('settings-changed', updated);
    return updated;
  });

  ipcMain.handle('settings:reset', (event) => {
    assertTrustedSender(event);
    return settings.reset();
  });

  ipcMain.handle('hotkeys:status', (event) => {
    assertTrustedSender(event);
    return hotkeyStatus;
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
  const { hotkey_toggle } = settings.get().general;

  globalShortcut.unregisterAll();

  // globalShortcut.register() returns false (it doesn't throw) when another
  // app already owns the combination — report it instead of failing silently.
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

  // Show / hide the window from inside Arena.
  hotkeyStatus.toggle = tryRegister(hotkey_toggle, controlWindowModule.toggleControlWindow);
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

  assistantManager.init(sendToWindows);
  const controlWindow = controlWindowModule.createControlWindow();
  registerIPC();
  registerUpdateIPC();
  registerShortcuts();
  tray.create(controlWindow);

  // Start the log watcher once the window can receive its events.
  controlWindow.webContents.once('did-finish-load', () => {
    logWatcher.startWatching(broadcastToAll);
  });

  app.on('activate', () => controlWindowModule.showControlWindow());

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
