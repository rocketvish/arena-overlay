#!/usr/bin/env node
/**
 * curve-research.js — do curve terms beyond "two-drops" predict held-out games?
 *
 *   node --max-old-space-size=8192 tools/pipeline/curve-research.js HOB [--cache DIR]
 *
 * Pro advice (Sierkovitz's 17Lands analyses, LR's curve guidelines): what
 * matters early is mana actually spent, not a two-drop count, and gluts of
 * 4- and 5-drops cost games. Adds to the shipped deck model (VALUE_FEATURES):
 *   cmc    hinges on spells by mana value (cheap, 3, 4, 5)
 *   spent  expected mana spent on turns 1–4 (simulated from curve + lands)
 * and reports held-out log loss / AUC with a paired standard error.
 */
'use strict';

const os = require('os');
const path = require('path');
const { ensureDataset } = require('./build-set');
const { cardTable } = require('./cards');
const wm = require('./winModel');

// Hinges on nonland spell counts by mana value: [name, count(n by mv), short knots, over knots].
const CMC_HINGES = [
  ['cheap', (n) => n[1] + n[2], [5, 7, 9], []],
  ['three', (n) => n[3], [3, 5], [8]],
  ['four', (n) => n[4], [], [4, 6]],
  ['five', (n) => n[5], [], [2, 4]],
];

/**
 * Expected mana spent on turns 1–4 by a 40-card deck with n[1..4] spells of
 * each mana value and `lands` lands (Monte Carlo, memoized). Each turn: play
 * a land if one is in hand, then cast the subset of spells using the most mana.
 */
const spentMemo = new Map();
function expectedSpent(n, lands, onPlay, sims = 1500) {
  const key = `${n.join(',')}|${lands}|${onPlay}`;
  if (spentMemo.has(key)) return spentMemo.get(key);
  // Deck codes: 0 = land, 1..4 = spell of that mana value, 9 = anything else.
  const deck = [];
  for (let i = 0; i < lands; i++) deck.push(0);
  for (let c = 1; c <= 4; c++) for (let i = 0; i < n[c]; i++) deck.push(c);
  while (deck.length < 40) deck.push(9);
  let total = 0;
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let s = 0; s < sims; s++) {
    // Partial shuffle: we only need the top 11 cards.
    const d = deck.slice();
    for (let i = 0; i < 11; i++) { const j = i + Math.floor(rand() * (d.length - i)); [d[i], d[j]] = [d[j], d[i]]; }
    const hand = d.slice(0, 7);
    let next = 7, landsIn = 0;
    for (let turn = 1; turn <= 4; turn++) {
      if (turn > 1 || !onPlay) hand.push(d[next++]);
      const li = hand.indexOf(0);
      if (li >= 0) { hand.splice(li, 1); landsIn++; }
      // Best subset of castable spells (hand is small: brute force).
      const spells = hand.map((c, i) => [c, i]).filter(([c]) => c >= 1 && c <= 4 && c <= landsIn);
      let best = 0, bestMask = 0;
      for (let m = 1; m < 1 << Math.min(spells.length, 10); m++) {
        let sum = 0;
        for (let b = 0; b < spells.length && b < 10; b++) if (m & (1 << b)) sum += spells[b][0];
        if (sum <= landsIn && sum > best) { best = sum; bestMask = m; }
      }
      const drop = [];
      for (let b = 0; b < spells.length && b < 10; b++) if (bestMask & (1 << b)) drop.push(spells[b][1]);
      drop.sort((a, b) => b - a).forEach((i) => hand.splice(i, 1));
      total += best;
    }
  }
  const v = total / sims;
  spentMemo.set(key, v);
  return v;
}

