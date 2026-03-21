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
 *
 * The Payload in the new format is a JSON-encoded STRING — it must be
 * JSON.parsed a second time to get the actual draft data.
 */

const { EventEmitter } = require('events');

const emitter = new EventEmitter();

// ─── Parser state ─────────────────────────────────────────────────────────────

let state = {
  inDraft: false,
  setCode: null,
  packNumber: 0,
  pickNumber: 0,
  currentPack: [],
  pickedCards: [],
};

// Which endpoint we are currently collecting a response body for
let pendingEndpoint = null;
let pendingBuffer   = '';

// ─── Endpoint matching ────────────────────────────────────────────────────────

// Endpoints whose ==> requests or <== responses we want to parse
const DRAFT_ENDPOINT_PATTERNS = [
  'BotDraftDraftStatus',   // Quick Draft (bot) pack status
  'BotDraftDraftPick',     // Quick Draft pick + next pack (Arena 2026)
  'BotDraftMakePick',      // Quick Draft pick (older format)
  'HumanDraftDraftStatus', // Premier Draft pack status
  'HumanDraftDraftPick',   // Premier Draft pick + next pack (Arena 2026)
  'HumanDraftMakePick',    // Premier Draft pick (older format)
  'Draft/DraftStatus',     // Legacy
  'Draft/MakePick',        // Legacy
  'Ranked/MakePick',       // Legacy ranked
  'Event/DraftNotify',     // Premier Draft server push
  'Draft/CompleteDraft',   // Draft complete
];

function isDraftEndpoint(ep) {
  return DRAFT_ENDPOINT_PATTERNS.some(p => ep === p || ep.includes(p) || p.includes(ep));
}

// ─── Line matching regexes ────────────────────────────────────────────────────

