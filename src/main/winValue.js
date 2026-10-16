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
  return total;
}

/** Deck slots for pair p: castable pool cards, then expected future picks. */
function deckUnits(vt, pool, p, nextPick, shift = 0) {
  const bit = 1 << p;
  const units = [];
  for (const c of pool) if (c.mask & bit) units.push({ w: c.w, a: c.a });
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

function poolCards(vt, poolIds) {
  const pool = [];
  for (const id of poolIds) {
    const c = vt.cards.get(id);
    if (c) pool.push(c);
  }
  return pool;
}

/** Projected decks per pair, from `nextPick` on. */
function projectDecks(vt, poolIds, nextPick, pickShift = null) {
  const pool = poolCards(vt, poolIds);
  return PAIRS.map((_, p) => buildDeck(vt, deckUnits(vt, pool, p, nextPick, pickShift?.[p] ?? 0)));
}

/** Projected deck value for each pair (archetype effect included). */
function pairValues(vt, poolIds, nextPick) {
  return Float64Array.from(projectDecks(vt, poolIds, nextPick), (d, p) => d.value + vt.pairBias[p]);
}

function softMax(values, tau) {
  let mx = -Infinity;
  for (const v of values) if (v > mx) mx = v;
  let s = 0;
  for (const v of values) s += Math.exp((v - mx) / tau);
  return mx + tau * Math.log(s);
}

/**
 * Score every card in the pack. `pickIndex` is the 0-based pick across the
 * whole draft (pack * packSize + pick). Returns null without a value table,
 * else { scores: Map(grpId → Δ log-odds), shape: Map(grpId → part of Δ from
 * deck shape in your likeliest pair), pairProbs: {WU: p, …}, best, needs }.
 * `pickShift` (per pair, in picks): see deckUnits — Quick Draft bot bias.
 */
function scorePack(vt, poolIds, packIds, pickIndex, { tau = DEFAULT_TAU, pickShift = null } = {}) {
  if (!vt) return null;
  const decks = projectDecks(vt, poolIds, pickIndex + 1, pickShift);
  const base = Float64Array.from(decks, (d, p) => d.value + vt.pairBias[p]);
  const baseSoft = softMax(base, tau);
  let top = 0;
  for (let p = 1; p < PAIRS.length; p++) if (base[p] > base[top]) top = p;
  const scores = new Map(), shape = new Map();
  for (const id of new Set(packIds)) {
    const c = vt.cards.get(id);
    if (!c) continue;
    const vals = Float64Array.from(base);
    for (let p = 0; p < PAIRS.length; p++) {
      if (!(c.mask & (1 << p))) continue;
      const r = withCard(vt, decks[p], c);
      vals[p] = r.value + vt.pairBias[p];
      if (p === top) shape.set(id, r.shapeGain);
    }
    scores.set(id, softMax(vals, tau) - baseSoft);
  }
  if (!scores.size) return null;
  const ex = Array.from(base, (v) => Math.exp((v - base[top]) / tau));
  const Z = ex.reduce((a, b) => a + b, 0);
  const pairProbs = Object.fromEntries(PAIRS.map((p, i) => [p, ex[i] / Z]));
  let best = null;
  for (const [id, s] of scores) if (!best || s > best[1]) best = [id, s];
  return { scores, shape, pairProbs, best: best[0], toPct: vt.toPct, needs: shapeNeeds(vt, decks[top]), topPair: PAIRS[top] };
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
function poolValue(vt, poolIds) {
  const v = pairValues(vt, poolIds, vt.picks);
  let best = 0;
  for (let p = 1; p < PAIRS.length; p++) if (v[p] > v[best]) best = p;
  return { value: v[best], pair: PAIRS[best], byPair: v };
}

module.exports = { PAIRS, SHAPE, SPELLS, DEFAULT_TAU, castMask, cardMask, prepareValue, pairValues, scorePack, poolValue, shapeValue };
