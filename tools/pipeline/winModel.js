/**
 * winModel.js — what makes a draft deck win, learned from 17Lands game data.
 *
 * The pick model (build-set.js) imitates top players. This one learns from
 * outcomes instead: a logistic regression of "did this game's deck win" on
 * the deck's contents, with the player's skill, rank and play/draw as
 * controls. Without the controls, a card's win rate mostly measures who
 * plays it (good players pick good cards *and* play well).
 *
 *   logit P(win) = nuisance(skill, games played, rank, on play)
 *                + pair[P] + lands[L] + creatures[K]
 *                + Σ_c count_c · (w[c] + w[c,P])
 *
 * w[c] is a card's value per copy in any deck; w[c,P] adjusts it inside the
 * two-color deck P (heavily shrunk — pair samples are small). Only
 * differences between cards matter: every deck has ~23 spells, so a common
 * shift is absorbed by the intercept.
 *
 * Games are held out by draft (hashId(draft_id) % 10 === 0, the same split
 * build-set.js uses for its held-out drafts), so every evaluation runs on
 * drafts the model never saw.
 */
'use strict';

const { readCsvGz, normCardName } = require('./csv');
const { cardTable, TRAIT, TRAIT_LIST } = require('./cards');
const { cardMask, PAIRS: VALUE_PAIRS } = require('../../src/main/winValue');

const PAIRS = ['WU', 'WB', 'WR', 'WG', 'UB', 'UR', 'UG', 'BR', 'BG', 'RG'];
const COLORS = 'WUBRG';
const RANKS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'mythic'];
const N_GAMES_BUCKETS = ['1', '5', '10', '50', '100', '500', '1000'];
const BASICS = new Set(['plains', 'island', 'swamp', 'mountain', 'forest', 'wastes']);

