const fs = require('fs');
const chokidar = require('chokidar');
const settings = require('./settings');
const logParser = require('./logParser');

let watcher = null;
let pollTimer = null;
let lastSize = 0;
let logPath = '';
let overlayWin = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolvedLogPath() {
  const s = settings.get();
  return settings.resolveArenaLogPath(s.general.arenaLogPath);
}

function emitStatus(status) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('status-update', status);
  }
}

function emitLogUpdated() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('log-updated', Date.now());
  }
}

// ─── Scan the file for the LATEST draft event ─────────────────────────────────
//
// Arena appends new events to the log, so older drafts appear earlier in the
// file. On startup we scan backwards to find the last draft-related block and
// feed only that (plus any subsequent lines) to the parser, ignoring all the
// stale history before it.

const DRAFT_MARKERS = [
  'BotDraftDraftStatus',
  'HumanDraftDraftStatus',
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

  // Use actual file size (bytes) — not content.length (chars) — as the byte offset
  lastSize = stat.size;

  if (latestDraftLine === -1) {
    console.log('[logWatcher] No draft events found in log during initial scan');
    return;
  }

  // Go back a few extra lines to capture the request line before the response
  const startLine = Math.max(0, latestDraftLine - 3);
  console.log(`[logWatcher] Latest draft event near line ${latestDraftLine}, parsing from line ${startLine}`);

  logParser.reset();
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim()) logParser.parseLine(line, overlayWin);
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
      initialScan(filePath);
      return;
    }

    if (currentSize === lastSize) return;

    const fd = fs.openSync(filePath, 'r');
    const bufLen = currentSize - lastSize;
    const buf = Buffer.alloc(bufLen);
    fs.readSync(fd, buf, 0, bufLen, lastSize);
    fs.closeSync(fd);
    lastSize = currentSize;

    console.log(`[logWatcher] Read ${bufLen} new bytes`);
    emitLogUpdated();

    const newContent = buf.toString('utf-8');
    for (const line of newContent.split('\n')) {
      if (line.trim()) logParser.parseLine(line, overlayWin);
    }
  } catch (err) {
    console.error('[logWatcher] Error reading log:', err.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

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
    console.log('[logWatcher] chokidar change event');
    readNewContent(logPath);
  });

  watcher.on('error', (err) => {
    console.error('[logWatcher] Watcher error:', err.message);
    emitStatus('error');
  });

  // ── Polling fallback — catches writes that chokidar misses on Windows ────
  // Runs every 500 ms and calls readNewContent if the file has grown.
  pollTimer = setInterval(() => {
    if (fs.existsSync(logPath)) {
      readNewContent(logPath);
    }
  }, 500);
}

function stopWatching() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = { startWatching, stopWatching };
