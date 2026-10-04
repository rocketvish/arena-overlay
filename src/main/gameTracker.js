/**
 * gameTracker.js — rebuild the in-game board from Arena's GRE messages.
 *
 * Arena's detailed log ("Detailed Logs (Plugin Support)" in Arena's options)
 * writes every message the game engine sends this client:
 *
 *   [UnityCrossThreadLogger]… Match to X: GreToClientEvent
 *   {"greToClientEvent":{"greToClientMessages":[ … ]}}
 *
 * Message types used here:
 *   ConnectResp        — our seat (systemSeatIds) and our 40-card deck
 *   GameStateMessage   — a Full snapshot or a Diff: zones, gameObjects,
 *                        players, turnInfo, gameInfo (stage / results)
 *   MulliganReq        — we're being asked keep or mulligan
 *
 * Only information Arena shows this client is available: our hand, public
 * zones, counts of hidden zones. The opponent's hand and both libraries stay
 * hidden — this module never infers them beyond what's public.
 */

'use strict';

const SEAT_HAND = 'ZoneType_Hand';
const LIBRARY = 'ZoneType_Library';
const BATTLEFIELD = 'ZoneType_Battlefield';
const PUBLIC_ZONES = new Set(['ZoneType_Battlefield', 'ZoneType_Graveyard', 'ZoneType_Exile', 'ZoneType_Stack', 'ZoneType_Revealed', 'ZoneType_Command']);
const LAND_SUBTYPE_COLOR = { SubType_Plains: 'W', SubType_Island: 'U', SubType_Swamp: 'B', SubType_Mountain: 'R', SubType_Forest: 'G' };

function freshGame() {
  return {
    active: false,
    matchId: null,
    gameNumber: null,
    seat: null,
    deckCards: [],
    zones: new Map(),      // zoneId → zone
    objects: new Map(),    // instanceId → gameObject
    players: new Map(),    // seat → player
    turnInfo: {},
    stage: null,
    startingPlayer: null,
    mulligan: null,        // { handSize } while we're being asked
    choosingStart: false,  // we won the die roll and choose play/draw
    result: null,          // 'win' | 'loss' | 'draw' once over
    // grpIds the opponent has shown in public zones this game
    oppSeen: new Map(),    // grpId → count (max seen at once)
    landGrpIds: new Set(), // grpIds we've seen as lands (types aren't in the deck list)
    stateId: 0,
  };
}

let game = freshGame();

function reset() {
  game = freshGame();
}

function oppSeat() {
  if (game.seat == null) return null;
  for (const s of game.players.keys()) if (s !== game.seat) return s;
  return game.seat === 1 ? 2 : 1;
}

