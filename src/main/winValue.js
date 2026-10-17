/**
 * winValue.js — score picks by how much they raise your final deck's
 * chance to win, using the deck win model from tools/pipeline/winModel.js.
 *
 * The set table's `value` block holds, per card, its learned value per copy
 * in a deck (log-odds of winning a game, controlling for player skill) and
 * its traits (creature, two-drop, removal, 6+ drop); the win-rate effect of
 * each two-color archetype; how deck shape matters (a weight per creature
 * count, two-drop count, removal count, top-end count — learned from games,
 * not rules of thumb); and "phantom" future picks: for a drafter who ends up
 * in pair P, the value of what they take at each later pick (mean and
 * spread), how often it's castable in P, and how often it has each trait.
 *
 * For each pair P the projected deck is the best 23 spells from your pool
 * plus the expected future picks, chosen for card value *and* shape (a
 * slightly weaker creature beats a better spell when the deck is short on
 * creatures). A card's score is how much it lifts a soft maximum over the
 * ten pairs:
 *
 *   V(pool) = τ · log Σ_P exp(V_P(pool) / τ)      score(c) = V(pool + c) − V(pool)
 *
 * τ keeps early picks flexible (a card good in several pairs counts in all of
 * them); as the pool grows one pair pulls ahead and the score becomes "how
 * much does this improve the deck I'm actually building" — including filling
 * its holes late in the draft.
 *
 * Pure functions, no Electron — shared by the app and the research scripts.
 */
'use strict';

const PAIRS = ['WU', 'WB', 'WR', 'WG', 'UB', 'UR', 'UG', 'BR', 'BG', 'RG'];
const SHAPE = ['creatures', 'twoDrops', 'removal', 'topEnd']; // order of trait bits 1, 2, 4, 8
const SPELLS = 23;
const DEFAULT_TAU = 0.15;
// Future picks vary: each expected pick becomes one deck slot whose value
// cycles through an equal-weight three-point spread with the right variance,
// so a card a bit below average still beats the weaker future draws.
const SPREAD = [0, Math.sqrt(1.5), -Math.sqrt(1.5)];
const SWAP_CANDIDATES = 10;   // lowest deck slots tried when a card comes in

/** Bitmask of the pairs a card of `color` can be cast in. */
function castMask(color) {
  const cs = String(color ?? '').replace(/[^WUBRG]/g, '');
  let mask = 0;
  PAIRS.forEach((p, i) => { if ([...cs].every((c) => p.includes(c))) mask |= 1 << i; });
  return mask;
}

/**
 * Pairs a table card can fill a spell slot in. Lands (other than land
 * creatures) never do: a dual land's worth is fixing, which a two-color
 * spell count can't see, and counting it as a spell made colorless lands
 * look like flexible playables.
 */
function cardMask(card) {
  const types = card?.types ?? [];
  if (types.some((t) => /\bLand\b/.test(t)) && !types.some((t) => /\bCreature\b/.test(t))) return 0;
  return castMask(card?.color);
}

const traitVector = (bits) => SHAPE.map((_, j) => ((bits >> j) & 1));

