const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// Lazy — app.getPath() must not be called at module load time (before app is ready)
let SETTINGS_FILE = null;
function getSettingsFile() {
  if (!SETTINGS_FILE) SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
  return SETTINGS_FILE;
}

const DEFAULT_SETTINGS = {
  general: {
    arenaLogPath: '%APPDATA%/../LocalLow/Wizards Of The Coast/MTGA/Player.log',
    hotkey_toggle: 'Alt+H',
    hotkey_interact: 'Alt+D',
    draftFormat: 'PremierDraft',
    runOnStartup: false,
    minimizeToTray: true,
    // Legacy compat
    autoLaunch: false,
  },
  overlay: {
    autoShowOnDraft: true,
    autoHideOnDraftEnd: true,
    x: -1,
    y: 50,
    width: 340,
    height: 700,
    opacity: 0.85,
    fontSize: 'medium',
    visible: true,
    // Legacy compat
    locked: false,
    minimized: false,
  },
  display: {
    sortBy: 'grade',
    colorFilter: 'all',
    compactMode: false,
    showRecommendation: true,
  },
  assistant: {
    enabled: true,
    showSignalsInOverlay: true,
    showRecommendationInOverlay: true,
    confidenceThreshold: 4,
    draftStyle: 'balanced',
  },
  columns: {
    grade: true,
    gihwr: true,
    ohwr: true,
    gpwr: false,
    alsa: false,
    iwd: false,
  },
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function load() {
  const file = getSettingsFile();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      const saved = JSON.parse(raw);
      return deepMerge(DEFAULT_SETTINGS, saved);
    }
  } catch (err) {
    console.error('[settings] Failed to load settings, using defaults:', err.message);
  }
  return deepMerge({}, DEFAULT_SETTINGS);
}

function save(settings) {
  const file = getSettingsFile();
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('[settings] Failed to save settings:', err.message);
  }
}

let _settings = null;

function get() {
  if (!_settings) _settings = load();
  return _settings;
}

function set(keyPath, value) {
  if (!_settings) _settings = load();
  const keys = keyPath.split('.');
  let obj = _settings;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  save(_settings);
  return _settings;
}

function reset() {
  _settings = deepMerge({}, DEFAULT_SETTINGS);
  save(_settings);
  return _settings;
}

function resolveArenaLogPath(rawPath) {
  return rawPath
    .replace('%APPDATA%', process.env.APPDATA || '')
    .replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA || '')
    .replace(/\//g, path.sep);
}

module.exports = { get, set, reset, resolveArenaLogPath, DEFAULT_SETTINGS };
