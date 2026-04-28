/**
 * MTG Arena log parser — extracts draft events from Player.log
 *
 * Arena 2026 log structure observed in the wild:
 *
 *   REQUEST (==>): the entire JSON is on the same line as the endpoint:
 *     [UnityCrossThreadLogger]==> BotDraftDraftStatus {"id":"...","request":"{...}"}
 *     [UnityCrossThreadLogger]==> BotDraftMakePick    {"id":"...","request":"{...}"}
 *
 *   RESPONSE (<==): endpoint header line, then JSON body on the NEXT line:
 *     <== BotDraftDraftStatus(3b8e06eb-...)
 *     {"CurrentModule":"BotDraft","Payload":"{...double-encoded JSON...}"}
 *
 *   OLDER / PREMIER DRAFT format (still supported):
 *     [UnityCrossThreadLogger]==> Draft/DraftStatus
 *     {"draftStatus":{"draftPack":[...]}}
 *
 *     [UnityCrossThreadLogger]==> Event/DraftNotify
 *     {"method":"Event_DraftNotify","payload":{"draftPack":[...]}}
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const appLogger = require('./appLogger');

// ─── Broadcast helper ────────────────────────────────────────────────────────

let broadcastFn = null;

function setBroadcast(fn) {
  broadcastFn = fn;
}

function emit(channel, data) {
  if (broadcastFn) {
    broadcastFn(channel, data);
  }
}

// ─── Parse failure logger ────────────────────────────────────────────────────

let parseFailureLog = null;

function getParseFailureLog() {
  if (!parseFailureLog) {
    try {
      const dir = path.join(app.getPath('userData'), 'logs');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      parseFailureLog = path.join(dir, 'parse-failures.log');
    } catch {
      parseFailureLog = null;
    }
  }
  return parseFailureLog;
}

function logParseFailure(line) {
  try {
    const fp = getParseFailureLog();
    if (fp) {
      fs.appendFileSync(fp, `[${new Date().toISOString()}] ${line.substring(0, 500)}\n`, 'utf-8');
    }
  } catch {}
  try {
    const logWatcher = require('./logWatcher');
    logWatcher.incrementFailureCount();
  } catch {}
}

// ─── Known endpoint patterns ─────────────────────────────────────────────────

const PATTERNS = {
  packStatus: ['BotDraftDraftStatus', 'HumanDraftDraftStatus', 'Draft/DraftStatus', 'Event/DraftNotify'],
  pick: ['BotDraftDraftPick', 'HumanDraftDraftPick', 'BotDraftMakePick', 'HumanDraftMakePick', 'Draft/MakePick', 'Ranked/MakePick'],
  draftComplete: ['Draft/CompleteDraft'],
};

const ALL_DRAFT_ENDPOINTS = [
  ...PATTERNS.packStatus,
  ...PATTERNS.pick,
  ...PATTERNS.draftComplete,
];

const DRAFT_KEYWORDS = ['Draft', 'Pack', 'Pick', 'CardId', 'GrpId', 'DraftPack'];

// ─── Parser state ─────────────────────────────────────────────────────────────

let state = {
  inDraft: false,
  setCode: null,
  format: null,   // 17Lands format string detected from EventName (e.g. 'QuickDraft')
  packNumber: 0,
  pickNumber: 0,
  currentPack: [],
  pickedCards: [],
};

// Track the last emitted pack-opened so we can deduplicate.
// Arena periodically re-writes the full draft state to the log, which would
// otherwise cause the same pack to be emitted on every heartbeat.
let lastEmittedPack = { packNumber: null, pickNumber: null };

// Track the last emitted card-picked to deduplicate replayed pick events.
// The stale-detection forward-read and initial scan can both replay MakePick
// lines; without this guard each replay fires card-picked and clears the overlay.
let lastEmittedPick = { packNumber: null, pickNumber: null };

// ─── Format detection ─────────────────────────────────────────────────────────

let detectedFormat = null; // 'arena-2026' | 'legacy' | null

function detectFormat(lines) {
  const recent = lines.slice(-500);
  for (const line of recent) {
    if (line.includes('BotDraftDraftStatus') || line.includes('HumanDraftDraftStatus')) {
      detectedFormat = 'arena-2026';
      appLogger.log('parser', 'info', 'Detected format: arena-2026');
      return 'arena-2026';
    }
  }
  detectedFormat = 'legacy';
  appLogger.log('parser', 'info', 'Detected format: legacy');
  return 'legacy';
}

// Which endpoint we are currently collecting a response body for
let pendingEndpoint = null;
let pendingBuffer   = '';

// ─── Endpoint matching ────────────────────────────────────────────────────────

function isDraftEndpoint(ep) {
  return ALL_DRAFT_ENDPOINTS.some(p => ep === p || ep.includes(p) || p.includes(ep));
}

function isPickEndpoint(ep) {
  return PATTERNS.pick.some(p => ep === p || ep.includes(p) || p.includes(ep));
}

// ─── Line matching regexes ────────────────────────────────────────────────────

const REQ_INLINE_RE = /\[UnityCrossThreadLogger\].*==>\s*([\w/]+)\s+(\{.+)$/;
const REQ_MULTI_RE  = /\[UnityCrossThreadLogger\].*==>\s*([\w/]+)\s*$/;
const RES_RE = /^<==\s*([\w/]+)/;
const SKIP_RE = /^\[UnityCrossThreadLogger\]|^Mono |^Initialize |^GfxDevice|^Direct3D|^NullRef|^  at /;

// ─── Main parse function ──────────────────────────────────────────────────────

function reset() {
  state = {
    inDraft: false, setCode: null, format: null,
    packNumber: 0, pickNumber: 0,
    currentPack: [], pickedCards: [],
  };
  pendingEndpoint = null;
  pendingBuffer   = '';
  lastEmittedPack = { packNumber: null, pickNumber: null };
  lastEmittedPick = { packNumber: null, pickNumber: null };
}

function parseLine(line, broadcast) {
  // Update broadcast if provided
  if (broadcast && typeof broadcast === 'function') {
    broadcastFn = broadcast;
  }

  // Check for parse failures — lines with draft keywords that don't match patterns
  const hasDraftKeyword = DRAFT_KEYWORDS.some(k => line.includes(k));

  // ── ==> request (new format — inline JSON) ───────────────────────────────
  const inlineMatch = line.match(REQ_INLINE_RE);
  if (inlineMatch) {
    flushPending();

    const endpoint  = inlineMatch[1];
    const inlineRaw = inlineMatch[2];
    appLogger.log('parser', 'debug', `==> ${endpoint} (inline JSON)`);

    if (isDraftEndpoint(endpoint)) {
      tryHandleRequest(endpoint, inlineRaw);
      incrementEvent();
    } else if (hasDraftKeyword) {
      logParseFailure(line);
    }
    pendingEndpoint = null;
    pendingBuffer   = '';
    return;
  }

  // ── ==> request (old format — JSON on next lines) ────────────────────────
  const multiMatch = line.match(REQ_MULTI_RE);
  if (multiMatch) {
    flushPending();
    const endpoint = multiMatch[1];
    appLogger.log('parser', 'debug', `==> ${endpoint} (multi-line)`);

    if (isDraftEndpoint(endpoint)) {
      pendingEndpoint = endpoint;
      pendingBuffer   = '';
    } else {
      pendingEndpoint = null;
      pendingBuffer   = '';
    }
    return;
  }

  // ── <== response header ───────────────────────────────────────────────────
  const resMatch = line.match(RES_RE);
  if (resMatch) {
    flushPending();

    const endpoint = resMatch[1];
    appLogger.log('parser', 'debug', `<== ${endpoint}`);

    if (isDraftEndpoint(endpoint)) {
      pendingEndpoint = endpoint;
      pendingBuffer   = '';
    } else {
      pendingEndpoint = null;
      pendingBuffer   = '';
    }
    return;
  }

  // ── JSON body accumulation ────────────────────────────────────────────────
  if (pendingEndpoint) {
    if (SKIP_RE.test(line) || line.trim() === '') return;

    pendingBuffer += line + '\n';

    if (pendingBuffer.trim().startsWith('{') || pendingBuffer.trim().startsWith('[')) {
      try {
        JSON.parse(pendingBuffer.trim());
        flushPending();
      } catch {
        // Not complete yet
      }
    }
  }
}

function flushPending() {
  if (!pendingEndpoint || !pendingBuffer.trim()) return;
  tryHandleResponse(pendingEndpoint, pendingBuffer.trim());
  pendingEndpoint = null;
  pendingBuffer   = '';
}

function incrementEvent() {
  try {
    const logWatcher = require('./logWatcher');
    logWatcher.incrementEventCount();
  } catch {}
}

// ─── Request handler (==> inline, new format) ────────────────────────────────

function tryHandleRequest(endpoint, raw) {
  let outer;
  try { outer = JSON.parse(raw); } catch { return; }

  let req = outer.request || outer;
  if (typeof req === 'string') {
    try { req = JSON.parse(req); } catch { return; }
  }

  if (isPickEndpoint(endpoint)) {
    const pickInfo = req.PickInfo ?? req.pickInfo;
    const cardIds = pickInfo?.CardIds ?? pickInfo?.cardIds;
    const grpId = cardIds?.length
      ? parseInt(cardIds[0])
      : parseInt(req.GrpId ?? req.grpId ?? req.CardId ?? req.cardId);
    if (!isNaN(grpId)) {
      appLogger.log('parser', 'info', `card-picked via request grpId=${grpId}`);
      handlePick(grpId);
    }
  }

  // DraftStatus inline request — extract EventName for set + format detection
  if (endpoint.includes('DraftStatus')) {
    if (req.EventName || req.eventName) {
      const { setCode: sc, format: fmt } = extractEventInfo(req.EventName ?? req.eventName);
      if (sc && !state.setCode) {
        state.setCode = sc;
        appLogger.log('parser', 'info', `Set code from request: ${sc}`);
      }
      if (fmt && !state.format) {
        state.format = fmt;
        appLogger.log('parser', 'info', `Format from request: ${fmt}`);
      }
    }
  }
}

// ─── Response handler (<== body, both formats) ───────────────────────────────

function tryHandleResponse(endpoint, raw) {
  let outer;
  try { outer = JSON.parse(raw); } catch (e) {
    appLogger.log('parser', 'warn', `JSON parse failed for ${endpoint}`, e.message);
    console.warn(`[parser] JSON parse failed for ${endpoint}:`, e.message);
    return;
  }

  // ── New format: double-encoded Payload ───────────────────────────────────
  if (outer.Payload && typeof outer.Payload === 'string') {
    let inner;
    try { inner = JSON.parse(outer.Payload); } catch (e) {
      appLogger.log('parser', 'warn', 'Payload parse failed', e.message);
      console.warn(`[parser] Payload parse failed:`, e.message);
      return;
    }
    appLogger.log('parser', 'info', `Response ${endpoint}`, {
      DraftStatus: inner.DraftStatus,
      Pack: inner.PackNumber,
      Pick: inner.PickNumber,
      Cards: inner.DraftPack?.length,
    });
    handleDraftPayload(inner);
    incrementEvent();
    return;
  }

  // ── Old DraftNotify / Event format ───────────────────────────────────────
  if (outer.method && outer.payload) {
    appLogger.log('parser', 'info', 'DraftNotify payload');
    handleDraftPayload(outer.payload);
    incrementEvent();
    return;
  }

  // ── Old DraftStatus format ────────────────────────────────────────────────
  if (endpoint.includes('DraftStatus') || endpoint.includes('DraftNotify')) {
    appLogger.log('parser', 'info', 'Legacy draft status');
    handleDraftPayload(outer.draftStatus || outer.DraftStatus || outer);
    incrementEvent();
    return;
  }

  if (isPickEndpoint(endpoint)) {
    const inner = outer.Payload ? outer : (outer.draftStatus || outer);
    handleDraftPayload(inner);
  }
}

// ─── Core draft payload handler ───────────────────────────────────────────────

// Maps the first segment of an Arena EventName to a 17Lands format param.
// Arena event names follow the pattern: <format>_<setCode>_<date>
// e.g. "QuickDraft_FDN_20241115", "PremierDraft_DSK_20240910"
const EVENT_FORMAT_MAP = {
  QuickDraft:    'QuickDraft',
  PremierDraft:  'PremierDraft',
  TradDraft:     'TradDraft',
  Sealed:        'Sealed',
  // BotDraft = Quick Draft (Arena bot-assisted draft)
  BotDraft:      'QuickDraft',
};

function extractEventInfo(eventName) {
  if (!eventName) return { setCode: null, format: null };
  const parts = eventName.split('_');
  const setCode = parts.length >= 2 ? parts[1] : null;
  const format = EVENT_FORMAT_MAP[parts[0]] ?? null;
  return { setCode, format };
}

// Keep for backwards compat within this file
function extractSetCode(eventName) {
  return extractEventInfo(eventName).setCode;
}

function handleDraftPayload(payload) {
  if (!payload) return;

  const packCards   = payload.DraftPack   ?? payload.draftPack   ?? payload.PackCards ?? payload.packCards;
  const packNumber  = payload.PackNumber  ?? payload.packNumber  ?? payload.PackNum;
  const pickNumber  = payload.PickNumber  ?? payload.pickNumber  ?? payload.PickNum;
  const eventName   = payload.EventName   ?? payload.eventName;
  const draftStatus = payload.DraftStatus ?? payload.draftStatus;
  const { setCode: scFromEvent, format: fmtFromEvent } = extractEventInfo(eventName);
  const setCode = scFromEvent ?? payload.WOTCReleaseId ?? payload.setCode;

  if (!packCards || !Array.isArray(packCards) || packCards.length === 0) {
    appLogger.log('parser', 'debug', `No pack cards in payload (DraftStatus=${draftStatus})`);
    return;
  }

  if (draftStatus && draftStatus !== 'PickNext') {
    appLogger.log('parser', 'debug', `Skipping — DraftStatus=${draftStatus} (not PickNext)`);
    return;
  }

  const normalizedPack = packCards.map(c => {
    if (typeof c === 'string' || typeof c === 'number') return { grpId: parseInt(c) };
    if (typeof c === 'object') return { grpId: parseInt(c.grpId ?? c.CardId ?? c.cardId ?? c.id), ...c };
    return null;
  }).filter(c => c && !isNaN(c.grpId));

  // Validation: log a warning when the pack size seems wrong.
  // In a normal 3-pack draft the remaining cards = 15 - pickNumber.
  // This fires when the parser might be processing stale or merged data.
  if (packNumber != null && pickNumber != null) {
    const expected = 15 - pickNumber;
    if (normalizedPack.length !== expected) {
      appLogger.log('parser', 'warn',
        `Pack size mismatch: got ${normalizedPack.length} card(s), ` +
        `expected ${expected} (pack=${packNumber}, pick=${pickNumber})`, {
          cards: normalizedPack.map(c => c.grpId),
        });
      console.warn(`[parser] Pack size mismatch: got ${normalizedPack.length}, expected ${expected} ` +
        `(pack=${packNumber}, pick=${pickNumber}) cards=${JSON.stringify(normalizedPack.map(c => c.grpId))}`);
    }
  }

  if (setCode) state.setCode = setCode;
  if (fmtFromEvent) state.format = fmtFromEvent;
  if (packNumber !== undefined && packNumber !== null) state.packNumber = packNumber;
  if (pickNumber !== undefined && pickNumber !== null) state.pickNumber = pickNumber;
  // Explicitly clear previous pack before setting new one (prevents any stale-merge bugs)
  state.currentPack = [];
  state.currentPack = normalizedPack;

  if (!state.inDraft) {
    state.inDraft = true;
    appLogger.log('parser', 'info', `draft-started setCode=${state.setCode} format=${state.format}`);
    console.log(`[parser] draft-started setCode=${state.setCode} format=${state.format}`);
    emit('draft-started', { setCode: state.setCode, format: state.format });
  }

  // Deduplicate / anti-regression: only emit a pack if it is strictly NEWER
  // than the last emitted pack.  "Newer" means a higher packNumber, or the
  // same packNumber with a higher pickNumber.
  //
  // The simple equality check used previously caused a phantom-card bug:
  // logWatcher's stale-detection force-re-reads the last 10 kB of the log
  // every 30 s when idle in a draft.  That re-read replays every old pick
  // event in the window (picks 0→N-1).  Each has a different pickNumber so
  // the old equality check let them all through, updating the overlay with
  // stale pack data and leaving it stuck on an old pack after pick N was
  // already deduplicated.
  //
  // With this check, once we have seen pack P / pick N, any event with a
  // lower pickNumber (same pack) or lower packNumber is silently discarded.
  const isNewer =
    lastEmittedPack.packNumber === null ||
    state.packNumber > lastEmittedPack.packNumber ||
    (state.packNumber === lastEmittedPack.packNumber &&
     state.pickNumber > lastEmittedPack.pickNumber);

  if (!isNewer) {
    appLogger.log('parser', 'debug',
      `pack-opened suppressed (stale) pack=${state.packNumber} pick=${state.pickNumber} ` +
      `lastPack=${lastEmittedPack.packNumber} lastPick=${lastEmittedPack.pickNumber}`);
    return;
  }
  lastEmittedPack = { packNumber: state.packNumber, pickNumber: state.pickNumber };

  // Section 6C: stamp every pack-opened with a unique event ID so downstream
  // consumers can verify they're not displaying a stale or duplicate pack.
  // The id encodes (pack, pick, monotonic timestamp) so it differs even if
  // Arena re-issues the same (pack, pick) — which can happen during pivots.
  const packEventId = `p${state.packNumber}-i${state.pickNumber}-t${Date.now()}`;

  appLogger.log('parser', 'info', `pack-opened pack=${state.packNumber} pick=${state.pickNumber} cards=${normalizedPack.length} set=${state.setCode} format=${state.format} eventId=${packEventId}`);
  console.log(`[parser] pack-opened pack=${state.packNumber} pick=${state.pickNumber} cards=${normalizedPack.length} eventId=${packEventId}`);
  emit('pack-opened', {
    packEventId,
    packNumber:  state.packNumber,
    pickNumber:  state.pickNumber,
    cards:       normalizedPack,
    setCode:     state.setCode,
    format:      state.format,
  });
}

function handlePick(grpId) {
  state.pickedCards = [...state.pickedCards, { grpId }];
  state.pickNumber  = (state.pickNumber || 0) + 1;

  // Deduplicate: only emit if this pick is strictly newer than the last one.
  // Replayed MakePick lines (from initial scan context or stale forward-reads)
  // must not re-fire card-picked and clear the renderer's current enrichedPack.
  const pickIsNewer =
    lastEmittedPick.packNumber === null ||
    state.packNumber > lastEmittedPick.packNumber ||
    (state.packNumber === lastEmittedPick.packNumber &&
     state.pickNumber > lastEmittedPick.pickNumber);

  if (!pickIsNewer) {
    appLogger.log('parser', 'debug',
      `card-picked suppressed (stale) pack=${state.packNumber} pick=${state.pickNumber} ` +
      `lastPack=${lastEmittedPick.packNumber} lastPick=${lastEmittedPick.pickNumber}`);
    return;
  }
  lastEmittedPick = { packNumber: state.packNumber, pickNumber: state.pickNumber };

  appLogger.log('parser', 'info', `card-picked grpId=${grpId} pickNumber=${state.pickNumber}`);
  console.log(`[parser] card-picked grpId=${grpId} pickNumber=${state.pickNumber}`);
  emit('card-picked', {
    grpId,
    packNumber:   state.packNumber,
    pickNumber:   state.pickNumber,
    pickedCards:  state.pickedCards,
  });
}

function getState() {
  return { ...state };
}

module.exports = { parseLine, reset, getState, setBroadcast, detectFormat };