async function main() {
  const set = (process.argv[2] ?? 'HOB').toUpperCase();
  const ci = process.argv.indexOf('--cache');
  const cache = ci > 0 ? process.argv[ci + 1] : path.join(os.tmpdir(), 'arena-overlay-datasets');
  const { cards, list } = await cardTable(set, cache);
  const game = await ensureDataset('game_data', set, 'PremierDraft', cache);
  let t = Date.now();
  const games = await wm.loadGames(game.file, cards);
  console.log(`${set}: ${games.won.length} games loaded in ${((Date.now() - t) / 1000).toFixed(0)}s`);

  const cmcOf = list.map((m) => m.cmc ?? null);
  const isLand = list.map((m) => /\bLand\b/.test(m.types.join(' ')) && !/\bCreature\b/.test(m.types.join(' ')));
  const onPlayOf = (g) => games.feats[g].onPlay;

  // Per game: spell counts by mana value and expected mana spent.
  t = Date.now();
  const curve = games.decks.map((d, g) => {
    const n = [0, 0, 0, 0, 0, 0, 0];
    for (let k = 0; k < d.length; k += 2) {
      if (isLand[d[k]]) continue;
      const c = cmcOf[d[k]];
      if (c == null) continue;
      n[Math.min(6, Math.max(1, Math.round(c)))] += d[k + 1];
    }
    const spent = expectedSpent([0, n[1], n[2], n[3], n[4]], games.feats[g].landsN, onPlayOf(g));
    return { n, spent };
  });
  const spents = curve.map((c) => c.spent);
  const meanSpent = spents.reduce((a, b) => a + b, 0) / spents.length;
  const sdSpent = Math.sqrt(spents.reduce((a, b) => a + (b - meanSpent) ** 2, 0) / spents.length);
  console.log(`  simulated ${spentMemo.size} curves in ${((Date.now() - t) / 1000).toFixed(0)}s; mana spent T1-4 mean ${meanSpent.toFixed(2)} sd ${sdSpent.toFixed(2)}`);

  const L0 = wm.layout(list.length);
  const base = L0.size;
  const cmcSlots = [];
  let k = base;
  for (const [name, test, short, over] of CMC_HINGES) { cmcSlots.push({ name, test, short, over, at: k }); k += short.length + over.length; }
  const spentSlot = k++;
  const spentShort = k++;   // hinge: max(0, mean - spent)
  const L = { ...L0, size: k };

  const cmcFeats = (g) => {
    const { n } = curve[g];
    const out = [];
    for (const s of cmcSlots) {
      const cnt = s.test(n);
      s.short.forEach((kn, h) => out.push([s.at + h, Math.max(0, kn - cnt)]));
      s.over.forEach((kn, h) => out.push([s.at + s.short.length + h, Math.max(0, cnt - kn)]));
    }
    return out;
  };
  const spentFeats = (g) => {
    const z = (curve[g].spent - meanSpent) / sdSpent;
    return [[spentSlot, z], [spentShort, Math.max(0, -1 - z)]];
  };

  const minimal = (g) => cmcFeats(g).filter(([i]) => i === cmcSlots[1].at + 1 || i === cmcSlots[2].at);
  const variants = [
    ['shipped model', null],
    ['+ cmc hinges', cmcFeats],
    ['+ mana spent T1-4', spentFeats],
    ['+ both', (g) => [...cmcFeats(g), ...spentFeats(g)]],
    ['+ three<5, four>4 only', minimal],
  ];
  const held = [];
  for (let g = 0; g < games.won.length; g++) if (games.heldOut[g]) held.push(g);
  let baseLoss = null;
  for (const [label, extra] of variants) {
    t = Date.now();
    const use = { ...wm.VALUE_FEATURES, ...(extra ? { extra } : {}) };
    const w = wm.train(games, L, use, { l2: wm.VALUE_L2 });
    const loss = held.map((g) => {
      const p = 1 / (1 + Math.exp(-wm.predictLogit(w, games, g, L, use)));
      return games.won[g] ? -Math.log(p) : -Math.log(1 - p);
    });
    const m = wm.heldOutMetrics(games, (g) => wm.predictLogit(w, games, g, L, use));
    let line = `  ${label.padEnd(22)} logloss ${m.logloss.toFixed(5)}  AUC ${m.auc.toFixed(4)}`;
    if (baseLoss) {
      const d = loss.map((x, i) => baseLoss[i] - x);
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      const se = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length / d.length);
      line += `  gain ${(mean * 1e5).toFixed(1)}e-5 ± ${(se * 1e5).toFixed(1)} (t=${(mean / se).toFixed(1)})`;
    } else baseLoss = loss;
    if (extra) {
      const desc = [];
      for (const s of cmcSlots) if (label.includes('cmc') || label.includes('both')) {
        s.short.forEach((kn, h) => desc.push(`${s.name}<${kn}:${(w[s.at + h] * 25).toFixed(2)}`));
        s.over.forEach((kn, h) => desc.push(`${s.name}>${kn}:${(w[s.at + s.short.length + h] * 25).toFixed(2)}`));
      }
      if (label.includes('spent') || label.includes('both')) desc.push(`spent/sd:${(w[spentSlot] * 25).toFixed(2)} short:${(w[spentShort] * 25).toFixed(2)}`);
      console.log(line);
      console.log(`    pp per unit: ${desc.join('  ')}`);
    } else console.log(line);
    console.log(`    (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });

module.exports = { expectedSpent };
