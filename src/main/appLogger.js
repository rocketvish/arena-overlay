/**
 * appLogger.js — Rotating session logger
 * Files: userData/logs/session-0.log through session-4.log
 * Rotates on each app start (shifts older files)
 * Max 5MB per file
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_FILES = 5;
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

let logDir = null;
let currentFile = null;
let currentSize = 0;
let ready = false;

function getLogDir() {
  if (!logDir) logDir = path.join(app.getPath('userData'), 'logs');
  return logDir;
}

function rotate() {
  const dir = getLogDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Shift older sessions: session-3 → session-4, etc.
    for (let i = MAX_FILES - 2; i >= 0; i--) {
      const from = path.join(dir, `session-${i}.log`);
      const to   = path.join(dir, `session-${i + 1}.log`);
      if (fs.existsSync(from)) {
        try { fs.renameSync(from, to); } catch {}
      }
    }

    // Start fresh session-0.log
    currentFile = path.join(dir, 'session-0.log');
    const header = `=== Session started ${new Date().toISOString()} ===\n`;
    fs.writeFileSync(currentFile, header, 'utf-8');
    currentSize = header.length;
    ready = true;
  } catch (err) {
    console.error('[appLogger] Failed to rotate logs:', err.message);
  }
}

function log(component, level, message, data) {
  if (!ready) {
    // Silently skip if not yet initialized
    return;
  }

  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${component}] ${message}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`;

  try {
    if (!currentFile) return;

    // Roll over if too large
    if (currentSize + line.length > MAX_SIZE) {
      rotate();
    }

    fs.appendFileSync(currentFile, line, 'utf-8');
    currentSize += line.length;
  } catch {
    // Swallow write errors silently
  }
}

function init() {
  rotate();
  log('appLogger', 'info', 'Logger initialized');
}

module.exports = { init, log };