/** Index the table's value block. Returns null when the table has none. */
function prepareValue(table) {
  const v = table?.value;
  // Shape checks so a corrupt table can't blow up the main process (real
  // blocks: a few hundred cards, 3 × 14–15 picks).
  const nums = (arr, max) => Array.isArray(arr) && arr.length <= max && arr.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v || !Array.isArray(v.ids) || v.ids.length === 0 || v.ids.length > 5000 || !nums(v.w, 5000) || v.ids.length !== v.w.length) return null;
  if (!nums(v.pairBias, PAIRS.length) || v.pairBias.length !== PAIRS.length) return null;
  if (!v.phantom || !PAIRS.every((p) => nums(v.phantom[p]?.value, 60) && nums(v.phantom[p]?.castable, 60) && v.phantom[p].value.length === v.phantom[PAIRS[0]].value.length)) return null;
  const cards = new Map();
  v.ids.forEach((id, i) => {
    const w = v.w[i];
    if (typeof w !== 'number' || !Number.isFinite(w)) return;
    cards.set(id, { w, mask: cardMask(table.cards?.[id]), a: traitVector(v.traits?.[i] ?? 0) });
  });
  const knots = (list) => (Array.isArray(list) ? list.slice(0, 10).filter((h) => Array.isArray(h) && h.length === 2 && h.every(Number.isFinite)) : []);
  const structure = SHAPE.map((name) => {
    const s = v.structure?.[name];
    return s ? { short: knots(s.short), over: knots(s.over) } : null;
  });
  const picks = v.phantom[PAIRS[0]].value.length;
  return {
    cards,
    pairBias: v.pairBias,
    structure,
    phantom: PAIRS.map((p) => {
      const ph = v.phantom[p];
      const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
      const traits = SHAPE.map((_, j) => (Array.isArray(ph.traits?.[j]) ? ph.traits[j] : null));
      return {
        value: ph.value, castable: ph.castable,
        sd: Array.from({ length: picks }, (_, t) => num(ph.sd?.[t])),
        unitTraits: Array.from({ length: picks }, (_, t) => traits.map((arr) => num(arr?.[t]))),
      };
    }),
    filler: Number.isFinite(v.filler) ? v.filler : 0,
    picks,
    toPct: Number.isFinite(v.toPct) ? v.toPct : 25,
  };
}

// ─── Deck projection ──────────────────────────────────────────────────────────

/**
 * Learned value of a deck shape: per trait, piecewise-linear costs for
 * being short of (or over) knot counts. Counts may be fractional.
 */
function shapeValue(vt, counts) {
  let total = 0;
  for (let j = 0; j < SHAPE.length; j++) {
    const s = vt.structure[j];
    if (!s) continue;
    for (const [k, w] of s.short) if (counts[j] < k) total += w * (k - counts[j]);
    for (const [k, w] of s.over) if (counts[j] > k) total += w * (counts[j] - k);
  }
  // "Deck needs: strong" scales the learned shape costs up (see scorePack).
  return total * (vt.shapeScale ?? 1);
}

/** Deck slots for pair p: castable pool cards, then expected future picks. */
function deckUnits(vt, pool, p, nextPick, shift = 0, splash = null) {
  const bit = 1 << p;
  const units = [];
  for (const c of pool) {
    if (c.mask & bit) units.push({ w: c.w, a: c.a });
    else if (splash && c.splash?.[p] === splash.color) units.push({ w: c.w * splash.eff, a: c.a, splash: true });
  }
  const ph = vt.phantom[p];
  const packSize = vt.picks / 3;
  let mass = 0, k = 0;
  for (let t = Math.max(0, nextPick); t < vt.picks; t++) {
    // shift > 0: cards of this pair stay around longer than in the data the
    // phantoms come from (Quick Draft bots under-drafting its colors), so
    // pick t looks like pick t − shift there. Stays inside the same pack.
    let value = ph.value[t], castable = ph.castable[t], at = t;
    if (shift) {
      const start = Math.floor(t / packSize) * packSize;
      const src = Math.max(start, Math.min(start + packSize - 1, t - shift));
      const lo = Math.floor(src), hi = Math.min(lo + 1, start + packSize - 1), f = src - lo;
      value = ph.value[lo] * (1 - f) + ph.value[hi] * f;
      castable = ph.castable[lo] * (1 - f) + ph.castable[hi] * f;
      at = Math.round(src);
    }
    mass += castable > 0 ? castable : 0;
    while (mass >= 1) {
      mass -= 1;
      units.push({ w: value + SPREAD[k++ % SPREAD.length] * ph.sd[at], a: ph.unitTraits[at] });
    }
  }
  return units;
}

const addTo = (counts, a, sign) => { for (let j = 0; j < counts.length; j++) counts[j] += sign * a[j]; };

/**
 * Best SPELLS units by card value, then a few swaps that trade a little card
 * value for a better shape. Returns the deck and its value (without the
 * archetype term).
 */
function buildDeck(vt, units) {
  units.sort((x, y) => y.w - x.w);
  const sel = units.slice(0, SPELLS);
  const rest = units.slice(SPELLS, SPELLS + 8);
  const counts = new Float64Array(SHAPE.length);
  let cardSum = 0;
  for (const u of sel) { addTo(counts, u.a, 1); cardSum += u.w; }
  for (let iter = 0; iter < 4 && rest.length; iter++) {
    const s0 = shapeValue(vt, counts);
    let best = null;
    for (let r = 0; r < rest.length; r++) {
      for (let s = Math.max(0, sel.length - SWAP_CANDIDATES); s < sel.length; s++) {
        addTo(counts, sel[s].a, -1); addTo(counts, rest[r].a, 1);
        const gain = rest[r].w - sel[s].w + shapeValue(vt, counts) - s0;
        addTo(counts, rest[r].a, -1); addTo(counts, sel[s].a, 1);
        if (gain > 1e-9 && (!best || gain > best.gain)) best = { gain, r, s };
      }
    }
    if (!best) break;
    const out = sel[best.s], inn = rest[best.r];
    addTo(counts, out.a, -1); addTo(counts, inn.a, 1);
    cardSum += inn.w - out.w;
    sel[best.s] = inn; rest[best.r] = out;
    sel.sort((x, y) => y.w - x.w);
  }
  const shape = shapeValue(vt, counts);
  return { sel, counts, cardSum, shape, value: cardSum + shape + (SPELLS - sel.length) * vt.filler };
}

/** Deck value with card c added (it replaces the best slot to give up, or none). */
function withCard(vt, deck, c) {
  const { sel, counts } = deck;
  if (sel.length < SPELLS) {
    addTo(counts, c.a, 1);
    const shape = shapeValue(vt, counts);
    addTo(counts, c.a, -1);
    return { value: deck.value - vt.filler + c.w + shape - deck.shape, shapeGain: shape - deck.shape };
  }
  let best = { value: deck.value, shapeGain: 0 };
  for (let s = Math.max(0, sel.length - SWAP_CANDIDATES); s < sel.length; s++) {
    addTo(counts, sel[s].a, -1); addTo(counts, c.a, 1);
    const shape = shapeValue(vt, counts);
    addTo(counts, c.a, -1); addTo(counts, sel[s].a, 1);
    const value = deck.value - sel[s].w + c.w + shape - deck.shape;
    if (value > best.value) best = { value, shapeGain: shape - deck.shape };
  }
  return best;
}

// ─── Splash and fixing ────────────────────────────────────────────────────────
// Each pair is also tried with one splash color: an off-color card counts if
// it's strong (17Lands z ≥ minZ, about B+) and needs at most one pip of it.
// It plays at a discount (inconsistent mana) that each land or mana rock
// making the splash color shrinks — that's what fixing is worth, and only
// once there's something to splash. A splash also costs the deck a little.
const SPLASH = { minZ: 1.0, maxPips: 1, base: 0.55, perFix: 0.12, maxFix: 3, deckCost: 0.01 };
const COLOR_LIST = ['W', 'U', 'B', 'R', 'G'];

/** Per pair: the off color this card could be splashed as, or null. */
function splashColors(info) {
  if (!info || info.land || !(info.z >= SPLASH.minZ)) return null;
  const cs = String(info.colors ?? '').replace(/[^WUBRG]/g, '');
  return PAIRS.map((p) => {
    const off = [...cs].filter((c) => !p.includes(c));
    if (off.length !== 1) return null;
    return (info.pips?.[off[0]] ?? 1) <= SPLASH.maxPips ? off[0] : null;
  });
}

// A 2nd+ copy of a legendary card is worth less (legend rule): measured in
// 17Lands games at about −0.4 to −0.6 win-rate points per extra copy
// (tools/pipeline/dup-research.js). Extra copies of other cards showed no
// consistent penalty, so they keep full value.
const LEGEND_DUP = 0.02;

const splashEff = (fixers) => SPLASH.base + SPLASH.perFix * Math.min(fixers, SPLASH.maxFix);

/**
 * Pool cards with what the scorer knows about them; `info` (grpId →
 * { colors, pips, z, land, fixes }) adds splash and fixing facts when given.
 */
function poolCards(vt, poolIds, info = null) {
  const pool = [];
  const seen = new Map();
  for (const id of poolIds) {
    const c = vt.cards.get(id);
    if (!c) continue;
    const i = info?.get(id);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    const w = i?.legendary && n > 1 ? c.w - LEGEND_DUP : c.w;
    pool.push(i ? { ...c, w, splash: splashColors(i), fixes: i.fixes ?? '' } : c);
  }
  pool.copies = seen;
  return pool;
}

/** Variants of pair p's deck: no splash, and one per off color. */
function pairVariants(vt, pool, p, nextPick, shift, withSplash) {
  const variants = [];
  const plain = buildDeck(vt, deckUnits(vt, pool, p, nextPick, shift));
  variants.push({ color: null, eff: 0, fixers: 0, deck: plain, value: plain.value, splashing: false });
  if (!withSplash) return variants;
  for (const color of COLOR_LIST) {
    if (PAIRS[p].includes(color)) continue;
    const fixers = pool.filter((c) => c.fixes?.includes(color)).length;
    const eff = splashEff(fixers);
    const deck = buildDeck(vt, deckUnits(vt, pool, p, nextPick, shift, { color, eff }));
    const splashing = deck.sel.some((u) => u.splash);
    variants.push({ color, eff, fixers, deck, value: deck.value - (splashing ? SPLASH.deckCost : 0), splashing });
  }
  return variants;
}

const bestVariant = (vs) => vs.reduce((a, b) => (b.value > a.value ? b : a));

/** Projected decks per pair (each with its best splash variant), from `nextPick` on. */
function projectDecks(vt, poolIds, nextPick, pickShift = null, info = null) {
  const pool = poolCards(vt, poolIds, info);
  return PAIRS.map((_, p) => {
    const variants = pairVariants(vt, pool, p, nextPick, pickShift?.[p] ?? 0, !!info);
    const best = bestVariant(variants);
    return { ...best.deck, value: best.value, variants, pool, splash: best.splashing ? best.color : null };
  });
}

/** Projected deck value for each pair (archetype effect included). */
function pairValues(vt, poolIds, nextPick, opts = {}) {
  return Float64Array.from(projectDecks(vt, poolIds, nextPick, opts.pickShift, opts.info), (d, p) => d.value + vt.pairBias[p]);
}

function softMax(values, tau) {
  let mx = -Infinity;
  for (const v of values) if (v > mx) mx = v;
  let s = 0;
  for (const v of values) s += Math.exp((v - mx) / tau);
  return mx + tau * Math.log(s);
}

/**
 * Pair p's value with card c added: the best of its variants, where c plays
 * normally (castable), as a splash (that variant's color), or as fixing
 * (rebuild that splash variant with one more source).
 */
function pairWithCard(vt, d, p, c, ci, nextPick, shift) {
  let best = { value: d.value, shapeGain: 0 };
  const splashAs = ci ? splashColors(ci)?.[p] : null;
  for (const v of d.variants) {
    let r = null;
    if (c.mask & (1 << p)) {
      r = withCard(vt, v.deck, c);
      r = { ...r, value: r.value - (v.splashing ? SPLASH.deckCost : 0) };
    } else if (v.color && splashAs === v.color) {
      r = withCard(vt, v.deck, { w: c.w * v.eff, a: c.a });
      r = { ...r, value: r.value - SPLASH.deckCost };
    } else if (v.color && v.splashing && ci?.fixes?.includes(v.color) && v.fixers < SPLASH.maxFix) {
      const deck = buildDeck(vt, deckUnits(vt, d.pool, p, nextPick, shift, { color: v.color, eff: splashEff(v.fixers + 1) }));
      r = { value: deck.value - SPLASH.deckCost, shapeGain: 0 };
    }
    if (r && r.value > best.value) best = r;
  }
  return best;
}