function hashId(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function pairIndexOf(colors) {
  const s = String(colors ?? '');
  if (s.length !== 2) return -1;
  return PAIRS.indexOf(COLORS.split('').filter((c) => s.includes(c)).join(''));
}

// ─── Feature layout ───────────────────────────────────────────────────────────
// Dense "slots" first (one weight each), then per-card weights, then per-card
// per-pair weights. A game is a list of (index, value) pairs.

function layout(nCards) {
  let k = 0;
  const L = {};
  L.bias = k++;
  L.skill = k; k += 30;          // win-rate bucket 0.20 … 0.80 in 0.02 steps (clamped)
  L.nGames = k; k += N_GAMES_BUCKETS.length;
  L.rank = k; k += RANKS.length;
  L.onPlay = k++;
  L.pair = k; k += PAIRS.length + 2;  // 10 pairs, mono, 3+ colors
  L.splash = k++;
  L.lands = k; k += 5;           // ≤15, 16, 17, 18, 19+
  // Deck shape: one weight per hinge, so the model learns e.g. how much each
  // creature short of 15 costs.
  for (const [name, s] of Object.entries(STRUCTURE)) { L[name] = k; k += s.short.length + s.over.length; }
  L.dense = k;
  L.card = k; k += nCards;
  L.cardPair = k; k += nCards * PAIRS.length;
  L.size = k;
  return L;
}

const skillSlot = (b) => Math.max(0, Math.min(29, Math.round((Number(b) - 0.2) / 0.02)));
const landSlot = (n) => (n <= 15 ? 0 : n >= 19 ? 4 : n - 15);

// ─── Deck shape ───────────────────────────────────────────────────────────────

// Deck shape as piecewise-linear hinges: `short` knots k contribute
// max(0, k − count), `over` knots max(0, count − k). The straight-line part
// of each trait is already in the card values; the hinges learn where a
// shortage (or a glut) starts to cost games, smoothly enough to score
// fractional expected counts.
const STRUCTURE = {
  creatures: { trait: TRAIT.creature, short: [11, 13, 15], over: [18] },
  twoDrops: { trait: TRAIT.twoDrop, short: [2, 4], over: [] },
  removal: { trait: TRAIT.removal, short: [2, 4], over: [] },
  topEnd: { trait: TRAIT.topEnd, short: [], over: [2, 4] },
};
/** Hinge amounts for one shape trait at count n (short knots, then over knots). */
const hinges = (s, n) => [...s.short.map((k) => Math.max(0, k - n)), ...s.over.map((k) => Math.max(0, n - k))];

// ─── Loading ──────────────────────────────────────────────────────────────────

/**
 * Read every game into compact arrays. `cards` maps a normalized card name to
 * { idx, land, traits } for the cards we model (basics are only counted as
 * lands).
 */
async function loadGames(file, cards) {
  const games = { won: [], heldOut: [], pair: [], draftHash: [], feats: [], decks: [], pairByDraft: new Map() };
  let cols = null;
  for await (const { header, row } of readCsvGz(file)) {
    if (!cols) {
      cols = {
        draft: header.indexOf('draft_id'), won: header.indexOf('won'), main: header.indexOf('main_colors'),
        splash: header.indexOf('splash_colors'), onPlay: header.indexOf('on_play'), rank: header.indexOf('rank'),
        wr: header.indexOf('user_game_win_rate_bucket'), ng: header.indexOf('user_n_games_bucket'),
        deck: [], basics: [],
      };
      header.forEach((h, i) => {
        if (!h.startsWith('deck_')) return;
        const key = normCardName(h.slice(5));
        if (BASICS.has(key)) cols.basics.push(i);
        else if (cards.has(key)) cols.deck.push([i, cards.get(key)]);
      });
    }
    const draftId = row[cols.draft];
    const h = hashId(draftId);
    let lands = 0;
    for (const i of cols.basics) lands += Number(row[i]) || 0;
    const deck = [];
    const shape = {};
    for (const name of Object.keys(STRUCTURE)) shape[name] = 0;
    for (const [i, meta] of cols.deck) {
      const n = Number(row[i]) || 0;
      if (!n) continue;
      deck.push(meta.idx, n);
      if (meta.land) lands += n;
      for (const [name, s] of Object.entries(STRUCTURE)) if (meta.traits & s.trait) shape[name] += n;
    }
    const main = row[cols.main] ?? '';
    const p = pairIndexOf(main);
    games.won.push(row[cols.won] === 'True' ? 1 : 0);
    games.heldOut.push(h % 10 === 0);
    games.draftHash.push(h);
    games.pair.push(p);
    if (p >= 0 && !games.pairByDraft.has(draftId)) games.pairByDraft.set(draftId, p);
    games.decks.push(Int32Array.from(deck));
    games.feats.push({
      skill: skillSlot(row[cols.wr]),
      nGames: Math.max(0, N_GAMES_BUCKETS.indexOf(row[cols.ng])),
      rank: RANKS.indexOf(row[cols.rank]),
      onPlay: row[cols.onPlay] === 'True' ? 1 : 0,
      pairSlot: p >= 0 ? p : main.length <= 1 ? PAIRS.length : PAIRS.length + 1,
      splash: (row[cols.splash] ?? '') !== '' ? 1 : 0,
      lands: landSlot(lands),
      landsN: lands,
      splashColors: String(row[cols.splash] ?? "").replace(/[^WUBRG]/g, ""),
      shape: Object.entries(STRUCTURE).map(([name, s]) => hinges(s, shape[name])),
    });
  }
  return games;
}

/** Sparse feature list for game g under the chosen feature groups. */
function features(games, g, L, use) {
  const f = games.feats[g];
  const idx = [L.bias], val = [1];
  if (use.nuisance) {
    idx.push(L.skill + f.skill, L.nGames + f.nGames); val.push(1, 1);
    if (f.rank >= 0) { idx.push(L.rank + f.rank); val.push(1); }
    idx.push(L.onPlay); val.push(f.onPlay);
  }
  if (use.pair) {
    idx.push(L.pair + f.pairSlot, L.splash); val.push(1, f.splash);
  }
  if (use.structure) {
    idx.push(L.lands + f.lands); val.push(1);
    Object.keys(STRUCTURE).forEach((name, j) => f.shape[j].forEach((x, h) => { if (x) { idx.push(L[name] + h); val.push(x); } }));
  }
  if (use.cards) {
    const d = games.decks[g];
    const p = games.pair[g];
    for (let k = 0; k < d.length; k += 2) {
      idx.push(L.card + d[k]); val.push(d[k + 1]);
      if (use.cardPair && p >= 0) { idx.push(L.cardPair + d[k] * PAIRS.length + p); val.push(d[k + 1]); }
    }
  }
  // Research hook: extra features, [[index, value], …] (indices ≥ L.size of
  // the base layout; the caller enlarges L.size).
  if (use.extra) for (const [i, v] of use.extra(g)) { if (v) { idx.push(i); val.push(v); } }
  return { idx, val };
}

// ─── Training ─────────────────────────────────────────────────────────────────

/**
 * L2-regularized logistic regression, AdaGrad SGD. Penalties are ridge
 * strengths on the summed loss: `l2` for dense slots and per-card weights,
 * `l2Pair` (much larger) for per-pair weights.
 */
function train(games, L, use, { epochs = 6, lr = 0.05, l2 = 20, l2Pair = 400, include = null, seed = null, log = () => {} } = {}) {
  // A seed makes the shuffle order repeatable (research: compare variants on equal footing).
  let st = seed ?? 0;
  const rand = seed == null ? Math.random : () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return st / 4294967296; };
  const w = new Float64Array(L.size);
  const G = new Float64Array(L.size).fill(1e-8);
  const trainIdx = [];
  for (let g = 0; g < games.won.length; g++) if (!games.heldOut[g] && (!include || include(g))) trainIdx.push(g);
  const feats = trainIdx.map((g) => features(games, g, L, use));
  const order = Uint32Array.from(trainIdx.keys());
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let loss = 0;
    for (const k of order) {
      const { idx, val } = feats[k];
      const y = games.won[trainIdx[k]];
      let z = 0;
      for (let j = 0; j < idx.length; j++) z += w[idx[j]] * val[j];
      const p = 1 / (1 + Math.exp(-z));
      loss -= y ? Math.log(p + 1e-12) : Math.log(1 - p + 1e-12);
      const e = p - y;
      for (let j = 0; j < idx.length; j++) {
        const i = idx[j];
        const reg = i === L.bias ? 0 : (i >= L.cardPair ? l2Pair : l2) * w[i] / trainIdx.length;
        const gr = e * val[j] + reg;
        G[i] += gr * gr;
        w[i] -= lr * gr / Math.sqrt(G[i]);
      }
    }
    log(`    epoch ${ep + 1}/${epochs}: train loss ${(loss / order.length).toFixed(5)}`);
  }
  return w;
}

