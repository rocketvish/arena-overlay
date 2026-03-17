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

  // ── Log watcher ───────────────────────────────────────────────────────────
  restartLogWatcher: () => ipcRenderer.send('log-watcher:restart'),

  // ── 17Lands data ─────────────────────────────────────────────────────────
  fetchSetData: (setCode, format) =>
    ipcRenderer.invoke('17lands:fetch-set', setCode, format),
  fetchColorPairData: (setCode, format, colorPair) =>
    ipcRenderer.invoke('17lands:fetch-color-pair', setCode, format, colorPair),
  clearCache: (setCode, format) =>
    ipcRenderer.invoke('17lands:clear-cache', setCode, format),

  // ── Scryfall ─────────────────────────────────────────────────────────────
  resolveArenaIds: (grpIds) => ipcRenderer.invoke('scryfall:resolve-ids', grpIds),

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
});
