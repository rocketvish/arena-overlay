#!/usr/bin/env node
/**
 * build-set.js — turn 17Lands' public datasets for one set into the small
 * table the overlay downloads (data/sets/<SET>.json).
 *
 *   node tools/pipeline/build-set.js FRA [--format PremierDraft] [--cache DIR] [--out data/sets]
 *
 * Source: https://www.17lands.com/public_datasets (CC BY 4.0). Draft data is
 * published ~2 weeks into a set, game data ~3 weeks in. The raw files are
 * 50–200 MB gzipped; only aggregates leave this script.
 *
 * Output (per card, keyed by Arena grpId):
 *   gih/oh/gp win rates and sample sizes, computed from game data
 *   pairs     GIH WR within each two-color main deck — the per-archetype view
 *             17Lands' public card endpoint doesn't offer
 *   wheel     P(card is still in the pack 8 picks later), by pick 1..6
 *   ata       average pick taken at
 * plus `model`: a small pick model trained on top players' drafts
 * (see trainPickModel), and an eval file of held-out drafts for
 * scripts/eval-picks.js (written to the cache dir, never shipped).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { readCsvGz, normCardName } = require('./csv');

const COLORS = 'WUBRG';
const POD_SIZE = 8;
// "Top players" for the pick model / eval: 17Lands win-rate bucket ≥ 60%
// over at least 50 games.
const TOP_WR_BUCKET = 0.6;
const TOP_MIN_GAMES_BUCKET = 50;
const EVAL_FRACTION = 10; // 1 in 10 top-player drafts is held out

// ─── Args / IO ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { set: null, format: 'PremierDraft', cache: path.join(os.tmpdir(), 'arena-overlay-datasets'), out: path.join(__dirname, '..', '..', 'data', 'sets'), epochs: 4, dim: 16 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') args.format = argv[++i];
    else if (a === '--cache') args.cache = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--epochs') args.epochs = Number(argv[++i]);
    else if (a === '--dim') args.dim = Number(argv[++i]);
    else if (!args.set) args.set = a.toUpperCase();
  }
  if (!args.set) throw new Error('usage: build-set.js SET [--format PremierDraft] [--cache DIR] [--out DIR]');
  return args;
}

function request(url, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    https.request(url, { method, headers: { 'User-Agent': 'ArenaOverlay-pipeline' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(request(res.headers.location, { method }));
      }
      resolve(res);
    }).on('error', reject).end();
  });
}

async function fetchJSON(url) {
  const res = await request(url);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode} for ${url}`);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Download a dataset into the cache unless an identical copy is there. */
async function ensureDataset(kind, set, format, cacheDir) {
  const url = `https://17lands-public.s3.amazonaws.com/analysis_data/${kind}/${kind}_public.${set}.${format}.csv.gz`;
  const file = path.join(cacheDir, `${kind}.${set}.${format}.csv.gz`);
  const head = await request(url, { method: 'HEAD' });
  head.resume();
  if (head.statusCode !== 200) throw new Error(`${kind} for ${set} ${format} not published yet (HTTP ${head.statusCode})`);
  const size = Number(head.headers['content-length']);
  const modified = head.headers['last-modified'] ?? null;
  if (fs.existsSync(file) && fs.statSync(file).size === size) return { file, modified };
  fs.mkdirSync(cacheDir, { recursive: true });
  process.stdout.write(`  downloading ${kind} (${(size / 1e6).toFixed(0)} MB)… `);
  const res = await request(url);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file + '.part');
    res.pipe(out);
    out.on('finish', resolve);
    res.on('error', reject);
  });
  fs.renameSync(file + '.part', file);
  console.log('done');
  return { file, modified };
}

// ─── Card identity ────────────────────────────────────────────────────────────

/**
 * Dataset columns are card names; the app keys by Arena grpId. 17Lands' card
 * list (legacy endpoint — still lists every card with its mtga_id even after
 * the stats window has passed) bridges the two.
 */
async function loadCardList(set) {
  const list = await fetchJSON(`https://www.17lands.com/card_ratings/data?expansion=${set}&format=PremierDraft`);
  const byName = new Map();
  list.forEach((c, order) => {
    if (c.mtga_id == null) return;
    const key = normCardName(c.name);
    if (!byName.has(key)) byName.set(key, { mtgaId: c.mtga_id, name: c.name, color: c.color ?? '', rarity: c.rarity, types: c.types ?? [], order });
  });
  return byName;
}

