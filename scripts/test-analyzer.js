#!/usr/bin/env node
/**
 * test-analyzer.js — unit tests for grading and the recommendation engine.
 * Synthetic data only; no network.
 *
 * Usage: node scripts/test-analyzer.js
 */
'use strict';

require('./lib/electronShim');
const assert = require('assert');
const { computeGrades, buildCardData } = require('../src/main/17landsData');
const sa = require('../src/main/signalAnalyzer');

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

// ── Synthetic 17Lands set ──────────────────────────────────────────────────────
// 60 cards with GIH spread 0.50–0.62 and GP tracking GIH; a few rares with
// GIH withheld (< 500 drawn games) like 17Lands does.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const raw = [];
for (let i = 0; i < 60; i++) {
  const gih = 0.50 + 0.12 * (i / 59);
  raw.push({
    name: `Card ${i}`, mtga_id: 1000 + i, color: 'WUBRG'[i % 5], rarity: 'common', types: ['Creature - Test'],
    ever_drawn_win_rate: gih, ever_drawn_game_count: 3000,
    // GP tracks GIH with slope ≈ 1/1.64, as fitted on real FRA data.
    win_rate: 0.21 + gih * 0.61 + (rand() - 0.5) * 0.004, game_count: 6000,
    avg_seen: 4 + (59 - i) / 8, avg_pick: 3 + (59 - i) / 8,
  });
}
// Withheld-GIH rares: strong, weak, and one with too few games to judge.
raw.push({ name: 'Strong Rare', mtga_id: 2001, color: 'W', rarity: 'rare', types: ['Creature'], ever_drawn_win_rate: null, ever_drawn_game_count: 300, win_rate: 0.21 + 0.62 * 0.61, game_count: 900, avg_seen: 1.5, avg_pick: 1.4 });
raw.push({ name: 'Weak Rare',   mtga_id: 2002, color: 'U', rarity: 'rare', types: ['Creature'], ever_drawn_win_rate: null, ever_drawn_game_count: 300, win_rate: 0.21 + 0.50 * 0.61, game_count: 900, avg_seen: 6, avg_pick: 5 });
raw.push({ name: 'Unknown Rare',mtga_id: 2003, color: 'B', rarity: 'rare', types: ['Creature'], ever_drawn_win_rate: null, ever_drawn_game_count: 20,  win_rate: 0.70, game_count: 40, avg_seen: null, avg_pick: null });

const cards = buildCardData(raw);
const byName = Object.fromEntries(cards.map(c => [c.name, c]));
const metrics = sa.computeSetMetrics(cards, {
  pairs: {
    WU: { games: 9000, wins: 5400, topgames: 1000, topwins: 640, wr: 0.60, topWr: 0.64 },
    WR: { games: 9000, wins: 4680, topgames: 1000, topwins: 530, wr: 0.52, topWr: 0.53 },
    WB: { games: 9000, wins: 4950, topgames: 1000, topwins: 560, wr: 0.55, topWr: 0.56 },
    UB: { games: 9000, wins: 4950, topgames: 1000, topwins: 560, wr: 0.55, topWr: 0.56 },
  },
});

console.log('\nGrading');

test('GIH cards keep the classic z-score grade', () => {
  // Top of distribution (raw z ≈ +1.7); 3000 drawn games shrink it a little.
  assert.ok(['A', 'A-'].includes(byName['Card 59'].stats.grade), byName['Card 59'].stats.grade);
  assert.ok(['F', 'D-'].includes(byName['Card 0'].stats.grade), byName['Card 0'].stats.grade); // bottom (raw z ≈ −1.73)
  assert.strictEqual(byName['Card 30'].stats.grade, 'C+');  // middle
  assert.strictEqual(byName['Card 59'].stats.gradeEstimated, false);
});

