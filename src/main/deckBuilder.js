/**
 * deckBuilder.js — Suggest 40-card Limited decks from a draft or sealed pool.
 *
 * All functions are pure (no stored state, no Electron). Input is an array of
 * normalized cards (17Lands stats + Scryfall text); output is a ranked list
 * of builds with reasons and warnings the UI can show as-is.
 *
 * The approach follows common Limited deck-building advice:
 *   - Try every two-color pair. Take the best ~23 castable spells by 17Lands
 *     GIH WR z-score, then nudge toward a sound structure (creature count,
 *     two-drops, removal, capped top end) when that costs little card quality.
 *   - 16 or 17 lands depending on the curve and Bo1/Bo3; basics split by
 *     colored pips.
 *   - Splash at most a couple of single-pip bombs / premium removal, and only
 *     with enough sources (Frank Karsten's mana math).
 *   - 17Lands two-color win rates break near-ties between pairs.
 */

const COLORS = ['W', 'U', 'B', 'R', 'G'];
const PAIRS = COLORS.flatMap((a, i) => COLORS.slice(i + 1).map(b => a + b)); // WU, WB, … RG
const COLOR_NAME = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const BASIC_NAMES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']);
const BASIC_TYPE_COLOR = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

// ─── Rules of thumb ───────────────────────────────────────────────────────────

const DECK_SIZE = 40;
const DEFAULT_LANDS = 17;           // the classic 40-card default: 17 lands + 23 spells
const MAX_LANDS = 18;               // never pad past 18 lands; a short deck gets a warning instead
const MAX_NONBASIC_LANDS = 3;
const UNKNOWN_VALUE = -0.3;         // no 17Lands z-score: assume slightly below average
const PLAYABLE_MIN_VALUE = -1.0;    // below ≈ D+ a card is filler, not a playable
const LAND_UTILITY_MIN_VALUE = 0.5; // a mono-color nonbasic only beats a basic if 17Lands says it's good

// "Be Boring" (Reid Duke): ~15–17 creatures, a real two-drop presence, a few
// removal spells, and a capped top end.
const CREATURES = { min: 15, max: 17 };
const TWO_DROPS = { min: 4, max: 6 };  // creatures costing ≤ 2
const REMOVAL_MIN = 3;
const TOP_END_MAX = 4;                 // cards at 6+ mana
const SWAP_TOLERANCE = 0.5;            // max z given up per structural swap
const TOP_END_SWAP_TOLERANCE = 1.0;    // clunky hands lose games; pay more to fix the top end

// Deck score, in units of summed z over the 23 best spells.
const PENALTY = {
  missingCreature: 0.3, extraCreature: 0.1, missingTwoDrop: 0.25, missingRemoval: 0.25,
  extraTopEnd: 0.3, missingCard: 1.5, doublePip: 0.15,
};
const REMOVAL_BONUS = 0.1;             // per removal spell past 3 (max 2 counted)
const PAIR_STRENGTH_WEIGHT = 40;       // +2pp archetype win rate ≈ +0.8 ≈ one good card

// Lands. Arena Bo1 smooths opening hands, so 16 lands is safer there than in Bo3.
const BO1_16_LANDS_MAX_AVG_CMC = 2.9;
const BO1_16_LANDS_MAX_FIVE_PLUS = 3;
const BO3_16_LANDS_MAX_AVG_CMC = 2.6;
const MIN_MAIN_SOURCES = 6;            // a real main color (≥ 4 cards) needs ≥ 6 sources
const MIN_LIGHT_SOURCES = 3;           // even a 1–3 card color needs splash-level sources