function pairKey(colors) {
  const s = String(colors ?? '');
  if (s.length !== 2) return null;
  return COLORS.split('').filter((c) => s.includes(c)).join('');
}

// ─── Game data pass ───────────────────────────────────────────────────────────

/**
 * Keep-or-mulligan statistics (London mulligan). For hands kept at 7: win
 * rate by number of lands, on the play and on the draw. For comparison: win
 * rate after mulliganing to 6. Note the selection effect — only hands players
 * chose to keep appear in the keep-7 rows — which is how 17Lands-style
 * mulligan analyses read this data too.
 */
function newMulliganStats() {
  const row = () => Array.from({ length: 8 }, () => [0, 0]); // [wins, games] by lands 0..7
  return { keep7: { play: row(), draw: row() }, mull6: { play: [0, 0], draw: [0, 0] }, mull5: { play: [0, 0], draw: [0, 0] } };
}

async function gamePass(file, nCards, cardIndexOf, isLand = () => false) {
  const mull = newMulliganStats();
  const z = () => new Float64Array(nCards);
  const agg = { gihW: z(), gihN: z(), ohW: z(), ohN: z(), gpW: z(), gpN: z(), gnsW: z(), gnsN: z() };
  const pairs = {}; // pair → { w: Float64Array, n: Float64Array }
  const decks = {}; // pair → { n, w, topN, topW } two-color deck results
  let cols = null, games = 0;

  for await (const { header, row } of readCsvGz(file)) {
    if (!cols) {
      cols = { won: header.indexOf('won'), main: header.indexOf('main_colors'), wr: header.indexOf('user_game_win_rate_bucket'), ng: header.indexOf('user_n_games_bucket'),
        onPlay: header.indexOf('on_play'), mulls: header.indexOf('num_mulligans'), ohAll: [], oh: [], drawn: [], deck: [] };
      // Opening-hand columns for every card, including basic lands (which
      // have no Arena id mapping but still count as lands).
      header.forEach((h, i) => { if (h.startsWith('opening_hand_')) cols.ohAll.push([i, h.slice(13)]); });
      cols.ohLand = cols.ohAll.filter(([, nm]) => isLand(nm)).map(([i]) => i);
      header.forEach((h, i) => {
        for (const [prefix, list] of [['opening_hand_', cols.oh], ['drawn_', cols.drawn], ['deck_', cols.deck]]) {
          if (h.startsWith(prefix)) {
            const idx = cardIndexOf(h.slice(prefix.length));
            if (idx != null) list[idx] = i;
          }
        }
      });
    }
    games++;
    const won = row[cols.won] === 'True' ? 1 : 0;
    const side = row[cols.onPlay] === 'True' ? 'play' : 'draw';
    const mulls = Number(row[cols.mulls]);
    if (mulls === 0) {
      let lands = 0;
      for (const i of cols.ohLand) lands += Number(row[i]) || 0;
      const cell = mull.keep7[side][Math.min(7, lands)];
      cell[0] += won; cell[1]++;
    } else if (mulls === 1 || mulls === 2) {
      const cell = (mulls === 1 ? mull.mull6 : mull.mull5)[side];
      cell[0] += won; cell[1]++;
    }
    const pair = pairKey(row[cols.main]);
    let pp = null;
    if (pair) {
      pp = pairs[pair] ?? (pairs[pair] = { w: z(), n: z() });
      const dk = decks[pair] ?? (decks[pair] = { n: 0, w: 0, topN: 0, topW: 0 });
      dk.n++; dk.w += won;
      if (Number(row[cols.wr]) >= TOP_WR_BUCKET && Number(row[cols.ng]) >= TOP_MIN_GAMES_BUCKET) { dk.topN++; dk.topW += won; }
    }
    for (let c = 0; c < nCards; c++) {
      const di = cols.deck[c];
      if (di === undefined || row[di] === '0' || row[di] === '') continue;
      const inOh = row[cols.oh[c]] !== '0';
      const drawn = row[cols.drawn[c]] !== '0';
      agg.gpN[c]++; agg.gpW[c] += won;
      if (inOh) { agg.ohN[c]++; agg.ohW[c] += won; }
      if (inOh || drawn) {
        agg.gihN[c]++; agg.gihW[c] += won;
        if (pp) { pp.n[c]++; pp.w[c] += won; }
      } else { agg.gnsN[c]++; agg.gnsW[c] += won; }
    }
  }
  return { agg, pairs, decks, games, mull };
}

// ─── Draft data pass ──────────────────────────────────────────────────────────

/** Growable flat Int32 storage for variable-length lists. */
class Ragged {
  constructor() { this.data = new Int32Array(1 << 20); this.len = 0; this.offsets = [0]; }
  push(list) {
    while (this.len + list.length > this.data.length) {
      const bigger = new Int32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data.set(list, this.len);
    this.len += list.length;
    this.offsets.push(this.len);
  }
  get(i) { return this.data.subarray(this.offsets[i], this.offsets[i + 1]); }
  get size() { return this.offsets.length - 1; }
}

function hashId(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

async function draftPass(file, nCards, cardIndexOf) {
  const ataSum = new Float64Array(nCards), ataN = new Float64Array(nCards);
  const wheelObs = Array.from({ length: 6 }, () => new Float64Array(nCards));
  const wheelHit = Array.from({ length: 6 }, () => new Float64Array(nCards));
  // Top-player picks for model training / evaluation.
  const train = { pool: new Ragged(), pack: new Ragged(), taken: [], pickNo: [] };
  const evalDrafts = [];
  let cols = null, drafts = 0, picks = 0, packSize = null;

  let curId = null, curRows = [];
  const flush = () => {
    if (!curRows.length) return;
    drafts++;
    const top = curRows[0].top;
    // Wheel observations: the pack seen at pick p (0-based) returns at p + 8.
    const byKey = new Map(curRows.map((r) => [r.packNo * 100 + r.pickNo, r]));
    for (const r of curRows) {
      if (r.pickNo > 5) continue;
      const back = byKey.get(r.packNo * 100 + r.pickNo + POD_SIZE);
      if (!back) continue;
      const backCounts = new Map();
      for (const c of back.pack) backCounts.set(c, (backCounts.get(c) ?? 0) + 1);
      const counts = new Map();
      for (const c of r.pack) counts.set(c, (counts.get(c) ?? 0) + 1);
      for (const [c, k] of counts) {
        const left = k - (r.taken === c ? 1 : 0);
        if (left <= 0) continue;
        wheelObs[r.pickNo][c] += left;
        wheelHit[r.pickNo][c] += Math.min(left, backCounts.get(c) ?? 0);
      }
    }
    if (top) {
      const held = hashId(curId) % EVAL_FRACTION === 0;
      if (held) {
        if (evalDrafts.length < 3000) evalDrafts.push({ id: curId, picks: curRows.map((r) => ({ p: r.packNo, i: r.pickNo, cards: r.pack, taken: r.taken })) });
      } else {
        for (const r of curRows) {
          train.pool.push(r.pool); train.pack.push(r.pack);
          train.taken.push(r.taken); train.pickNo.push(r.packNo * 15 + r.pickNo);
        }
      }
    }
    curRows = [];
  };

  for await (const { header, row } of readCsvGz(file)) {
    if (!cols) {
      cols = {
        id: header.indexOf('draft_id'), packNo: header.indexOf('pack_number'), pickNo: header.indexOf('pick_number'),
        pick: header.indexOf('pick'), wr: header.indexOf('user_game_win_rate_bucket'), ng: header.indexOf('user_n_games_bucket'),
        pack: [], pool: [],
      };
      header.forEach((h, i) => {
        if (h.startsWith('pack_card_')) { const c = cardIndexOf(h.slice(10)); if (c != null) cols.pack.push([i, c]); }
        if (h.startsWith('pool_')) { const c = cardIndexOf(h.slice(5)); if (c != null) cols.pool.push([i, c]); }
      });
    }
    const id = row[cols.id];
    if (id !== curId) { flush(); curId = id; }
    const packNo = Number(row[cols.packNo]), pickNo = Number(row[cols.pickNo]);
    const taken = cardIndexOf(row[cols.pick]);
    const expand = (list) => {
      const out = [];
      for (const [i, c] of list) { const k = Number(row[i]); for (let j = 0; j < k; j++) out.push(c); }
      return out;
    };
    const pack = expand(cols.pack);
    if (pickNo === 0 && packSize == null) packSize = pack.length;
    if (taken != null) { ataSum[taken] += pickNo + 1; ataN[taken]++; }
    picks++;
    curRows.push({
      packNo, pickNo, taken, pack,
      pool: expand(cols.pool),
      top: Number(row[cols.wr]) >= TOP_WR_BUCKET && Number(row[cols.ng]) >= TOP_MIN_GAMES_BUCKET,
    });
  }
  flush();
  return { ataSum, ataN, wheelObs, wheelHit, train, evalDrafts, drafts, picks, packSize };
}

// ─── Pick model ───────────────────────────────────────────────────────────────

/**
 * What would a top player take from this pack, given their pool?
 *
 *   logit(c) = b[c] + u[c] · mean(v[p] for p in pool)
 *
 * b is the card's stand-alone desirability; v places pool cards in a small
 * latent space (colors, archetypes, synergies emerge on their own) and u says
 * which pools a candidate fits. Softmax over the cards in the pack. ~33
 * floats per card, microseconds per prediction — cheap enough to run on every
 * pack inside the overlay. Trained with AdaGrad on top-player picks.
 */
function trainPickModel(train, nCards, { dim = 16, epochs = 4, lr = 0.05, l2 = 1e-6, log = console.log } = {}) {
  const b = new Float64Array(nCards);
  const u = new Float64Array(nCards * dim).map(() => (Math.random() - 0.5) * 0.02);
  const v = new Float64Array(nCards * dim).map(() => (Math.random() - 0.5) * 0.02);
  const gb = new Float64Array(nCards).fill(1e-8), gu = new Float64Array(nCards * dim).fill(1e-8), gv = new Float64Array(nCards * dim).fill(1e-8);
  const n = train.taken.length;
  const order = Uint32Array.from({ length: n }, (_, i) => i);
  const h = new Float64Array(dim), dh = new Float64Array(dim);

  for (let ep = 0; ep < epochs; ep++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let loss = 0, hits = 0, counted = 0;
    for (const idx of order) {
      const taken = train.taken[idx];
      if (taken == null) continue;
      const pool = train.pool.get(idx);
      const pack = [...new Set(train.pack.get(idx))];
      if (pack.length < 2) continue;
      h.fill(0);
      for (const p of pool) for (let d = 0; d < dim; d++) h[d] += v[p * dim + d];
      const inv = pool.length ? 1 / pool.length : 0;
      for (let d = 0; d < dim; d++) h[d] *= inv;
      const logits = pack.map((c) => { let s = b[c]; for (let d = 0; d < dim; d++) s += u[c * dim + d] * h[d]; return s; });
      const mx = Math.max(...logits);
      const ex = logits.map((x) => Math.exp(x - mx));
      const Z = ex.reduce((a, x) => a + x, 0);
      const ti = pack.indexOf(taken);
      if (ti < 0) continue;
      loss -= Math.log(ex[ti] / Z);
      counted++;
      if (logits[ti] === mx) hits++;
      dh.fill(0);
      for (let k = 0; k < pack.length; k++) {
        const c = pack[k];
        const g = ex[k] / Z - (k === ti ? 1 : 0);
        gb[c] += g * g; b[c] -= lr * g / Math.sqrt(gb[c]);
        for (let d = 0; d < dim; d++) {
          const j = c * dim + d;
          dh[d] += g * u[j];
          const gj = g * h[d] + l2 * u[j];
          gu[j] += gj * gj; u[j] -= lr * gj / Math.sqrt(gu[j]);
        }
      }
      if (pool.length) {
        for (const p of pool) {
          for (let d = 0; d < dim; d++) {
            const j = p * dim + d;
            const gj = dh[d] * inv + l2 * v[j];
            gv[j] += gj * gj; v[j] -= lr * gj / Math.sqrt(gv[j]);
          }
        }
      }
    }
    log(`  epoch ${ep + 1}/${epochs}: loss ${(loss / counted).toFixed(4)}  train top-1 ${(100 * hits / counted).toFixed(1)}%`);
  }
  return { dim, b, u, v };
}

function modelTop1(model, nCards, drafts, cardIdx) {
  const { dim, b, u, v } = model;
  let hits = 0, total = 0, hitsBase = 0;
  for (const d of drafts) {
    const pool = [];
    for (const pk of d.picks) {
      const h = new Float64Array(dim);
      for (const p of pool) for (let k = 0; k < dim; k++) h[k] += v[p * dim + k];
      const inv = pool.length ? 1 / pool.length : 0;
      let best = -1, bestS = -Infinity, bestB = -1, bestBS = -Infinity;
      for (const c of new Set(pk.cards)) {
        let s = b[c];
        for (let k = 0; k < dim; k++) s += u[c * dim + k] * h[k] * inv;
        if (s > bestS) { bestS = s; best = c; }
        if (b[c] > bestBS) { bestBS = b[c]; bestB = c; }
      }
      if (pk.taken != null && pk.cards.length > 1) {
        total++;
        if (best === pk.taken) hits++;
        if (bestB === pk.taken) hitsBase++;
      }
      if (pk.taken != null) pool.push(pk.taken);
    }
  }
  return { top1: hits / total, baseTop1: hitsBase / total, picks: total };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const r4 = (x) => Math.round(x * 1e4) / 1e4;

async function main() {
  const args = parseArgs(process.argv);
  const t0 = Date.now();
  console.log(`Building ${args.set} (${args.format})`);

  const cardList = await loadCardList(args.set);
  const draft = await ensureDataset('draft_data', args.set, args.format, args.cache);
  const game = await ensureDataset('game_data', args.set, args.format, args.cache);

  // Card index = dataset column order; map each to an Arena grpId.
  const names = [];
  const indexByName = new Map();
  const cardIndexOf = (name) => {
    const key = normCardName(name);
    if (!key) return null;
    let i = indexByName.get(key);
    if (i === undefined) { i = names.length; names.push(name); indexByName.set(key, i); }
    return i;
  };
  // Seed the index from the draft header so indices are stable.
  for await (const { header } of readCsvGz(draft.file)) {
    for (const h of header) if (h.startsWith('pack_card_')) cardIndexOf(h.slice(10));
    break;
  }
  const nCards = names.length;
  const unmapped = names.filter((nm) => !cardList.has(normCardName(nm)));
  console.log(`  ${nCards} cards in dataset; ${unmapped.length} without an Arena id${unmapped.length ? ': ' + unmapped.slice(0, 5).join(', ') : ''}`);

  console.log('  game data pass…');
  const BASICS = new Set(['plains', 'island', 'swamp', 'mountain', 'forest', 'wastes']);
  const isLand = (nm) => {
    const key = normCardName(nm);
    if (BASICS.has(key)) return true;
    const meta = cardList.get(key);
    return !!meta && meta.types.some((t) => /\bLand\b/.test(t)) && !meta.types.some((t) => /\bCreature\b/.test(t));
  };
  const g = await gamePass(game.file, nCards, (nm) => indexByName.get(normCardName(nm)), isLand);
  console.log(`    ${g.games} games`);
  console.log('  draft data pass…');
  const d = await draftPass(draft.file, nCards, (nm) => indexByName.get(normCardName(nm)));
  console.log(`    ${d.drafts} drafts, ${d.picks} picks, pack size ${d.packSize}; ${d.train.taken.length} top-player training picks, ${d.evalDrafts.length} held-out drafts`);

  console.log('  training pick model…');
  const model = trainPickModel(d.train, nCards, { dim: args.dim, epochs: args.epochs });
  const evalRes = modelTop1(model, nCards, d.evalDrafts);
  console.log(`  held-out top-1 agreement: model ${(100 * evalRes.top1).toFixed(1)}%  (card bias only: ${(100 * evalRes.baseTop1).toFixed(1)}%) over ${evalRes.picks} picks`);

  // ── Assemble the shipped table ────────────────────────────────────────────
  const cards = {};
  const modelOrder = [];
  for (let c = 0; c < nCards; c++) {
    const meta = cardList.get(normCardName(names[c]));
    if (!meta) continue;
    const rate = (w, n) => (n > 0 ? r4(w / n) : null);
    const pairs = {};
    for (const [pair, pp] of Object.entries(g.pairs)) {
      if (pp.n[c] >= 20) pairs[pair] = [r4(pp.w[c] / pp.n[c]), pp.n[c]];
    }
    const wheel = d.wheelObs.map((obs, p) => (obs[c] >= 30 ? r4(d.wheelHit[p][c] / obs[c]) : null));
    cards[meta.mtgaId] = {
      name: meta.name, color: meta.color, rarity: meta.rarity, types: meta.types,
      order: meta.order, // position in 17Lands' card list ≈ collector number (Arena pack sort)
      gih: rate(g.agg.gihW[c], g.agg.gihN[c]), gihN: g.agg.gihN[c],
      oh: rate(g.agg.ohW[c], g.agg.ohN[c]), ohN: g.agg.ohN[c],
      gp: rate(g.agg.gpW[c], g.agg.gpN[c]), gpN: g.agg.gpN[c],
      gns: rate(g.agg.gnsW[c], g.agg.gnsN[c]),
      ata: d.ataN[c] > 0 ? Math.round((d.ataSum[c] / d.ataN[c]) * 100) / 100 : null,
      pairs, wheel,
    };
    modelOrder.push([meta.mtgaId, c]);
  }
  const dim = model.dim;
  const out = {
    schema: 1,
    set: args.set,
    format: args.format,
    generatedAt: new Date().toISOString(),
    source: {
      attribution: 'Derived from 17Lands public datasets (https://www.17lands.com/public_datasets), CC BY 4.0',
      draftDataModified: draft.modified, gameDataModified: game.modified,
      drafts: d.drafts, games: g.games, packSize: d.packSize,
    },
    // Same shape as 17landsData.fetchColorRatings().pairs, so it can stand in for it.
    // Keep-vs-mulligan win rates: keep7[play|draw][lands] = [winRate, games].
    mulligan: (() => {
      const rate = ([w, n]) => [n ? r4(w / n) : null, n];
      return {
        keep7: { play: g.mull.keep7.play.map(rate), draw: g.mull.keep7.draw.map(rate) },
        mull6: { play: rate(g.mull.mull6.play), draw: rate(g.mull.mull6.draw) },
        mull5: { play: rate(g.mull.mull5.play), draw: rate(g.mull.mull5.draw) },
      };
    })(),
    pairs: Object.fromEntries(Object.entries(g.decks).map(([p, x]) => [p, {
      games: x.n, wins: x.w, topgames: x.topN, topwins: x.topW,
      wr: x.n ? r4(x.w / x.n) : null, topWr: x.topN ? r4(x.topW / x.topN) : null,
    }])),
    cards,
    model: {
      kind: 'pool-factorization', dim,
      evalTop1: r4(evalRes.top1), evalBaseTop1: r4(evalRes.baseTop1), evalPicks: evalRes.picks,
      ids: modelOrder.map(([id]) => id),
      b: modelOrder.map(([, c]) => r4(model.b[c])),
      u: modelOrder.flatMap(([, c]) => Array.from(model.u.subarray(c * dim, c * dim + dim), r4)),
      v: modelOrder.flatMap(([, c]) => Array.from(model.v.subarray(c * dim, c * dim + dim), r4)),
    },
  };
  fs.mkdirSync(args.out, { recursive: true });
  const outFile = path.join(args.out, `${args.set}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out));

  // Held-out drafts for scripts/eval-picks.js (dev only), in grpIds.
  const idOf = names.map((nm) => cardList.get(normCardName(nm))?.mtgaId ?? null);
  const evalOut = d.evalDrafts.map((dr) => dr.picks.map((pk) => ({ p: pk.p, i: pk.i, cards: pk.cards.map((c) => idOf[c]).filter(Boolean), taken: pk.taken != null ? idOf[pk.taken] : null })));
  const evalFile = path.join(args.cache, `eval.${args.set}.${args.format}.json.gz`);
  fs.writeFileSync(evalFile, zlib.gzipSync(JSON.stringify({ set: args.set, packSize: d.packSize, drafts: evalOut })));

  console.log(`  wrote ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB) and ${evalFile}`);
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { trainPickModel, pairKey, hashId };