test('a high GIH on few games is graded more cautiously than the same GIH on many', () => {
  const extra = (name, id, n) => ({ name, mtga_id: id, color: 'W', rarity: 'uncommon', types: ['Creature'],
    ever_drawn_win_rate: 0.63, ever_drawn_game_count: n, win_rate: 0.58, game_count: n * 2, avg_seen: 3, avg_pick: 3 });
  const cards = buildCardData([...raw, extra('Few', 3001, 520), extra('Many', 3002, 8000)]);
  const few = cards.find((c) => c.name === 'Few').stats, many = cards.find((c) => c.name === 'Many').stats;
  assert.ok(few.z < many.z - 0.2, `520 games z ${few.z.toFixed(2)} vs 8000 games z ${many.z.toFixed(2)}`);
  assert.strictEqual(few.gihwr, 0.63, 'the displayed GIH WR stays 17Lands\' number');
});

test('withheld-GIH cards get an estimated grade on the GIH scale', () => {
  const strong = byName['Strong Rare'].stats;
  const weak = byName['Weak Rare'].stats;
  assert.strictEqual(strong.gradeEstimated, true);
  // True GIH 62% (top of set) / 50% (bottom). With ~900 games the GP signal is
  // noisy, so estimates are pulled part-way toward the mean — but stay clearly
  // above / below average.
  assert.ok(['A', 'A-', 'B+', 'B'].includes(strong.grade), `strong rare graded ${strong.grade}`);
  assert.ok(['F', 'D-', 'D', 'D+', 'C-'].includes(weak.grade), `weak rare graded ${weak.grade}`);
  assert.ok(strong.gihwrEst > 0.585 && strong.gihwrEst < 0.62, `strong estimate ${strong.gihwrEst}`);
  assert.ok(weak.gihwrEst < 0.545 && weak.gihwrEst > 0.50, `weak estimate ${weak.gihwrEst}`);
});

test('estimates are shrunk toward the mean for small samples', () => {
  const mk = (n) => buildCardData([...raw, {
    name: 'X', mtga_id: 9, color: 'W', rarity: 'rare', ever_drawn_win_rate: null, ever_drawn_game_count: 1,
    win_rate: 0.21 + 0.66 * 0.61, game_count: n,
  }]).find(c => c.name === 'X').stats.gihwrEst;
  assert.ok(mk(150) < mk(5000), 'fewer games ⇒ estimate closer to the mean');
});

test('too few games ⇒ no grade at all', () => {
  assert.strictEqual(byName['Unknown Rare'].stats.grade, null);
});

test('no GIH anywhere (day-one set) falls back to GP grading', () => {
  const g = computeGrades(raw.map(c => ({ ...c, ever_drawn_win_rate: null })));
  assert.ok(g.filter(x => x.grade).length >= 60);
  assert.ok(g.every(x => !x.grade || x.gradeEstimated));
});

console.log('\nRecommendations');

const tracker = (over = {}) => ({ packHistory: [], pickHistory: [], setMetrics: metrics, packSize: 14, ...over });
const pick = (card) => ({ ...card, grade: card.stats.grade, grpId: card.mtgaId });
const asPack = (...names) => names.map(n => ({ ...byName[n], grpId: byName[n].mtgaId }));

test('P1p1 takes the best card regardless of color', () => {
  const a = sa.analyze(tracker(), asPack('Card 10', 'Card 59', 'Card 40'), { packNumber: 0, pickNumber: 0, packSize: 14 }, {});
  assert.strictEqual(a.recommendation.primary.name, 'Card 59');
});

test('card quality is not swamped by color fit (scale bug)', () => {
  // The v0.5 scorer took an in-color D+ over an off-color bomb at P1p7. Six
  // W/U picks; off-color A (Card 57, R) vs in-color F/D (Card 5, W).
  const picks = ['Card 55', 'Card 51', 'Card 45', 'Card 41', 'Card 35', 'Card 31']
    .map(n => pick(byName[n])); // colors alternate W,U (index%5 ∈ {0,1})
  const a = sa.analyze(tracker({ pickHistory: picks }), asPack('Card 5', 'Card 57'), { packNumber: 0, pickNumber: 6, packSize: 14 }, {});
  assert.strictEqual(a.recommendation.primary.name, 'Card 57', JSON.stringify(a.recommendation.ranking));
});

