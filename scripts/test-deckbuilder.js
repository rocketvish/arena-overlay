#!/usr/bin/env node
/**
 * test-deckbuilder.js — unit tests for the deck builder.
 * Synthetic pools only; no network, no Electron.
 *
 * Usage: node scripts/test-deckbuilder.js
 */
'use strict';

const assert = require('assert');
const db = require('../src/main/deckBuilder');

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

// ── Synthetic cards ────────────────────────────────────────────────────────────

let nextId = 1;
/** Card with an auto-generated cost: `pips` copies of each color letter plus generic. */
function card({ name, color = '', cmc = 3, pips = 1, z = 0, type = 'Creature — Test', text = '', manaCost }) {
  const id = nextId++;
  const colored = color.split('').map(c => `{${c}}`.repeat(pips)).join('');
  const generic = cmc - pips * color.length;
  const cost = manaCost !== undefined ? manaCost : (generic > 0 ? `{${generic}}` : '') + colored;
  return {
    grpId: id, name: name ?? `Card ${id}`, color, rarity: 'common', cmc, manaCost: cost,
    typeLine: type, oracleText: text, stats: z == null ? null : { z },
  };
}
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const removal = (o) => card({ type: 'Instant', text: 'Destroy target creature.', ...o });
const land = (name, text, z = 0) => card({ name, cmc: 0, type: 'Land', text, manaCost: '', z });

/** A pool that is clearly best in UB with a normal (17-land) curve. */
function ubPool() {
  const cmcs = [2, 2, 2, 3, 3, 3, 4, 4, 5, 5, 3, 4, 6];
  return [
    ...many(13, i => card({ color: 'U', cmc: cmcs[i], pips: i % 3 === 0 ? 2 : 1, z: 0.6 })),
    ...many(8, i => card({ color: 'B', cmc: cmcs[i + 3], z: 0.5 })),
    ...many(3, i => removal({ color: 'B', cmc: 2 + i, z: 0.8 })),
    ...many(8, i => card({ color: 'W', cmc: 2 + (i % 4), z: -0.5 })),
    ...many(8, i => card({ color: 'R', cmc: 2 + (i % 4), z: -0.6 })),
    ...many(8, i => card({ color: 'G', cmc: 2 + (i % 4), z: -0.6 })),
  ];
}

console.log('\npipsOf');

test('plain, hybrid, phyrexian and colorless symbols', () => {
  assert.deepStrictEqual(db.pipsOf({ manaCost: '{1}{W}{W}' }), { W: 2, U: 0, B: 0, R: 0, G: 0 });
  assert.deepStrictEqual(db.pipsOf({ manaCost: '{W/U}{W/U}' }), { W: 1, U: 1, B: 0, R: 0, G: 0 });
  assert.deepStrictEqual(db.pipsOf({ manaCost: '{2}{B/P}' }), { W: 0, U: 0, B: 1, R: 0, G: 0 });
  assert.deepStrictEqual(db.pipsOf({ manaCost: '{X}{C}{S}{3}' }), { W: 0, U: 0, B: 0, R: 0, G: 0 });
  assert.deepStrictEqual(db.pipsOf({ manaCost: '{2/G}' }), { W: 0, U: 0, B: 0, R: 0, G: 0.5 });
});

test('missing manaCost falls back to the color identity', () => {
  assert.deepStrictEqual(db.pipsOf({ color: 'BR' }), { W: 0, U: 0, B: 1, R: 1, G: 0 });
  assert.deepStrictEqual(db.pipsOf({ color: '' }), { W: 0, U: 0, B: 0, R: 0, G: 0 });
});

console.log('\nbuildDecks');

