const { contextBridge, ipcRenderer } = require('electron');

/**
 * Secure IPC bridge — only named channels are exposed to the renderer.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // ── Settings ─────────────────────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (keyPath, value) => ipcRenderer.invoke('settings:set', keyPath, value),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  // ── Overlay controls ──────────────────────────────────────────────────────
  toggleInteract: () => ipcRenderer.send('overlay:toggle-interact'),
  toggleVisibility: () => ipcRenderer.send('overlay:toggle-visibility'),
  getOverlayVisible: () => ipcRenderer.invoke('overlay:get-visible'),
  setOverlayVisible: (visible) => ipcRenderer.invoke('overlay:set-visible', visible),

  // ── Log watcher ───────────────────────────────────────────────────────────
  restartLogWatcher: () => ipcRenderer.send('log-watcher:restart'),
  startWatcher: () => ipcRenderer.invoke('control:start-watcher'),
  stopWatcher: () => ipcRenderer.invoke('control:stop-watcher'),
  getWatcherStatus: () => ipcRenderer.invoke('watcher:status'),

  // ── Stats ─────────────────────────────────────────────────────────────────
  getStats: () => ipcRenderer.invoke('stats:get'),

  // ── 17Lands data ─────────────────────────────────────────────────────────
  fetchSetData: (setCode, format) =>
    ipcRenderer.invoke('17lands:fetch-set', setCode, format),
  fetchColorPairData: (setCode, format, colorPair) =>
    ipcRenderer.invoke('17lands:fetch-color-pair', setCode, format, colorPair),
  clearCache: (setCode, format) =>
    ipcRenderer.invoke('17lands:clear-cache', setCode, format),

  // ── Scryfall ─────────────────────────────────────────────────────────────
  resolveArenaIds: (grpIds) => ipcRenderer.invoke('scryfall:resolve-ids', grpIds),

  // ── App info ─────────────────────────────────────────────────────────────
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),

  // ── Auto-updater ──────────────────────────────────────────────────────────
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  quitAndInstall: () => ipcRenderer.send('updater:quit-and-install'),

  // ── Draft recommendation ─────────────────────────────────────────────────
  getRecommendation: () => ipcRenderer.invoke('draft:get-recommendation'),

  // ── Assistant ─────────────────────────────────────────────────────────────
  getAssistantState: () => ipcRenderer.invoke('assistant:get-state'),

  onAssistantUpdate: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('assistant-update', h);
    return () => ipcRenderer.removeListener('assistant-update', h);
  },

  // ── Test replay ───────────────────────────────────────────────────────────
  startReplay: (opts) => ipcRenderer.invoke('test:start-replay', opts),
  stopReplay:  ()     => ipcRenderer.invoke('test:stop-replay'),
  isReplayActive: ()  => ipcRenderer.invoke('test:is-active'),

  onReplayStarted: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('test:replay-started', h);
    return () => ipcRenderer.removeListener('test:replay-started', h);
  },
  onReplayEnded: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('test:replay-ended', h);
    return () => ipcRenderer.removeListener('test:replay-ended', h);
  },

  // ── Shell ─────────────────────────────────────────────────────────────────
  openUrl: (url) => ipcRenderer.send('shell:open-url', url),

  // ── Events from main → renderer (each returns an unsubscribe fn) ──────────
  onStatusUpdate: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('status-update', h);
    return () => ipcRenderer.removeListener('status-update', h);
  },
  onInteractableChanged: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('interactable-changed', h);
    return () => ipcRenderer.removeListener('interactable-changed', h);
  },
  onDraftStarted: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('draft-started', h);
    return () => ipcRenderer.removeListener('draft-started', h);
  },
  onPackOpened: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('pack-opened', h);
    return () => ipcRenderer.removeListener('pack-opened', h);
  },
  onCardPicked: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('card-picked', h);
    return () => ipcRenderer.removeListener('card-picked', h);
  },
  onDraftEnded: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('draft-ended', h);
    return () => ipcRenderer.removeListener('draft-ended', h);
  },
  onGameStarted: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('game-started', h);
    return () => ipcRenderer.removeListener('game-started', h);
  },
  onGameEnded: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('game-ended', h);
    return () => ipcRenderer.removeListener('game-ended', h);
  },
  on17landsStatus: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('17lands-status', h);
    return () => ipcRenderer.removeListener('17lands-status', h);
  },
  onOpenSettings: (cb) => {
    const h = () => cb();
    ipcRenderer.on('open-settings', h);
    return () => ipcRenderer.removeListener('open-settings', h);
  },
  onLogUpdated: (cb) => {
    const h = (_e, ts) => cb(ts);
    ipcRenderer.on('log-updated', h);
    return () => ipcRenderer.removeListener('log-updated', h);
  },
  onSettingsChanged: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('settings-changed', h);
    return () => ipcRenderer.removeListener('settings-changed', h);
  },
  onOverlayVisibilityChanged: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('overlay-visibility-changed', h);
    return () => ipcRenderer.removeListener('overlay-visibility-changed', h);
  },
  onUpdateAvailable: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('update-available', h);
    return () => ipcRenderer.removeListener('update-available', h);
  },
  onUpdateDownloaded: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('update-downloaded', h);
    return () => ipcRenderer.removeListener('update-downloaded', h);
  },
  onParseWarning: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('control:parse-warning', h);
    return () => ipcRenderer.removeListener('control:parse-warning', h);
  },
});