/**
 * Score every card in the pack. `pickIndex` is the 0-based pick across the
 * whole draft (pack * packSize + pick). Returns null without a value table,
 * else { scores: Map(grpId → Δ log-odds), shape: Map(grpId → part of Δ from
 * deck shape in your likeliest pair), pairProbs: {WU: p, …}, best, needs,
 * topPair, splash: the likeliest deck's splash color or null }.
 * Options: `pickShift` (per pair, in picks; see deckUnits — Quick Draft bot
 * bias), `info` (grpId → card facts; enables splash and fixing),
 * `shapeScale` (> 1 weighs deck needs more than the data says).
 */
function scorePack(vtIn, poolIds, packIds, pickIndex, { tau = DEFAULT_TAU, pickShift = null, info = null, shapeScale = 1 } = {}) {
  if (!vtIn) return null;
  const vt = shapeScale !== 1 ? { ...vtIn, shapeScale } : vtIn;
  const next = pickIndex + 1;
  const decks = projectDecks(vt, poolIds, next, pickShift, info);
  const base = Float64Array.from(decks, (d, p) => d.value + vt.pairBias[p]);
  const baseSoft = softMax(base, tau);
  let top = 0;
  for (let p = 1; p < PAIRS.length; p++) if (base[p] > base[top]) top = p;
  // topGain: how much of a card's lift is in the likeliest pair (the rest
  // is a hedge toward another pair).
  const scores = new Map(), shape = new Map(), topGain = new Map();
  for (const id of new Set(packIds)) {
    const c = vt.cards.get(id);
    if (!c) continue;
    const ci = info?.get(id) ?? null;
    const dupLegend = ci?.legendary && (decks[0].pool.copies?.get(id) ?? 0) > 0;
    const cc = dupLegend ? { ...c, w: c.w - LEGEND_DUP } : c;
    const vals = Float64Array.from(base);
    for (let p = 0; p < PAIRS.length; p++) {
      const r = pairWithCard(vt, decks[p], p, cc, ci, next, pickShift?.[p] ?? 0);
      vals[p] = r.value + vt.pairBias[p];
      if (p === top) { shape.set(id, r.shapeGain); topGain.set(id, r.value - decks[p].value); }
    }
    scores.set(id, softMax(vals, tau) - baseSoft);
  }
  if (!scores.size) return null;
  const ex = Array.from(base, (v) => Math.exp((v - base[top]) / tau));
  const Z = ex.reduce((a, b) => a + b, 0);
  const pairProbs = Object.fromEntries(PAIRS.map((p, i) => [p, ex[i] / Z]));
  let best = null;
  for (const [id, sc] of scores) if (!best || sc > best[1]) best = [id, sc];
  return { scores, shape, topGain, pairProbs, best: best[0], toPct: vt.toPct, needs: shapeNeeds(vt, decks[top]), topPair: PAIRS[top], splash: decks[top].splash };
}

/**
 * Which shape traits the likeliest deck is short on: the learned gain from
 * one more card with that trait (log-odds), for the UI ("needs creatures").
 */
function shapeNeeds(vt, deck) {
  const out = {};
  SHAPE.forEach((name, j) => {
    const a = SHAPE.map((_, k) => (k === j ? 1 : 0));
    addTo(deck.counts, a, 1);
    const up = shapeValue(vt, deck.counts);
    addTo(deck.counts, a, -1);
    out[name] = { count: Math.round(deck.counts[j] * 10) / 10, gain: up - deck.shape };
  });
  return out;
}

/** Value of the best finished deck you could build from a pool (no future picks). */
function poolValue(vt, poolIds, opts = {}) {
  const v = pairValues(vt, poolIds, vt.picks, opts);
  let best = 0;
  for (let p = 1; p < PAIRS.length; p++) if (v[p] > v[best]) best = p;
  return { value: v[best], pair: PAIRS[best], byPair: v };
}

module.exports = { PAIRS, SHAPE, SPELLS, DEFAULT_TAU, SPLASH, LEGEND_DUP, castMask, cardMask, prepareValue, pairValues, scorePack, poolValue, shapeValue, splashColors };
