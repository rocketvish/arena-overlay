/**
 * valuePrior.js — a deck win model for sets without public data yet.
 *
 * 17Lands' public datasets arrive 2–3 weeks into a set, so for most of a
 * set's life on Arena there is no per-set `value` block (winValue.js). What
 * carries over between sets is measured from the published tables
 * (tools/pipeline/build-prior.js → valuePrior.json), in units of a card's
 * 17Lands GIH z-score:
 *   - how much deck value a card's z is worth
 *   - deck-shape costs (creatures / two-drops / removal / top end)
 *   - what future picks look like at each pick (value, castability, traits)
 *   - how a two-color pair's win rate translates into its archetype term
 * Combined with the live 17Lands grades of the current set, that gives a
 * value block in the same shape as a published one.
 */
'use strict';

const { cardTraits } = require('./cardTraits');

const PAIRS = ['WU', 'WB', 'WR', 'WG', 'UB', 'UR', 'UG', 'BR', 'BG', 'RG'];
const SHAPE = ['creatures', 'twoDrops', 'removal', 'topEnd'];
const PRIOR_PACK = 14; // prior phantoms are stored for 14-card packs

const logit = (p) => Math.log(p / (1 - p));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Least-squares y = a + b·x. */
function fitLine(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** Resample a per-pick array (3 packs of `from` picks) to packs of `to` picks. */
function resample(arr, from, to) {
  const out = [];
  for (let pack = 0; pack < 3; pack++) {
    for (let i = 0; i < to; i++) {
      const u = to > 1 ? (i * (from - 1)) / (to - 1) : 0;
      const lo = Math.floor(u), hi = Math.min(from - 1, lo + 1), f = u - lo;
      out.push(arr[pack * from + lo] * (1 - f) + arr[pack * from + hi] * f);
    }
  }
  return out;
}

/** GIH z-scores of a table's cards (cards with enough games). */
function tableZ(table, minGames = 300) {
  const cs = Object.entries(table.cards ?? {}).filter(([, c]) => c.gih != null && (c.gihN ?? 0) >= minGames);
  const m = mean(cs.map(([, c]) => c.gih));
  const sd = Math.sqrt(mean(cs.map(([, c]) => (c.gih - m) ** 2)));
  return new Map(cs.map(([id, c]) => [Number(id), (c.gih - m) / sd]));
}

/**
 * The cross-set prior from published tables (each with a `value` block).
 * Everything in z units except structure weights and pair slopes, which are
 * already in log-odds.
 */
function derivePrior(tables) {
  const per = [];
  for (const t of tables) {
    const v = t?.value;
    if (!v?.phantom || !Array.isArray(v.w)) continue;
    const z = tableZ(t);
    const xs = [], ys = [];
    v.ids.forEach((id, i) => { if (z.has(id)) { xs.push(z.get(id)); ys.push(v.w[i]); } });
    if (xs.length < 50) continue;
    const { a, b } = fitLine(xs, ys);
    const packSize = v.phantom.WU.value.length / 3;
    // Phantoms averaged over pairs (by how often each pair is played), in z units.
    const games = PAIRS.map((p) => t.pairs?.[p]?.games ?? 0);
    const G = games.reduce((s, g) => s + g, 0) || 1;
    const avg = (pick) => {
      const n = v.phantom.WU.value.length;
      return Array.from({ length: n }, (_, k) => PAIRS.reduce((s, p, j) => s + (games[j] / G) * pick(v.phantom[p], k), 0));
    };
    const ph = {
      valueZ: avg((ph, k) => (ph.value[k] - a) / b),
      sdZ: avg((ph, k) => (ph.sd?.[k] ?? 0) / b),
      castable: avg((ph, k) => ph.castable[k]),
      traits: SHAPE.map((_, j) => avg((ph, k) => ph.traits?.[j]?.[k] ?? 0)),
    };
    const resampled = {
      valueZ: resample(ph.valueZ, packSize, PRIOR_PACK),
      sdZ: resample(ph.sdZ, packSize, PRIOR_PACK),
      castable: resample(ph.castable, packSize, PRIOR_PACK),
      traits: ph.traits.map((arr) => resample(arr, packSize, PRIOR_PACK)),
    };
    // Archetype term vs the pair's win rate (both centered).
    const wrs = PAIRS.map((p) => t.pairs?.[p]?.wr).map((w) => (w ? logit(w) : null));
    const ok = PAIRS.map((_, j) => wrs[j] != null && games[j] > 500);
    const lm = mean(wrs.filter((_, j) => ok[j]));
    const pm = mean(v.pairBias.filter((_, j) => ok[j]));
    let sxy = 0, sxx = 0;
    PAIRS.forEach((_, j) => { if (!ok[j]) return; const x = wrs[j] - lm; sxy += x * (v.pairBias[j] - pm); sxx += x * x; });
    per.push({
      set: t.set, wPerZ: b, fillerZ: (v.filler - a) / b, pairSlope: sxx ? sxy / sxx : 0,
      structure: v.structure, phantom: resampled,
    });
  }
  if (!per.length) return null;
  const avgArr = (get) => get(per[0]).map((_, k) => mean(per.map((p) => get(p)[k])));
  const structure = Object.fromEntries(SHAPE.map((name) => {
    const s = per[0].structure?.[name] ?? { short: [], over: [] };
    const knot = (kind) => s[kind].map(([k], h) => [k, mean(per.map((p) => p.structure?.[name]?.[kind]?.[h]?.[1] ?? 0))]);
    return [name, { short: knot('short'), over: knot('over') }];
  }));
  const r5 = (x) => Math.round(x * 1e5) / 1e5;
  return {
    sets: per.map((p) => p.set),
    wPerZ: r5(mean(per.map((p) => p.wPerZ))),
    fillerZ: r5(mean(per.map((p) => p.fillerZ))),
    pairSlope: r5(mean(per.map((p) => p.pairSlope))),
    structure: Object.fromEntries(Object.entries(structure).map(([k, s]) => [k, { short: s.short.map(([a, w]) => [a, r5(w)]), over: s.over.map(([a, w]) => [a, r5(w)]) }])),
    phantom: {
      valueZ: avgArr((p) => p.phantom.valueZ).map(r5),
      sdZ: avgArr((p) => p.phantom.sdZ).map(r5),
      castable: avgArr((p) => p.phantom.castable).map(r5),
      traits: SHAPE.map((_, j) => avgArr((p) => p.phantom.traits[j]).map(r5)),
    },
  };
}

const UNKNOWN_Z = -0.3; // listed by 17Lands but no win rate yet: slightly below average

/**
 * A `value` block (winValue.prepareValue's input) for a set from the prior:
 *   cards     [{ mtgaId, color, types | typeLine, cmc, oracleText, z }]
 *   pairWr    { WU: winRate, … } — 17Lands' live two-color win rates
 *   packSize  picks per pack in this event
 */
function buildPriorValue(prior, cards, pairWr = {}, packSize = PRIOR_PACK) {
  if (!prior || !cards?.length) return null;
  const ids = [], w = [], traits = [];
  for (const c of cards) {
    if (c.mtgaId == null) continue;
    ids.push(c.mtgaId);
    w.push(prior.wPerZ * (Number.isFinite(c.z) ? c.z : UNKNOWN_Z));
    traits.push(cardTraits(c));
  }
  const known = PAIRS.filter((p) => pairWr[p] > 0 && pairWr[p] < 1);
  const center = known.length ? mean(known.map((p) => logit(pairWr[p]))) : 0;
  const pairBias = PAIRS.map((p) => (known.includes(p) ? prior.pairSlope * (logit(pairWr[p]) - center) : 0));
  const ph = prior.phantom;
  const fit = (arr) => (packSize === PRIOR_PACK ? arr : resample(arr, PRIOR_PACK, packSize));
  const one = {
    value: fit(ph.valueZ).map((z) => prior.wPerZ * z),
    sd: fit(ph.sdZ).map((z) => prior.wPerZ * z),
    castable: fit(ph.castable),
    traits: ph.traits.map(fit),
  };
  return {
    kind: 'prior', ids, w, traits,
    pairBias,
    structure: prior.structure,
    phantom: Object.fromEntries(PAIRS.map((p) => [p, one])),
    filler: prior.wPerZ * prior.fillerZ,
    toPct: 25,
  };
}

module.exports = { derivePrior, buildPriorValue, tableZ, resample, PRIOR_PACK };
