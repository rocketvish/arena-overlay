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
const setData = require('../../src/main/setData');
const winValue = require('../../src/main/winValue');
const tracker = require('../../src/main/draftTracker');

function parseArgs(argv) {
  const a = { set: null, limit: 2500, cache: path.join(os.tmpdir(), 'arena-overlay-datasets'), settings: {}, tilt: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') a.limit = Number(argv[++i]);
    else if (argv[i] === '--strong') a.settings.deckNeeds = 'strong';
    else if (argv[i] === '--tilt') a.tilt = true;
    else if (argv[i] === '--vacuum') a.vacuum = true;
    else if (argv[i] === '--inclusion') a.inclusion = true;
    else if (argv[i] === '--splash') a.splash = true;
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
  // --inclusion: card values discounted for selective inclusion (inclusion.js).
  const inclusionTables = {};
  if (args.inclusion) {
    const { playRates, discountValues } = require('./inclusion');
    const { cardTable } = require('./cards');
    const { ensureDataset } = require('./build-set');
    const { cards } = await cardTable(args.set, args.cache);
    const game = await ensureDataset('game_data', args.set, 'PremierDraft', args.cache);
    const rates = await playRates(args.set, game.file, cards, args.cache);
    for (const [name, kappa] of [['incl', 1], ['incl2', 2]]) {
      const { w, changes } = discountValues(ctx.table.value, rates, { kappa });
      inclusionTables[name] = setData.prepare({ ...ctx.table, value: { ...ctx.table.value, w } }, 0);
      if (kappa === 1) {
        const nm = (id) => ctx.byId.get(id)?.name ?? id;
        const top = changes.sort((a, b) => (b.w - b.w2) - (a.w - a.w2)).slice(0, 8);
        console.log(`  inclusion: ${changes.length} cards discounted; largest: ${top.map((c) => `${nm(c.id)} (plays ${(100 * c.r).toFixed(0)}% vs ${(100 * c.expected).toFixed(0)}%, ${(c.w * 25).toFixed(1)}→${(c.w2 * 25).toFixed(1)}pp)`).join(', ')}`);
      }
    }
  }
  // --tilt: the table rule with the fading top-player tilt vs a flat one.
  // --vacuum: the rules against "best card in a vacuum" (highest 17Lands GIH
  // z in the pack, or in your two most-picked colors), which don't use the analyzer.
  const variants = args.tilt
    ? { table: { ...base }, flat: { ...base }, nosplash: { ...base }, before: { ...base } }
    : args.splash
    ? { table: { ...base }, cost: { ...base }, costNoFix: { ...base } }
    : args.inclusion
    ? { table: { ...base }, incl: { ...base, table: inclusionTables.incl }, incl2: { ...base, table: inclusionTables.incl2 } }
    : args.vacuum
    ? { table: { ...base }, prior: { ...base, table: null, valuePrior: prior }, gih: null, gihColors: null }
    : { old: { ...base, table: null, cards: undefined }, prior: { ...base, table: null, valuePrior: prior }, table: { ...base } };
  const z = (c) => sa.cardQuality ? (c?.stats?.z ?? -9) : -9;
  const topColors = (picks) => {
    const n = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const c of picks) for (const ch of String(c.color ?? '').replace(/[^WUBRG]/g, '')) n[ch]++;
    return Object.keys(n).sort((a, b) => n[b] - n[a]).slice(0, 2);
  };
  const vacuum = {
    gih: (pack) => pack.reduce((b, c) => (z(c) > z(b) ? c : b)).grpId,
    gihColors: (pack, picks) => {
      const top = topColors(picks);
      const fits = (c) => [...String(c.color ?? '').replace(/[^WUBRG]/g, '')].every((ch) => top.includes(ch));
      const inColor = picks.length >= 6 ? pack.filter(fits) : pack;
      return (inColor.length ? inColor : pack).reduce((b, c) => (z(c) > z(b) ? c : b)).grpId;
    },
  };
  // before = the rule as validated earlier (flat tilt, no splash).
  // --splash: a splash costs what the deck model measures (~2–4pp a game,
  // whatever the fixing) instead of SPLASH.deckCost 0.01.
  const splashFor = { cost: { deckCost: 0.13 }, costNoFix: { deckCost: 0.13, perFix: 0, base: 0.75 } };
  const ruleFor = { flat: { tiltByStage: [1, 1, 1, 1] }, nosplash: { splash: false }, before: { tiltByStage: [1, 1, 1, 1], splash: false } };
  const names = Object.keys(variants);
  const pairsToCompare = args.splash ? [['cost', 'table'], ['costNoFix', 'table']] : args.inclusion ? [['incl', 'table'], ['incl2', 'table']] : args.vacuum ? [['table', 'gih'], ['table', 'gihColors'], ['prior', 'gih'], ['prior', 'gihColors']] : args.tilt ? [['table', 'before'], ['table', 'flat'], ['table', 'nosplash']] : [['prior', 'old'], ['table', 'prior'], ['table', 'old']];

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
            const savedSplash = splashFor[k] ? { ...winValue.SPLASH } : null;
            if (savedSplash) Object.assign(winValue.SPLASH, splashFor[k]);
            if (vacuum[k] && !variants[k]) rec[k] = vacuum[k](pack, ts.pickHistory);
            else {
              const a = sa.analyze({ ...ts, setMetrics: variants[k] }, pack, { packNumber, pickNumber, packSize }, args.settings);
              rec[k] = a.recommendation?.primary?.grpId ?? null;
            }
            if (saved) Object.assign(sa.WIN_RULE, saved);
            if (savedSplash) Object.assign(winValue.SPLASH, savedSplash);
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
