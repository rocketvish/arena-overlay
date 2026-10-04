#!/usr/bin/env node
/**
 * test-game.js — in-game tracker + assistant tests.
 *
 * scripts/fixtures/fra-sealed-match.log.gz is one real Bo1 match from an
 * FRA Sealed event (game-engine messages only; player names/ids removed).
 *
 * Usage: node scripts/test-game.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const gameTracker = require('../src/main/gameTracker');
const ga = require('../src/main/gameAssistant');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

const lines = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'fra-sealed-match.log.gz')))
  .toString('utf-8').split('\r\n').filter((l) => l.startsWith('{'));

/** Replay the match, collecting snapshots at interesting moments. */
function replay() {
  gameTracker.reset();
  const out = { atMulligan: null, byTurn: new Map(), final: null, accountingErrors: 0, checks: 0 };
  for (const l of lines) {
    const j = JSON.parse(l);
    if (!j.greToClientEvent) continue;
    const changes = gameTracker.handleGreEvent(j);
    const s = gameTracker.snapshot();
    if (!s) continue;
    if (changes.includes('mulligan')) out.atMulligan = s;
    if (s.turn && !out.byTurn.has(s.turn)) out.byTurn.set(s.turn, s);
    if (changes.includes('game-over')) out.final = s;
    if (s.turn) {
      out.checks++;
      // Every deck card is either still in the library or seen elsewhere.
      const odds = ga.drawOdds(s, new Map());
      if (odds.tracked !== s.me.libraryCount) out.accountingErrors++;
    }
  }
  return out;
}

console.log('\nGame tracker (real match)');
const r = replay();

test('finds our seat and our 40-card deck', () => {
  assert.strictEqual(r.atMulligan.me.seat, 2);
  assert.strictEqual(r.atMulligan.deckCards.length, 40);
});

test('mulligan prompt: 7-card hand, known to be on the draw', () => {
  assert.deepStrictEqual(r.atMulligan.mulligan, { handSize: 7 });
  assert.strictEqual(r.atMulligan.me.hand.length, 7);
  assert.strictEqual(r.atMulligan.onPlay, false);
});

test('mulligan prompt clears once the game starts', () => {
  assert.strictEqual(r.byTurn.get(1).mulligan, null);
});

test('board and hidden-zone counts by turn 5', () => {
  const s = r.byTurn.get(5);
  assert.strictEqual(s.me.libraryCount + s.me.hand.length <= 40, true);
  assert.ok(s.opp.battlefield.some((o) => o.isLand), 'opponent has lands out');
  assert.deepStrictEqual(s.opp.landColors.sort(), ['G', 'R']);
  assert.ok(s.opp.seen.length > 0);
});

test('library accounting matches Arena on every update', () => {
  assert.strictEqual(r.accountingErrors, 0, `${r.accountingErrors}/${r.checks} snapshots off`);
});

test('game result is read from the final state', () => {
  assert.strictEqual(r.final.result, 'loss');
});

console.log('\nGame assistant');

test('mulligan advice compares keep-7 with mulligan-to-6 for that land count', () => {
  const table = { mulligan: { keep7: { draw: [null, [0.30, 2000], [0.515, 30000], [0.546, 80000], [0.50, 25000], [0.40, 3000], null, null], play: [] }, mull6: { draw: [0.386, 15000], play: [0.45, 15000] } } };
  const mk = (lands) => ({
    mulligan: { handSize: 7 }, onPlay: false,
    me: { hand: Array.from({ length: 7 }, (_, i) => ({ isLand: i < lands })) },
  });
  assert.strictEqual(ga.mulliganAdvice(mk(3), table).verdict, 'keep');
  assert.strictEqual(ga.mulliganAdvice(mk(1), table).verdict, 'mulligan');
  assert.strictEqual(ga.mulliganAdvice(mk(5), table).verdict, 'close'); // 40.0 vs 38.6
});

test('thin cells lean on the cross-set prior', () => {
  const table = { mulligan: { keep7: { play: [null, [0.9, 5], null, null, null, null, null, null], draw: [] }, mull6: { play: [0.45, 15000], draw: [0.39, 1] } } };
  const a = ga.mulliganAdvice({ mulligan: { handSize: 7 }, onPlay: true, me: { hand: Array.from({ length: 7 }, (_, i) => ({ isLand: i < 1 })) } }, table);
  assert.ok(a.keepWr < 0.5, `5 lucky games shouldn't say 90%: ${a.keepWr}`);
});