// Splash (Karsten: ≥ 3 sources for a single-pip splash; LSV/LR: splash bombs
// and removal, never filler, and prefer cards you cast later in the game).
const SPLASH_MAX_CARDS = 2;
const SPLASH_MIN_VALUE = 1.0;          // ≈ B+ or better
const SPLASH_PREFERRED_MIN_CMC = 3;
const SPLASH_LOW_CMC_PENALTY = 0.5;    // ranking only: cheap splash cards often sit stranded early
const SPLASH_MIN_SOURCES = 3;
const SPLASH_MAX_BASICS = 3;
const SPLASH_FLAT_COST = 0.3;          // consistency tax of any third color
const SPLASH_BASIC_COST = 0.25;        // each splash basic is a main-color source lost
const SPLASH_BASICS_ONLY_MIN_GAIN = 0.5; // basics-only splash must clearly pay off (on top of the costs above)
const FIXER_MIN_VALUE = -0.6;          // a fixer spell this weak isn't worth a slot
const CARDS_SEEN_BY_TURN_6 = 14;       // 7-card hand + 6 draws on the draw, +1 for a scry/loot

// Aggressive variant (sealed): favor cheap creatures, play 16 lands.
const AGGRO_MAX_AVG_CMC = 2.8;
const AGGRO_RANK_ADJUST = { cheapCreature: 0.4, three: 0.1, four: -0.1, fivePlus: -0.6 };

// Same idea as signalAnalyzer's REMOVAL_RE (kept local so the modules stay independent).
const REMOVAL_RE = /\b(destroy target|exile target|deal[s]? \d+ damage to (any target|target)|deals damage equal to .* to (any target|target)|gets? [-−]\d+\/[-−]\d+|[-−]\d+\/[-−]\d+ until|[-−]x\/[-−]x|fights? (another |up to one )?target|target creature .* fights|return[s]? target (creature|nonland permanent) to its owner's hand)/i;

// ─── Card helpers ─────────────────────────────────────────────────────────────

const cardColorsOf = (card) => (card?.color ?? '').replace(/[^WUBRG]/g, '');
const byDesc = (f) => (a, b) => f(b) - f(a);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const lookupPair = (table, pair) => table?.[pair] ?? table?.[pair[1] + pair[0]] ?? 0;

/**
 * Colored pips in the mana cost. Hybrid {W/U} counts ½ to each side, {2/W}
 * ½ to W, phyrexian {W/P} a full pip; {X}, {C}, {S} and generic are ignored.
 * Without a mana cost, falls back to one pip per color letter.
 */
function pipsOf(card) {
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const cost = card?.manaCost;
  if (cost == null) {
    for (const c of cardColorsOf(card)) pips[c] += 1;
    return pips;
  }
  for (const [, sym] of String(cost).matchAll(/\{([^}]+)\}/g)) {
    const parts = sym.toUpperCase().split('/').filter(p => p !== 'P');
    const colored = parts.filter(p => pips[p] !== undefined);
    for (const p of colored) pips[p] += 1 / parts.length;
  }
  return pips;
}

/** Mana value; derived from the mana cost when Scryfall's cmc is missing. */
function cmcOf(card) {
  if (typeof card?.cmc === 'number') return card.cmc;
  if (typeof card?.manaCost !== 'string') return null;
  let total = 0;
  for (const [, sym] of card.manaCost.matchAll(/\{([^}]+)\}/g)) {
    const s = sym.toUpperCase();
    if (s === 'X') continue;
    const n = parseInt(s, 10);
    total += Number.isNaN(n) ? 1 : n;   // {2/W} counts 2, matching the rules
  }
  return total;
}

/** Which colors a land (or mana rock / dork / ramp spell) can produce. */
function manaProduced(card, isLand) {
  const ot = card?.oracleText ?? '';
  const front = (card?.typeLine ?? '').split('//')[0];
  const colors = new Set();
  const any = /mana of any (one )?(color|type)/i.test(ot);
  const search = /search your library for (a|an|up to \w+) basic land/i.test(ot);
  if (isLand) {
    for (const [t, c] of Object.entries(BASIC_TYPE_COLOR)) if (new RegExp(`\\b${t}\\b`).test(front)) colors.add(c);
  }
  // Nonlands only count tap abilities, so "add {R}{R}{R}" rituals don't look like fixing.
  const abilityRe = isLand ? /\badd ([^.]*)/gi : /\{T\}[^:]*:\s*add ([^.]*)/gi;
  for (const m of ot.matchAll(abilityRe)) {
    for (const s of m[1].matchAll(/\{([WUBRG])\}/g)) colors.add(s[1]);
  }
  return { colors, any, search };
}