test('late in pack 3, a committed deck prefers a playable in-color card', () => {
  const picks = [];
  for (let i = 0; i < 30; i++) picks.push(pick(byName[`Card ${30 + (i % 6) * 5 - (i % 2 ? 4 : 0)}`]));
  // Colors of those picks: indices ≡ 0 or 1 mod 5 → W and U.
  const a = sa.analyze(tracker({ pickHistory: picks }), asPack('Card 45', 'Card 52'),
    { packNumber: 2, pickNumber: 11, packSize: 14 }, {});
  // Card 45 is W (in color, B), Card 52 is B (off color, B+).
  assert.strictEqual(a.recommendation.primary.name, 'Card 45', JSON.stringify(a.recommendation.ranking));
});

test('signals: a card arriving far past its ATA marks its color open', () => {
  // Card 58 (B? index 58 % 5 = 3 → R) has ATA ≈ 3.1; seeing it at pick 9 is a strong signal.
  const packs = [];
  for (let p = 1; p <= 8; p++) {
    packs.push({ packNumber: 0, pickNumber: p, cards: p === 8 ? asPack('Card 58', 'Card 10') : asPack('Card 10', 'Card 11') });
  }
  const sig = sa.computeColorSignals(packs, metrics, 4, 0);
  assert.ok(sig.R.score > 60, `R score ${sig.R.score}`);
  assert.ok(sig.R.score > sig.W.score);
  assert.match(sig.R.evidence, /Card 58/);
});

test('signals: no data ⇒ neutral, not "cut"', () => {
  const packs = [1, 2, 3, 4, 5].map(p => ({ packNumber: 0, pickNumber: p, cards: [] }));
  const sig = sa.computeColorSignals(packs, metrics, 4, 0);
  for (const c of 'WUBRG') assert.strictEqual(sig[c].score, 50);
});

test('wheel prediction uses ALSA and pack size', () => {
  const pos = { packNumber: 0, pickNumber: 1, packSize: 14 };
  const late = { stats: { alsa: 11.5 } }, early = { stats: { alsa: 3.2 } };
  assert.strictEqual(sa.wheelInfo(late, pos, 13).likely, true);   // returns at pick 10
  assert.strictEqual(sa.wheelInfo(early, pos, 13).likely, false);
  assert.strictEqual(sa.wheelInfo(late, { ...pos, pickNumber: 7 }, 7), null); // pack won't come back
});

test('archetype data steers the second color toward winning pairs', () => {
  // W committed (no clear second color). U (WU 64% top) vs R (WR 53%) cards of equal quality.
  const picks = ['Card 55', 'Card 50', 'Card 45', 'Card 40'].map(n => pick(byName[n])); // all W
  const u = { ...byName['Card 36'], grpId: 1 };   // U
  const r = { ...byName['Card 38'], grpId: 2, stats: { ...byName['Card 36'].stats } }; // R, same stats as u
  const a = sa.analyze(tracker({ pickHistory: picks }), [r, u], { packNumber: 0, pickNumber: 6, packSize: 14 }, {});
  assert.strictEqual(a.recommendation.primary.grpId, 1, JSON.stringify(a.recommendation.ranking));
  assert.strictEqual(a.archetypeStandings[0].pair, 'WU');
});

test('estimated grades are labelled as estimates in pick reasons', () => {
  const a = sa.analyze(tracker(), asPack('Strong Rare', 'Card 10'), { packNumber: 0, pickNumber: 0, packSize: 14 }, {});
  assert.strictEqual(a.recommendation.primary.name, 'Strong Rare');
  assert.match(a.recommendation.picks[0].reason, /GIH ~\d+% est\./);
});

