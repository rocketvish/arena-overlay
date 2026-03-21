const fs = require('fs');
const chokidar = require('chokidar');
const settings = require('./settings');
const logParser = require('./logParser');
const appLogger = require('./appLogger');

let watcher = null;
let pollTimer = null;
let staleCheckTimer = null;
let lastSize = 0;
let logPath = '';
let broadcastFn = null; // function(channel, data) — sends to all windows
let running = false;

// ── Health metrics ────────────────────────────────────────────────────────────

let stats = {
  linesParsed: 0,
  eventsDetected: 0,
  parseFailures: 0,
};

// ── Activity tracking for stale detection ─────────────────────────────────────

let lastActivityTime = Date.now();
let lastStaleWarned = false;

// ── Burst buffering ───────────────────────────────────────────────────────────

let lineBuffer = [];
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const lines = lineBuffer.splice(0);
    processLines(lines);
  }, 200);
}

function processLines(lines) {
  if (!broadcastFn) return;
  for (const line of lines) {
    if (line.trim()) {
      stats.linesParsed++;
      logParser.parseLine(line, broadcastFn);
    }
  }
  // Check parse failure ratio
  if (stats.linesParsed > 100 && stats.parseFailures / stats.linesParsed > 0.1) {
    broadcastFn('control:parse-warning', {
      ratio: stats.parseFailures / stats.linesParsed,
      failures: stats.parseFailures,
      total: stats.linesParsed,
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolvedLogPath() {
  const s = settings.get();
  return settings.resolveArenaLogPath(s.general.arenaLogPath);
}

function emitStatus(status) {
  if (broadcastFn) broadcastFn('status-update', status);
}

function emitLogUpdated() {
  if (broadcastFn) broadcastFn('log-updated', Date.now());
}

// ─── Scan the file for the LATEST draft event ─────────────────────────────────

const DRAFT_MARKERS = [
  'BotDraftDraftStatus',
  'HumanDraftDraftStatus',
  'BotDraftDraftPick',
  'HumanDraftDraftPick',
  'Draft/DraftStatus',
  'Event/DraftNotify',
  'BotDraftMakePick',
  'HumanDraftMakePick',
];

function isDraftLine(line) {
  return DRAFT_MARKERS.some(m => line.includes(m));
}

function initialScan(filePath) {
  let content;
  let stat;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
    stat = fs.statSync(filePath);
  } catch (err) {
    appLogger.log('logWatcher', 'error', 'Cannot read log for initial scan', err.message);
    console.error('[logWatcher] Cannot read log for initial scan:', err.message);
    return;
  }

  const lines = content.split('\n');
  console.log(`[logWatcher] Initial scan: ${lines.length} lines, ${stat.size} bytes`);

  // Walk backwards to find the last line that looks like a draft event header
  let latestDraftLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isDraftLine(lines[i]) && (lines[i].includes('==>') || lines[i].startsWith('<=='))) {
      latestDraftLine = i;
      break;
    }
  }

  lastSize = stat.size;

  if (latestDraftLine === -1) {
    console.log('[logWatcher] No draft events found in log during initial scan');
    return;
  }

  const startLine = Math.max(0, latestDraftLine - 3);
  console.log(`[logWatcher] Latest draft event near line ${latestDraftLine}, parsing from line ${startLine}`);

  logParser.reset();
  if (broadcastFn) {
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim()) {
        stats.linesParsed++;
        logParser.parseLine(line, broadcastFn);
      }
    }
  }
}

// ─── Incremental read (called on file-change events and poll timer) ───────────

