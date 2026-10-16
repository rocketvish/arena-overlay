#!/usr/bin/env node
/**
 * win-policy.js — does picking by deck win value beat imitating top players?
 *
 *   node --max-old-space-size=8192 tools/pipeline/win-policy.js HOB [--table data/sets/HOB.json] [--sims 300]
 *
 * 1. Fits the deck win model (winModel.js) on training games and builds the
 *    table's `value` block (card values, archetype effects, phantom picks).
 * 2. Pool check: on held-out drafts, does the best deck buildable from the
 *    final pool predict the drafter's match win rate (within skill bucket)?
 * 3. Natural experiment: on held-out drafts, does "regret" under each
 *    recommender (value lost vs its favourite pick) predict losing?
 * 4. Simulated pods: one seat follows a policy, seven bots draft like top
 *    players (sampled from the pick model). Compares final deck value.
 *
 * Writes the value block to <cache>/value.<SET>.json for build-set / tuning.
 */
'use strict';

require('../../scripts/lib/electronShim');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureDataset } = require('./build-set');
const wm = require('./winModel');
const wv = require('../../src/main/winValue');
const setData = require('../../src/main/setData');

function parseArgs(argv) {
  const a = { set: null, table: null, sims: 300, l2: wm.VALUE_L2, cache: path.join(os.tmpdir(), 'arena-overlay-datasets'), taus: [0.05, 0.15, 0.4], lambdas: [0, 0.01, 0.03], skip: new Set() };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--table') a.table = argv[++i];
    else if (argv[i] === '--sims') a.sims = Number(argv[++i]);
    else if (argv[i] === '--l2') a.l2 = Number(argv[++i]);
    else if (argv[i] === '--cache') a.cache = argv[++i];
    else if (argv[i] === '--taus') a.taus = argv[++i].split(',').map(Number);
    else if (argv[i] === '--lambdas') a.lambdas = argv[++i].split(',').map(Number);
    else if (argv[i] === '--skip') a.skip = new Set(argv[++i].split(','));
    else if (!a.set) a.set = argv[i].toUpperCase();
  }
  a.table ??= path.join(__dirname, '..', '..', 'data', 'sets', `${a.set}.json`);
  return a;
}

// Seeded PRNG (mulberry32) so policies face the same packs.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Stage 1: value block ─────────────────────────────────────────────────────

// Full model, plus two models on disjoint halves of the training drafts: the
// simulation picks with one half and scores decks with the other, so a
// policy can't win by chasing its own model's noise.
async function buildValue(set, cache, table, l2) {
  const game = await ensureDataset('game_data', set, 'PremierDraft', cache);
  const draft = await ensureDataset('draft_data', set, 'PremierDraft', cache);
  return wm.buildValueBlock({
    set, gameFile: game.file, draftFile: draft.file, cache, l2, halves: true, keepHeldOut: 8000, keepPacks: 30000,
    cardColor: (id) => table.cards?.[id]?.color,
  });
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

/** Weighted regression of y on xs after demeaning within groups (skill buckets). */
function withinRegression(rows, xKeys) {
  const groups = new Map();
  for (const r of rows) { const g = groups.get(r.group) ?? []; g.push(r); groups.set(r.group, g); }
  const X = [], Y = [], W = [];
  for (const g of groups.values()) {
    const sw = g.reduce((a, r) => a + r.weight, 0);
    const my = g.reduce((a, r) => a + r.weight * r.y, 0) / sw;
    const mx = xKeys.map((k) => g.reduce((a, r) => a + r.weight * r[k], 0) / sw);
    for (const r of g) { X.push(xKeys.map((k, j) => r[k] - mx[j])); Y.push(r.y - my); W.push(r.weight); }
  }
  const k = xKeys.length;
  const A = Array.from({ length: k }, () => new Float64Array(k)), b = new Float64Array(k);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < k; a++) { b[a] += W[i] * X[i][a] * Y[i]; for (let c = 0; c < k; c++) A[a][c] += W[i] * X[i][a] * X[i][c]; }
  const inv = invert(A);
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * b[j], 0));
  let rss = 0, sw = 0;
  for (let i = 0; i < X.length; i++) { const e = Y[i] - X[i].reduce((s, v, j) => s + v * beta[j], 0); rss += W[i] * e * e; sw += W[i]; }
  const sigma2 = rss / (sw * (1 - (k + groups.size) / X.length));
  const se = inv.map((row, j) => Math.sqrt(sigma2 * row[j]));
  const sd = xKeys.map((_, j) => Math.sqrt(X.reduce((s, x, i) => s + W[i] * x[j] * x[j], 0) / sw));
  return { beta, se, sd, n: X.length };
}

function invert(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((row) => row.slice(n));
}

// ─── Stage 2/3: held-out drafts ───────────────────────────────────────────────

/** The overlay's pick rule: win value, tilted toward the top-player model by λ. */
function hybridBest(vt, table, pool, pack, t, tau, lambda) {
  const v = wv.scorePack(vt, pool, pack, t, { tau });
  const ms = setData.modelScores(table, pool, pack);
  if (!v || !ms) return null;
  const pMax = Math.max(...ms.values());
  let best = null, bs = -Infinity;
  for (const [id, s] of v.scores) {
    const total = s + lambda * Math.log(Math.max(ms.get(id) ?? 1e-6, 1e-6) / pMax);
    if (total > bs) { bs = total; best = id; }
  }
  return { best, v, ms };
}

function heldOutAnalysis(drafts, vt, table, tau, lambda = 0) {
  const rows = [];
  for (const d of drafts) {
    const matches = d.wins + d.losses;
    if (!matches || !Number.isFinite(d.skill)) continue;
    const pool = [];
    let regretVar = 0, regretImit = 0, agreeVar = 0, agreeImit = 0, n = 0, dis = 0, disN = 0;
    for (const pk of d.picks) {
      if (pk.taken == null) continue;
      if (new Set(pk.pack).size > 1) {
        const hb = hybridBest(vt, table, pool, pk.pack, pk.t, tau, lambda);
        const v = hb?.v, ms = hb?.ms;
        if (hb && v.scores.has(pk.taken) && ms.has(pk.taken)) {
          n++;
          regretVar += v.scores.get(v.best) - v.scores.get(pk.taken);
          let imBest = null, pMax = 0;
          for (const [id, p] of ms) if (p > pMax) { pMax = p; imBest = id; }
          regretImit += Math.log(pMax / Math.max(ms.get(pk.taken), 1e-9));
          agreeVar += pk.taken === hb.best ? 1 : 0;
          agreeImit += pk.taken === imBest ? 1 : 0;
          if (hb.best !== imBest) {
            if (pk.taken === hb.best) { dis++; disN++; } else if (pk.taken === imBest) { dis--; disN++; }
          }
        }
      }
      pool.push(pk.taken);
    }
    if (n < 30) continue;
    const pv = wv.poolValue(vt, pool);
    rows.push({
      group: Math.round(d.skill * 50), weight: matches, y: d.wins / matches,
      pool: pv.value, regretVar, regretImit, agreeVar: agreeVar / n, agreeImit: agreeImit / n, dis, disN,
    });
  }
  return rows;
}

// ─── Stage 4: simulated pods ──────────────────────────────────────────────────

function sample(probs, r) {
  let x = r(), last = null;
  for (const [id, p] of probs) { last = id; x -= p; if (x <= 0) return id; }
  return last;
}

function removeOne(arr, id) {
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
}

/**
 * policy(pool, pack, t) → grpId. Bots sample the top-player pick model.
 * Returns seat 0's pool and the bots' pools.
 */
function simulateDraft(packs, packSize, policy, table, seed) {
  const r = rng(seed);
  const pools = Array.from({ length: 8 }, () => []);
  for (let round = 0; round < 3; round++) {
    let cur = Array.from({ length: 8 }, () => packs[Math.floor(r() * packs.length)].slice());
    for (let i = 0; i < packSize; i++) {
      const t = round * packSize + i;
      for (let s = 0; s < 8; s++) {
        const pack = cur[s];
        if (!pack.length) continue;
        let id;
        if (s === 0) id = policy(pools[0], pack, t);
        else {
          const ms = setData.modelScores(table, pools[s], pack);
          id = ms ? sample(ms, r) : pack[0];
        }
        pools[s].push(id);
        removeOne(pack, id);
      }
      const dir = round === 1 ? -1 : 1;
      cur = cur.map((_, s) => cur[(s - dir + 8) % 8]);
    }
  }
  return pools;
}

