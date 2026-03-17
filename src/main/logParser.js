/**
 * MTG Arena log parser — extracts draft and game events from Player.log
 *
 * Parsing approach informed by:
 * https://github.com/bstaple1/MTGA_Draft_17Lands
 *
 * Arena logs are structured as blocks:
 *   [time] <direction> <endpoint>
 *   <JSON payload>
 *
 * Key endpoints we care about:
 *   POST /Draft/DraftStatus          → current pack contents
 *   POST /Draft/MakePick             → pick request (card chosen)
 *   POST /Event/DraftNotify          → server push: pack + picks
 *   POST /Ranked/MakePick            → ranked draft pick
 *   GET  /Event/GetCombinedRankInfo  → player info / event type
 *   POST /MatchServiceReactor/...    → game events
 */

const { EventEmitter } = require('events');

const emitter = new EventEmitter();

// Parser state
let state = {
  inDraft: false,
  setCode: null,
  packNumber: 0,
  pickNumber: 0,
  currentPack: [],
  pickedCards: [],
  currentEvent: null,
};

// Buffer for multi-line JSON accumulation
let jsonBuffer = '';
let collectingJson = false;
let currentEndpoint = '';

const DRAFT_ENDPOINTS = [
  'Draft/DraftStatus',
  'Draft/MakePick',
  'Event/DraftNotify',
  'Ranked/MakePick',
  'Draft/CompleteDraft',
];

const GAME_ENDPOINTS = [
  'Event/AIPractice',
  'MatchServiceReactor',
];

function reset() {
  state = {
    inDraft: false,
    setCode: null,
    packNumber: 0,
    pickNumber: 0,
    currentPack: [],
    pickedCards: [],
    currentEvent: null,
  };
  jsonBuffer = '';
  collectingJson = false;
  currentEndpoint = '';
}

/**
 * Detect log block headers like:
 *   [UnityCrossThreadLogger] 12:34:56 AM: ==> Draft/DraftStatus
 *   [UnityCrossThreadLogger]==> Draft/MakePick
 */
const HEADER_RE = /(?:==>|<==)\s+([\w/]+)/;
const JSON_START_RE = /^\s*[{[]/;
const JSON_END_RE = /^\s*[}\]]/;

function parseLine(line, win) {
  // Check for a new log block header
  const headerMatch = line.match(HEADER_RE);
  if (headerMatch) {
    // Process any buffered JSON first
    if (collectingJson && jsonBuffer) {
      tryParseBlock(currentEndpoint, jsonBuffer, win);
    }
    jsonBuffer = '';
    collectingJson = false;

    const endpoint = headerMatch[1];
    const relevant = DRAFT_ENDPOINTS.some(e => endpoint.includes(e)) ||
                     GAME_ENDPOINTS.some(e => endpoint.includes(e));
    if (relevant) {
      currentEndpoint = endpoint;
      collectingJson = true;
    } else {
      currentEndpoint = '';
    }
    return;
  }

  // Accumulate JSON lines
  if (collectingJson) {
    jsonBuffer += line + '\n';

    // Heuristic: try to parse once we see what looks like a complete object
    if (jsonBuffer.trim().startsWith('{') || jsonBuffer.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(jsonBuffer.trim());
        tryParseBlock(currentEndpoint, jsonBuffer, win);
        jsonBuffer = '';
        collectingJson = false;
      } catch {
        // Not complete yet, keep buffering
      }
    }
  }
}

function tryParseBlock(endpoint, raw, win) {
  let payload;
  try {
    payload = JSON.parse(raw.trim());
  } catch {
    return;
  }

  if (!payload) return;

  if (endpoint.includes('DraftStatus') || endpoint.includes('DraftNotify')) {
    handleDraftStatus(payload, win);
  } else if (endpoint.includes('MakePick')) {
    handleMakePick(payload, win);
  } else if (endpoint.includes('CompleteDraft')) {
    handleDraftComplete(win);
  }
}

function handleDraftStatus(payload, win) {
  // DraftStatus / DraftNotify payloads contain draftPack, pickedCards, packNumber, pickNumber
  // Format varies between endpoints; we try both structures

  const draftStatus = payload.draftStatus || payload.DraftStatus || payload;
  const packCards = draftStatus.draftPack || draftStatus.PackCards || draftStatus.packCards;
  const pickNum = draftStatus.pickNumber ?? draftStatus.PickNumber;
  const packNum = draftStatus.packNumber ?? draftStatus.PackNumber;
  const setCode = draftStatus.setCode || draftStatus.SetCode || draftStatus.WOTCReleaseId;
  const picks = draftStatus.pickedCards || draftStatus.PickedCards || [];

  if (!packCards || !Array.isArray(packCards) || packCards.length === 0) return;

  if (!state.inDraft) {
    state.inDraft = true;
    if (win && !win.isDestroyed()) {
      win.webContents.send('draft-started', { setCode });
    }
  }

  if (setCode) state.setCode = setCode;
  if (packNum !== undefined) state.packNumber = packNum;
  if (pickNum !== undefined) state.pickNumber = pickNum;
  state.pickedCards = picks;

  // Normalize cards: can be int IDs or objects
  const normalizedPack = packCards.map(c => {
    if (typeof c === 'number') return { grpId: c };
    if (typeof c === 'object') return { grpId: c.grpId || c.CardId || c.cardId || c.id, ...c };
    return { grpId: c };
  }).filter(c => c.grpId);

  state.currentPack = normalizedPack;

  if (win && !win.isDestroyed()) {
    win.webContents.send('pack-opened', {
      packNumber: state.packNumber,
      pickNumber: state.pickNumber,
      cards: normalizedPack,
      setCode: state.setCode,
    });
  }
}

function handleMakePick(payload, win) {
  // MakePick payload has the picked card grpId
  const grpId = payload.grpId || payload.GrpId || payload.cardId ||
                (payload.request && payload.request.grpId);

  if (grpId !== undefined) {
    state.pickedCards = [...state.pickedCards, { grpId }];
    state.pickNumber = (state.pickNumber || 0) + 1;

    if (win && !win.isDestroyed()) {
      win.webContents.send('card-picked', {
        grpId,
        packNumber: state.packNumber,
        pickNumber: state.pickNumber,
        pickedCards: state.pickedCards,
      });
    }
  }
}

function handleDraftComplete(win) {
  state.inDraft = false;
  if (win && !win.isDestroyed()) {
    win.webContents.send('draft-ended', {
      pickedCards: state.pickedCards,
      setCode: state.setCode,
    });
  }
  // Reset draft-specific state but keep set info
  state.packNumber = 0;
  state.pickNumber = 0;
  state.currentPack = [];
}

module.exports = { parseLine, reset, emitter };
