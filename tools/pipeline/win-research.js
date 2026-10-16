#!/usr/bin/env node
/**
 * win-research.js — does the deck win model predict held-out games?
 *
 *   node --max-old-space-size=8192 tools/pipeline/win-research.js HOB [--cache DIR]
 *
 * Fits winModel.js with growing feature sets and reports held-out log loss /
 * AUC, next to a 17Lands-style baseline (the deck's mean GIH WR).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normCardName } = require('./csv');
const { ensureDataset } = require('./build-set');
const { cardTable } = require('./cards');
const wm = require('./winModel');

async function main() {
  const set = (process.argv[2] ?? 'HOB').toUpperCase();
  const ci = process.argv.indexOf('--cache');
  const cache = ci > 0 ? process.argv[ci + 1] : path.join(os.tmpdir(), 'arena-overlay-datasets');
  const { cards, list } = await cardTable(set, cache);
  const game = await ensureDataset('game_data', set, 'PremierDraft', cache);
  let t = Date.now();
  const games = await wm.loadGames(game.file, cards);
  const nHeld = games.heldOut.filter(Boolean).length;
  console.log(`${set}: ${games.won.length} games (${nHeld} held out) loaded in ${((Date.now() - t) / 1000).toFixed(0)}s`);

  const L = wm.layout(list.length);
  const report = (label, m) => console.log(`  ${label.padEnd(44)} logloss ${m.logloss.toFixed(5)}  AUC ${m.auc.toFixed(4)}`);

  // Baseline: deck's mean GIH WR from training games (17Lands-style).
  const gihW = new Float64Array(list.length), gihN = new Float64Array(list.length);
  for (let g = 0; g < games.won.length; g++) {
    if (games.heldOut[g]) continue;
    const d = games.decks[g];
    for (let k = 0; k < d.length; k += 2) { gihW[d[k]] += games.won[g]; gihN[d[k]]++; }
  }
  const variants = [
    ['nuisance (skill, rank, play/draw)', { nuisance: true }],
    ['+ pair + structure', { nuisance: true, pair: true, structure: true }],
    ['+ cards', { nuisance: true, pair: true, structure: true, cards: true }],
    ['+ cards × pair', { nuisance: true, pair: true, structure: true, cards: true, cardPair: true }],
    ['cards × pair, no skill controls', { pair: true, structure: true, cards: true, cardPair: true }],
  ];
  const opts = JSON.parse(process.env.WM_OPTS ?? '{}');
  let nuisanceW = null;
  for (const [label, use] of variants) {
    t = Date.now();
    const w = wm.train(games, L, use, opts);
    if (!use.pair && !use.cards) nuisanceW = w;
    report(label, wm.heldOutMetrics(games, (g) => wm.predictLogit(w, games, g, L, use)));
    if (use.cardPair && use.nuisance) {
      // GIH baseline on top of the nuisance model: one fitted slope on the
      // deck's mean deck-WR (1-D logistic fit by Newton on training games).
      const meanWr = (g) => {
        const d = games.decks[g];
        let s = 0, n = 0;
        for (let k = 0; k < d.length; k += 2) if (gihN[d[k]] >= 50) { s += d[k + 1] * gihW[d[k]] / gihN[d[k]]; n += d[k + 1]; }
        return n ? s / n - 0.55 : 0;
      };
      const base = (g) => wm.predictLogit(nuisanceW, games, g, L, { nuisance: true });
      let a = 0;
      for (let it = 0; it < 20; it++) {
        let gr = 0, hs = 0;
        for (let g = 0; g < games.won.length; g++) {
          if (games.heldOut[g]) continue;
          const x = meanWr(g);
          const p = 1 / (1 + Math.exp(-(base(g) + a * x)));
          gr += (p - games.won[g]) * x; hs += p * (1 - p) * x * x;
        }
        a -= gr / hs;
      }
      report(`nuisance + deck mean GP WR (slope ${a.toFixed(1)})`, wm.heldOutMetrics(games, (g) => base(g) + a * meanWr(g)));
      // Top / bottom cards by learned value (per copy, logit).
      const vals = list.map((m, i) => [m.name, w[L.card + i], gihN[i]]).filter((x) => x[2] >= 500).sort((x, y) => y[1] - x[1]);
      console.log('    top:', vals.slice(0, 8).map(([n, v]) => `${n} ${(v * 25).toFixed(1)}pp`).join(', '));
      console.log('    bottom:', vals.slice(-5).map(([n, v]) => `${n} ${(v * 25).toFixed(1)}pp`).join(', '));
    }
    console.log(`    (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });

module.exports = { cardTable };
