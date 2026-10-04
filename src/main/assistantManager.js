/**
 * assistantManager.js — Ties draftTracker + signalAnalyzer together.
 * Intercepts draft events, runs analysis, broadcasts results.
 */

const draftTracker   = require('./draftTracker');
const signalAnalyzer = require('./signalAnalyzer');
const landsData      = require('./17landsData');
const settings       = require('./settings');
const setData        = require('./setData');
const deckBuilder    = require('./deckBuilder');
const appLogger      = require('./appLogger');
const draftLog       = require('./draftLog');
const gameTracker    = require('./gameTracker');
const gameAssistant  = require('./gameAssistant');

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
    manaCost:   lands?.manaCost ?? scryfall.manaCost ?? null,
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
/**
 * Card stats + archetype win rates + the per-set table derived from 17Lands'
 * public datasets (pick model, per-pair GIH WR, wheel rates) when published.
 */
async function loadSetMetrics(setCode) {
  const [cards, ratings, table] = await Promise.all([
    landsData.fetchSetData(setCode).then(r => r?.data ?? null),
    landsData.fetchColorRatings(setCode).catch(() => null),
    setData.loadSetTable(setCode).catch(() => null),
  ]);
  if (!cards) return null;
  // Live 17Lands archetype data first; the public-data table can stand in.
  const metrics = signalAnalyzer.computeSetMetrics(cards, ratings ?? (table?.pairs ? { pairs: table.pairs } : null));
  metrics.table = table;
  return metrics;
}

/** Best 40-card builds from the current pool (shown once there's enough to build). */
function suggestDecks(pool, metrics, { sealed = false, bo3 = false } = {}) {
  if (pool.length < 15) return [];
  const pairStrength = metrics?.pairs
    ? Object.fromEntries(Object.entries(metrics.pairs).map(([p, v]) => [p, v.delta ?? 0]))
    : undefined;
  const mean = metrics?.meanGihwr ?? 0.55;
  const std = metrics?.stdGihwr ?? 0.04;
  const table = metrics?.table;
  // Card value inside a given pair: archetype-specific GIH WR when we have it.
  const cardValue = (card, pair) => {
    const pg = table ? setData.pairGih(table, card.grpId, pair) : null;
    if (pg && !pg.shrunk) {
      const overall = table.cards?.[card.grpId]?.gih;
      if (card.stats?.z != null && overall != null) return card.stats.z + (pg.gih - overall) / std;
    }
    if (card.stats?.z != null) return card.stats.z;
    if (card.stats?.gihwr != null) return (card.stats.gihwr - mean) / std;
    return -0.3;
  };
  // Traditional events are best-of-three: land counts follow Bo3 data.
  const opts = { cardValue, pairStrength, format: bo3 ? 'bo3' : 'bo1', maxSuggestions: 3 };
  try {
    return sealed ? deckBuilder.buildSealed(pool, opts) : deckBuilder.buildDecks(pool, opts);
  } catch (e) {
    appLogger.log('assistant', 'warn', 'Deck builder failed', e.message);
    return [];
  }
}

function reanalyze(packCards) {
  const trackerState = draftTracker.getState();
  const state = signalAnalyzer.analyze(trackerState, packCards, currentPosition, getAssistantSettings());
  // Deck suggestions from the pool so far (full card objects, not the trimmed pick log).
  state.deckSuggestions = suggestDecks(trackerState.pickHistory.map(p => p.card ?? p), trackerState.setMetrics,
    { bo3: trackerState.format === 'TradDraft' })
    .map(slimDeck);
  broadcast(state);
}

/** Keep IPC payloads small: decks carry names/ids, not whole card objects. */
function slimDeck(d) {
  const slim = (c) => ({ grpId: c.grpId, name: c.name, color: c.color, cmc: c.cmc, typeLine: c.typeLine, grade: c.stats?.grade ?? null });
  return {
    ...d,
    main: d.main.map(slim),
    nonbasicLands: (d.nonbasicLands ?? []).map(slim),
    splash: d.splash ? { ...d.splash, cards: d.splash.cards.map(slim) } : null,
  };
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
    const ts = draftTracker.getState();
    draftLog.saveDraft({
      setCode: ts.setCode, format: ts.format, packSize: ts.packSize,
      picks: ts.pickHistory.map(p => ({ ...p, stats: undefined, oracleText: undefined })),
      deck: currentState?.deckSuggestions?.[0] ?? null,
    });
  }

  else if (channel === 'sealed-pool') {
    const { setCode, eventName, cards } = data;
    const [metrics, landsMap] = await Promise.all([loadSetMetrics(setCode), loadLandsMap(setCode)]);
    const pool = (cards ?? []).map(c => enrichOne(c.grpId, landsMap));
    const decks = suggestDecks(pool, metrics, { sealed: true, bo3: /Trad/i.test(eventName ?? '') }).map(slimDeck);
    appLogger.log('assistant', 'info', `Sealed pool ${eventName}: ${pool.length} cards, ${decks.length} builds`);
    broadcast({ ...(currentState ?? signalAnalyzer.emptyState()), sealed: { eventName, setCode, poolSize: pool.length, decks, at: Date.now() } });
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

// ─── In-game assistant ─────────────────────────────────────────────────────────

const GAME_UPDATE_MS = 250; // state messages arrive many times a second
let gameTimer = null;
let gameContext = null;     // { setCode, cardsById, table } for the deck being played
let lastGameAnalysis = null;

/** Which set's data to use: the set the deck's cards come from (Limited decks). */
async function loadGameContext(deckCards) {
  const setCode = landsData.inferSetFromGrpIds(deckCards) ?? draftTracker.getState().setCode;
  if (!setCode) return { setCode: null, cardsById: new Map(), table: null };
  if (gameContext?.setCode === setCode) return gameContext;
  const [res, table] = await Promise.all([
    landsData.fetchSetData(setCode).catch(() => null),
    setData.loadSetTable(setCode).catch(() => null),
  ]);
  const cardsById = new Map((res?.data ?? []).filter((c) => c.mtgaId != null).map((c) => [c.mtgaId, c]));
  gameContext = { setCode, cardsById, table };
  return gameContext;
}

function publishGame() {
  gameTimer = null;
  const snap = gameTracker.snapshot();
  if (!snap) return;
  const ctx = gameContext ?? { cardsById: new Map(), table: null };
  const analysis = gameAssistant.analyzeGame(snap, ctx.cardsById, ctx.table);
  // Names for the UI (the analysis carries grpIds).
  for (const t of analysis?.opponent?.threats ?? []) t.name = t.name ?? ctx.cardsById.get(t.grpId)?.name;
  lastGameAnalysis = { ...analysis, setCode: ctx.setCode, at: Date.now() };
  if (broadcastFn) broadcastFn('game-update', lastGameAnalysis);
}

/** Called by the log parser with each parsed in-game message. */
function handleGameMessage(json) {
  if (settings.get().assistant?.gameAssistant === false) return;
  if (json.matchGameRoomStateChangedEvent) {
    const st = json.matchGameRoomStateChangedEvent.gameRoomInfo?.stateType;
    if (st === 'MatchGameRoomStateType_MatchCompleted') {
      gameTracker.endMatch();
      if (broadcastFn) broadcastFn('game-update', null);
    }
    return;
  }
  const changes = gameTracker.handleGreEvent(json);
  if (!changes.length) return;
  if (changes.includes('game-start')) {
    const snap = gameTracker.snapshot();
    loadGameContext(snap?.deckCards ?? []).then(publishGame).catch((e) =>
      appLogger.log('assistant', 'warn', 'Game context load failed', e.message));
    return;
  }
  // Mulligan prompts and game end show immediately; board changes are batched.
  if (changes.includes('mulligan') || changes.includes('game-over')) {
    clearTimeout(gameTimer);
    publishGame();
  } else if (!gameTimer) {
    gameTimer = setTimeout(publishGame, GAME_UPDATE_MS);
  }
}

function getGameState() {
  return lastGameAnalysis;
}

function getState() {
  return currentState;
}

module.exports = { init, handleEvent, getState, reloadSetMetrics, handleGameMessage, getGameState };
