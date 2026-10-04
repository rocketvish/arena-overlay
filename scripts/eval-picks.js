#!/usr/bin/env node
/**
 * eval-picks.js — how often does the overlay's top recommendation match what
 * a strong drafter actually took?
 *
 * Replays held-out top-player drafts (written by tools/pipeline/build-set.js)
 * through the real analyzer, pick by pick, and reports top-1 agreement. A
 * single user's match results are far too noisy to judge pick quality;
 * agreement with top players on thousands of picks is measurable.
 *
 *   node scripts/eval-picks.js HOB --table data/sets/HOB.json --eval <cache>/eval.HOB.PremierDraft.json.gz [--limit 400]
 *
 * Also usable as a module: evaluate(opts) → { agreement, byPhase, ... }.
 */
'use strict';

require('./lib/electronShim');
const fs = require('fs');
const zlib = require('zlib');
const landsData = require('../src/main/17landsData');
const setData = require('../src/main/setData');
const sa = require('../src/main/signalAnalyzer');
const tracker = require('../src/main/draftTracker');

function parseArgs(argv) {
  const a = { set: null, table: null, eval: null, limit: 400, style: 'balanced' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--table') a.table = argv[++i];
    else if (argv[i] === '--eval') a.eval = argv[++i];
    else if (argv[i] === '--limit') a.limit = Number(argv[++i]);
    else if (argv[i] === '--style') a.style = argv[++i];
    else if (!a.set) a.set = argv[i].toUpperCase();
  }
  return a;
}

/** Cards + metrics exactly as the app would build them from the set table. */
async function loadContext(set, tablePath) {
  const raw = JSON.parse(fs.readFileSync(tablePath, 'utf-8'));
  const table = { ...raw, modelIndex: new Map(raw.model.ids.map((id, i) => [id, i])) };
  const cards = landsData.buildCardData(setData.toRawRatings(table));
  const { log } = console;
  console.log = () => {};
  try { await landsData.attachCardText(set, cards); } finally { console.log = log; }
  const byId = new Map(cards.map((c) => [c.mtgaId, { ...c, grpId: c.mtgaId }]));
  const metrics = sa.computeSetMetrics(cards, { pairs: table.pairs });
  metrics.table = table;
  return { table, byId, metrics };
}

function evaluate({ ctx, drafts, settings = {}, limit = 400 }) {
  const counts = { all: [0, 0], early: [0, 0], mid: [0, 0], late: [0, 0], model: [0, 0], quality: [0, 0] };
  const packSize = drafts.packSize ?? 14;
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    for (const draft of drafts.drafts.slice(0, limit)) {
      tracker.reset();
      tracker.setInfo(drafts.set, 'PremierDraft');
      tracker.setSetMetrics(ctx.metrics);
      tracker.setPackSize(packSize);
      for (const pk of draft) {
        const pack = pk.cards.map((id) => ctx.byId.get(id)).filter(Boolean);
        if (pack.length < 2 || pk.taken == null) {
          if (pk.taken != null && ctx.byId.get(pk.taken)) tracker.recordPick({ packNumber: pk.p, pickNumber: pk.i, grpId: pk.taken, enrichedCard: ctx.byId.get(pk.taken) });
          continue;
        }
        tracker.recordPackSeen({ packNumber: pk.p, pickNumber: pk.i, cards: pack });
        const a = sa.analyze(tracker.getState(), pack, { packNumber: pk.p, pickNumber: pk.i, packSize }, settings);
        const rec = a.recommendation?.primary?.grpId;
        const phase = pk.p === 0 && pk.i < 5 ? 'early' : pk.i >= packSize - 4 ? 'late' : 'mid';
        const hit = rec === pk.taken ? 1 : 0;
        counts.all[0] += hit; counts.all[1]++;
        counts[phase][0] += hit; counts[phase][1]++;
        // Reference points: the pick model alone, and raw card quality alone.
        const ms = setData.modelScores(ctx.table, tracker.getState().pickHistory.map((p) => p.grpId), pk.cards);
        if (ms) {
          const best = [...ms.entries()].sort((x, y) => y[1] - x[1])[0][0];
          counts.model[0] += best === pk.taken ? 1 : 0; counts.model[1]++;
        }
        const bestQ = pack.slice().sort((x, y) => (y.stats?.z ?? -9) - (x.stats?.z ?? -9))[0].grpId;
        counts.quality[0] += bestQ === pk.taken ? 1 : 0; counts.quality[1]++;
        tracker.recordPick({ packNumber: pk.p, pickNumber: pk.i, grpId: pk.taken, enrichedCard: ctx.byId.get(pk.taken), recommendation: a.recommendation });
      }
    }
  } finally {
    console.log = log; console.warn = warn;
  }
  const pct = ([h, n]) => (n ? (100 * h) / n : 0);
  return {
    agreement: pct(counts.all), picks: counts.all[1],
    byPhase: { early: pct(counts.early), mid: pct(counts.mid), late: pct(counts.late) },
    modelOnly: pct(counts.model), qualityOnly: pct(counts.quality),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = await loadContext(args.set, args.table);
  const drafts = JSON.parse(zlib.gunzipSync(fs.readFileSync(args.eval)).toString('utf-8'));
  const t0 = Date.now();
  const r = evaluate({ ctx, drafts, settings: { draftStyle: args.style }, limit: args.limit });
  console.log(`${args.set}: overlay top pick = top player's pick ${r.agreement.toFixed(1)}% of ${r.picks} picks ` +
    `(early ${r.byPhase.early.toFixed(1)} / mid ${r.byPhase.mid.toFixed(1)} / late ${r.byPhase.late.toFixed(1)})`);
  console.log(`  reference: pick model alone ${r.modelOnly.toFixed(1)}%, best GIH card alone ${r.qualityOnly.toFixed(1)}%   [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });

module.exports = { loadContext, evaluate };
