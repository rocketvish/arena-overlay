/**
 * testReplay.js — Replay a past draft from Player.log for testing.
 *
 * Finds the most recent complete draft in the log (one that has both a
 * draft-started event AND at least 15 pack-opened events), then replays
 * every event through the normal broadcast pipeline with configurable delays.
 *
 * Called from main.js via IPC: 'test:start-replay' / 'test:stop-replay'
 */

const fs      = require('fs');
const path    = require('path');
const logParser = require('./logParser');
const settings  = require('./settings');
const appLogger = require('./appLogger');

// ─── State ────────────────────────────────────────────────────────────────────

let replayTimer   = null;
let isReplaying   = false;
let broadcastFn   = null;

// ─── Log path helpers ─────────────────────────────────────────────────────────

function getLogPath() {
  const s = settings.get();
  return settings.resolveArenaLogPath(s.general.arenaLogPath);
}

// ─── Draft extraction ─────────────────────────────────────────────────────────

/**
 * Walk the log and collect all draft events by replaying the parser.
 * Returns an array of event objects: { channel, data, lineIndex }
 * sorted in log order.
 */
function extractDraftEventsFromLog(logContent) {
  // Strip trailing \r — Windows CRLF would otherwise break the parser's
  // `(\{.+)$` regex (since `.` doesn't match `\r`).
  const lines = logContent.split('\n').map(l => l.replace(/\r$/, ''));
  const events = [];

  // Temporarily hijack the parser's broadcast to collect events
  const originalBroadcast = null;
  const collector = (channel, data) => {
    events.push({ channel, data: JSON.parse(JSON.stringify(data)) });
  };

  logParser.reset();
  logParser.setBroadcast(collector);

  for (const line of lines) {
    if (line.trim()) logParser.parseLine(line, collector);
  }

  // Reset parser to clean state after extraction
  logParser.reset();

  return events;
}

/**
 * Find the most recent complete draft in the event stream.
 * A "complete" draft has a draft-started event and at least 15 pack-opened events.
 * Returns the slice of events for that draft, or null if none found.
 */
function findLastCompleteDraft(events) {
  // Find all draft-started indices
  const startIndices = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].channel === 'draft-started') startIndices.push(i);
  }

  if (startIndices.length === 0) return null;

  // Walk from most recent start backwards until we find one with >=15 packs
  for (let si = startIndices.length - 1; si >= 0; si--) {
    const start = startIndices[si];
    const end   = si + 1 < startIndices.length ? startIndices[si + 1] : events.length;
    const slice = events.slice(start, end);

    const packCount = slice.filter(e => e.channel === 'pack-opened').length;
    const pickCount = slice.filter(e => e.channel === 'card-picked').length;

    if (packCount >= 15) {
      appLogger.log('testReplay', 'info',
        `Found draft: ${packCount} packs, ${pickCount} picks, ` +
        `setCode=${slice[0].data.setCode} format=${slice[0].data.format}`);
      return slice;
    }
  }

  // No complete draft found — return the most recent partial draft if it has any packs
  const lastStart = startIndices[startIndices.length - 1];
  const lastSlice = events.slice(lastStart);
  const packCount = lastSlice.filter(e => e.channel === 'pack-opened').length;
  if (packCount > 0) return lastSlice;

  return null;
}

// ─── Replay engine ────────────────────────────────────────────────────────────

/**
 * Start replaying a draft.
 * @param {function} broadcast  broadcastToAll(channel, data)
 * @param {object}   opts       { pickDelayMs: number }
 * @returns {{ ok: boolean, error?: string, draftInfo?: object }}
 */
async function startReplay(broadcast, opts = {}) {
  if (isReplaying) {
    return { ok: false, error: 'Replay already running' };
  }

  const pickDelayMs = opts.pickDelayMs ?? 2000;
  broadcastFn = broadcast;

  // Read log
  const logPath = getLogPath();
  let logContent;
  try {
    logContent = fs.readFileSync(logPath, 'utf-8');
  } catch (err) {
    return { ok: false, error: `Cannot read log: ${err.message}` };
  }

  // Extract and find draft
  const allEvents = extractDraftEventsFromLog(logContent);
  const draftEvents = findLastCompleteDraft(allEvents);

  if (!draftEvents || draftEvents.length === 0) {
    return { ok: false, error: 'No complete draft found in Player.log' };
  }

  const draftInfo = {
    setCode:   draftEvents[0].data.setCode,
    format:    draftEvents[0].data.format,
    packCount: draftEvents.filter(e => e.channel === 'pack-opened').length,
    pickCount: draftEvents.filter(e => e.channel === 'card-picked').length,
  };

  appLogger.log('testReplay', 'info', 'Starting replay', draftInfo);
  isReplaying = true;

  // Signal test mode is active
  broadcast('test:replay-started', draftInfo);

  // Fire events sequentially with delay before each pack/pick
  let i = 0;

  function fireNext() {
    if (!isReplaying || i >= draftEvents.length) {
      isReplaying = false;
      broadcast('test:replay-ended', { complete: i >= draftEvents.length });
      appLogger.log('testReplay', 'info', 'Replay ended', { eventsReplayed: i });
      return;
    }

    const { channel, data } = draftEvents[i++];

    // Fire the event through the normal broadcast pipeline
    broadcast(channel, data);

    // Delay before next event: immediately for draft-started, delay for packs/picks
    const isPaced = channel === 'pack-opened' || channel === 'card-picked';
    const delay   = isPaced ? pickDelayMs : 50;

    replayTimer = setTimeout(fireNext, delay);
  }

  // Small startup delay so the UI can show the TEST MODE banner first
  replayTimer = setTimeout(fireNext, 300);

  return { ok: true, draftInfo };
}

function stopReplay() {
  if (replayTimer) {
    clearTimeout(replayTimer);
    replayTimer = null;
  }
  const wasRunning = isReplaying;
  isReplaying = false;
  if (broadcastFn && wasRunning) {
    broadcastFn('test:replay-ended', { complete: false, aborted: true });
  }
  logParser.reset();
  return { ok: true };
}

function isActive() {
  return isReplaying;
}

module.exports = { startReplay, stopReplay, isActive };