test('deck needs use total picks, not pick-within-pack', () => {
  const picks = Array.from({ length: 20 }, (_, i) => ({ ...pick(byName[`Card ${i * 2}`]), typeLine: 'Creature', oracleText: '' }));
  // Pack 2, pick 1 — old code saw pickNumber=0 and reported no needs at all.
  const a = sa.analyze(tracker({ pickHistory: picks }), null, { packNumber: 1, pickNumber: 0, packSize: 14 }, {});
  assert.ok(a.deckNeeds.some(n => n.id === 'removal'), JSON.stringify(a.deckNeeds));
});

test('archetype win rates never mix player cohorts across pairs', () => {
  const m = sa.computeSetMetrics(cards, { pairs: {
    WU: { games: 9000, wins: 5400, topgames: 1000, topwins: 640, wr: 0.60, topWr: 0.64 },
    WR: { games: 9000, wins: 4680, topgames: 100,  topwins: 60,  wr: 0.52, topWr: 0.60 },
  } });
  assert.strictEqual(m.pairs.WU.cohort, 'all');
  assert.strictEqual(m.pairs.WU.wr, 0.60);
  assert.strictEqual(m.pairs.WR.wr, 0.52);
});

console.log('\nSet tables (public-dataset derived)');
const setData = require('../src/main/setData');

// Tiny table: two cards, 2-d model where card 1 fits pools of card 3.
const table = {
  cards: {
    1: { name: 'A', gih: 0.60, pairs: { WU: [0.66, 300] }, wheel: [0.1, 0.2, 0.4, 0.6, 0.8, 0.9] },
    2: { name: 'B', gih: 0.58, pairs: {}, wheel: [0, 0, 0, 0, 0, 0] },
  },
  model: { dim: 2, ids: [1, 2, 3], b: [0, 0.5, 0], u: [2, 0, 0, 0, 0, 0], v: [0, 0, 0, 0, 1, 0] },
};
table.modelIndex = new Map(table.model.ids.map((id, i) => [id, i]));

test('model prefers the card that fits the pool', () => {
  const empty = setData.modelScores(table, [], [1, 2]);
  assert.ok(empty.get(2) > empty.get(1), 'without a pool, the higher-bias card wins');
  const fit = setData.modelScores(table, [3, 3], [1, 2]);
  assert.ok(fit.get(1) > fit.get(2), 'with card 3 in the pool, card 1 wins');
  assert.ok(Math.abs(fit.get(1) + fit.get(2) - 1) < 1e-9);
});

test('per-pair GIH WR is shrunk toward the overall rate', () => {
  const pg = setData.pairGih(table, 1, 'WU');
  assert.ok(pg.gih > 0.60 && pg.gih < 0.66, `shrunk ${pg.gih}`);
  assert.strictEqual(setData.pairGih(table, 2, 'WU').shrunk, true);
});

test('measured wheel rates are used when present', () => {
  const w = sa.wheelInfo({ grpId: 1, stats: { alsa: 2 } }, { pickNumber: 3, packSize: 14 }, 11, table);
  assert.strictEqual(w.prob, 0.6);
  assert.strictEqual(w.measured, true);
  const fallback = sa.wheelInfo({ grpId: 99, stats: { alsa: 6 } }, { pickNumber: 0, packSize: 14 }, 14, table);
  assert.ok(Math.abs(fallback.prob - 0.5) < 0.01, `ALSA 6 at pick 1 ≈ 50% (Sierkovitz), got ${fallback.prob}`);
});

test('wheel report lists what the table took from a returning pack', () => {
  const mk = (id, color) => ({ grpId: id, name: `C${id}`, color, stats: null });
  const first = [mk(1, 'W'), mk(2, 'U'), mk(3, 'B'), mk(4, 'B'), mk(5, 'R'), mk(6, 'G'), mk(7, 'W'), mk(8, 'U'), mk(9, 'B'), mk(10, 'R'), mk(10, 'R')];
  const back = [mk(9, 'B'), mk(10, 'R')];
  const a = sa.analyze(tracker({
    packHistory: [{ packNumber: 0, pickNumber: 0, cards: first }, { packNumber: 0, pickNumber: 8, cards: back }],
    pickHistory: [{ ...mk(1, 'W'), packNumber: 0, pickNumber: 0 }],
  }), back, { packNumber: 0, pickNumber: 8, packSize: 14 }, {});
  assert.strictEqual(a.wheelReport.taken.length, 8);           // 11 cards − my pick − 2 still here
  assert.strictEqual(a.wheelReport.colorCounts.B, 2);
  assert.strictEqual(a.wheelReport.colorCounts.R, 2);           // card 5 and one copy of card 10; the other copy is still here
});

test('playables count cards you would play in your colors', () => {
  const picks = ['Card 55', 'Card 50', 'Card 45', 'Card 51', 'Card 46', 'Card 0'].map(n => ({ ...pick(byName[n]), typeLine: 'Creature' }));
  const a = sa.analyze(tracker({ pickHistory: picks }), null, { packNumber: 0, pickNumber: 6, packSize: 14 }, {});
  assert.strictEqual(a.playables.colors, 'WU');
  assert.strictEqual(a.playables.playables, 5);                // Card 0 (F) isn't playable
});

console.log('\nDeck win value');
const wv = require('../src/main/winValue');

// Synthetic set: W/U creatures and spells, an R bomb, a dual land. Future
// picks in WU are average non-creatures, so creatures run short unless drafted.
function winTable() {
  const cards = {
    101: { name: 'W Bear', color: 'W', types: ['Creature'] },
    102: { name: 'W Spell', color: 'W', types: ['Instant'] },
    103: { name: 'U Bear', color: 'U', types: ['Creature'] },
    104: { name: 'U Spell', color: 'U', types: ['Sorcery'] },
    105: { name: 'R Bomb', color: 'R', types: ['Creature'] },
    106: { name: 'Dual Land', color: '', types: ['Land'] },
  };
  const ids = [101, 102, 103, 104, 105, 106];
  const picks = 42;
  const phantom = Object.fromEntries(wv.PAIRS.map((p) => [p, {
    value: Array(picks).fill(0.0), castable: Array(picks).fill(0.6), sd: Array(picks).fill(0),
    traits: [Array(picks).fill(0), Array(picks).fill(0), Array(picks).fill(0), Array(picks).fill(0)],
  }]));
  return setData.prepare({
    cards,
    model: { dim: 1, ids, b: [0, 0, 0, 0, 0, 0], u: [0, 0, 0, 0, 0, 0], v: [0, 0, 0, 0, 0, 0] },
    value: {
      ids, w: [0.02, 0.03, 0.02, 0.03, 0.2, 0.05], traits: [1, 0, 1, 0, 1, 0],
      pairBias: Array(10).fill(0), filler: -0.05, toPct: 25, phantom,
      // Each creature short of 15 costs 0.03 log-odds.
      structure: { creatures: { short: [[15, -0.03]], over: [] } },
    },
  }, 0);
}

test('value block is loaded with the set table, and rejected when malformed', () => {
  assert.ok(winTable().valueTable, 'prepared');
  assert.strictEqual(setData.prepare({ cards: {}, value: { ids: [1], w: ['x'] } }, 0).valueTable, null);
  assert.strictEqual(setData.prepare({ cards: {}, value: { ids: [1], w: [0.1], pairBias: [0], phantom: {} } }, 0).valueTable, null);
});

test('late in a creature-light deck, a creature beats a slightly better spell', () => {
  const t = winTable();
  const pool = [102, 104, 102, 104, 102, 104, 102, 104, 102, 104, 102, 104, 102, 104, 102, 104, 102, 104, 102, 104]; // 20 WU spells
  const r = setData.winScores(t, pool, [101, 102], 38, { tau: 0.05 });
  assert.ok(r.scores.get(101) > r.scores.get(102), `creature ${r.scores.get(101)} vs spell ${r.scores.get(102)}`);
  assert.ok(r.shape.get(101) > 0, 'the creature gains through deck shape');
  assert.ok(r.needs.creatures.gain > 0, 'deck reports a creature need');
});

test('lands never take a spell slot; off-color cards fade once committed', () => {
  const t = winTable();
  const early = setData.winScores(t, [], [105, 106], 0, { tau: 0.05 });
  assert.strictEqual(early.scores.get(106), 0, 'dual land adds no spell value');
  assert.ok(early.scores.get(105) > 0, 'the bomb counts while colors are open');
  const pool = Array(16).fill(0).map((_, i) => (i % 2 ? 101 : 104)); // 8 W creatures, 8 U spells
  const late = setData.winScores(t, pool, [105, 101], 30, { tau: 0.05 });
  assert.ok(late.scores.get(101) > late.scores.get(105), 'in-color creature beats the off-color bomb late');
  assert.strictEqual(late.topPair, 'WU');
});

test('analyzer ranks by the win rule when the set table has a value block', () => {
  const t = winTable();
  const metricsWin = { ...metrics, table: t };
  const mk = (id) => ({ grpId: id, name: t.cards[id].name, color: t.cards[id].color, typeLine: t.cards[id].types.join(' '), stats: null });
  const pool = Array(20).fill(0).map((_, i) => ({ ...mk(i % 2 ? 102 : 104), packNumber: 1, pickNumber: i % 14 }));
  const a = sa.analyze({ packHistory: [], pickHistory: pool, setMetrics: metricsWin, packSize: 14 }, [mk(101), mk(102)], { packNumber: 2, pickNumber: 10, packSize: 14 }, {});
  assert.strictEqual(a.recommendation.primary.grpId, 101);
  assert.ok(a.recommendation.win.byCard[101] > a.recommendation.win.byCard[102]);
  assert.match(a.recommendation.picks[0].reason, /deck win/);
});

console.log('\nSplash, fixing, new sets');

test('a strong one-pip off-color card counts as a splash; a mediocre one does not', () => {
  const t = winTable();
  const pool = Array(16).fill(0).map((_, i) => (i % 2 ? 101 : 104)); // W creatures + U spells
  const info = new Map([
    [105, { colors: 'R', pips: { R: 1 }, z: 1.5, land: false, fixes: '' }],  // strong, one pip
  ]);
  const withSplash = setData.winScores(t, pool, [105], 30, { tau: 0.05, info });
  const without = setData.winScores(t, pool, [105], 30, { tau: 0.05 });
  assert.ok(withSplash.scores.get(105) > without.scores.get(105) + 1e-6, `${withSplash.scores.get(105)} vs ${without.scores.get(105)}`);
  const weak = new Map([[105, { colors: 'R', pips: { R: 1 }, z: 0.2, land: false, fixes: '' }]]);
  const w = setData.winScores(t, pool, [105], 30, { tau: 0.05, info: weak });
  assert.ok(Math.abs(w.scores.get(105) - without.scores.get(105)) < 1e-9, 'below B+ → no splash');
  const twoPips = new Map([[105, { colors: 'R', pips: { R: 2 }, z: 1.5, land: false, fixes: '' }]]);
  const tp = setData.winScores(t, pool, [105], 30, { tau: 0.05, info: twoPips });
  assert.ok(Math.abs(tp.scores.get(105) - without.scores.get(105)) < 1e-9, 'two off-color pips → no splash');
});

test('fixing for the splash color gains value only once there is a splash', () => {
  const t = winTable();
  const base = Array(16).fill(0).map((_, i) => (i % 2 ? 101 : 104));
  const info = new Map([
    [105, { colors: 'R', pips: { R: 1 }, z: 1.5, land: false, fixes: '' }],
    [106, { colors: '', pips: {}, z: 0, land: true, fixes: 'WR' }],
  ]);
  const splashing = setData.winScores(t, [...base, 105], [106], 30, { tau: 0.05, info });
  const notSplashing = setData.winScores(t, base, [106], 30, { tau: 0.05, info });
  assert.ok(splashing.scores.get(106) > 1e-6, `dual land with a splash: ${splashing.scores.get(106)}`);
  assert.ok(Math.abs(notSplashing.scores.get(106)) < 1e-9, `dual land without a splash: ${notSplashing.scores.get(106)}`);
});