/** Precomputed facts about one pool card. */
function describe(card) {
  const front = (card?.typeLine ?? '').split('//')[0]; // MDFC "Sorcery // Land" is a spell
  const isCreature = /\bCreature\b/i.test(front);
  const isLand = /\bLand\b/i.test(front) && !isCreature;
  return {
    card,
    colors: cardColorsOf(card),
    isCreature,
    isLand,
    isBasic: isLand && (/\bBasic\b/i.test(front) || BASIC_NAMES.has(card?.name)),
    isRemoval: !isLand && REMOVAL_RE.test(card?.oracleText ?? ''),
    cmc: cmcOf(card),
    pips: pipsOf(card),
    mana: manaProduced(card, isLand),
  };
}

const producesColor = (e, c) => e.mana.any || e.mana.colors.has(c);

/** P(at least one of `sources` among the cards seen by turn 6), hypergeometric. */
function castOdds(sources, deckSize = DECK_SIZE, seen = CARDS_SEEN_BY_TURN_6) {
  let pNone = 1;
  for (let i = 0; i < seen; i++) pNone *= Math.max(0, deckSize - sources - i) / (deckSize - i);
  return 1 - pNone;
}

// ─── Structure ────────────────────────────────────────────────────────────────

function tally(main) {
  const curve = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  let creatures = 0, removal = 0, twoDrops = 0, topEnd = 0, fivePlus = 0, cmcSum = 0, cmcN = 0;
  for (const e of main) {
    if (e.isCreature) creatures++;
    if (e.isRemoval) removal++;
    if (e.cmc == null) continue;
    const k = Math.min(6, Math.max(1, Math.round(e.cmc)));
    curve[k]++;
    if (e.isCreature && Math.round(e.cmc) <= 2) twoDrops++;
    if (e.cmc >= 6) topEnd++;
    if (e.cmc >= 5) fivePlus++;
    cmcSum += e.cmc;
    cmcN++;
  }
  return { creatures, removal, twoDrops, topEnd, fivePlus, curve, avgCmc: cmcN ? cmcSum / cmcN : 0 };
}

function deficits(t) {
  return {
    creaturesLow:  Math.max(0, CREATURES.min - t.creatures),
    creaturesHigh: Math.max(0, t.creatures - CREATURES.max),
    twoDrops:      Math.max(0, TWO_DROPS.min - t.twoDrops),
    removal:       Math.max(0, REMOVAL_MIN - t.removal),
    topEnd:        Math.max(0, t.topEnd - TOP_END_MAX),
  };
}

/**
 * Swap cards between the main deck and the bench to fix structural holes,
 * cheapest swap first. A swap must shrink the hole it targets, may not open
 * another one, and may cost at most the tolerance in card value.
 */
function adjustStructure(main, bench, rank, locked) {
  main = [...main];
  bench = [...bench];
  const order = ['topEnd', 'creaturesLow', 'twoDrops', 'removal', 'creaturesHigh'];
  for (let iter = 0; iter < 24; iter++) {
    const d = deficits(tally(main));
    let applied = false;
    for (const k of order) {
      if (d[k] === 0) continue;
      const tol = k === 'topEnd' ? TOP_END_SWAP_TOLERANCE : SWAP_TOLERANCE;
      let best = null;
      for (let i = 0; i < main.length; i++) {
        if (locked.has(main[i])) continue;
        for (let j = 0; j < bench.length; j++) {
          const loss = rank(main[i]) - rank(bench[j]);
          if (loss > tol || (best && loss >= best.loss)) continue;
          const trial = main.slice();
          trial[i] = bench[j];
          const d2 = deficits(tally(trial));
          if (d2[k] < d[k] && order.every(o => d2[o] <= d[o])) best = { i, j, loss };
        }
      }
      if (best) {
        const out = main[best.i];
        main[best.i] = bench[best.j];
        bench[best.j] = out;
        applied = true;
        break;
      }
    }
    if (!applied) break;
  }
  return { main, bench };
}

function chooseLandCount(t, format, splashing, mode) {
  if (mode === 'aggro') return 16;
  if (splashing) return DEFAULT_LANDS;                 // a third color wants the extra land
  if (format === 'bo3') return t.avgCmc <= BO3_16_LANDS_MAX_AVG_CMC ? 16 : 17;
  return t.avgCmc <= BO1_16_LANDS_MAX_AVG_CMC && t.fivePlus <= BO1_16_LANDS_MAX_FIVE_PLUS ? 16 : 17;
}

// ─── Mana base ────────────────────────────────────────────────────────────────

/** Nonbasic lands worth playing: duals/fixers for the deck's colors, best first. */
function chooseNonbasics(entries, pairSet, splashColor, value) {
  const relevant = new Set(pairSet);
  if (splashColor) relevant.add(splashColor);
  return entries
    .filter(e => e.isLand && !e.isBasic)
    .map(e => {
      const rel = (e.mana.any || e.mana.search) ? relevant.size : [...e.mana.colors].filter(c => relevant.has(c)).length;
      const splashes = splashColor ? (producesColor(e, splashColor) || e.mana.search ? 1 : 0) : 0;
      return { e, rel, splashes, v: value(e) };
    })
    .filter(x => x.rel >= 2 || (x.rel >= 1 && x.v >= LAND_UTILITY_MIN_VALUE))
    .sort((a, b) => (b.splashes - a.splashes) || (b.rel - a.rel) || (b.v - a.v))
    .slice(0, MAX_NONBASIC_LANDS)
    .map(x => x.e);
}

/**
 * Split basics in proportion to colored pips (largest remainder), then make
 * sure each color the deck relies on has a minimum number of sources.
 */
function splitBasics(n, colors, pips, cardCounts, otherSources) {
  const alloc = Object.fromEntries(colors.map(c => [c, 0]));
  if (n <= 0 || colors.length === 0) return alloc;
  const total = colors.reduce((s, c) => s + pips[c], 0);
  const raw = colors.map(c => [c, n * (total > 0 ? pips[c] / total : 1 / colors.length)]);
  let used = 0;
  for (const [c, r] of raw) { alloc[c] = Math.floor(r); used += alloc[c]; }
  raw.sort((a, b) => (b[1] % 1) - (a[1] % 1));
  for (let i = 0; used < n; i++, used++) alloc[raw[i % raw.length][0]]++;

  const minFor = (c) => cardCounts[c] >= 4 ? MIN_MAIN_SOURCES : cardCounts[c] >= 1 ? MIN_LIGHT_SOURCES : 0;
  const have = (c) => alloc[c] + (otherSources[c] ?? 0);
  for (const c of colors) {
    while (have(c) < minFor(c)) {
      const donor = colors
        .filter(o => o !== c && alloc[o] > 0 && have(o) - 1 >= minFor(o))
        .sort((a, b) => alloc[b] - alloc[a])[0];
      if (!donor) break;
      alloc[donor]--;
      alloc[c]++;
    }
  }
  return alloc;
}

// ─── Build one deck ───────────────────────────────────────────────────────────

function aggroAdjust(e) {
  if (e.cmc == null) return 0;
  const c = Math.round(e.cmc);
  if (e.isCreature && c <= 2) return AGGRO_RANK_ADJUST.cheapCreature;
  if (c <= 3) return AGGRO_RANK_ADJUST.three;
  if (c === 4) return AGGRO_RANK_ADJUST.four;
  return AGGRO_RANK_ADJUST.fivePlus;
}

/**
 * Build the deck for one color pair. `splash` = { color, cards: [entry] } or
 * null; `mode` 'aggro' favors cheap creatures and plays 16 lands. Returns
 * null when the pair has no castable spells at all.
 */
function buildForPair(entries, pair, ctx, splash = null, mode = 'standard') {
  const pairSet = new Set(pair);
  const value = (e) => ctx.value(e, pair);
  const rank = mode === 'aggro' ? (e) => value(e) + aggroAdjust(e) : value;
  const splashColor = splash?.color ?? null;
  const splashCards = new Set(splash?.cards ?? []);

  const castable = entries.filter(e => !e.isLand && [...e.colors].every(c => pairSet.has(c)));
  if (castable.length === 0) return null;
  const spellPool = [...castable, ...splashCards];
  const locked = new Set(splashCards);
  const nonbasics = chooseNonbasics(entries, pairSet, splashColor, value);

  // Splash sources: lands first (free), then fixer spells, then basics.
  let direct = 0, search = 0;
  const fixerSpells = [];
  if (splashColor) {
    for (const e of nonbasics) {
      if (producesColor(e, splashColor)) direct++;
      else if (e.mana.search) search++;
    }
    const fixers = castable
      .filter(e => (producesColor(e, splashColor) || e.mana.search) && value(e) >= FIXER_MIN_VALUE)
      .sort(byDesc(value));
    for (const f of fixers) {
      if (direct + search >= SPLASH_MIN_SOURCES) break;
      fixerSpells.push(f);
      locked.add(f);
      if (producesColor(f, splashColor)) direct++; else search++;
    }
  }

  // Greedy by value, then structure.
  const slots = DECK_SIZE - DEFAULT_LANDS;
  const ordered = spellPool.filter(e => !locked.has(e)).sort(byDesc(rank));
  const free = Math.max(0, slots - locked.size);
  let { main, bench } = adjustStructure([...locked, ...ordered.slice(0, free)], ordered.slice(free), rank, locked);

  let landCount = chooseLandCount(tally(main), ctx.format, !!splash, mode);
  if (landCount < DEFAULT_LANDS) {
    bench.sort(byDesc(rank));
    if (bench.length > 0) main.push(bench.shift()); // the 17th-land slot becomes a spell
    else landCount = DEFAULT_LANDS;
  }
  if (main.length < DECK_SIZE - landCount) landCount = Math.min(MAX_LANDS, DECK_SIZE - main.length);
  const t = tally(main);

  // ── Basics ──
  const nb = nonbasics.slice(0, landCount);
  const basicsTotal = landCount - nb.length;
  let splashBasics = 0;
  if (splashColor) {
    splashBasics = Math.max(0, SPLASH_MIN_SOURCES - direct - search);
    if (search > 0 && direct < SPLASH_MIN_SOURCES) splashBasics = Math.max(1, splashBasics); // something to fetch
    splashBasics = Math.min(SPLASH_MAX_BASICS, splashBasics, basicsTotal);
  }
  const mainCards = main.filter(e => !splashCards.has(e));
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const cardCounts = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const e of mainCards) {
    for (const c of pairSet) {
      pips[c] += e.pips[c];
      if (e.colors.includes(c) || e.pips[c] > 0) cardCounts[c]++;
    }
  }
  const used = [...pair].filter(c => cardCounts[c] > 0);
  const basicColors = used.length > 0 ? used : [...pair];
  const nbSources = Object.fromEntries(basicColors.map(c => [c, nb.filter(e => producesColor(e, c)).length]));
  const basics = splitBasics(basicsTotal - splashBasics, basicColors, pips, cardCounts, nbSources);
  if (splashBasics > 0) basics[splashColor] = splashBasics;
  const sourcesOf = (c) => (basics[c] ?? 0) +
    nb.filter(e => producesColor(e, c) || (e.mana.search && (basics[c] ?? 0) > 0)).length +
    (c === splashColor ? fixerSpells.length : 0);

  // ── Score ──
  const values = main.map(value).sort((a, b) => b - a);
  let score = values.slice(0, slots).reduce((s, v) => s + v, 0);
  const d = deficits(t);
  score -= PENALTY.missingCreature * d.creaturesLow + PENALTY.extraCreature * d.creaturesHigh;
  score -= PENALTY.missingTwoDrop * d.twoDrops + PENALTY.missingRemoval * d.removal;
  score -= PENALTY.extraTopEnd * d.topEnd;
  score += REMOVAL_BONUS * Math.min(2, Math.max(0, t.removal - REMOVAL_MIN));
  score -= PENALTY.missingCard * Math.max(0, slots - main.length);

  let second = null, doublePips = [];
  if (used.length === 2) {
    second = pips[used[0]] < pips[used[1]] ? used[0] : used[1];
    doublePips = mainCards.filter(e => e.pips[second] >= 2);
    score -= PENALTY.doublePip * Math.max(0, doublePips.length - 1);
  }

  const pairDelta = used.length === 2 ? lookupPair(ctx.pairStrength, pair) : 0;
  score += pairDelta * PAIR_STRENGTH_WEIGHT;

  let splashOut = null;
  if (splashColor) {
    const sources = sourcesOf(splashColor);
    const odds = castOdds(sources);
    score -= SPLASH_FLAT_COST + SPLASH_BASIC_COST * splashBasics;
    for (const e of splashCards) score -= (1 - odds) * Math.max(0, value(e));
    splashOut = { color: splashColor, cards: [...splashCards].map(e => e.card), sources, castOdds: round(odds, 3) };
  }

  // ── Explain ──
  const names = (list) => list.map(e => e.card.name ?? `#${e.card.grpId}`).join(', ');
  const playables = spellPool.filter(e => value(e) >= PLAYABLE_MIN_VALUE).length;
  const label = used.length > 0 ? used.join('') : pair;
  const reasons = [];
  const warnings = [];

  reasons.push(`Best cards: ${names(main.slice().sort(byDesc(value)).slice(0, 3))}`);
  reasons.push(`${t.creatures} creatures, ${t.removal} removal, ${t.twoDrops} two-drops`);
  reasons.push(landCount === 16
    ? `16 lands — low curve (avg mana value ${t.avgCmc.toFixed(2)})`
    : `${landCount} lands (avg mana value ${t.avgCmc.toFixed(2)})`);
  if (pairDelta >= 0.005) reasons.push(`${label} decks win ${(pairDelta * 100).toFixed(1)}pp above average on 17Lands`);
  if (pairDelta <= -0.01) warnings.push(`${label} decks win ${(-pairDelta * 100).toFixed(1)}pp below average on 17Lands`);
  if (nb.length > 0) reasons.push(`Nonbasic lands: ${names(nb)}`);
  if (splashOut) {
    reasons.push(`Splash ${COLOR_NAME[splashColor]} for ${names([...splashCards])} — ${splashOut.sources} sources, ` +
      `~${Math.round(splashOut.castOdds * 100)}% to have one by turn 6`);
    if (direct + search === 0) warnings.push('Splash relies on basic lands only — no duals or fixers');
  }

  if (d.creaturesLow) warnings.push(`Only ${t.creatures} creatures — aim for ${CREATURES.min}–${CREATURES.max}`);
  if (d.twoDrops) warnings.push(`Only ${t.twoDrops} two-drops — aim for ${TWO_DROPS.min}–${TWO_DROPS.max}`);
  if (d.removal) warnings.push(`Only ${t.removal} removal spell${t.removal === 1 ? '' : 's'}`);
  if (d.topEnd) warnings.push(`${t.topEnd} cards at 6+ mana — top-heavy`);
  if (doublePips.length >= 2) warnings.push(`Double-pip cards in your second color: ${names(doublePips)}`);
  if (playables < DECK_SIZE - landCount) warnings.push(`Only ${playables} playables — consider 18 lands or weak filler`);
  const shortBy = DECK_SIZE - landCount - main.length;
  if (shortBy > 0) warnings.push(`Only ${main.length} castable spells — deck is ${shortBy} short of ${DECK_SIZE}`);

  const display = main.slice().sort((a, b) => ((a.cmc ?? 99) - (b.cmc ?? 99)) || (value(b) - value(a)));
  return {
    colors: label,
    splash: splashOut,
    main: display.map(e => e.card),
    nonbasicLands: nb.map(e => e.card),
    lands: { total: landCount, basics },
    score: round(score, 3),
    reasons,
    warnings,
    stats: {
      creatures: t.creatures, removal: t.removal, twoDrops: t.twoDrops,
      curve: t.curve, avgCmc: round(t.avgCmc), playables,
    },
    // internal — stripped before returning
    _pair: pair,
    _basicsOnly: !!splashColor && direct + search === 0,
    _key: `${label}|${splashColor ?? ''}|${main.map(e => e.card.grpId).sort().join(',')}`,
  };
}

/** Splash packages for a pair: the best one or two single-pip off-color cards per color. */
function splashOptions(entries, pair, ctx) {
  const pairSet = new Set(pair);
  const options = [];
  for (const off of COLORS.filter(c => !pairSet.has(c))) {
    const sortKey = (e) => ctx.value(e, pair) - ((e.cmc ?? 0) < SPLASH_PREFERRED_MIN_CMC ? SPLASH_LOW_CMC_PENALTY : 0);
    const cands = entries
      .filter(e => !e.isLand && e.colors.includes(off) &&
        [...e.colors].every(c => c === off || pairSet.has(c)) &&
        e.pips[off] === 1 && ctx.value(e, pair) >= SPLASH_MIN_VALUE)
      .sort(byDesc(sortKey));
    for (let n = 1; n <= Math.min(SPLASH_MAX_CARDS, cands.length); n++) {
      options.push({ color: off, cards: cands.slice(0, n) });
    }
  }
  return options;
}

// ─── Public API ───────────────────────────────────────────────────────────────

function makeContext(opts = {}) {
  const custom = typeof opts.cardValue === 'function' ? opts.cardValue : null;
  return {
    value: (e, pair) => {
      if (e.isBasic) return -Infinity;
      if (custom) return custom(e.card, pair);
      return e.card?.stats?.z ?? UNKNOWN_VALUE;
    },
    pairStrength: opts.pairStrength ?? null,
    format: opts.format === 'bo3' ? 'bo3' : 'bo1',
    maxSuggestions: opts.maxSuggestions ?? 3,
  };
}

/** Best build per pair (splash variant only when it beats the plain build), ranked. */
function rankDecks(entries, ctx) {
  const decks = [];
  for (const pair of PAIRS) {
    const base = buildForPair(entries, pair, ctx);
    if (!base) continue;
    let best = base;
    for (const option of splashOptions(entries, pair, ctx)) {
      const d = buildForPair(entries, pair, ctx, option);
      if (!d) continue;
      const needed = d._basicsOnly ? SPLASH_BASICS_ONLY_MIN_GAIN : 0;
      if (d.score - base.score > needed && d.score > best.score) best = d;
    }
    decks.push(best);
  }
  decks.sort((a, b) => b.score - a.score);
  // Pairs whose second color goes unused collapse to the same mono deck.
  const seen = new Set();
  return decks.filter(d => {
    const k = `${d.colors}|${d.splash?.color ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function publicDeck(d) {
  return Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('_')));
}

/**
 * Suggested decks for a pool, best first.
 * @param pool  normalized cards (lands included; basics are ignored)
 * @param opts  { cardValue?(card, pair), pairStrength?: { WU: 0.02, … },
 *                format?: 'bo1'|'bo3', maxSuggestions?: 3 }
 */
function buildDecks(pool, opts = {}) {
  const ctx = makeContext(opts);
  const entries = (pool ?? []).filter(Boolean).map(describe);
  return rankDecks(entries, ctx).slice(0, ctx.maxSuggestions).map(publicDeck);
}

/**
 * Like buildDecks, but every suggestion carries `variant` ('standard' |
 * 'aggro'), and an aggressive 16-land build of the best pair is inserted
 * right after it when the pool supports one.
 */
function buildSealed(pool, opts = {}) {
  const ctx = makeContext(opts);
  const entries = (pool ?? []).filter(Boolean).map(describe);
  const ranked = rankDecks(entries, ctx);
  const out = ranked.slice(0, ctx.maxSuggestions).map(d => ({ ...d, variant: 'standard' }));
  const best = ranked[0];
  if (best) {
    const aggro = buildForPair(entries, best._pair, ctx, null, 'aggro');
    if (aggro && aggro.stats.avgCmc <= AGGRO_MAX_AVG_CMC && aggro.stats.creatures >= CREATURES.min &&
        aggro._key !== best._key) {
      aggro.reasons.unshift('Aggressive build: lower curve, more cheap creatures, 16 lands');
      out.splice(1, 0, { ...aggro, variant: 'aggro' });
    }
  }
  return out.map(publicDeck);
}

module.exports = {
  buildDecks, buildSealed, pipsOf,
  // exported for tests
  castOdds, cmcOf, describe,
};
