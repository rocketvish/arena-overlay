#!/usr/bin/env node
/**
 * tune-weights.js — fit the recommendation weights to top players' picks.
 *
 * Coordinate search over the per-phase component weights and the shape
 * parameters in signalAnalyzer (TUNE), maximizing top-1 agreement on one half
 * of the held-out drafts and reporting the other half (and optionally other
 * sets) so we don't fool ourselves with overfitting.
 *
 *   node scripts/tune-weights.js --set HOB <table.json> <eval.json.gz> [--set EOE <table> <eval>] [--drafts 300]
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { loadContext, evaluate } = require('./eval-picks');
const sa = require('../src/main/signalAnalyzer');

function parseArgs(argv) {
  const a = { sets: [], drafts: 300, rounds: 2, noModel: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--set') a.sets.push({ set: argv[++i].toUpperCase(), table: argv[++i], eval: argv[++i] });
    else if (argv[i] === '--drafts') a.drafts = Number(argv[++i]);
    else if (argv[i] === '--rounds') a.rounds = Number(argv[++i]);
    else if (argv[i] === '--no-model') a.noModel = true; // tune the weights used before a set's model exists
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const sets = [];
  for (const s of args.sets) {
    const ctx = await loadContext(s.set, s.table);
    if (args.noModel) ctx.metrics.table = null; // early-set situation: no public-data table at all
    const all = JSON.parse(zlib.gunzipSync(fs.readFileSync(s.eval)).toString('utf-8'));
    const half = Math.min(args.drafts, Math.floor(all.drafts.length / 2));
    sets.push({
      set: s.set, ctx,
      tune: { ...all, drafts: all.drafts.slice(0, half) },
      test: { ...all, drafts: all.drafts.slice(half, half * 2) },
    });
  }
  const tuneSet = sets[0];
  const score = () => evaluate({ ctx: tuneSet.ctx, drafts: tuneSet.tune, limit: 1e9 }).agreement;
  const report = (label) => {
    const parts = sets.map((s) => {
      const r = evaluate({ ctx: s.ctx, drafts: s.test, limit: 1e9 });
      return `${s.set} test ${r.agreement.toFixed(1)}% (e ${r.byPhase.early.toFixed(0)}/m ${r.byPhase.mid.toFixed(0)}/l ${r.byPhase.late.toFixed(0)}; model ${r.modelOnly.toFixed(1)})`;
    });
    console.log(`${label}: tune ${score().toFixed(2)}%  |  ${parts.join('  |  ')}`);
  };

  report('start');
  const which = args.noModel ? 'base' : 'model';
  let weights = JSON.parse(JSON.stringify(sa.getWeights(which)));
  let tuning = {
    commitStart: 3, commitSpan: 15, commitBase: 0.7, commitLead: 1.0,
    pipPenalty: 0.15, pairQualityScale: 1.0, modelSharpness: 1.0, earlySignalWeight: 0.3,
  };
  sa.setWeights(weights, which); sa.setTuning(tuning, which);
  let best = score();

  const phases = ['early', 'mid-balanced', 'late'];
  const comps = (args.noModel ? [] : ['model']).concat(['quality', 'colorFit', 'needs', 'openness', 'archetype']);
  const tuneGrid = {
    commitStart: [0, 3, 6], commitSpan: [8, 15, 22], commitBase: [0.4, 0.7, 1.0], commitLead: [0, 1, 2],
    pipPenalty: [0, 0.15, 0.3], pairQualityScale: [0, 0.5, 1, 1.5], modelSharpness: [0.5, 1, 2, 3], earlySignalWeight: [0.3, 1],
  };

  for (let round = 0; round < args.rounds; round++) {
    for (const ph of phases) {
      for (const c of comps) {
        const cur = weights[ph][c];
        const candidates = c === 'model' ? [0, 0.25, 0.5, 1, 2, 4] : [0, cur * 0.5, cur, cur * 1.6, cur * 2.5, 0.05].filter((x, i, a) => a.indexOf(x) === i);
        for (const val of candidates) {
          if (val === cur) continue;
          const trial = JSON.parse(JSON.stringify(weights));
          trial[ph][c] = val;
          sa.setWeights(trial, which);
          const sc = score();
          if (sc > best + 0.02) { best = sc; weights = trial; }
        }
        sa.setWeights(weights, which);
      }
    }
    for (const [k, grid] of Object.entries(tuneGrid)) {
      for (const val of grid) {
        if (val === tuning[k]) continue;
        sa.setTuning({ ...tuning, [k]: val }, which);
        const sc = score();
        if (sc > best + 0.02) { best = sc; tuning = { ...tuning, [k]: val }; }
      }
      sa.setTuning(tuning, which);
    }
    report(`round ${round + 1}`);
  }

  // Styles other than "balanced" aren't in the data; derive them from it.
  const mid = weights['mid-balanced'];
  weights['mid-best-card'] = { ...mid, quality: mid.quality * 1.4, colorFit: mid.colorFit * 0.7 };
  weights['mid-signals'] = { ...mid, openness: Math.max(mid.openness * 2, 0.15), colorFit: mid.colorFit * 0.8 };
  const round3 = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
  console.log('\nWEIGHTS =', JSON.stringify(round3(weights), null, 1));
  console.log('TUNE =', JSON.stringify(round3(tuning)));
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
