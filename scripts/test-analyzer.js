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
  assert.strictEqual(byName['Card 59'].stats.grade, 'A');   // top of distribution (z ≈ +1.7)
  assert.strictEqual(byName['Card 0'].stats.grade, 'F');    // bottom (z ≈ −1.73, below the D- band)
  assert.strictEqual(byName['Card 30'].stats.grade, 'C+');  // middle
  assert.strictEqual(byName['Card 59'].stats.gradeEstimated, false);
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
  assert.match(a.recommendation.picks[0].reason, /~[AB][+-]?, est/);
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

console.log(failures ? `\n${failures} test(s) failed\n` : '\nAll analyzer tests passed\n');
process.exit(failures ? 1 : 0);