function predictLogit(w, games, g, L, use) {
  const { idx, val } = features(games, g, L, use);
  let z = 0;
  for (let j = 0; j < idx.length; j++) z += w[idx[j]] * val[j];
  return z;
}

/** Held-out log loss and AUC. `score(g)` returns a logit. */
function heldOutMetrics(games, score) {
  const pts = [];
  let loss = 0;
  for (let g = 0; g < games.won.length; g++) {
    if (!games.heldOut[g]) continue;
    const z = score(g);
    const p = 1 / (1 + Math.exp(-z));
    const y = games.won[g];
    loss -= y ? Math.log(p) : Math.log(1 - p);
    pts.push([z, y]);
  }
  return { logloss: loss / pts.length, auc: auc(pts), n: pts.length };
}

function auc(pts) {
  pts.sort((a, b) => a[0] - b[0]);
  let pos = 0, neg = 0, rankSum = 0;
  for (let i = 0; i < pts.length;) {
    let j = i;
    while (j < pts.length && pts[j][0] === pts[i][0]) j++;
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (pts[k][1]) { rankSum += avgRank; pos++; } else neg++;
    i = j;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

// ─── Value block for the set table ────────────────────────────────────────────

/**
 * One pass over draft data. For training drafts whose deck pair is known
 * (from game data), the "phantom" future pick per pair and pick index: the
 * mean value of what drafters who ended in that pair took, how often it was
 * castable there, and how often it was a creature / two-drop / removal /
 * 6+ drop. Also collects held-out drafts (with match results) and
 * first-pick packs for research.
 *
 * `cardOf(name)` → { idx, mtgaId, mask, traits } or null; `ws` is a list of card
 * value vectors (w[idx]); phantoms are computed for each.
 */
async function draftPassForValue(file, cardOf, ws, pairByDraft, { keepHeldOut = 8000, keepPacks = 30000 } = {}) {
  // Per weight vector: pair*1000 + t → [valueSum, castableN, totalN, valueSqSum].
  const sums = ws.map(() => new Map());
  const heldOut = [];
  const packs = [];
  let cols = null, cur = null, packSize = null;
  const flush = () => {
    if (!cur) return;
    // Picks per pack (the pack_card columns leave out basics, so count picks).
    if (packSize == null) packSize = Math.max(...cur.rows.map((r) => r.pickNo)) + 1;
    for (const r of cur.rows) r.t = r.packNo * packSize + r.pickNo;
    const h = hashId(cur.id);
    const p = pairByDraft.get(cur.id);
    if (h % 10 !== 0 && p != null) {
      for (const r of cur.rows) {
        if (!r.taken) continue;
        const key = p * 1000 + r.t;
        ws.forEach((w, k) => {
          const s = sums[k].get(key) ?? [0, 0, 0, 0, 0, 0, 0, 0];
          s[2]++;
          if (r.taken.mask & (1 << p)) {
            const x = w[r.taken.idx];
            s[0] += x; s[3] += x * x; s[1]++;
            TRAIT_LIST.forEach((bit, j) => { if (r.taken.traits & bit) s[4 + j]++; });
          }
          sums[k].set(key, s);
        });
      }
    }
    if (h % 10 === 0 && heldOut.length < keepHeldOut) {
      heldOut.push({ id: cur.id, wins: cur.wins, losses: cur.losses, skill: cur.skill, nGames: cur.nGames, rank: cur.rank, pair: p ?? null,
        picks: cur.rows.map((r) => ({ t: r.t, pack: r.pack, taken: r.taken?.mtgaId ?? null })) });
    }
    if (packs.length < keepPacks) for (const r of cur.rows) if (r.pickNo === 0) packs.push(r.pack);
    cur = null;
  };
  for await (const { header, row } of readCsvGz(file)) {
    if (!cols) {
      cols = {
        id: header.indexOf('draft_id'), packNo: header.indexOf('pack_number'), pickNo: header.indexOf('pick_number'), pick: header.indexOf('pick'),
        wins: header.indexOf('event_match_wins'), losses: header.indexOf('event_match_losses'), rank: header.indexOf('rank'),
        wr: header.indexOf('user_game_win_rate_bucket'), ng: header.indexOf('user_n_games_bucket'), pack: [],
      };
      header.forEach((hd, i) => { if (hd.startsWith('pack_card_')) { const c = cardOf(hd.slice(10)); if (c) cols.pack.push([i, c]); } });
    }
    const id = row[cols.id];
    if (!cur || cur.id !== id) {
      flush();
      cur = { id, rows: [], wins: Number(row[cols.wins]) || 0, losses: Number(row[cols.losses]) || 0, skill: Number(row[cols.wr]), nGames: row[cols.ng], rank: row[cols.rank] };
    }
    const packNo = Number(row[cols.packNo]), pickNo = Number(row[cols.pickNo]);
    const pack = [];
    for (const [i, c] of cols.pack) { const k = Number(row[i]); for (let j = 0; j < k; j++) pack.push(c.mtgaId); }
    cur.rows.push({ packNo, pickNo, pack, taken: cardOf(row[cols.pick]) });
  }
  flush();
  const picks = 3 * packSize;
  const phantoms = sums.map((sm) => {
    const phantom = {};
    PAIRS.forEach((pair, p) => {
      const value = [], castable = [], sd = [];
      const traits = TRAIT_LIST.map(() => []);
      for (let t = 0; t < picks; t++) {
        const s = sm.get(p * 1000 + t);
        const mean = s && s[1] ? s[0] / s[1] : 0;
        value.push(mean);
        castable.push(s && s[2] ? s[1] / s[2] : 0);
        sd.push(s && s[1] > 1 ? Math.sqrt(Math.max(0, s[3] / s[1] - mean * mean)) : 0);
        // Share of castable picks with each trait (creature, two-drop, …).
        TRAIT_LIST.forEach((_, j) => traits[j].push(s && s[1] ? s[4 + j] / s[1] : 0));
      }
      phantom[pair] = { value, castable, sd, traits };
    });
    return phantom;
  });
  return { phantoms, heldOut, packs, packSize };
}

/**
 * The `value` block shipped in the set table (read by src/main/winValue.js):
 * per-card values and trait bits, archetype effects, deck-shape weights by
 * count, and phantom future picks per pair.
 */
function valueBlock({ w, L, list, traits, phantom }) {
  const r5 = (x) => Math.round(x * 1e5) / 1e5;
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  const cw = list.map((_, i) => w[L.card + i]);
  const sorted = cw.slice().sort((x, y) => x - y);
  return {
    kind: 'deck-logit',
    ids: list.map((c) => c.mtgaId),
    w: cw.map(r5),
    traits: traits.slice(),
    traitOrder: ['creature', 'twoDrop', 'removal', 'topEnd'],
    pairBias: PAIRS.map((_, p) => r5(w[L.pair + p])),
    structure: Object.fromEntries(Object.entries(STRUCTURE).map(([name, s]) => [name, {
      short: s.short.map((k, h) => [k, r5(w[L[name] + h])]),
      over: s.over.map((k, h) => [k, r5(w[L[name] + s.short.length + h])]),
    }])),
    phantom: Object.fromEntries(Object.entries(phantom).map(([k, v]) => [k, {
      value: v.value.map(r5), castable: v.castable.map(r4), sd: v.sd.map(r5), traits: v.traits.map((a) => a.map(r4)),
    }])),
    filler: r5(sorted[Math.floor(sorted.length * 0.1)]),
    toPct: 25,
  };
}

// Feature groups of the shipped model (card × pair terms didn't improve
// held-out games on HOB, so they're left out).
const VALUE_FEATURES = { nuisance: true, pair: true, structure: true, cards: true };
const VALUE_L2 = 80;

/**
 * Fit the deck win model on a set's game data and build the table's
 * `value` block. With `halves`, also fits two models on disjoint halves of
 * the training drafts (for research: pick with one, judge with the other).
 */
async function buildValueBlock({ set, gameFile, draftFile, cache, cardColor = null, halves = false, l2 = VALUE_L2, keepHeldOut = 0, keepPacks = 0, log = console.log }) {
  if (VALUE_PAIRS.join() !== PAIRS.join()) throw new Error('pair order differs between winModel and winValue');
  const { cards, list } = await cardTable(set, cache);
  const games = await loadGames(gameFile, cards);
  const L = layout(list.length);
  const fits = [{ w: train(games, L, VALUE_FEATURES, { l2 }) }];
  if (halves) {
    const half = (g) => (games.draftHash[g] >>> 8) % 2;
    fits.push({ w: train(games, L, VALUE_FEATURES, { l2, include: (g) => half(g) === 0 }) });
    fits.push({ w: train(games, L, VALUE_FEATURES, { l2, include: (g) => half(g) === 1 }) });
  }
  const m = heldOutMetrics(games, (g) => predictLogit(fits[0].w, games, g, L, VALUE_FEATURES));
  log(`  deck win model: held-out log loss ${m.logloss.toFixed(5)}, AUC ${m.auc.toFixed(4)} on ${m.n} games`);
  const cardOf = (name) => {
    const c = cards.get(normCardName(name));
    if (!c) return null;
    const color = cardColor?.(c.mtgaId) ?? c.color;
    return { idx: c.idx, mtgaId: c.mtgaId, mask: cardMask({ types: c.types, color }), traits: c.traits };
  };
  const cws = fits.map(({ w }) => list.map((_, i) => w[L.card + i]));
  const dp = await draftPassForValue(draftFile, cardOf, cws, games.pairByDraft, { keepHeldOut, keepPacks });
  const traits = list.map((c) => cards.get(normCardName(c.name)).traits);
  const blocks = fits.map(({ w }, k) => valueBlock({ w, L, list, traits, phantom: dp.phantoms[k] }));
  const r5 = (x) => Math.round(x * 1e5) / 1e5;
  blocks[0].heldOut = { logloss: r5(m.logloss), auc: r5(m.auc), games: m.n };
  return { value: blocks[0], halves: halves ? blocks.slice(1) : null, heldOut: dp.heldOut, packs: dp.packs, packSize: dp.packSize };
}

module.exports = {
  draftPassForValue, valueBlock, buildValueBlock,
  PAIRS, RANKS, STRUCTURE, VALUE_FEATURES, VALUE_L2, layout, loadGames, features, train, predictLogit, heldOutMetrics, auc, hashId, pairIndexOf,
};