function gihDeck(table, pool) {
  // Independent yardstick: mean GIH WR of the best 23 castable cards in the best pair.
  let best = -Infinity;
  for (let p = 0; p < wv.PAIRS.length; p++) {
    const vals = pool.map((id) => table.cards?.[id]).filter((c) => c && c.gih != null && (wv.castMask(c.color) & (1 << p)) && !(c.types ?? []).some((t) => /^Land$|\bLand\b/.test(t) && !/Creature/.test(t)))
      .map((c) => c.gih).sort((a, b) => b - a).slice(0, 23);
    while (vals.length < 23) vals.push(0.45);
    best = Math.max(best, vals.reduce((a, b) => a + b, 0) / 23);
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv);
  const raw = JSON.parse(fs.readFileSync(args.table, 'utf8'));
  const table = { ...raw, modelIndex: new Map(raw.model.ids.map((id, i) => [id, i])) };
  console.log(`${args.set}: building value block…`);
  const built = await buildValue(args.set, args.cache, table, args.l2);
  fs.writeFileSync(path.join(args.cache, `value.${args.set}.json`), JSON.stringify(built.value));
  fs.writeFileSync(path.join(args.cache, `heldout.${args.set}.json`), JSON.stringify(built.heldOut));
  const vt = wv.prepareValue({ ...table, value: built.value });
  const vtA = wv.prepareValue({ ...table, value: built.halves[0] });
  const vtB = wv.prepareValue({ ...table, value: built.halves[1] });
  console.log(`  ${built.heldOut.length} held-out drafts, ${built.packs.length} sample packs, pack size ${built.packSize}`);
  // Learned deck-shape effects (win % points per card short of / over a count).
  for (const [name, s] of Object.entries(built.value.structure)) {
    console.log(`    ${name.padEnd(10)} ` + [...s.short.map(([k, x]) => `short of ${k}: ${(x * 25).toFixed(2)}`), ...s.over.map(([k, x]) => `over ${k}: ${(x * 25).toFixed(2)}`)].join(' · '));
  }

  const fmt = (r, j, scale = 1, unit = '') => `${(r.beta[j] * r.sd[j] * scale).toFixed(2)}${unit} per SD (t=${(r.beta[j] / r.se[j]).toFixed(1)})`;
  if (!args.skip.has('heldout')) {
    for (const tau of args.taus) for (const lambda of args.lambdas) {
      const rows = heldOutAnalysis(built.heldOut, vt, table, tau, lambda);
      console.log(`\n  held-out drafts (τ=${tau} λ=${lambda}, n=${rows.length}); match win % within skill bucket:`);
      if (tau === args.taus[0] && lambda === args.lambdas[0]) {
        const r = withinRegression(rows, ['pool']);
        console.log(`    final pool's best-deck value      → ${fmt(r, 0, 100, 'pp')}`);
      }
      const a = withinRegression(rows, ['regretVar']);
      const b = withinRegression(rows, ['regretImit']);
      const c = withinRegression(rows, ['regretVar', 'regretImit']);
      console.log(`    regret vs win-value picks        → ${fmt(a, 0, 100, 'pp')}`);
      console.log(`    regret vs top-player model       → ${fmt(b, 0, 100, 'pp')}`);
      console.log(`    both: win-value ${fmt(c, 0, 100, 'pp')}; top-player ${fmt(c, 1, 100, 'pp')}`);
      const avg = (k) => rows.reduce((s, x) => s + x[k], 0) / rows.length;
      console.log(`    agreement with drafter: overlay rule ${(100 * avg('agreeVar')).toFixed(1)}%, top-player model ${(100 * avg('agreeImit')).toFixed(1)}%; disagreements/draft ${avg('disN').toFixed(1)}`);
      const dd = withinRegression(rows.filter((x) => x.disN > 0), ['dis']);
      console.log(`    when overlay rule ≠ top-player model, +1 pick taken the overlay way → ${(dd.beta[0] * 100).toFixed(2)}pp match win (t=${(dd.beta[0] / dd.se[0]).toFixed(1)})`);
    }
  }

  if (!args.skip.has('sim')) {
    const imitation = (pool, pack) => {
      const ms = setData.modelScores(table, pool, pack);
      let best = pack[0], bp = -1;
      if (ms) for (const [id, p] of ms) if (p > bp) { bp = p; best = id; }
      return best;
    };
    const valuePolicy = (tau, lambda) => (pool, pack, t) => hybridBest(vtA, table, pool, pack, t, tau, lambda)?.best ?? imitation(pool, pack);
    const policies = [['top-player model (argmax)', imitation]];
    for (const tau of args.taus) for (const lambda of args.lambdas) policies.push([`win-value τ=${tau} λ=${lambda}`, valuePolicy(tau, lambda)]);
    console.log(`\n  simulated pods (${args.sims} drafts each; bots sample the top-player model; policy uses model half A, decks scored by half B):`);
    let baseline = null;
    for (const [label, policy] of policies) {
      let v = 0, v2 = 0, gih = 0, bots = 0;
      for (let k = 0; k < args.sims; k++) {
        const pools = simulateDraft(built.packs, built.packSize, policy, table, 1000 + k);
        const pv = wv.poolValue(vtB, pools[0]).value;
        v += pv; v2 += pv * pv;
        gih += gihDeck(table, pools[0]);
        bots += wv.poolValue(vtB, pools[1]).value;
      }
      const n = args.sims, mean = v / n, se = Math.sqrt((v2 / n - mean * mean) / n);
      baseline ??= mean;
      console.log(`    ${label.padEnd(34)} deck value ${((mean - baseline) * 25).toFixed(2)}pp ±${(se * 25).toFixed(2)} vs top-player model · mean GIH of deck ${(100 * gih / n).toFixed(2)}% · a bot's deck ${((bots / n - baseline) * 25).toFixed(2)}pp`);
    }
  }
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });
