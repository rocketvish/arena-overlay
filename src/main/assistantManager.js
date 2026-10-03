/**
 * assistantManager.js — Ties draftTracker + signalAnalyzer together.
 * Intercepts draft events, runs analysis, broadcasts results.
 */

const draftTracker   = require('./draftTracker');
const signalAnalyzer = require('./signalAnalyzer');
const landsData      = require('./17landsData');
const settings       = require('./settings');
const appLogger      = require('./appLogger');

let broadcastFn  = null;
let currentState = null;
let pendingPackCards = null; // enriched cards for the current pack (for recommendation)
let currentPosition = { packNumber: 0, pickNumber: 0, packSize: null };
let lastHandledPackEventId = null; // dedupe by parser-stamped event ID

function isEnabled() {
  return settings.get().assistant?.enabled !== false;
}

function getAssistantSettings() {
  return settings.get().assistant ?? {};
}

/**
 * Call once from main.js, passing the sendToWindows function.
 */
function init(broadcast) {
  broadcastFn = broadcast;
  currentState = signalAnalyzer.emptyState();
}

function broadcast(state) {
  currentState = state;
  if (broadcastFn) broadcastFn('assistant-update', state);
}

function enrichOne(grpId, landsMap) {
  const lands = landsMap.get(grpId) ?? null;
  const scryfall = landsData.getScryfallCardData(grpId) ?? {};
  return {
    grpId,
    name:       lands?.name ?? scryfall.name ?? `#${grpId}`,
    color:      lands?.color ?? scryfall.colorIdentity ?? '',
    rarity:     lands?.rarity ?? scryfall.rarity ?? 'common',
    cmc:        lands?.cmc ?? scryfall.cmc ?? null,
    typeLine:   lands?.typeLine || scryfall.typeLine || '',
    oracleText: lands?.oracleText || scryfall.oracleText || '',
    stats:      lands?.stats ?? null,
  };
}

async function loadLandsMap(setCode) {
  const map = new Map();
  if (!setCode) return map;
  try {
    const result = await landsData.fetchSetData(setCode);
    for (const card of result?.data ?? []) {
      if (card.mtgaId != null) map.set(card.mtgaId, card);
    }
  } catch (e) {
    appLogger.log('assistant', 'warn', 'Failed to load set data for enrichment', e.message);
  }
  return map;
}

/** Card stats + archetype win rates → set metrics for the analyzer. */
async function loadSetMetrics(setCode) {
  const [cards, ratings] = await Promise.all([
    landsData.fetchSetData(setCode).then(r => r?.data ?? null),
    landsData.fetchColorRatings(setCode).catch(() => null),
  ]);
  if (!cards) return null;
  return signalAnalyzer.computeSetMetrics(cards, ratings);
}

function reanalyze(packCards) {
  const state = signalAnalyzer.analyze(
    draftTracker.getState(), packCards, currentPosition, getAssistantSettings());
  broadcast(state);
}

// Events are processed strictly in arrival order. Handlers await data loads,
// and a burst of events (e.g. the initial log scan) must not interleave —
// otherwise a pick could be recorded before the pack it came from.
let queue = Promise.resolve();

/**
 * Handle an event from the log pipeline.
 * Called by the wrapped broadcastToAll in main.js.
 */
function handleEvent(channel, data) {
  const run = queue.then(() => processEvent(channel, data));
  queue = run.catch((e) => appLogger.log('assistant', 'error', `handleEvent ${channel} failed`, e.message));
  return run;
}

async function processEvent(channel, data) {
  if (!isEnabled()) return;

  if (channel === 'draft-started') {
    draftTracker.reset();
    draftTracker.setInfo(data.setCode, data.format);
    pendingPackCards = null;
    lastHandledPackEventId = null;
    currentPosition = { packNumber: 0, pickNumber: 0, packSize: null };
    broadcast(signalAnalyzer.emptyState());

    const { setCode } = data;
    if (setCode) {
      loadSetMetrics(setCode).then(metrics => {
        // Ignore if a different draft has started meanwhile.
        if (!metrics || draftTracker.getState().setCode !== setCode) return;
        draftTracker.setSetMetrics(metrics);
        appLogger.log('assistant', 'info', `Set metrics loaded for ${setCode}`, {
          pairs: metrics.pairs ? Object.keys(metrics.pairs).length : 0,
        });
        reanalyze(pendingPackCards);
      }).catch(e => appLogger.log('assistant', 'warn', 'Set metrics load failed', e.message));
    }
  }

  else if (channel === 'pack-opened') {
    const { packEventId, packNumber, pickNumber, packSize, cards, setCode } = data;

    // Refuse to re-process the same packEventId (parser-level dedup is the
    // primary defense; this catches re-broadcasts from testReplay etc.).
    if (packEventId && packEventId === lastHandledPackEventId) {
      appLogger.log('assistant', 'debug', `Duplicate packEventId rejected at assistant: ${packEventId}`);
      return;
    }
    lastHandledPackEventId = packEventId ?? null;

    const sc = setCode || draftTracker.getState().setCode;
    if (packSize) draftTracker.setPackSize(packSize);
    currentPosition = { packNumber, pickNumber, packSize: packSize ?? draftTracker.getState().packSize };

    const landsMap = await loadLandsMap(sc);
    const enriched = (cards ?? []).map(c => enrichOne(c.grpId, landsMap));
    pendingPackCards = enriched;

    draftTracker.recordPackSeen({ packNumber, pickNumber, cards: enriched });
    reanalyze(enriched);
  }

  else if (channel === 'card-picked') {
    const { grpId, packNumber, pickNumber } = data;
    const trackerState = draftTracker.getState();

    const enrichedCard = (pendingPackCards ?? []).find(c => c.grpId === grpId)
      ?? enrichOne(grpId, await loadLandsMap(trackerState.setCode));

    draftTracker.recordPick({
      packNumber,
      pickNumber,
      grpId,
      enrichedCard,
      recommendation: currentState?.recommendation,
    });

    // Remove picked card from pending pack
    if (pendingPackCards) {
      // Remove one copy only — packs can contain duplicates.
      const i = pendingPackCards.findIndex(c => c.grpId === grpId);
      if (i >= 0) pendingPackCards = [...pendingPackCards.slice(0, i), ...pendingPackCards.slice(i + 1)];
    }

    reanalyze(null);
  }

  else if (channel === 'draft-ended') {
    // Keep the final pool on screen; just stop recommending.
    pendingPackCards = null;
    lastHandledPackEventId = null;
    reanalyze(null);
  }
}

/** Re-read card + archetype data (after a manual refresh) and re-analyze. */
function reloadSetMetrics(setCode) {
  queue = queue.then(async () => {
    if (!setCode || draftTracker.getState().setCode !== setCode) return;
    const metrics = await loadSetMetrics(setCode);
    if (!metrics) return;
    draftTracker.setSetMetrics(metrics);
    reanalyze(pendingPackCards);
  }).catch((e) => appLogger.log('assistant', 'warn', 'Set metrics reload failed', e.message));
  return queue;
}

function getState() {
  return currentState;
}

module.exports = { init, handleEvent, getState, reloadSetMetrics };