// ==> request line (new format: JSON inline after endpoint name)
// [UnityCrossThreadLogger]==> BotDraftDraftStatus {"id":"...","request":"..."}
const REQ_INLINE_RE = /\[UnityCrossThreadLogger\].*==>\s*([\w/]+)\s+(\{.+)$/;

// ==> request line (old format: JSON on next line)
// [UnityCrossThreadLogger]==> Draft/DraftStatus
const REQ_MULTI_RE  = /\[UnityCrossThreadLogger\].*==>\s*([\w/]+)\s*$/;

// <== response header (new format)
// <== BotDraftDraftStatus(3b8e06eb-...)
const RES_RE = /^<==\s*([\w/]+)/;

// Timestamp / non-JSON lines to skip when buffering
const SKIP_RE = /^\[UnityCrossThreadLogger\]|^Mono |^Initialize |^GfxDevice|^Direct3D|^NullRef|^  at /;

// ─── Main parse function ──────────────────────────────────────────────────────

function reset() {
  state = {
    inDraft: false, setCode: null,
    packNumber: 0, pickNumber: 0,
    currentPack: [], pickedCards: [],
  };
  pendingEndpoint = null;
  pendingBuffer   = '';
}

function parseLine(line, win) {
  // ── ==> request (new format — inline JSON) ───────────────────────────────
  const inlineMatch = line.match(REQ_INLINE_RE);
  if (inlineMatch) {
    flushPending(win); // process any buffered <== response first

    const endpoint  = inlineMatch[1];
    const inlineRaw = inlineMatch[2];
    console.log(`[parser] ==> ${endpoint} (inline JSON)`);

    if (isDraftEndpoint(endpoint)) {
      // Extract inner request string and process immediately
      tryHandleRequest(endpoint, inlineRaw, win);
    }
    // Don't start buffering — the request body was inline
    pendingEndpoint = null;
    pendingBuffer   = '';
    return;
  }

  // ── ==> request (old format — JSON on next lines) ────────────────────────
  const multiMatch = line.match(REQ_MULTI_RE);
  if (multiMatch) {
    flushPending(win);
    const endpoint = multiMatch[1];
    console.log(`[parser] ==> ${endpoint} (multi-line)`);

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
    flushPending(win); // flush any prior response

    const endpoint = resMatch[1];
    console.log(`[parser] <== ${endpoint}`);

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
    // Skip non-JSON lines (timestamps, Unity messages, etc.)
    if (SKIP_RE.test(line) || line.trim() === '') return;

    pendingBuffer += line + '\n';

    // Try to parse as soon as we have a complete object
    if (pendingBuffer.trim().startsWith('{') || pendingBuffer.trim().startsWith('[')) {
      try {
        JSON.parse(pendingBuffer.trim()); // validate completeness
        flushPending(win);
      } catch {
        // Not complete yet — keep accumulating
      }
    }
  }
}

function flushPending(win) {
  if (!pendingEndpoint || !pendingBuffer.trim()) return;
  tryHandleResponse(pendingEndpoint, pendingBuffer.trim(), win);
  pendingEndpoint = null;
  pendingBuffer   = '';
}

// ─── Request handler (==> inline, new format) ────────────────────────────────
//
// Outer JSON: {"id":"...","request":"{...escaped inner JSON...}"}
// Inner JSON for MakePick: {"EventName":"...","GrpId":"100508","Pack":0,"Pick":0}

function tryHandleRequest(endpoint, raw, win) {
  let outer;
  try { outer = JSON.parse(raw); } catch { return; }

  // Unwrap the inner request string
  let req = outer.request || outer;
  if (typeof req === 'string') {
    try { req = JSON.parse(req); } catch { return; }
  }

  if (endpoint.includes('MakePick') || endpoint.includes('DraftPick')) {
    // Arena 2026: PickInfo.CardIds[0]
    // Older format: GrpId / CardId at top level
    const pickInfo = req.PickInfo ?? req.pickInfo;
    const cardIds = pickInfo?.CardIds ?? pickInfo?.cardIds;
    const grpId = cardIds?.length
      ? parseInt(cardIds[0])
      : parseInt(req.GrpId ?? req.grpId ?? req.CardId ?? req.cardId);
    if (!isNaN(grpId)) {
      console.log(`[parser] card-picked via request grpId=${grpId}`);
      handlePick(grpId, win);
    }
  }
}

// ─── Response handler (<== body, both formats) ───────────────────────────────
//
// New format:  {"CurrentModule":"BotDraft","Payload":"{...escaped...}"}
// Old format:  {"draftStatus":{"draftPack":[...]}} or {"method":"...","payload":{...}}

function tryHandleResponse(endpoint, raw, win) {
  let outer;
  try { outer = JSON.parse(raw); } catch (e) {
    console.warn(`[parser] JSON parse failed for ${endpoint}:`, e.message);
    return;
  }

  // ── New format: double-encoded Payload ───────────────────────────────────
  if (outer.Payload && typeof outer.Payload === 'string') {
    let inner;
    try { inner = JSON.parse(outer.Payload); } catch (e) {
      console.warn(`[parser] Payload parse failed:`, e.message);
      return;
    }
    console.log(`[parser] Response ${endpoint}: DraftStatus=${inner.DraftStatus} Pack=${inner.PackNumber} Pick=${inner.PickNumber} Cards=${inner.DraftPack?.length}`);
    handleDraftPayload(inner, win);
    return;
  }

  // ── Old DraftNotify / Event format ───────────────────────────────────────
  if (outer.method && outer.payload) {
    const p = outer.payload;
    console.log(`[parser] DraftNotify payload`);
    handleDraftPayload(p, win);
    return;
  }

  // ── Old DraftStatus format ────────────────────────────────────────────────
  if (endpoint.includes('DraftStatus') || endpoint.includes('DraftNotify')) {
    console.log(`[parser] Legacy draft status`);
    handleDraftPayload(outer.draftStatus || outer.DraftStatus || outer, win);
    return;
  }

  if (endpoint.includes('MakePick')) {
    // Pick responses sometimes re-send the updated pack
    const inner = outer.Payload ? outer : (outer.draftStatus || outer);
    handleDraftPayload(inner, win);
  }
}

// ─── Core draft payload handler ───────────────────────────────────────────────

function extractSetCode(eventName) {
  // "QuickDraft_TMT_20260313"  → "TMT"
  // "PremierDraft_TDM_20260401" → "TDM"
  // "Sealed_FIN_20260301"       → "FIN"
  if (!eventName) return null;
  const parts = eventName.split('_');
  return parts.length >= 2 ? parts[1] : null;
}

function handleDraftPayload(payload, win) {
  if (!payload) return;

  // Extract fields — support both PascalCase (new) and camelCase (old)
  const packCards   = payload.DraftPack   ?? payload.draftPack   ?? payload.PackCards ?? payload.packCards;
  const packNumber  = payload.PackNumber  ?? payload.packNumber  ?? payload.PackNum;
  const pickNumber  = payload.PickNumber  ?? payload.pickNumber  ?? payload.PickNum;
  const eventName   = payload.EventName   ?? payload.eventName;
  const draftStatus = payload.DraftStatus ?? payload.draftStatus;
  const pickedCards = payload.PickedCards ?? payload.pickedCards ?? [];
  const setCode     = extractSetCode(eventName) ?? payload.WOTCReleaseId ?? payload.setCode;

  // Only handle packs that are ready to be picked from
  if (!packCards || !Array.isArray(packCards) || packCards.length === 0) {
    console.log(`[parser] No pack cards in payload (DraftStatus=${draftStatus})`);
    return;
  }

  if (draftStatus && draftStatus !== 'PickNext') {
    console.log(`[parser] Skipping — DraftStatus=${draftStatus} (not PickNext)`);
    return;
  }

  // Normalise card list: can be string IDs, ints, or objects
  const normalizedPack = packCards.map(c => {
    if (typeof c === 'string' || typeof c === 'number') return { grpId: parseInt(c) };
    if (typeof c === 'object') return { grpId: parseInt(c.grpId ?? c.CardId ?? c.cardId ?? c.id), ...c };
    return null;
  }).filter(c => c && !isNaN(c.grpId));

  if (setCode) state.setCode = setCode;
  if (packNumber !== undefined && packNumber !== null) state.packNumber = packNumber;
  if (pickNumber !== undefined && pickNumber !== null) state.pickNumber = pickNumber;
  state.currentPack = normalizedPack;

  if (!state.inDraft) {
    state.inDraft = true;
    console.log(`[parser] draft-started setCode=${state.setCode}`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('draft-started', { setCode: state.setCode });
    }
  }

  console.log(`[parser] pack-opened pack=${state.packNumber} pick=${state.pickNumber} cards=${normalizedPack.length} set=${state.setCode}`);
  if (win && !win.isDestroyed()) {
    win.webContents.send('pack-opened', {
      packNumber:  state.packNumber,
      pickNumber:  state.pickNumber,
      cards:       normalizedPack,
      setCode:     state.setCode,
    });
  }
}

function handlePick(grpId, win) {
  state.pickedCards = [...state.pickedCards, { grpId }];
  state.pickNumber  = (state.pickNumber || 0) + 1;

  console.log(`[parser] card-picked grpId=${grpId} pickNumber=${state.pickNumber}`);
  if (win && !win.isDestroyed()) {
    win.webContents.send('card-picked', {
      grpId,
      packNumber:   state.packNumber,
      pickNumber:   state.pickNumber,
      pickedCards:  state.pickedCards,
    });
  }
}

module.exports = { parseLine, reset, emitter };
