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
let lastHandledPackEventId = null; // Section 6C: dedupe by parser-stamped event ID

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

/**
 * Enrich a list of raw pack cards using 17Lands data + Scryfall type cache.
 * Returns enriched cards with stats attached (no stats = empty stats).
 */
async function enrichCards(rawCards, setCode, format) {
  if (!rawCards || rawCards.length === 0) return [];

  let landsMap = new Map();
  try {
    const result = await landsData.fetchSetData(setCode, format);
    if (result?.data) {
      for (const card of result.data) {
        if (card.mtgaId != null) landsMap.set(card.mtgaId, card);
      }
    }
  } catch (e) {
    appLogger.log('assistant', 'warn', 'Failed to load set data for enrichment', e.message);
  }

  return rawCards.map(c => {
    const lands = landsMap.get(c.grpId) ?? null;
    const scryfall = landsData.getScryfallCardData(c.grpId) ?? {};
    return {
      grpId:     c.grpId,
      name:      lands?.name ?? scryfall.name ?? c.name ?? `#${c.grpId}`,
      color:     lands?.color ?? scryfall.colorIdentity ?? '',
      rarity:    lands?.rarity ?? scryfall.rarity ?? 'common',
      cmc:       lands?.cmc ?? scryfall.cmc ?? null,
      typeLine:  scryfall.typeLine  ?? '',
      oracleText: scryfall.oracleText ?? '',
      stats:     lands?.stats ?? null,
    };
  });
}

/**
 * Handle an event from the log pipeline.
 * Called by the wrapped broadcastToAll in main.js.
 */
async function handleEvent(channel, data) {
  if (!isEnabled()) return;

  const assistantSettings = getAssistantSettings();

  if (channel === 'draft-started') {
    draftTracker.reset();
    draftTracker.setInfo(data.setCode, data.format);
    pendingPackCards = null;
    lastHandledPackEventId = null;

    // Load set metrics asynchronously for signal quality baseline
    const { setCode, format } = data;
    if (setCode && format) {
      landsData.fetchSetData(setCode, format).then(result => {
        if (result?.data) {
          const metrics = signalAnalyzer.computeSetMetrics(result.data);
          draftTracker.setSetMetrics(metrics);
          appLogger.log('assistant', 'info', `Set metrics loaded for ${setCode}:${format}`);
          // Re-analyze with updated metrics
          const state = signalAnalyzer.analyze(draftTracker.getState(), pendingPackCards, 0, assistantSettings);
          broadcast(state);
        }
      }).catch(e => appLogger.log('assistant', 'warn', 'Set metrics load failed', e.message));
    }

    broadcast(signalAnalyzer.emptyState());
  }

  else if (channel === 'pack-opened') {
    const { packEventId, packNumber, pickNumber, cards, setCode, format } = data;

    // Section 6C: extra guard — refuse to re-process the same packEventId.
    // Parser-level dedup is the primary defense; this catches any re-broadcast
    // that might slip past it (e.g. from testReplay or from log re-reads).
    if (packEventId && packEventId === lastHandledPackEventId) {
      appLogger.log('assistant', 'debug', `Duplicate packEventId rejected at assistant: ${packEventId}`);
      return;
    }
    lastHandledPackEventId = packEventId ?? null;

    const sc = setCode || draftTracker.getState().setCode;
    const fmt = format || draftTracker.getState().format;

    const enriched = await enrichCards(cards, sc, fmt);
    pendingPackCards = enriched;

    draftTracker.recordPackSeen({ packNumber, pickNumber, cards: enriched });

    const trackerState = draftTracker.getState();
    const state = signalAnalyzer.analyze(trackerState, enriched, pickNumber, assistantSettings);
    broadcast(state);
  }

  else if (channel === 'card-picked') {
    const { grpId, packNumber, pickNumber } = data;
    const trackerState = draftTracker.getState();

    // Look up enriched card from the current pack or from lands data
    const enrichedCard = (pendingPackCards ?? []).find(c => c.grpId === grpId)
      ?? await (async () => {
        const scryfall = landsData.getScryfallCardData(grpId) ?? {};
        const result = await landsData.fetchSetData(trackerState.setCode, trackerState.format).catch(() => null);
        const lands = result?.data ? result.data.find(c => c.mtgaId === grpId) : null;
        return {
          grpId,
          name: lands?.name ?? scryfall.name ?? `#${grpId}`,
          color: lands?.color ?? scryfall.colorIdentity ?? '',
          cmc: lands?.cmc ?? scryfall.cmc ?? null,
          rarity: lands?.rarity ?? scryfall.rarity ?? 'common',
          typeLine: scryfall.typeLine ?? '',
          oracleText: scryfall.oracleText ?? '',
          stats: lands?.stats ?? null,
        };
      })();

    draftTracker.recordPick({
      packNumber,
      pickNumber,
      grpId,
      enrichedCard,
      recommendation: currentState?.recommendation,
    });

    // Remove picked card from pending pack
    if (pendingPackCards) {
      pendingPackCards = pendingPackCards.filter(c => c.grpId !== grpId);
    }

    const updatedTrackerState = draftTracker.getState();
    const state = signalAnalyzer.analyze(updatedTrackerState, null, pickNumber, assistantSettings);
    broadcast(state);
  }

  else if (channel === 'draft-ended') {
    draftTracker.reset();
    pendingPackCards = null;
    lastHandledPackEventId = null;
    broadcast(signalAnalyzer.emptyState());
  }
}

function getState() {
  return currentState;
}

module.exports = { init, handleEvent, getState };