test('a new set without a table gets a win model from the cross-set prior', () => {
  const vp = require('../src/main/valuePrior');
  const prior = require('../src/main/valuePrior.json');
  const cards = [
    { mtgaId: 1, color: 'W', typeLine: 'Creature — Bear', cmc: 2, oracleText: '', z: 1 },
    { mtgaId: 2, color: 'U', typeLine: 'Instant', cmc: 2, oracleText: 'Destroy target creature.', z: 0 },
  ];
  const value = vp.buildPriorValue(prior, cards, { WU: 0.56, WB: 0.54 }, 13);
  assert.strictEqual(value.phantom.WU.value.length, 39, 'resampled to 13-card packs');
  assert.ok(value.w[0] > value.w[1], 'better grade → more value');
  assert.strictEqual(value.traits[0] & 1, 1); assert.strictEqual(value.traits[1] & 4, 4);
  const vt = wv.prepareValue({ cards: { 1: { color: 'W', types: ['Creature'] }, 2: { color: 'U', types: ['Instant'] } }, value });
  assert.ok(vt, 'loads like a published value block');
  assert.ok(value.pairBias[0] > value.pairBias[1], 'stronger pair → bigger archetype term');
});

test('synergy lane: an archetype standout is recommended when its lane is open', () => {
  const t = winTable();
  // U Spell plays much better in WU than overall (17Lands per-pair GIH).
  t.cards[104] = { ...t.cards[104], gih: 0.54, pairs: { WU: [0.60, 900] } };
  t.cards[102] = { ...t.cards[102], gih: 0.56 };
  const metricsWin = { ...metrics, table: t };
  const mk = (id, z) => ({ grpId: id, name: t.cards[id].name, color: t.cards[id].color, typeLine: t.cards[id].types.join(' '), stats: { z, grade: 'C' } });
  const pool = Array(10).fill(0).map((_, i) => ({ ...mk(i % 2 ? 101 : 103, 0), packNumber: 0, pickNumber: i }));
  const a = sa.analyze({ packHistory: [], pickHistory: pool, setMetrics: metricsWin, packSize: 14 }, [mk(102, 0.5), mk(104, -0.3)], { packNumber: 0, pickNumber: 10, packSize: 14 }, {});
  const syn = a.recommendation.picks.find((p) => p.kind === 'synergy' || p.synergy);
  assert.ok(syn, JSON.stringify(a.recommendation.picks.map((p) => [p.kind, p.card.name])));
  assert.strictEqual(syn.card.grpId, 104);
  assert.match(syn.reason, /Synergy for WU/);
});

test('situational cards are flagged, not re-ranked', () => {
  const t = winTable();
  // W Spell: maindecked in 12% of on-color decks vs 80% for cards this good.
  t.cards[102] = { ...t.cards[102], incl: [0.12, 0.8, 900] };
  t.cards[101] = { ...t.cards[101], incl: [0.75, 0.8, 900] };
  const mk = (id, z) => ({ grpId: id, name: t.cards[id].name, color: t.cards[id].color, typeLine: t.cards[id].types.join(' '), stats: { z, grade: 'C' } });
  const run = (table) => sa.analyze({ packHistory: [], pickHistory: [], setMetrics: { ...metrics, table }, packSize: 14 }, [mk(101, 0), mk(102, 0)], { packNumber: 0, pickNumber: 3, packSize: 14 }, {});
  const a = run(t);
  const flagged = a.recommendation.picks.filter((p) => p.situational).map((p) => p.card.grpId);
  assert.deepStrictEqual(flagged, [102]);
  assert.match(a.recommendation.picks.find((p) => p.card.grpId === 102).reason, /Situational: maindecked in 12%/);
  assert.strictEqual(a.recommendation.primary.grpId, run(winTable()).recommendation.primary.grpId, 'ranking unchanged');
});

console.log('\nPack 2 forecast');

test("what the left side took in pack 1 counts against that color in pack 2", () => {
  const mk = (id, color) => ({ grpId: id, name: `C${id}`, color, stats: null });
  // Pack-1 pick-1 pack: lots of black; when it wheels, the black is gone.
  const first = [mk(1, 'W'), mk(2, 'B'), mk(3, 'B'), mk(4, 'B'), mk(5, 'B'), mk(6, 'U'), mk(7, 'U'), mk(8, 'G'), mk(9, 'R'), mk(10, 'W'), mk(11, 'G'), mk(12, 'R')];
  const back = [mk(6, 'U'), mk(7, 'U'), mk(8, 'G')];
  const pack2 = [{ packNumber: 1, pickNumber: 1, cards: [mk(20, 'W'), mk(21, 'U')] }];
  const history = [{ packNumber: 0, pickNumber: 0, cards: first }, { packNumber: 0, pickNumber: 8, cards: back }, ...pack2];
  const picks = [{ ...mk(1, 'W'), packNumber: 0, pickNumber: 0 }];
  const withLeft = sa.computeColorSignals(history, metrics, 1, 1, picks);
  const without = sa.computeColorSignals(history, metrics, 1, 1, null);
  assert.ok(withLeft.B.score < without.B.score, `B ${withLeft.B.score} vs ${without.B.score}`);
  assert.match(withLeft.B.evidence, /left side took/);
});

console.log('\nQuick Draft bots');

test('bot profile: per-color shift in last-seen pick vs Premier', () => {
  const cards = [];
  for (let i = 0; i < 10; i++) {
    cards.push({ mtgaId: 500 + i, color: 'U', stats: { alsa: 5 } });
    cards.push({ mtgaId: 600 + i, color: 'G', stats: { alsa: 5 } });
  }
  const quick = { cards: Object.fromEntries(cards.map((c) => [c.mtgaId, { ata: 4, alsa: c.color === 'U' ? 6 : 4.5, picks: 500 }])) };
  const bots = sa.computeBotProfile(cards, quick);
  assert.strictEqual(bots.colorShift.U, 1);
  assert.strictEqual(bots.colorShift.G, -0.5);
  assert.strictEqual(bots.colorShift.W, 0, 'too few cards → no claim');
  const shift = sa.pairPickShift(bots);
  assert.strictEqual(shift[wv.PAIRS.indexOf('UG')], 0.25);
  // Wheel odds follow the bots' last-seen position, not Premier wheel rates.
  const w = sa.wheelInfo({ grpId: 500, stats: { alsa: 2 } }, { pickNumber: 0, packSize: 14 }, 14, table, bots);
  assert.strictEqual(w.measured, false);
  assert.strictEqual(w.alsa, 6);
});

test('win model: a pair the bots under-draft projects a better deck', () => {
  const t = winTable();
  const plain = setData.winScores(t, [101], [102], 1, { tau: 0.05 });
  const shift = wv.PAIRS.map((p) => (p === 'WU' ? 2 : 0));
  // Make later phantom picks worse so shifting toward earlier picks matters.
  for (const ph of t.valueTable.phantom) ph.value.forEach((_, i) => { ph.value[i] = -0.002 * (i % 14); });
  const flat = setData.winScores(t, [101], [102], 1, { tau: 0.05 });
  const biased = setData.winScores(t, [101], [102], 1, { tau: 0.05, pickShift: shift });
  assert.ok(plain && flat && biased);
  assert.ok(biased.pairProbs.WU > flat.pairProbs.WU, `${biased.pairProbs.WU} vs ${flat.pairProbs.WU}`);
});

console.log(failures ? `\n${failures} test(s) failed\n` : '\nAll analyzer tests passed\n');
process.exit(failures ? 1 : 0);
