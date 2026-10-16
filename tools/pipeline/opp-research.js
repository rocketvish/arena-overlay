#!/usr/bin/env node
/**
 * opp-research.js — how well does src/main/opponentRead.js read a deck?
 *
 *   node --max-old-space-size=8192 tools/pipeline/opp-research.js HOB
 *
 * Builds the per-archetype deck stats from training games only, then treats
 * held-out decks (by draft id) as "the opponent": reveal R random spells,
 * optionally the two main land colors, and score
 *   - archetype: top-1 accuracy, mean log-probability of the true pair
 *   - deck contents: for every instant-speed card not revealed, P(the deck
 *     runs it) vs the truth — Brier score and log loss, against a colors-only
 *     read (what the overlay did before) and an oracle that knows the pair.
 */
'use strict';

const os = require('os');
const path = require('path');
const { normCardName } = require('./csv');
const { ensureDataset } = require('./build-set');
const { cardTable } = require('./cards');
const wm = require('./winModel');
const opp = require('../../src/main/opponentRead');

const PAIRS = opp.PAIRS;
const COLORS = 'WUBRG';

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const set = (process.argv[2] ?? 'HOB').toUpperCase();
  const cache = path.join(os.tmpdir(), 'arena-overlay-datasets');
  const { cards, list } = await cardTable(set, cache);
  const game = await ensureDataset('game_data', set, 'PremierDraft', cache);
  const games = await wm.loadGames(game.file, cards);
  const meta = list.map((m) => cards.get(normCardName(m.name)));
  const pairName = (i) => PAIRS[i] ?? null;
  // winModel's pair index uses the same order.
  if (wm.PAIRS.join() !== PAIRS.join()) throw new Error('pair order mismatch');

  // ── Training stats (non-held-out games) → a table shaped like the app's.
  const n = list.length;
  const pairGames = Object.fromEntries(PAIRS.map((p) => [p, 0]));
  const has = Object.fromEntries(PAIRS.map((p) => [p, new Float64Array(n)]));
  const copies = Object.fromEntries(PAIRS.map((p) => [p, new Float64Array(n)]));
  for (let g = 0; g < games.won.length; g++) {
    const p = pairName(games.pair[g]);
    if (games.heldOut[g] || !p) continue;
    pairGames[p]++;
    const d = games.decks[g];
    for (let k = 0; k < d.length; k += 2) { has[p][d[k]]++; copies[p][d[k]] += d[k + 1]; }
  }
  const table = { pairs: Object.fromEntries(PAIRS.map((p) => [p, { games: pairGames[p] }])), cards: {} };
  for (let c = 0; c < n; c++) {
    const deck = {};
    for (const p of PAIRS) {
      if (pairGames[p] < 200 || has[p][c] / pairGames[p] < 0.002) continue;
      deck[p] = [has[p][c] / pairGames[p], copies[p][c] / has[p][c]];
    }
    table.cards[list[c].mtgaId] = { deck };
  }
  const instantSpeed = list.map((m) => !meta[list.indexOf(m)]?.land && ((m.types ?? []).includes('Instant') || /\bFlash\b/.test(m.oracle ?? '')));
  const colorsOf = (c) => String(list[c].color ?? '').replace(/[^WUBRG]/g, '');

  const r = rng(7);
  const results = {};
  const score = (key, pred, truth) => {
    const s = results[key] ?? (results[key] = { brier: 0, loss: 0, n: 0 });
    const p = Math.min(1 - 1e-4, Math.max(1e-4, pred));
    s.brier += (pred - truth) ** 2;
    s.loss -= truth ? Math.log(p) : Math.log(1 - p);
    s.n++;
  };
  const arche = {};
  let tested = 0;
  for (let g = 0; g < games.won.length && tested < 20000; g++) {
    const p = pairName(games.pair[g]);
    if (!games.heldOut[g] || !p) continue;
    tested++;
    const d = games.decks[g];
    const inDeck = new Set();
    const spells = [];
    for (let k = 0; k < d.length; k += 2) {
      inDeck.add(d[k]);
      if (!meta[d[k]]?.land) for (let j = 0; j < d[k + 1]; j++) spells.push(d[k]);
    }
    for (const R of [1, 3, 5]) {
      for (const lands of [false, true]) {
        const pool = spells.slice();
        const seen = {};
        for (let j = 0; j < R && pool.length; j++) {
          const c = pool.splice(Math.floor(r() * pool.length), 1)[0];
          seen[list[c].mtgaId] = (seen[list[c].mtgaId] ?? 0) + 1;
        }
        const landColors = lands ? p.split('') : [];
        const odds = opp.archetypeOdds(table, seen, landColors);
        // Colors-only: what the overlay did before — colors shown, no card identities.
        const shown = new Set(landColors);
        for (const id of Object.keys(seen)) for (const ch of colorsOf(list.findIndex((m) => String(m.mtgaId) === id))) shown.add(ch);
        const colorOnly = opp.archetypeOdds(table, {}, [...shown]);
        const key = `${R} spell${R > 1 ? 's' : ''}${lands ? ' + lands' : ''}`;
        const a = arche[key] ?? (arche[key] = { top1: 0, logp: 0, top1c: 0, n: 0 });
        const top = Object.entries(odds.probs).sort((x, y) => y[1] - x[1])[0][0];
        const topc = Object.entries(colorOnly.probs).sort((x, y) => y[1] - x[1])[0][0];
        a.top1 += top === p ? 1 : 0; a.top1c += topc === p ? 1 : 0; a.logp += Math.log(Math.max(odds.probs[p], 1e-6)); a.n++;
        for (let c = 0; c < n; c++) {
          if (!instantSpeed[c] || seen[list[c].mtgaId]) continue;
          const truth = inDeck.has(c) ? 1 : 0;
          score(`${key} · this read`, opp.cardOdds(table, odds, list[c].mtgaId).inDeck, truth);
          score(`${key} · colors only`, opp.cardOdds(table, colorOnly, list[c].mtgaId).inDeck, truth);
          score(`${key} · knows the pair`, table.cards[list[c].mtgaId]?.deck?.[p]?.[0] ?? 0, truth);
        }
      }
    }
  }
  console.log(`${set}: ${tested} held-out decks as the opponent`);
  console.log('  archetype           top-1 (this read / colors only)   mean log P(true pair)');
  for (const [k, a] of Object.entries(arche)) console.log(`  ${k.padEnd(18)}  ${(100 * a.top1 / a.n).toFixed(1)}% / ${(100 * a.top1c / a.n).toFixed(1)}%                     ${(a.logp / a.n).toFixed(3)}`);
  console.log('  instant-speed cards: does the deck run it?   Brier      log loss');
  for (const [k, s] of Object.entries(results)) console.log(`  ${k.padEnd(36)} ${(s.brier / s.n).toFixed(5)}   ${(s.loss / s.n).toFixed(5)}`);
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });
