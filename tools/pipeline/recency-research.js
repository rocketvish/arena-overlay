#!/usr/bin/env node
/**
 * recency-research.js — should later drafts count more?
 *
 *   node --max-old-space-size=8192 tools/pipeline/recency-research.js HOB [--test-days 7]
 *
 * Holds out the last `test-days` of a set's draft data and predicts it from
 * everything earlier, with recency half-lives from "off" to a week:
 *   - top-player pick agreement of the pick model
 *   - wheel rates (Brier score per observation)
 *   - average pick position (squared error, weighted by picks)
 */
'use strict';

const os = require('os');
const path = require('path');
const { draftPass, collapseDays, trainPickModel, readCardIndex, ensureDataset } = require('./build-set');

function parseArgs(argv) {
  const a = { set: null, testDays: 7, cache: path.join(os.tmpdir(), 'arena-overlay-datasets'), halfLives: [null, 56, 28, 14, 7] };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--test-days') a.testDays = Number(argv[++i]);
    else if (argv[i] === '--half-lives') a.halfLives = argv[++i].split(',').map((x) => (x === 'off' ? null : Number(x)));
    else if (!a.set) a.set = argv[i].toUpperCase();
  }
  return a;
}

/** Share of rows where the model's favourite is the card the top player took. */
function rowTop1(model, train, rows) {
  const { dim, b, u, v } = model;
  const h = new Float64Array(dim);
  let hits = 0, n = 0;
  for (const i of rows) {
    const taken = train.taken[i];
    const pack = [...new Set(train.pack.get(i))];
    if (taken == null || pack.length < 2) continue;
    const pool = train.pool.get(i);
    h.fill(0);
    for (const p of pool) for (let d = 0; d < dim; d++) h[d] += v[p * dim + d];
    const inv = pool.length ? 1 / pool.length : 0;
    let best = -1, bs = -Infinity;
    for (const c of pack) {
      let s = b[c];
      for (let d = 0; d < dim; d++) s += u[c * dim + d] * h[d] * inv;
      if (s > bs) { bs = s; best = c; }
    }
    n++;
    if (best === taken) hits++;
  }
  return { top1: hits / n, n };
}

/** Wheel Brier score and ATA error of `pred` (collapsed counts) against `test`. */
function scoreStats(pred, test) {
  let brier = 0, obs = 0, ataErr = 0, ataW = 0;
  for (let p = 0; p < 6; p++) {
    let gHit = 0, gObs = 0;
    for (let c = 0; c < pred.wheelObs[p].length; c++) { gHit += pred.wheelHit[p][c]; gObs += pred.wheelObs[p][c]; }
    const fallback = gObs ? gHit / gObs : 0.5;
    for (let c = 0; c < test.wheelObs[p].length; c++) {
      const n = test.wheelObs[p][c], k = test.wheelHit[p][c];
      if (!n) continue;
      // Same rule as the shipped table: measured rate needs ≥ 30 observations.
      const q = pred.wheelObs[p][c] >= 30 ? pred.wheelHit[p][c] / pred.wheelObs[p][c] : fallback;
      brier += k * (1 - q) ** 2 + (n - k) * q ** 2;
      obs += n;
    }
  }
  for (let c = 0; c < test.ataN.length; c++) {
    if (!test.ataN[c] || !pred.ataN[c]) continue;
    const err = pred.ataSum[c] / pred.ataN[c] - test.ataSum[c] / test.ataN[c];
    ataErr += test.ataN[c] * err * err;
    ataW += test.ataN[c];
  }
  return { brier: brier / obs, ataRmse: Math.sqrt(ataErr / ataW) };
}

async function main() {
  const args = parseArgs(process.argv);
  const draft = await ensureDataset('draft_data', args.set, 'PremierDraft', args.cache);
  const { names, indexByName } = await readCardIndex(draft.file);
  const { normCardName } = require('./csv');
  const d = await draftPass(draft.file, names.length, (nm) => indexByName.get(normCardName(nm)));
  const cutoff = d.lastDay - args.testDays;
  const trainRows = [], testRows = [];
  d.train.day.forEach((day, i) => (day > cutoff ? testRows : trainRows).push(i));
  const test = collapseDays(d, (day) => (day > cutoff ? 1 : 0));
  console.log(`${args.set}: ${d.lastDay - d.firstDay + 1} days of drafts; predicting the last ${args.testDays} ` +
    `(${testRows.length} top-player picks) from the ${cutoff - d.firstDay + 1} before`);
  for (const hl of args.halfLives) {
    const w = (day) => (day > cutoff ? 0 : hl ? 0.5 ** ((cutoff - day) / hl) : 1);
    const model = trainPickModel(d.train, names.length, { rows: trainRows, weight: hl ? (i) => w(d.train.day[i]) : null, log: () => {} });
    const r = rowTop1(model, d.train, testRows);
    const s = scoreStats(collapseDays(d, w), test);
    console.log(`  half-life ${hl ? `${hl}d`.padEnd(4) : 'off '}  pick model top-1 ${(100 * r.top1).toFixed(2)}%   wheel Brier ${s.brier.toFixed(5)}   ATA RMSE ${s.ataRmse.toFixed(3)}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });
