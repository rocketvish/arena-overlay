const fs = require('fs');
const { StringDecoder } = require('string_decoder');
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
let lastForceReread = 0; // timestamp of last stale-check forward-read

// ── Burst buffering ───────────────────────────────────────────────────────────

let lineBuffer = [];
let flushTimer = null;
// Arena can flush half a line at a time; hold the unterminated tail until the
// next read so a JSON body is never split into two unparseable fragments.
let partialLine = '';
let decoder = new StringDecoder('utf8');

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

/**
 * Split a freshly read chunk into complete lines. `carry` is the unterminated
 * tail of the previous chunk; the new unterminated tail is returned as `carry`.
 * Handles CRLF (Player.log's native line ending) and a CRLF split across reads.
 */
function splitLogChunk(carry, chunk) {
  const lines = (carry + chunk).split(/\r?\n/);
  const rest = lines.pop() ?? '';
  return { lines, carry: rest };
}

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

// Markers that appear in DraftStatus *response* headers (<== lines).
// We deliberately search for pack-bearing responses, not pick requests,
// so the initial scan always starts at the most recent pack boundary.
const PACK_RESPONSE_MARKERS = [
  'BotDraftDraftStatus',
  'HumanDraftDraftStatus',
  'Draft/DraftStatus',
  'Event/DraftNotify',
];

function isPackResponseLine(line) {
  // Human drafts (Premier / Traditional) deliver packs on bare Draft.Notify lines.
  if (/Draft\.Notify\s+\{/.test(line)) return true;
  return line.startsWith('<==') && PACK_RESPONSE_MARKERS.some(m => line.includes(m));
}

function initialScan(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch (err) {
    appLogger.log('logWatcher', 'error', 'Cannot read log for initial scan', err.message);
    console.error('[logWatcher] Cannot read log for initial scan:', err.message);
    return;
  }
  // Size of exactly what we read — a separate stat() could include bytes
  // Arena wrote in between, which would then never be parsed.
  lastSize = raw.length;
  decoder = new StringDecoder('utf8');

  // Player.log uses CRLF line endings — split on both so no line keeps a '\r'.
  // An unterminated last line (Arena mid-write) is held until the rest arrives.
  const { lines, carry } = splitLogChunk('', decoder.write(raw));
  partialLine = carry;
  console.log(`[logWatcher] Initial scan: ${lines.length} lines, ${raw.length} bytes`);

  // Walk backwards to find the last DraftStatus *response* line (<==).
  // Searching for responses (not requests) ensures we start at the most recent
  // pack boundary, not at a MakePick that comes after it.
  let latestPackLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isPackResponseLine(lines[i])) {
      latestPackLine = i;
      break;
    }
  }

  // A Sealed pool being built right now lives in the latest course listing.
  if (broadcastFn) {
    for (let i = lines.length - 1; i > latestPackLine; i--) {
      if (/^<==\s*(EventGetCoursesV2|Event_?Join)\b/.test(lines[i])) {
        logParser.parseLine(lines[i], broadcastFn);
        if (lines[i + 1]) logParser.parseLine(lines[i + 1], broadcastFn);
        break;
      }
    }
  }

  // A game in progress (connected after the last completed match): replay it
  // so the game assistant has the current board.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('MatchGameRoomStateType_MatchCompleted')) break;
    if (lines[i].includes('"GREMessageType_ConnectResp"')) {
      const end = latestPackLine === -1 || latestPackLine < i ? lines.length : latestPackLine - 1;
      for (let k = i; k < end; k++) {
        if (lines[k].charCodeAt(0) === 123) logParser.parseLine(lines[k], broadcastFn);
      }
      break;
    }
  }

  if (latestPackLine === -1) {
    console.log('[logWatcher] No draft pack events found in log during initial scan');
    return;
  }

  // Start 1 line before the response header so the parser has a clean context.
  const startLine = Math.max(0, latestPackLine - 1);
  console.log(`[logWatcher] Latest pack response at line ${latestPackLine}, parsing from line ${startLine}`);

  logParser.reset();

  // Human-draft packs don't name their set; replay the EventJoin that started
  // this draft first so a mid-draft restart still knows which set it is.
  for (let i = startLine - 1; i >= 0; i--) {
    if (/==>\s*Event_?Join\b/.test(lines[i]) && lines[i].includes('Draft')) {
      if (broadcastFn) logParser.parseLine(lines[i], broadcastFn);
      break;
    }
  }

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

    // StringDecoder keeps a multi-byte character split across reads intact.
    const { lines: newLines, carry } = splitLogChunk(partialLine, decoder.write(buf));
    partialLine = carry;

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

    // Forward-only check: call readNewContent (no-op if file hasn't grown).
    // We do NOT rewind lastSize backwards — replaying already-seen bytes causes
    // duplicate MakePick events which clear the overlay with ghost data.
    // The 500ms poll timer already handles missed writes; this is just a
    // belt-and-suspenders forward-read in case both watchers stalled.
    if (elapsed > 30000 && fs.existsSync(logPath)) {
      const sinceForcedReread = Date.now() - lastForceReread;
      if (sinceForcedReread > 30000) {
        lastForceReread = Date.now();
        readNewContent(logPath); // forward-only; no-op if size unchanged
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
  partialLine = '';
  decoder = new StringDecoder('utf8');
  lineBuffer = [];
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
  splitLogChunk,
};
