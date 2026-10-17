#!/usr/bin/env node
/**
 * newset-research.js — picks for a set without public data yet.
 *
 *   node --max-old-space-size=8192 tools/pipeline/newset-research.js HOB [--limit 2500]
 *
 * Pretends the set is new: its deck win model is built from the cross-set
 * prior of the OTHER published sets (valuePrior.js) plus the set's own card
 * grades. Replays held-out drafts (written by win-policy.js) and compares
 *   old    — the overlay's scorer before this change (no win model)
 *   prior  — win rule from the leave-one-out prior
 *   table  — win rule with the set's real table (reference)
 * Where two of them disagree, did drafters who took one's pick win more
 * matches (within skill bucket)? Observational, like win-policy.js.
 */
'use strict';

require('../../scripts/lib/electronShim');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadContext } = require('../../scripts/eval-picks');
const { derivePrior } = require('../../src/main/valuePrior');
const sa = require('../../src/main/signalAnalyzer');
const tracker = require('../../src/main/draftTracker');

function parseArgs(argv) {
  const a = { set: null, limit: 2500, cache: path.join(os.tmpdir(), 'arena-overlay-datasets'), settings: {}, tilt: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') a.limit = Number(argv[++i]);
    else if (argv[i] === '--strong') a.settings.deckNeeds = 'strong';
    else if (argv[i] === '--tilt') a.tilt = true;
    else if (!a.set) a.set = argv[i].toUpperCase();
  }
  return a;
}

/** Weighted regression of y on x after demeaning within groups (skill buckets). */
function within(rows, key) {
  const groups = new Map();
  for (const r of rows) { const g = groups.get(r.group) ?? []; g.push(r); groups.set(r.group, g); }
  let sxy = 0, sxx = 0, n = 0;
  const pts = [];
  for (const g of groups.values()) {
    const sw = g.reduce((s, r) => s + r.weight, 0);
    const my = g.reduce((s, r) => s + r.weight * r.y, 0) / sw;
    const mx = g.reduce((s, r) => s + r.weight * r[key], 0) / sw;
    for (const r of g) { const x = r[key] - mx, y = r.y - my; sxy += r.weight * x * y; sxx += r.weight * x * x; pts.push([x, y, r.weight]); n++; }
  }
  const beta = sxx ? sxy / sxx : 0;
  let rss = 0, sw = 0;
  for (const [x, y, w] of pts) { rss += w * (y - beta * x) ** 2; sw += w; }
  const se = Math.sqrt((rss / sw) / (sxx / sw) / (n - groups.size));
  return { beta, se, n };
}

async function main() {
  const args = parseArgs(process.argv);
  const tablesDir = path.join(args.cache, 'tables');
  const others = fs.readdirSync(tablesDir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(tablesDir, f), 'utf8')))
    .filter((t) => t.value && t.set !== args.set);
  const prior = derivePrior(others);
  const ctx = await loadContext(args.set, path.join(tablesDir, `${args.set}.json`));
  const drafts = JSON.parse(fs.readFileSync(path.join(args.cache, `heldout.${args.set}.json`), 'utf8')).slice(0, args.limit);
  const packSize = ctx.table.value.phantom.WU.value.length / 3;
  console.log(`${args.set}: prior from ${prior.sets.join(', ')}; ${drafts.length} held-out drafts, packs of ${packSize}${args.settings.deckNeeds ? ', deck needs: strong' : ''}`);

  // Three views of the set: no win model / prior win model / real table.
  const base = { ...ctx.metrics };
  // --tilt: the table rule with the fading top-player tilt vs a flat one.
  const variants = args.tilt
    ? { table: { ...base }, flat: { ...base }, nosplash: { ...base }, before: { ...base } }
    : { old: { ...base, table: null, cards: undefined }, prior: { ...base, table: null, valuePrior: prior }, table: { ...base } };
  // before = the rule as validated earlier (flat tilt, no splash).
  const ruleFor = { flat: { tiltByStage: [1, 1, 1, 1] }, nosplash: { splash: false }, before: { tiltByStage: [1, 1, 1, 1], splash: false } };
  const names = Object.keys(variants);
  const pairsToCompare = args.tilt ? [['table', 'before'], ['table', 'flat'], ['table', 'nosplash']] : [['prior', 'old'], ['table', 'prior'], ['table', 'old']];

  const rows = [];
  const agree = Object.fromEntries(names.map((k) => [k, [0, 0]]));
  const t0 = Date.now();
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    for (const d of drafts) {
      const matches = d.wins + d.losses;
      if (!matches || !Number.isFinite(d.skill)) continue;
      tracker.reset();
      tracker.setInfo(args.set, 'PremierDraft');
      tracker.setPackSize(packSize);
      const dis = Object.fromEntries(pairsToCompare.map(([a, b]) => [`${a}-${b}`, 0]));
      const disN = { ...dis };
      for (const pk of d.picks) {
        const packNumber = Math.floor(pk.t / packSize), pickNumber = pk.t % packSize;
        const pack = pk.pack.map((id) => ctx.byId.get(id)).filter(Boolean);
        const takenCard = ctx.byId.get(pk.taken);
        if (pack.length >= 2 && takenCard) {
          tracker.recordPackSeen({ packNumber, pickNumber, cards: pack });
          const ts = tracker.getState();
          const rec = {};
          for (const k of names) {
            const saved = ruleFor[k] ? Object.fromEntries(Object.keys(ruleFor[k]).map((x) => [x, sa.WIN_RULE[x]])) : null;
            if (saved) Object.assign(sa.WIN_RULE, ruleFor[k]);
            const a = sa.analyze({ ...ts, setMetrics: variants[k] }, pack, { packNumber, pickNumber, packSize }, args.settings);
            if (saved) Object.assign(sa.WIN_RULE, saved);
            rec[k] = a.recommendation?.primary?.grpId ?? null;
            agree[k][0] += rec[k] === pk.taken ? 1 : 0; agree[k][1]++;
          }
          for (const [a, b] of pairsToCompare) {
            if (rec[a] === rec[b]) continue;
            const key = `${a}-${b}`;
            if (pk.taken === rec[a]) { dis[key]++; disN[key]++; } else if (pk.taken === rec[b]) { dis[key]--; disN[key]++; }
          }
        }
        if (takenCard) tracker.recordPick({ packNumber, pickNumber, grpId: pk.taken, enrichedCard: takenCard });
      }
      rows.push({ group: Math.round(d.skill * 50), weight: matches, y: d.wins / matches, ...Object.fromEntries(Object.keys(dis).map((k) => [k, dis[k]])), ...Object.fromEntries(Object.keys(disN).map((k) => [`${k}N`, disN[k]])) });
    }
  } finally {
    console.log = log; console.warn = warn;
  }
  console.log(`  ${rows.length} drafts in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const k of names) console.log(`  ${k.padEnd(6)} agrees with the drafter on ${(100 * agree[k][0] / agree[k][1]).toFixed(1)}% of picks`);
  for (const [a, b] of pairsToCompare) {
    const key = `${a}-${b}`;
    const sub = rows.filter((r) => r[`${key}N`] > 0);
    const r = within(sub, key);
    const perDraft = sub.reduce((s, x) => s + x[`${key}N`], 0) / rows.length;
    console.log(`  ${a} vs ${b}: ${perDraft.toFixed(1)} disagreements/draft; taking ${a}'s pick → ${(100 * r.beta).toFixed(2)}pp match win per pick (t=${(r.beta / r.se).toFixed(1)})`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });
