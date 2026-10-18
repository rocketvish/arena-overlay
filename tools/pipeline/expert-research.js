#!/usr/bin/env node
/**
 * expert-research.js — three expert ideas tested on the deck win model.
 *
 *   node --max-old-space-size=12000 tools/pipeline/expert-research.js HOB [--cache DIR]
 *
 *   skill   card × player skill: some cards gain much more in skilled hands
 *           (17Lands "Learning from the Best"), so a card's value depends on
 *           who plays it. One shrunk slope per card on the skill bucket.
 *   shape   deck shape by color pair: fast pairs need two-drops and
 *           creatures more than slow ones (Sierkovitz, "Finding Plans").
 *           Per-pair copies of the shape hinges, shrunk.
 *   splash  splash × fixing: does a splash do better with sources for its
 *           color? Splash indicators by fixer count (0, 1, 2, 3+) for the
 *           splash color, next to the app's rule (SPLASH in winValue.js).
 *
 * Each variant is the shipped model (VALUE_FEATURES) plus its terms, trained
 * with the same seed; held-out log loss is compared game by game.
 */
'use strict';

const os = require('os');
const path = require('path');
const { normCardName } = require('./csv');
const { ensureDataset } = require('./build-set');
const { cardTable } = require('./cards');
const wm = require('./winModel');

const SEED = 7;

async function main() {
  const set = (process.argv[2] ?? 'HOB').toUpperCase();
  const ci = process.argv.indexOf('--cache');
  const cache = ci > 0 ? process.argv[ci + 1] : path.join(os.tmpdir(), 'arena-overlay-datasets');
  const { cards, list } = await cardTable(set, cache);
  const game = await ensureDataset('game_data', set, 'PremierDraft', cache);
  const games = await wm.loadGames(game.file, cards);
  const N = games.won.length;
  const L0 = wm.layout(list.length);
  let k = L0.size;

  // card × skill
  const skills = games.feats.map((f) => f.skill);
  const sm = skills.reduce((a, b) => a + b, 0) / N;
  const ssd = Math.sqrt(skills.reduce((a, b) => a + (b - sm) ** 2, 0) / N);
  const cardSkill = k; k += list.length;
  const skillFeats = (g) => {
    const s = (skills[g] - sm) / ssd;
    const d = games.decks[g], out = [];
    for (let j = 0; j < d.length; j += 2) out.push([cardSkill + d[j], d[j + 1] * s]);
    return out;
  };

  // per-pair shape hinges
  const H = games.feats[0].shape.reduce((a, h) => a + h.length, 0);
  const pairShape = k; k += wm.PAIRS.length * H;
  const shapeFeats = (g) => {
    const p = games.pair[g];
    if (p < 0) return [];
    const out = [];
    let h = 0;
    for (const arr of games.feats[g].shape) for (const x of arr) { if (x) out.push([pairShape + p * H + h, x]); h++; }
    return out;
  };

  // splash × fixers for the splash color
  const fixesOf = list.map((m) => cards.get(normCardName(m.name))?.fixes ?? '');
  const splashFix = k; k += 4;
  const fixerCount = (g) => {
    const sc = games.feats[g].splashColors;
    if (!sc) return -1;
    const d = games.decks[g];
    let n = 0;
    for (let j = 0; j < d.length; j += 2) if ([...sc].some((c) => fixesOf[d[j]].includes(c))) n += d[j + 1];
    return n;
  };
  const fixers = games.feats.map((_, g) => fixerCount(g));
  const splashFeats = (g) => (fixers[g] < 0 ? [] : [[splashFix + Math.min(3, fixers[g]), 1]]);

  const L = { ...L0, size: k };
  // Interaction terms (indices ≥ L.cardPair) get the strong pair penalty.
  const held = [];
  for (let g = 0; g < N; g++) if (games.heldOut[g]) held.push(g);
  const fit = (extra) => {
    const use = { ...wm.VALUE_FEATURES, ...(extra ? { extra } : {}) };
    const w = wm.train(games, L, use, { l2: wm.VALUE_L2, seed: SEED });
    const loss = held.map((g) => {
      const p = 1 / (1 + Math.exp(-wm.predictLogit(w, games, g, L, use)));
      return games.won[g] ? -Math.log(p) : -Math.log(1 - p);
    });
    return { w, loss, m: wm.heldOutMetrics(games, (g) => wm.predictLogit(w, games, g, L, use)) };
  };
  const base = fit(null);
  console.log(`${set}: ${N} games, ${held.length} held out; shipped model logloss ${base.m.logloss.toFixed(5)} AUC ${base.m.auc.toFixed(4)}`);
  const compare = (label, r) => {
    const d = r.loss.map((x, i) => base.loss[i] - x);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const se = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length / d.length);
    console.log(`  ${label.padEnd(16)} logloss ${r.m.logloss.toFixed(5)} AUC ${r.m.auc.toFixed(4)}  gain ${(mean * 1e5).toFixed(1)}e-5 ± ${(se * 1e5).toFixed(1)} (t=${(mean / se).toFixed(1)})`);
  };

  const sk = fit(skillFeats);
  compare('+ card × skill', sk);
  const slopes = list.map((m, i) => [m.name, sk.w[cardSkill + i]]).sort((a, b) => b[1] - a[1]);
  console.log(`    most skill-rewarding (pp per skill SD): ${slopes.slice(0, 6).map(([n, v]) => `${n} ${(v * 25).toFixed(2)}`).join(', ')}`);
  console.log(`    least: ${slopes.slice(-4).map(([n, v]) => `${n} ${(v * 25).toFixed(2)}`).join(', ')}`);

  const sh = fit(shapeFeats);
  compare('+ shape by pair', sh);
  // Global hinge h → its slot in the base layout, and a label.
  const hinge = Object.entries(wm.STRUCTURE).flatMap(([nm, st]) => [
    ...st.short.map((x, j) => ({ label: `${nm}<${x}`, at: L0[nm] + j })),
    ...st.over.map((x, j) => ({ label: `${nm}>${x}`, at: L0[nm] + st.short.length + j })),
  ]);
  hinge.forEach((hg, h) => {
    if (!['creatures<15', 'creatures<13', 'twoDrops<4', 'twoDrops<2', 'topEnd>2'].includes(hg.label)) return;
    const bw = sh.w[hg.at];
    console.log(`    ${hg.label.padEnd(12)} pp per card: all ${(bw * 25).toFixed(2)} | ${wm.PAIRS.map((pr, pi) => `${pr} ${((bw + sh.w[pairShape + pi * H + h]) * 25).toFixed(2)}`).join(' ')}`);
  });

  const sp = fit(splashFeats);
  compare('+ splash × fixers', sp);
  const nBy = [0, 0, 0, 0];
  for (const f of fixers) if (f >= 0) nBy[Math.min(3, f)]++;
  console.log(`    splash decks: ${(100 * fixers.filter((f) => f >= 0).length / N).toFixed(1)}% of games; base splash ${(sp.w[L0.splash] * 25).toFixed(2)}pp; by fixers ${[0, 1, 2, 3].map((j) => `${j}${j === 3 ? '+' : ''}: ${((sp.w[L0.splash] + sp.w[splashFix + j]) * 25).toFixed(2)}pp (${nBy[j]} games)`).join(', ')}`);

  const all = fit((g) => [...skillFeats(g), ...shapeFeats(g), ...splashFeats(g)]);
  compare('+ all three', all);
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });
