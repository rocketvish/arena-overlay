const { contextBridge, ipcRenderer } = require('electron');

/**
 * Secure IPC bridge — exposes only named channels to the renderer.
 * contextIsolation is ON so the renderer cannot access Node APIs directly.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // ── Settings ────────────────────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (keyPath, value) => ipcRenderer.invoke('settings:set', keyPath, value),

  // ── Overlay controls ────────────────────────────────────────────────────
  toggleInteract: () => ipcRenderer.send('overlay:toggle-interact'),
  toggleVisibility: () => ipcRenderer.send('overlay:toggle-visibility'),

  // ── Log watcher ─────────────────────────────────────────────────────────
  restartLogWatcher: () => ipcRenderer.send('log-watcher:restart'),

  // ── Events from main → renderer ─────────────────────────────────────────
  // Each returns an unsubscribe function for cleanup
  onStatusUpdate: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('status-update', handler);
    return () => ipcRenderer.removeListener('status-update', handler);
  },

  onInteractableChanged: (cb) => {
    const handler = (_e, val) => cb(val);
    ipcRenderer.on('interactable-changed', handler);
    return () => ipcRenderer.removeListener('interactable-changed', handler);
  },

  onDraftStarted: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('draft-started', handler);
    return () => ipcRenderer.removeListener('draft-started', handler);
  },

  onPackOpened: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('pack-opened', handler);
    return () => ipcRenderer.removeListener('pack-opened', handler);
  },

  onCardPicked: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('card-picked', handler);
    return () => ipcRenderer.removeListener('card-picked', handler);
  },

  onDraftEnded: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('draft-ended', handler);
    return () => ipcRenderer.removeListener('draft-ended', handler);
  },

  onGameStarted: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('game-started', handler);
    return () => ipcRenderer.removeListener('game-started', handler);
  },

  onGameEnded: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('game-ended', handler);
    return () => ipcRenderer.removeListener('game-ended', handler);
  },

  onOpenSettings: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('open-settings', handler);
    return () => ipcRenderer.removeListener('open-settings', handler);
  },
});
