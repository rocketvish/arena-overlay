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
  // [{ packNumber, pickNumber, cards: [enrichedCard] }]
  packHistory: [],
  // [{ seqNum, packNumber, pickNumber, grpId, name, grade, color, cmc,
  //    typeLine, oracleText, recommendation, alignedWithRec }]
  pickHistory: [],
};

function reset() {
  state = {
    setCode: null, format: null, setMetrics: null,
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
  const pickedName = enrichedCard?.name ?? `#${grpId}`;
  const alignedWithRec = !recName || pickedName === recName;

  state.pickHistory.push({
    seqNum: state.pickHistory.length + 1,
    packNumber,
    pickNumber,
    grpId,
    name: pickedName,
    grade: enrichedCard?.stats?.grade ?? null,
    color: enrichedCard?.color ?? '',
    cmc: enrichedCard?.cmc ?? null,
    typeLine: enrichedCard?.typeLine ?? '',
    oracleText: enrichedCard?.oracleText ?? '',
    recommendation: recName,
    alignedWithRec,
  });
}

function getState() {
  return state;
}

module.exports = { reset, setInfo, setSetMetrics, recordPackSeen, recordPick, getState };
