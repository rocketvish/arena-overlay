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
// Optional: (grpIds) => setCode | null, for drafts whose set we never saw named.
let setCodeResolver = null;

function setBroadcast(fn) {
  broadcastFn = fn;
}

// In-game messages are large and frequent, so they go straight to the game
// tracker in the main process instead of being broadcast to the windows.
let gameHandler = null;
function setGameHandler(fn) {
  gameHandler = fn;
}

function setSetCodeResolver(fn) {
  setCodeResolver = fn;
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

const MAX_PARSE_FAILURE_LOG = 2 * 1024 * 1024;

function logParseFailure(line) {
  try {
    const fp = getParseFailureLog();
    if (fp) {
      // Keep it bounded: roll over to a single .old file at 2 MB.
      try {
        if (fs.statSync(fp).size > MAX_PARSE_FAILURE_LOG) fs.renameSync(fp, fp + '.old');
      } catch {}
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
  pick: [
    'BotDraftDraftPick', 'HumanDraftDraftPick', 'BotDraftMakePick', 'HumanDraftMakePick',
    'Draft/MakePick', 'Ranked/MakePick',
    // Premier / Traditional (human) drafts
    'EventPlayerDraftMakePick', 'Event_PlayerDraftMakePick', 'Event.PlayerDraftMakePick',
  ],
  draftComplete: ['Draft/CompleteDraft', 'EventCompleteDraft', 'Event_CompleteDraft'],
};

// Human-draft packs arrive on a bare notify line rather than a <== response:
//   [UnityCrossThreadLogger]Draft.Notify {"draftId":"…","SelfPick":3,"SelfPack":1,"PackCards":"101,102,…"}
// SelfPack / SelfPick are 1-based.
const DRAFT_NOTIFY_RE = /Draft\.Notify\s+(\{.*\})\s*$/;

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
  eventName: null,
  packNumber: 0,
  pickNumber: 0,
  // Cards per pack. Not always 15 — e.g. SOS packs hold 14. Learned from the
  // first pick of each pack (pickNumber 0 → full pack).
  packSize: null,
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
    inDraft: false, setCode: null, format: null, eventName: null,
    packNumber: 0, pickNumber: 0, packSize: null,
    currentPack: [], pickedCards: [],
  };
  pendingEndpoint = null;
  pendingBuffer   = '';
  lastEmittedPack = { packNumber: null, pickNumber: null };
  lastEmittedPick = { packNumber: null, pickNumber: null };
}

function parseLine(rawLine, broadcast) {
  // Update broadcast if provided
  if (broadcast && typeof broadcast === 'function') {
    broadcastFn = broadcast;
  }

  // Player.log is written with CRLF endings. A trailing '\r' defeats every
  // `$`-anchored regex below (`.` never matches '\r'), which silently dropped
  // every ==> request line — including all draft picks.
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

  // Check for parse failures — lines with draft keywords that don't match patterns
  const hasDraftKeyword = DRAFT_KEYWORDS.some(k => line.includes(k));

  // ── In-game engine messages (GRE) and match room state ───────────────────
  if (line.charCodeAt(0) === 123 /* { */ && gameHandler &&
      (line.includes('"greToClientEvent"') || line.includes('"matchGameRoomStateChangedEvent"'))) {
    try {
      gameHandler(JSON.parse(line));
    } catch (e) {
      appLogger.log('parser', 'warn', 'Game message parse failed', e.message);
    }
    return;
  }

  // ── Draft.Notify (human drafts: Premier / Traditional) ───────────────────
  const notifyMatch = line.match(DRAFT_NOTIFY_RE);
  if (notifyMatch) {
    flushPending();
    handleDraftNotify(notifyMatch[1]);
    incrementEvent();
    pendingEndpoint = null;
    pendingBuffer   = '';
    return;
  }

  // ── ==> request (new format — inline JSON) ───────────────────────────────
  const inlineMatch = line.match(REQ_INLINE_RE);
  if (inlineMatch) {
    flushPending();

    const endpoint  = inlineMatch[1];
    const inlineRaw = inlineMatch[2];
    appLogger.log('parser', 'debug', `==> ${endpoint} (inline JSON)`);

    if (endpoint === 'EventJoin' || endpoint === 'Event_Join') {
      handleEventJoin(inlineRaw);
    } else if (isDraftEndpoint(endpoint)) {
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

    if (isDraftEndpoint(endpoint) || COURSE_ENDPOINTS.test(endpoint)) {
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

  if (PATTERNS.draftComplete.some(p => endpoint.includes(p))) {
    endDraft(endpoint);
    return;
  }

  if (isPickEndpoint(endpoint)) {
    const pickInfo = req.PickInfo ?? req.pickInfo;
    const cardIds = pickInfo?.CardIds ?? pickInfo?.cardIds ?? req.GrpIds ?? req.grpIds;
    const grpId = cardIds?.length
      ? parseInt(cardIds[0])
      : parseInt(req.GrpId ?? req.grpId ?? req.CardId ?? req.cardId);

    // Where in the draft this pick was made. Bot drafts send 0-based
    // PickInfo.PackNumber/PickNumber; human drafts send 1-based Pack/Pick.
    let pickPack = pickInfo?.PackNumber ?? pickInfo?.packNumber;
    let pickPick = pickInfo?.PickNumber ?? pickInfo?.pickNumber;
    if (pickPack == null && (req.Pack ?? req.pack) != null) {
      pickPack = (req.Pack ?? req.pack) - 1;
      pickPick = (req.Pick ?? req.pick) - 1;
    }

    if (!isNaN(grpId)) {
      appLogger.log('parser', 'info', `card-picked via request grpId=${grpId} pack=${pickPack} pick=${pickPick}`);
      handlePick(grpId, toInt(pickPack), toInt(pickPick));
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

// ─── Sealed pools ─────────────────────────────────────────────────────────────

// Responses that describe event "courses" — a Sealed course carries the whole
// card pool: {"Course":{"InternalEventName":"…Sealed…","CurrentModule":"DeckSelect","CardPool":[ids…]}}
const COURSE_ENDPOINTS = /^(Event_?Join|EventGetCoursesV2|Event_GetCourses)$/;
const emittedPools = new Set(); // courseId:poolSize already announced

function handleCourses(outer) {
  const courses = outer.Courses ?? (outer.Course ? [outer.Course] : []);
  for (const c of courses) {
    const name = c.InternalEventName ?? '';
    const pool = Array.isArray(c.CardPool) ? c.CardPool.map(Number).filter(Number.isFinite) : [];
    // Only while building — finished events stay in the course list for days.
    if (!/Sealed/i.test(name) || pool.length < 40 || c.CurrentModule !== 'DeckSelect') continue;
    const key = `${c.CourseId}:${pool.length}`;
    if (emittedPools.has(key)) continue;
    emittedPools.add(key);
    const { setCode } = extractEventInfo(name);
    appLogger.log('parser', 'info', `sealed-pool ${name} cards=${pool.length}`);
    emit('sealed-pool', { eventName: name, setCode, courseId: c.CourseId, cards: pool.map(grpId => ({ grpId })) });
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

  if (COURSE_ENDPOINTS.test(endpoint)) {
    handleCourses(outer);
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

/**
 * Set codes end up in cache/log file names, so only plain codes (e.g. FRA,
 * Y26SOS) are accepted — anything else from the log is ignored.
 */
function validSetCode(code) {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(c) ? c : null;
}

function extractEventInfo(eventName) {
  if (typeof eventName !== 'string' || !eventName) return { setCode: null, format: null };
  const parts = eventName.split('_');
  const setCode = parts.length >= 2 ? validSetCode(parts[1]) : null;
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
  const setCode = scFromEvent ?? validSetCode(payload.WOTCReleaseId) ?? validSetCode(payload.setCode);

  // Bot drafts finish with a pick response whose DraftStatus is "Completed"
  // and whose DraftPack is empty. Without this the overlay stayed stuck on
  // the final pack and the next draft in the same session was suppressed as
  // "stale" by the anti-regression check below.
  if (draftStatus === 'Completed' || draftStatus === 'Complete') {
    endDraft(`DraftStatus=${draftStatus}`);
    return;
  }

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

  applyPack({
    cards: normalizedPack,
    packNumber: toInt(packNumber),
    pickNumber: toInt(pickNumber),
    eventName,
    setCode,
    format: fmtFromEvent,
  });
}

function toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * Joining an event names the set and format. Human-draft packs (Draft.Notify)
 * don't carry an EventName, so this is the only place Premier / Traditional
 * drafts learn their set code.
 */
function handleEventJoin(raw) {
  let req;
  try {
    const outer = JSON.parse(raw);
    req = typeof outer.request === 'string' ? JSON.parse(outer.request) : (outer.request ?? outer);
  } catch { return; }
  const eventName = req?.EventName ?? req?.eventName;
  if (!eventName || !/Draft/i.test(eventName)) return; // sealed, constructed, etc.
  const { setCode, format } = extractEventInfo(eventName);
  if (!setCode) return;
  appLogger.log('parser', 'info', `EventJoin ${eventName} → set=${setCode} format=${format}`);
  if (state.inDraft && state.eventName && state.eventName !== eventName) endDraft(`joined ${eventName}`);
  state.setCode = setCode;
  state.format = format ?? state.format;
  state.eventName = eventName;
}

// Human-draft pack notification (Premier / Traditional). 1-based pack/pick.
function handleDraftNotify(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch (e) {
    appLogger.log('parser', 'warn', 'Draft.Notify parse failed', e.message);
    return;
  }
  const cardsRaw = payload.PackCards ?? payload.packCards;
  const cards = (typeof cardsRaw === 'string' ? cardsRaw.split(',') : (cardsRaw ?? []))
    .map(id => ({ grpId: parseInt(id) }))
    .filter(c => !isNaN(c.grpId));
  if (cards.length === 0) return;

  const pack = toInt(payload.SelfPack ?? payload.selfPack);
  const pick = toInt(payload.SelfPick ?? payload.selfPick);
  applyPack({
    cards,
    packNumber: pack != null ? pack - 1 : null,
    pickNumber: pick != null ? pick - 1 : null,
    eventName: null,
    setCode: null,
    format: null,
  });
}

function endDraft(reason) {
  if (!state.inDraft) return;
  appLogger.log('parser', 'info', `draft-ended (${reason}) setCode=${state.setCode}`);
  console.log(`[parser] draft-ended (${reason})`);
  emit('draft-ended', { setCode: state.setCode, format: state.format });
  state.inDraft = false;
  state.pickedCards = [];
  state.currentPack = [];
  state.packSize = null;
  lastEmittedPack = { packNumber: null, pickNumber: null };
  lastEmittedPick = { packNumber: null, pickNumber: null };
}

function applyPack({ cards: normalizedPack, packNumber, pickNumber, eventName, setCode, format: fmtFromEvent }) {
  // A different event, or a fresh P1p1 after we'd already moved past it,
  // means a new draft began without us seeing the previous one finish
  // (abandoned draft, app started mid-way, etc.). Start over cleanly.
  const isNewEvent = eventName && state.eventName && eventName !== state.eventName;
  const isRestartedDraft = packNumber === 0 && pickNumber === 0 &&
    lastEmittedPack.packNumber !== null &&
    (lastEmittedPack.packNumber > 0 || lastEmittedPack.pickNumber > 0);
  if (state.inDraft && (isNewEvent || isRestartedDraft)) {
    endDraft(isNewEvent ? `new event ${eventName}` : 'new P1p1');
  }

  if (setCode) state.setCode = setCode;
  if (fmtFromEvent) state.format = fmtFromEvent;
  if (eventName) state.eventName = eventName;
  if (packNumber != null) state.packNumber = packNumber;
  if (pickNumber != null) state.pickNumber = pickNumber;

  // Learn the pack size from the first pick of a pack (full pack), or infer
  // it from a later pick if we joined mid-pack.
  if (pickNumber === 0) state.packSize = normalizedPack.length;
  else if (state.packSize == null && pickNumber != null) state.packSize = normalizedPack.length + pickNumber;

  if (state.packSize != null && pickNumber != null) {
    const expected = state.packSize - pickNumber;
    if (normalizedPack.length !== expected) {
      appLogger.log('parser', 'warn',
        `Pack size mismatch: got ${normalizedPack.length} card(s), ` +
        `expected ${expected} (pack=${packNumber}, pick=${pickNumber}, packSize=${state.packSize})`, {
          cards: normalizedPack.map(c => c.grpId),
        });
    }
  }

  state.currentPack = normalizedPack;

  // Human-draft packs don't name their set. If we missed the EventJoin (Arena
  // restarted mid-draft), recognise the set from the cards themselves.
  if (!state.setCode && setCodeResolver) {
    try {
      const inferred = setCodeResolver(normalizedPack.map(c => c.grpId));
      if (inferred) {
        state.setCode = inferred;
        appLogger.log('parser', 'info', `Set inferred from card IDs: ${inferred}`);
      }
    } catch {}
  }

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
    packSize:    state.packSize,
    cards:       normalizedPack,
    setCode:     state.setCode,
    format:      state.format,
  });
}

/**
 * Record a pick. packNumber/pickNumber identify the pick that was made
 * (0-based); when the request didn't carry them we assume it answers the
 * pack currently on screen.
 */
function handlePick(grpId, packNumber = null, pickNumber = null) {
  const pack = packNumber ?? state.packNumber ?? 0;
  const pick = pickNumber ?? state.pickNumber ?? 0;

  // Deduplicate: only emit if this pick is strictly newer than the last one.
  // Replayed MakePick lines (from the initial scan context) must not re-fire
  // card-picked or append the same card to the pool twice.
  const pickIsNewer =
    lastEmittedPick.packNumber === null ||
    pack > lastEmittedPick.packNumber ||
    (pack === lastEmittedPick.packNumber && pick > lastEmittedPick.pickNumber);

  if (!pickIsNewer) {
    appLogger.log('parser', 'debug',
      `card-picked suppressed (stale) pack=${pack} pick=${pick} ` +
      `lastPack=${lastEmittedPick.packNumber} lastPick=${lastEmittedPick.pickNumber}`);
    return;
  }
  lastEmittedPick = { packNumber: pack, pickNumber: pick };
  state.pickedCards = [...state.pickedCards, { grpId }];

  appLogger.log('parser', 'info', `card-picked grpId=${grpId} pack=${pack} pick=${pick}`);
  console.log(`[parser] card-picked grpId=${grpId} pack=${pack} pick=${pick}`);
  emit('card-picked', {
    grpId,
    packNumber:   pack,
    pickNumber:   pick,
    pickedCards:  state.pickedCards,
  });
}

function getState() {
  return { ...state };
}

module.exports = { parseLine, reset, getState, setBroadcast, setSetCodeResolver, setGameHandler, detectFormat };