test('opponent read: instant-speed cards in their colors that fit open mana, most-played first', () => {
  const cards = new Map([
    [1, { mtgaId: 1, name: 'Shock', color: 'R', cmc: 1, typeLine: 'Instant', oracleText: 'Shock deals 2 damage to any target.' }],
    [2, { mtgaId: 2, name: 'Giant Growth', color: 'G', cmc: 1, typeLine: 'Instant', oracleText: 'Target creature gets +3/+3 until end of turn.' }],
    [3, { mtgaId: 3, name: 'Big Burn', color: 'R', cmc: 4, typeLine: 'Instant', oracleText: 'deals 5 damage to any target.' }],
    [4, { mtgaId: 4, name: 'Cancel', color: 'U', cmc: 3, typeLine: 'Instant', oracleText: 'Counter target spell.' }],
    [5, { mtgaId: 5, name: 'Grizzly', color: 'G', cmc: 2, typeLine: 'Creature — Bear', oracleText: '' }],
  ]);
  const table = { cards: { 1: { pairs: { RG: [0.55, 900] } }, 2: { pairs: { RG: [0.54, 3000] } }, 3: { pairs: { RG: [0.6, 5000] } }, 4: { pairs: {} } } };
  const snap = { opp: { landColors: ['R', 'G'], seen: [], untappedLands: 2 } };
  const o = ga.opponentThreats(snap, cards, table);
  assert.deepStrictEqual(o.colors, ['R', 'G']);
  assert.deepStrictEqual(o.threats.map((t) => t.name), ['Giant Growth', 'Shock']); // Big Burn costs 4; Cancel is blue; Grizzly is sorcery-speed
  assert.strictEqual(o.threats[1].kind, 'removal');
  assert.strictEqual(o.threats[0].kind, 'trick');
});

test('draw odds ignore cards that were never in the deck', () => {
  const cards = new Map([[10, { typeLine: 'Basic Land — Forest' }], [11, { typeLine: 'Creature — Elf' }]]);
  const snap = { deckCards: [10, 10, 11, 11], me: { known: [10, 99], libraryCount: 3 } };
  const d = ga.drawOdds(snap, cards);
  assert.strictEqual(d.library, 3);
  assert.strictEqual(d.lands, 1);
  assert.ok(Math.abs(d.pLand - 1 / 3) < 1e-9);
});

test('basic lands count as lands even though 17Lands does not list them', () => {
  // 20 = a basic (absent from 17Lands' list), 21 = a nonbasic seen on the battlefield, 11 = a creature.
  const cards = new Map([[11, { typeLine: 'Creature — Elf' }]]);
  const snap = { deckCards: [20, 20, 20, 21, 11, 11], landGrpIds: [21], me: { known: [], libraryCount: 6 } };
  const d = ga.drawOdds(snap, cards);
  assert.strictEqual(d.lands, 4);
  assert.strictEqual(d.creatures, 2);
});

test('play/draw: prompt appears for the die-roll winner and clears once chosen', () => {
  gameTracker.reset();
  const msg = (m) => ({ greToClientEvent: { greToClientMessages: [m] } });
  gameTracker.handleGreEvent(msg({ type: 'GREMessageType_ConnectResp', systemSeatIds: [1], connectResp: { deckMessage: { deckCards: [1, 2] } } }));
  gameTracker.handleGreEvent(msg({ type: 'GREMessageType_ChooseStartingPlayerReq', systemSeatIds: [1] }));
  assert.strictEqual(gameTracker.snapshot().choosingStart, true);
  const advice = ga.playDrawAdvice(gameTracker.snapshot(), null);
  assert.strictEqual(advice.verdict, 'play');            // every recent format favors playing first
  gameTracker.handleGreEvent(msg({ type: 'GREMessageType_GameStateMessage', systemSeatIds: [1], gameStateMessage: { type: 'GameStateType_Diff', turnInfo: { activePlayer: 1 } } }));
  assert.strictEqual(gameTracker.snapshot().choosingStart, false);
  assert.strictEqual(gameTracker.snapshot().onPlay, true);
});

test('play/draw follows the format when the data says drawing is better', () => {
  const slow = { mulligan: { keep7: { play: [[0.5, 2000]], draw: [[0.53, 2000]] }, mull6: {}, mull5: {} } };
  assert.strictEqual(ga.playDrawAdvice({ choosingStart: true }, slow).verdict, 'draw');
});

test('London mulligan: bottoming guidance when keeping fewer than 7', () => {
  const a = ga.mulliganAdvice({ mulligan: { handSize: 6 }, onPlay: true, me: { hand: Array.from({ length: 7 }, (_, i) => ({ isLand: i < 4 })) } }, null);
  assert.strictEqual(a.verdict, null);
  assert.match(a.note, /bottom 1/);
});

test('race math: turns to win unblocked and who should be the beatdown', () => {
  const r = ga.raceMath({
    me: { life: 12, battlefield: [{ isCreature: true, power: 3 }, { isCreature: true, power: 2 }, { isCreature: false, power: null }] },
    opp: { life: 14, battlefield: [{ isCreature: true, power: 2 }] },
  });
  assert.deepStrictEqual([r.myClock, r.oppClock, r.beatdown], [3, 6, 'you']);
});

console.log(failures ? `\n${failures} test(s) failed\n` : '\nAll game tests passed\n');
process.exit(failures ? 1 : 0);
