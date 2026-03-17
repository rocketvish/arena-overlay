const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  overlay: {
    x: -1,
    y: 0,
    width: 320,
    height: 900,
    opacity: 0.85,
    locked: false,
    visible: true,
  },
  columns: {
    grade: true,
    gihwr: true,
    ohwr: true,
    gpwr: false,
    alsa: false,
    iwd: false,
  },
  display: {
    sortBy: 'grade',
    colorFilter: 'all',
    compactMode: false,
    fontSize: 'medium',
  },
  general: {
    arenaLogPath: '%APPDATA%/../LocalLow/Wizards Of The Coast/MTGA/Player.log',
    autoLaunch: false,
    hotkey_toggle: 'Alt+H',
    hotkey_interact: 'Alt+D',
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
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      return deepMerge(DEFAULT_SETTINGS, saved);
    }
  } catch (err) {
    console.error('[settings] Failed to load settings, using defaults:', err.message);
  }
  return { ...DEFAULT_SETTINGS };
}

function save(settings) {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('[settings] Failed to save settings:', err.message);
  }
}

// In-memory cache
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
    if (!obj[keys[i]]) obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;

  save(_settings);
  return _settings;
}

function resolveArenaLogPath(rawPath) {
  return rawPath
    .replace('%APPDATA%', process.env.APPDATA || '')
    .replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA || '')
    .replace(/\//g, path.sep);
}

module.exports = { get, set, resolveArenaLogPath, DEFAULT_SETTINGS };