function readNewContent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const currentSize = stat.size;

    if (currentSize < lastSize) {
      // Arena restarted and truncated the log
      console.log('[logWatcher] Log file truncated — Arena restarted');
      lastSize = 0;
      logParser.reset();
      stats = { linesParsed: 0, eventsDetected: 0, parseFailures: 0 };
      initialScan(filePath);
      return;
    }

    if (currentSize === lastSize) return;

    lastActivityTime = Date.now();
    lastStaleWarned = false;

    const fd = fs.openSync(filePath, 'r');
    const bufLen = currentSize - lastSize;
    const buf = Buffer.alloc(bufLen);
    fs.readSync(fd, buf, 0, bufLen, lastSize);
    fs.closeSync(fd);
    lastSize = currentSize;

    appLogger.log('logWatcher', 'debug', `Read ${bufLen} new bytes`);
    emitLogUpdated();

    const newContent = buf.toString('utf-8');
    const newLines = newContent.split('\n');

    // Use burst buffer for rapid writes
    lineBuffer.push(...newLines);
    scheduleFlush();
  } catch (err) {
    appLogger.log('logWatcher', 'error', 'Error reading log', err.message);
    console.error('[logWatcher] Error reading log:', err.message);
  }
}

// ─── Stale detection ──────────────────────────────────────────────────────────

function setupStaleDetection() {
  if (staleCheckTimer) clearInterval(staleCheckTimer);

  staleCheckTimer = setInterval(() => {
    const elapsed = Date.now() - lastActivityTime;
    const parserState = logParser.getState();
    const inDraft = parserState?.inDraft ?? false;

    if (inDraft && elapsed > 30000) {
      // In draft but no activity for 30s — force re-read last portion
      if (fs.existsSync(logPath)) {
        const stat = fs.statSync(logPath);
        const rereadSize = Math.max(0, stat.size - 10000);
        if (rereadSize < lastSize) {
          console.log('[logWatcher] Stale detection: forcing re-read');
          lastSize = rereadSize;
          readNewContent(logPath);
        }
      }
    }

    if (elapsed > 60000 && !lastStaleWarned) {
      lastStaleWarned = true;
      emitStatus('log-stale');
      appLogger.log('logWatcher', 'warn', 'Log appears stale — no activity for 60s');
    }
  }, 5000);
}

// ─── Public API ───────────────────────────────────────────────────────────────

function startWatching(broadcast) {
  broadcastFn = broadcast;
  // Also update parser's broadcast function
  logParser.setBroadcast(broadcast);

  stopWatching();
  running = true;

  logPath = resolvedLogPath();
  lastSize = 0;
  lastActivityTime = Date.now();
  lastStaleWarned = false;
  stats = { linesParsed: 0, eventsDetected: 0, parseFailures: 0 };
  logParser.reset();

  console.log('[logWatcher] Watching:', logPath);
  appLogger.log('logWatcher', 'info', 'Starting log watcher', { logPath });
  emitStatus('watching');

  if (!fs.existsSync(logPath)) {
    console.warn('[logWatcher] Log file not found:', logPath);
    emitStatus('log-not-found');
  }

  // ── Chokidar watcher for immediate native events ─────────────────────────
  watcher = chokidar.watch(logPath, {
    persistent: true,
    usePolling: false,
    ignoreInitial: false,
    awaitWriteFinish: false,
  });

  watcher.on('add', () => {
    console.log('[logWatcher] Log file appeared — scanning for latest draft');
    initialScan(logPath);
    emitStatus('arena-detected');
    emitLogUpdated();
  });

  watcher.on('change', () => {
    readNewContent(logPath);
  });

  watcher.on('error', (err) => {
    appLogger.log('logWatcher', 'error', 'Watcher error', err.message);
    console.error('[logWatcher] Watcher error:', err.message);
    emitStatus('error');
  });

  // ── Polling fallback — catches writes that chokidar misses on Windows ────
  pollTimer = setInterval(() => {
    if (fs.existsSync(logPath)) {
      readNewContent(logPath);
    }
  }, 500);

  // ── Stale detection ──────────────────────────────────────────────────────
  setupStaleDetection();
}

function stopWatching() {
  running = false;
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (staleCheckTimer) {
    clearInterval(staleCheckTimer);
    staleCheckTimer = null;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function isRunning() {
  return running;
}

function getStats() {
  return { ...stats, running };
}

// Expose method for logParser to increment event count
function incrementEventCount() {
  stats.eventsDetected++;
}

function incrementFailureCount() {
  stats.parseFailures++;
}

module.exports = {
  startWatching, stopWatching, isRunning, getStats,
  incrementEventCount, incrementFailureCount,
};