function applyGameState(gs) {
  // Next game of a Bo3: same connection, fresh per-game facts.
  const nextGame = gs.gameInfo?.gameNumber;
  if (nextGame != null && game.gameNumber != null && nextGame !== game.gameNumber) {
    Object.assign(game, {
      zones: new Map(), objects: new Map(), turnInfo: {}, startingPlayer: null,
      mulligan: null, result: null, oppSeen: new Map(), stage: null,
    });
  }
  if (gs.type === 'GameStateType_Full') {
    game.zones.clear();
    game.objects.clear();
  }
  for (const z of gs.zones ?? []) game.zones.set(z.zoneId, z);
  for (const o of gs.gameObjects ?? []) {
    game.objects.set(o.instanceId, o);
    if (o.grpId && (o.cardTypes ?? []).includes('CardType_Land')) game.landGrpIds.add(o.grpId);
  }
  for (const id of gs.diffDeletedInstanceIds ?? []) game.objects.delete(id);
  for (const p of gs.players ?? []) game.players.set(p.systemSeatNumber, { ...(game.players.get(p.systemSeatNumber) ?? {}), ...p });
  if (gs.turnInfo) {
    game.turnInfo = { ...game.turnInfo, ...gs.turnInfo };
    if (game.startingPlayer == null && gs.turnInfo.activePlayer != null) game.startingPlayer = gs.turnInfo.activePlayer;
  }
  if (gs.gameInfo) {
    if (gs.gameInfo.matchID) game.matchId = gs.gameInfo.matchID;
    if (gs.gameInfo.gameNumber != null) game.gameNumber = gs.gameInfo.gameNumber;
    if (gs.gameInfo.stage) game.stage = gs.gameInfo.stage;
    const res = (gs.gameInfo.results ?? []).find((r) => r.scope === 'MatchScope_Game');
    if (game.stage === 'GameStage_GameOver' && res && !game.result) {
      const myTeam = game.players.get(game.seat)?.teamId ?? game.seat;
      game.result = res.result !== 'ResultType_WinLoss' ? 'draw' : res.winningTeamId === myTeam ? 'win' : 'loss';
    }
  }
  if (gs.gameStateId) game.stateId = gs.gameStateId;

  // Remember everything the opponent has shown publicly.
  const opp = oppSeat();
  const nowSeen = new Map();
  for (const o of game.objects.values()) {
    if (o.ownerSeatId !== opp || !o.grpId || o.type === 'GameObjectType_Ability') continue;
    const zone = game.zones.get(o.zoneId);
    if (!zone || !PUBLIC_ZONES.has(zone.type)) continue;
    nowSeen.set(o.grpId, (nowSeen.get(o.grpId) ?? 0) + 1);
  }
  for (const [g, n] of nowSeen) game.oppSeen.set(g, Math.max(game.oppSeen.get(g) ?? 0, n));
}

/**
 * Feed one parsed GreToClientEvent payload. Returns a list of change kinds
 * ('game-start', 'mulligan', 'state', 'game-over') so callers can decide
 * whether to re-run the assistant.
 */
function handleGreEvent(json) {
  const changes = new Set();
  for (const m of json?.greToClientEvent?.greToClientMessages ?? []) {
    switch (m.type) {
      case 'GREMessageType_ConnectResp': {
        // A new game (also each game of a Bo3 match).
        const seat = m.systemSeatIds?.[0] ?? null;
        reset();
        game.active = true;
        game.seat = seat;
        game.deckCards = (m.connectResp?.deckMessage?.deckCards ?? []).map(Number);
        changes.add('game-start');
        break;
      }
      case 'GREMessageType_GameStateMessage':
      case 'GREMessageType_QueuedGameStateMessage': {
        if (!game.active) { game.active = true; game.seat = game.seat ?? m.systemSeatIds?.[0] ?? null; }
        const before = game.result;
        applyGameState(m.gameStateMessage ?? {});
        changes.add('state');
        if (!before && game.result) changes.add('game-over');
        break;
      }
      case 'GREMessageType_ChooseStartingPlayerReq': {
        if (game.seat == null || (m.systemSeatIds ?? []).includes(game.seat)) {
          game.choosingStart = true;
          changes.add('mulligan'); // shown immediately, like the mulligan prompt
        }
        break;
      }
      case 'GREMessageType_MulliganReq': {
        if (game.seat != null && !(m.systemSeatIds ?? []).includes(game.seat)) break;
        const size = m.prompt?.parameters?.find((p) => p.parameterName === 'NumberOfCards')?.numberValue ?? 7;
        game.mulligan = { handSize: size };
        changes.add('mulligan');
        break;
      }
      default:
        break;
    }
  }
  if (game.choosingStart && game.startingPlayer != null) { game.choosingStart = false; changes.add('state'); }
  // The mulligan prompt is over once the game has a real turn.
  if (game.mulligan && game.turnInfo.turnNumber >= 1) { game.mulligan = null; changes.add('state'); }
  return [...changes];
}

/** The match is over (all games) — called on MatchGameRoomStateType_MatchCompleted. */
function endMatch() {
  game.active = false;
}

// ─── Snapshot for the assistant / UI ─────────────────────────────────────────

function objectsIn(zoneType, seat) {
  const out = [];
  for (const z of game.zones.values()) {
    if (z.type !== zoneType || (seat != null && z.ownerSeatId !== seat)) continue;
    for (const id of z.objectInstanceIds ?? []) {
      const o = game.objects.get(id);
      if (o) out.push(o);
    }
  }
  return out;
}

function zoneCount(zoneType, seat) {
  let n = 0;
  for (const z of game.zones.values()) {
    if (z.type === zoneType && z.ownerSeatId === seat) n += (z.objectInstanceIds ?? []).length;
  }
  return n;
}

const isLandObj = (o) => (o.cardTypes ?? []).includes('CardType_Land');
const slim = (o) => ({
  grpId: o.grpId, instanceId: o.instanceId,
  isLand: isLandObj(o), isCreature: (o.cardTypes ?? []).includes('CardType_Creature'),
  tapped: !!o.isTapped, power: o.power?.value ?? null, toughness: o.toughness?.value ?? null,
  colors: (o.subtypes ?? []).map((s) => LAND_SUBTYPE_COLOR[s]).filter(Boolean),
});

function snapshot() {
  if (!game.active || game.seat == null) return null;
  const me = game.seat;
  const opp = oppSeat();
  const myBattlefield = objectsIn(BATTLEFIELD, null).filter((o) => o.controllerSeatId === me).map(slim);
  const oppBattlefield = objectsIn(BATTLEFIELD, null).filter((o) => o.controllerSeatId === opp).map(slim);
  // Our cards that are no longer in the library (for draw odds).
  // Shared zones (battlefield, stack, exile) have no owner, so go by each card's owner.
  const myKnown = [];
  for (const z of game.zones.values()) {
    // Revealed/Suppressed mirror cards that are also in another zone.
    if ([LIBRARY, 'ZoneType_Sideboard', 'ZoneType_Limbo', 'ZoneType_Pending', 'ZoneType_Revealed', 'ZoneType_Suppressed'].includes(z.type)) continue;
    for (const id of z.objectInstanceIds ?? []) {
      const o = game.objects.get(id);
      if (o?.grpId && o.ownerSeatId === me && (o.type === 'GameObjectType_Card' || !o.type)) myKnown.push(o.grpId);
    }
  }
  const oppLands = oppBattlefield.filter((o) => o.isLand);
  return {
    matchId: game.matchId,
    gameNumber: game.gameNumber,
    stage: game.stage,
    turn: game.turnInfo.turnNumber ?? 0,
    phase: game.turnInfo.phase ?? null,
    step: game.turnInfo.step ?? null,
    myTurn: game.turnInfo.activePlayer === me,
    onPlay: game.startingPlayer != null ? game.startingPlayer === me : null,
    result: game.result,
    mulligan: game.mulligan,
    choosingStart: game.choosingStart,
    deckCards: game.deckCards,
    landGrpIds: [...game.landGrpIds],
    me: {
      seat: me,
      life: game.players.get(me)?.lifeTotal ?? null,
      hand: objectsIn(SEAT_HAND, me).map(slim),
      libraryCount: zoneCount(LIBRARY, me),
      battlefield: myBattlefield,
      known: myKnown,
    },
    opp: {
      seat: opp,
      life: game.players.get(opp)?.lifeTotal ?? null,
      handCount: zoneCount(SEAT_HAND, opp),
      libraryCount: zoneCount(LIBRARY, opp),
      battlefield: oppBattlefield,
      untappedLands: oppLands.filter((o) => !o.tapped).length,
      landColors: [...new Set(oppLands.flatMap((o) => o.colors))],
      seen: [...game.oppSeen.keys()],
    },
  };
}

module.exports = { handleGreEvent, endMatch, snapshot, reset };
