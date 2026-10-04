/**
 * draftTracker.js — Stateful draft history tracker for the assistant.
 * Records every pack seen and every card picked throughout the draft.
 * Pure data storage — no analysis logic here.
 */

let state = {
  setCode: null,
  format: null,
  // { meanGihwr: number, qualityFractions: {W,U,B,R,G}, totalCards: number }
  setMetrics: null,
  // Cards per pack (14 for current Arena boosters), learned from the log.
  packSize: null,
  // [{ packNumber, pickNumber, cards: [enrichedCard] }]
  packHistory: [],
  // [{ seqNum, packNumber, pickNumber, grpId, name, grade, color, cmc,
  //    typeLine, oracleText, recommendation, alignedWithRec }]
  pickHistory: [],
};

function reset() {
  state = {
    setCode: null, format: null, setMetrics: null, packSize: null,
    packHistory: [], pickHistory: [],
  };
}

function setInfo(setCode, format) {
  state.setCode = setCode;
  state.format = format;
}

function setSetMetrics(metrics) {
  state.setMetrics = metrics;
}

function setPackSize(size) {
  if (size) state.packSize = size;
}

/**
 * Record a pack shown to the user.
 * @param {{ packNumber: number, pickNumber: number, cards: object[] }} data
 */
function recordPackSeen({ packNumber, pickNumber, cards }) {
  state.packHistory.push({ packNumber, pickNumber, cards: cards ?? [] });
}

/**
 * Record a card pick.
 * @param {{ packNumber: number, pickNumber: number, grpId: number,
 *           enrichedCard: object|null, recommendation: object|null }} data
 */
function recordPick({ packNumber, pickNumber, grpId, enrichedCard, recommendation }) {
  const recName = recommendation?.primary?.name ?? null;
  const recId = recommendation?.primary?.grpId ?? null;
  const pickedName = enrichedCard?.name ?? `#${grpId}`;
  const alignedWithRec = !recName || pickedName === recName;

  state.pickHistory.push({
    seqNum: state.pickHistory.length + 1,
    packNumber,
    pickNumber,
    grpId,
    name: pickedName,
    grade: enrichedCard?.stats?.grade ?? null,
    // Full stats so color commitment and deck grade can weight picks by quality.
    stats: enrichedCard?.stats ?? null,
    color: enrichedCard?.color ?? '',
    rarity: enrichedCard?.rarity ?? null,
    cmc: enrichedCard?.cmc ?? null,
    manaCost: enrichedCard?.manaCost ?? null,
    typeLine: enrichedCard?.typeLine ?? '',
    oracleText: enrichedCard?.oracleText ?? '',
    recommendation: recName,
    recommendedGrpId: recId,
    alignedWithRec: recId != null ? recId === grpId : alignedWithRec,
    // What the assistant showed, for the post-draft review.
    options: (recommendation?.picks ?? []).map(p => ({ kind: p.kind, name: p.card?.name, grpId: p.card?.grpId, reason: p.reason })),
  });
}

function getState() {
  return state;
}

module.exports = { reset, setInfo, setSetMetrics, setPackSize, recordPackSeen, recordPick, getState };
