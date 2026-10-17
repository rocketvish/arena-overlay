#!/usr/bin/env node
/**
 * dup-research.js — is a 2nd / 3rd copy of a card worth less than the 1st?
 *
 *   node --max-old-space-size=8192 tools/pipeline/dup-research.js HOB
 *
 * Adds to the deck win model (winModel.js) features counting, per deck, the
 * cards present in ≥ 2 and ≥ 3 copies — split by card quality (17Lands GIH
 * z below / above `split`) and legendary 2nd copies. Their coefficients are
 * the change in value of that extra copy relative to the card's average
 * per-copy value. Fitted on two halves of the games to show stability.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normCardName } = require('./csv');
const { ensureDataset } = require('./build-set');
const { cardTable } = require('./cards');
const { tableZ } = require('../../src/main/valuePrior');
const wm = require('./winModel');

const NAMES = ['2nd copy, z < split', '2nd copy, z ≥ split', '3rd+ copy, z < split', '3rd+ copy, z ≥ split', '2nd copy of a legendary'];

async function main() {
  const set = (process.argv[2] ?? 'HOB').toUpperCase();
  const si = process.argv.indexOf('--split');
  const split = si > 0 ? Number(process.argv[si + 1]) : 0.67; // ≈ B grade
  const cache = path.join(os.tmpdir(), 'arena-overlay-datasets');
  const table = JSON.parse(fs.readFileSync(path.join(cache, 'tables', `${set}.json`), 'utf8'));
  const zById = tableZ(table, 200);
  const { cards, list } = await cardTable(set, cache);
  const game = await ensureDataset('game_data', set, 'PremierDraft', cache);
  const games = await wm.loadGames(game.file, cards);
  const z = list.map((m) => zById.get(m.mtgaId) ?? null);
  const legendary = list.map((m) => (m.types ?? []).some((t) => /Legendary/.test(t)) && !(m.types ?? []).some((t) => /Land/.test(t)));
  const land = list.map((m) => cards.get(normCardName(m.name))?.land);

  const L0 = wm.layout(list.length);
  const L = { ...L0, size: L0.size + NAMES.length };
  const X = L0.size;
  const extra = (g) => {
    const d = games.decks[g];
    const f = new Array(NAMES.length).fill(0);
    for (let k = 0; k < d.length; k += 2) {
      const c = d[k], n = d[k + 1];
      if (land[c] || z[c] == null) continue;
      const hi = z[c] >= split ? 1 : 0;
      if (n >= 2) f[hi] += 1;
      if (n >= 3) f[2 + hi] += n - 2;
      if (n >= 2 && legendary[c]) f[4] += 1;
    }
    return f.map((v, j) => [X + j, v]);
  };
  const use = { ...wm.VALUE_FEATURES, extra };
  const half = (g) => (games.draftHash[g] >>> 8) % 2;
  const fits = [null, (g) => half(g) === 0, (g) => half(g) === 1].map((inc) => wm.train(games, L, use, { l2: wm.VALUE_L2, include: inc }));
  // How common each situation is (decks with at least one).
  const share = new Array(NAMES.length).fill(0);
  for (let g = 0; g < games.won.length; g++) extra(g).forEach(([, v], j) => { if (v) share[j]++; });
  console.log(`${set}: ${games.won.length} games; quality split at z = ${split}`);
  console.log(`  ${'extra copy'.padEnd(26)} all games   half A   half B   (in % of decks)`);
  NAMES.forEach((name, j) => {
    const pp = (w) => `${(w[X + j] * 25 >= 0 ? '+' : '')}${(w[X + j] * 25).toFixed(2)}pp`;
    console.log(`  ${name.padEnd(26)} ${pp(fits[0]).padStart(9)} ${pp(fits[1]).padStart(8)} ${pp(fits[2]).padStart(8)}   ${(100 * share[j] / games.won.length).toFixed(0)}%`);
  });
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });
