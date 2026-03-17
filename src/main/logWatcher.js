const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const settings = require('./settings');
const logParser = require('./logParser');

let watcher = null;
let lastSize = 0;
let logPath = '';
let overlayWin = null;

function resolvedLogPath() {
  const s = settings.get();
  return settings.resolveArenaLogPath(s.general.arenaLogPath);
}

function emitStatus(status) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('status-update', status);
  }
}

function readNewContent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const currentSize = stat.size;

    // File was truncated/replaced (Arena restart)
    if (currentSize < lastSize) {
      console.log('[logWatcher] Log file truncated — Arena restarted');
      lastSize = 0;
      logParser.reset();
    }

    if (currentSize === lastSize) return;

    const fd = fs.openSync(filePath, 'r');
    const bufLen = currentSize - lastSize;
    const buf = Buffer.alloc(bufLen);
    fs.readSync(fd, buf, 0, bufLen, lastSize);
    fs.closeSync(fd);
    lastSize = currentSize;

    const newContent = buf.toString('utf-8');
    const lines = newContent.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        logParser.parseLine(line, overlayWin);
      }
    }
  } catch (err) {
    console.error('[logWatcher] Error reading log:', err.message);
  }
}

function startWatching(win) {
  overlayWin = win;
  stopWatching();

  logPath = resolvedLogPath();
  lastSize = 0;
  logParser.reset();

  console.log('[logWatcher] Watching:', logPath);
  emitStatus('watching');

  if (!fs.existsSync(logPath)) {
    console.warn('[logWatcher] Log file not found:', logPath);
    emitStatus('log-not-found');
    // Still set up a watcher to detect when the file appears
  }

  watcher = chokidar.watch(logPath, {
    persistent: true,
    usePolling: false,
    ignoreInitial: false,
    awaitWriteFinish: false,
  });

  watcher.on('add', () => {
    console.log('[logWatcher] Log file appeared');
    lastSize = 0;
    readNewContent(logPath);
    emitStatus('arena-detected');
  });

  watcher.on('change', () => {
    readNewContent(logPath);
  });

  watcher.on('error', (err) => {
    console.error('[logWatcher] Watcher error:', err.message);
    emitStatus('error');
  });
}

function stopWatching() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

module.exports = { startWatching, stopWatching };