test('a pool strongest in UB builds UB: 23 spells + 17 lands, basics by pips', () => {
  const [top] = db.buildDecks(ubPool());
  assert.strictEqual(top.colors, 'UB', JSON.stringify(top.reasons));
  assert.strictEqual(top.splash, null);
  assert.strictEqual(top.main.length, 23);
  assert.strictEqual(top.lands.total, 17);
  assert.strictEqual(top.main.length + top.lands.total, 40);
  const b = top.lands.basics;
  assert.strictEqual((b.U ?? 0) + (b.B ?? 0), 17, JSON.stringify(b));
  assert.ok(b.U > b.B, `blue has more pips, so more Islands: ${JSON.stringify(b)}`);
  assert.ok(b.B >= 6, 'second color keeps at least 6 sources');
  assert.ok(top.main.every(c => /^[UB]*$/.test(c.color)));
  assert.strictEqual(top.stats.removal, 3);
});

test('a low-curve aggro pool plays 16 lands in Bo1 (17 in Bo3)', () => {
  const pool = [
    ...many(14, i => card({ color: 'R', cmc: 1 + (i % 3), z: 0.5 })),
    ...many(12, i => card({ color: 'W', cmc: 1 + (i % 3), z: 0.4 })),
    ...many(6, i => card({ color: 'G', cmc: 4, z: -0.8 })),
  ];
  const [bo1] = db.buildDecks(pool);
  assert.strictEqual(bo1.colors, 'WR');
  assert.strictEqual(bo1.lands.total, 16);
  assert.strictEqual(bo1.main.length, 24);
  const [bo3] = db.buildDecks(pool.map(c => ({ ...c, cmc: c.cmc + 1, manaCost: null })), { format: 'bo3' });
  assert.strictEqual(bo3.lands.total, 17, `avg ${bo3.stats.avgCmc}`);
});

test('colorless artifacts are castable in any pair', () => {
  const golems = many(3, i => card({ name: `Golem ${i}`, color: '', cmc: 3, z: 1.0, type: 'Artifact Creature — Golem' }));
  const [top] = db.buildDecks([...ubPool(), ...golems]);
  for (const g of golems) assert.ok(top.main.includes(g), `${g.name} missing`);
});

test('basic lands in the pool are never selected', () => {
  const basics = many(5, () => card({ name: 'Island', type: 'Basic Land — Island', cmc: 0, manaCost: '', z: 3 }));
  const [top] = db.buildDecks([...ubPool(), ...basics]);
  assert.ok(top.main.every(c => c.name !== 'Island'));
  assert.ok(top.nonbasicLands.every(c => c.name !== 'Island'));
});

test('splashes a single-pip bomb with 2 duals + a fixer', () => {
  const bomb = card({ name: 'Red Dragon', color: 'R', cmc: 5, z: 2.5 });
  const fixers = [
    land('Volcanic Isle', '{T}: Add {U} or {R}.'),
    land('Sulfurous Mire', '{T}: Add {B} or {R}.'),
    card({ name: 'Prism', color: '', cmc: 2, z: -0.2, type: 'Artifact', text: '{T}: Add one mana of any color.' }),
  ];
  const [top] = db.buildDecks([...ubPool(), bomb, ...fixers]);
  assert.strictEqual(top.colors, 'UB');
  assert.ok(top.splash, `expected a splash: ${JSON.stringify(top.reasons)}`);
  assert.strictEqual(top.splash.color, 'R');
  assert.deepStrictEqual(top.splash.cards.map(c => c.name), ['Red Dragon']);
  assert.ok(top.splash.sources >= 3);
  assert.ok(top.splash.castOdds > 0.7 && top.splash.castOdds < 0.8, `castOdds ${top.splash.castOdds}`);
  assert.ok(top.main.includes(bomb));
  assert.strictEqual(top.nonbasicLands.length, 2);
  assert.strictEqual(top.main.length + top.lands.total, 40);
  const basicCount = Object.values(top.lands.basics).reduce((a, b) => a + b, 0);
  assert.strictEqual(basicCount + top.nonbasicLands.length, top.lands.total);
});

test('does not splash a double-pip off-color card', () => {
  const bomb = card({ name: 'Red Dragon', color: 'R', cmc: 5, pips: 2, z: 2.5 });
  const fixers = [
    land('Volcanic Isle', '{T}: Add {U} or {R}.'),
    land('Sulfurous Mire', '{T}: Add {B} or {R}.'),
    card({ name: 'Prism', color: '', cmc: 2, z: -0.2, type: 'Artifact', text: '{T}: Add one mana of any color.' }),
  ];
  const decks = db.buildDecks([...ubPool(), bomb, ...fixers]);
  assert.strictEqual(decks[0].colors, 'UB');
  assert.strictEqual(decks[0].splash, null);
  assert.ok(decks.every(d => !d.splash), JSON.stringify(decks.map(d => d.splash)));
});

test('basics-only splash needs a true bomb, and says so', () => {
  const good = card({ name: 'Good Red Card', color: 'R', cmc: 5, z: 2.0 });
  assert.strictEqual(db.buildDecks([...ubPool(), good])[0].splash, null);
  const bomb = card({ name: 'Huge Bomb', color: 'R', cmc: 5, z: 3.5 });
  const [top] = db.buildDecks([...ubPool(), bomb]);
  assert.strictEqual(top.splash?.color, 'R', JSON.stringify(top.reasons));
  assert.strictEqual(top.lands.basics.R, 3);
  assert.ok(top.warnings.some(w => /basic lands only/.test(w)));
});

test('empty pool → no suggestions', () => {
  assert.deepStrictEqual(db.buildDecks([]), []);
  assert.deepStrictEqual(db.buildSealed(null), []);
});

test('a weak pool warns about playables', () => {
  const pool = ['W', 'U', 'B', 'R', 'G'].flatMap(c => [
    ...many(5, i => card({ color: c, cmc: 2 + (i % 4), z: 0 })),
    ...many(7, i => card({ color: c, cmc: 2 + (i % 4), z: -1.6 })),
  ]);
  const [top] = db.buildDecks(pool);
  assert.ok(top.warnings.some(w => /Only 10 playables/.test(w)), JSON.stringify(top.warnings));
  assert.strictEqual(top.main.length + top.lands.total, 40);
});

test('pairStrength breaks a near-tie between pairs', () => {
  const pool = ['W', 'U', 'B'].flatMap(c => many(12, i => i < 2
    ? removal({ color: c, cmc: 2 + i, z: 0.3 })
    : card({ color: c, cmc: 2 + (i % 4), z: 0.3 })));
  const plain = db.buildDecks(pool);
  assert.ok(Math.abs(plain[0].score - plain[2].score) < 1e-9, 'symmetric pool ties three ways');
  assert.strictEqual(db.buildDecks(pool, { pairStrength: { UB: 0.02, WU: -0.01 } })[0].colors, 'UB');
  // 17Lands may key pairs in either order.
  assert.strictEqual(db.buildDecks(pool, { pairStrength: { BW: 0.02 } })[0].colors, 'WB');
});

test('castOdds follows the hypergeometric', () => {
  assert.ok(Math.abs(db.castOdds(3) - (1 - (26 * 25 * 24) / (40 * 39 * 38))) < 1e-9);
  assert.strictEqual(db.castOdds(0), 0);
});

console.log('\nbuildSealed');

test('tags variants and offers an aggro build of the best pair when possible', () => {
  const pool = [
    ...many(16, i => card({ color: 'R', cmc: 1 + (i % 3), z: 0.3 })),
    ...many(14, i => card({ color: 'W', cmc: 1 + (i % 3), z: 0.3 })),
    ...many(10, i => card({ color: i % 2 ? 'R' : 'W', cmc: 5 + (i % 2), z: 0.5 })),
    ...many(8, i => card({ color: 'G', cmc: 3, z: -0.5 })),
  ];
  const decks = db.buildSealed(pool);
  assert.strictEqual(decks[0].variant, 'standard');
  assert.strictEqual(decks[0].colors, 'WR');
  const aggro = decks.find(d => d.variant === 'aggro');
  assert.ok(aggro, JSON.stringify(decks.map(d => [d.colors, d.variant, d.lands.total])));
  assert.strictEqual(aggro.colors, 'WR');
  assert.strictEqual(aggro.lands.total, 16);
  assert.ok(aggro.stats.avgCmc < decks[0].stats.avgCmc);
});

console.log(failures ? `\n${failures} test(s) failed\n` : '\nAll deck builder tests passed\n');
process.exit(failures ? 1 : 0);
