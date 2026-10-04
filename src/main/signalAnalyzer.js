/**
 * signalAnalyzer.js — Draft signal analysis + pick recommendation engine.
 *
 * All functions are pure (no stored state). Input is the tracker state plus
 * current pack data; output is the full assistant analysis object.
 *
 * Recommendations lean on what the rest of the 17Lands player base does:
 *   - Card quality: GIH WR z-score (or the estimate for low-sample cards),
 *     mapped through the normal CDF so it lives on the same 0–1 scale as
 *     every other component. (Raw GIH WR only spans ~0.48–0.65, which used to
 *     let a 0/1 color bonus swamp card quality entirely.)
 *   - Signals: a card tells you something when it reaches you *later than
 *     17Lands drafters usually take it* (pick # vs. its ATA). Seeing a pick-2
 *     card at pick 8 is a strong "open" signal; a pick-9 card at pick 8 is not.
 *   - Wheel prediction: ALSA (average last seen at) says whether a card
 *     typically survives a full lap of the table.
 *   - Archetype strength: two-color deck win rates (top-player cohort when
 *     there's enough data) steer the choice of a second color.
 */

// ─── Tier 3 detectors ─────────────────────────────────────────────────────────
const synergyDetector    = require('./analysis/synergyDetector');
const archetypeDetector  = require('./analysis/archetypeDetector');
const winConditionAnalyzer = require('./analysis/winConditionAnalyzer');
// Lookups into the per-set tables derived from 17Lands' public datasets.
const setDataLookups = require('./setData');

const COLORS = ['W', 'U', 'B', 'R', 'G'];
const POD_SIZE = 8;                 // drafters per pod — a pack wheels after 8 picks
const DEFAULT_PACK_SIZE = 14;       // current Arena boosters; learned from the log when available
const MIN_TOP_PAIR_GAMES = 500;     // trust the top-player cohort's pair WR above this

// Patterns for card classification (rules text from Scryfall)
const REMOVAL_RE = /\b(destroy target|exile target|deal[s]? \d+ damage to (any target|target)|deals damage equal to .* to (any target|target)|gets? [-−]\d+\/[-−]\d+|[-−]\d+\/[-−]\d+ until|loses all abilities|fights? (another )?target|target creature .* fights|return[s]? target (creature|nonland permanent) to its owner's hand|tap target .* it doesn't untap)/i;
const CARD_ADV_RE = /\b(draw a card|draw two|draw three|draw \d+ card|draws? cards? equal|create .* token|investigate|surveil \d|scry \d|proliferate)/i;
const FIXING_RE   = /(guildgate|locket|signpost|pathway|triome|talisman|cultivate|kodama|farseek|growth spiral|expedition map|arcane signet|chromatic|wayfarer|bounty|font of .* )/i;

// ─── Small helpers ───────────────────────────────────────────────────────────

const cardColorsOf = (card) => (card?.color ?? '').replace(/[^WUBRG]/g, '');
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |err| < 1.5e-7). */
function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

const isLandCard = (card) => /\bLand\b/i.test(card?.typeLine ?? '') && !/\bCreature\b/i.test(card?.typeLine ?? '');

function fmtPct(v) { return v != null ? `${(v * 100).toFixed(1)}%` : '—'; }

/** "B+, 58.2%" or "~B, est 56.9%" — never presents an estimate as measured. */
function gradeLabel(card) {
  const s = card?.stats;
  if (!s) return 'no data';
  if (s.grade && s.gradeEstimated && s.gihwrEst != null) return `~${s.grade}, est ${fmtPct(s.gihwrEst)}`;
  if (s.grade && s.gradeEstimated) return `~${s.grade}, GP ${fmtPct(s.gpwr)}`; // brand-new set: no GIH yet
  if (s.grade) return `${s.grade}, ${fmtPct(s.gihwr)}`;
  return 'no grade yet';
}

// ─── Set Metrics ─────────────────────────────────────────────────────────────

/**
 * Per-set baselines. `colorRatings` is the optional output of
 * 17landsData.fetchColorRatings().
 */
function computeSetMetrics(cards, colorRatings = null) {
  const withGih = cards.filter(c => c.stats?.gihwr != null);
  const meanGihwr = withGih.length > 0
    ? withGih.reduce((s, c) => s + c.stats.gihwr, 0) / withGih.length
    : 0.55;
  const stdGihwr = withGih.length > 1
    ? Math.sqrt(withGih.reduce((s, c) => s + (c.stats.gihwr - meanGihwr) ** 2, 0) / withGih.length)
    : 0.04;

  const qualityFractions = {};
  for (const color of COLORS) {
    const qualityCount = withGih.filter(c =>
      c.stats.gihwr > meanGihwr && cardColorsOf(c).includes(color)).length;
    qualityFractions[color] = cards.length > 0 ? qualityCount / cards.length : 0.05;
  }

  // Two-color archetype strength. Prefer the top-player cohort — it reflects
  // what the format rewards when played well — but only when *every* pair has
  // a meaningful top-player sample. Mixing cohorts across pairs would make
  // pairs on the all-player rate look ~5 points worse than they are.
  let pairs = null;
  if (colorRatings?.pairs) {
    pairs = {};
    let wSum = 0, gSum = 0;
    const entries = Object.entries(colorRatings.pairs).filter(([, v]) => v.games);
    const useTop = entries.length > 0 &&
      entries.every(([, v]) => (v.topgames ?? 0) >= MIN_TOP_PAIR_GAMES && v.topWr != null);
    for (const [pair, v] of Object.entries(colorRatings.pairs)) {
      const wr = useTop ? v.topWr : v.wr;
      if (wr == null || !v.games) continue;
      const games = useTop ? v.topgames : v.games;
      pairs[pair] = { wr, overallWr: v.wr, topWr: v.topWr, games: v.games, cohort: useTop ? 'top' : 'all' };
      wSum += wr * games;
      gSum += games;
    }
    const mean = gSum > 0 ? wSum / gSum : null;
    const totalGames = Object.values(pairs).reduce((s, p) => s + p.games, 0);
    for (const p of Object.values(pairs)) {
      p.delta = mean != null ? p.wr - mean : 0;
      p.share = totalGames > 0 ? p.games / totalGames : 0; // how often the field drafts it
    }
    if (Object.keys(pairs).length === 0) pairs = null;
  }

  return { meanGihwr, stdGihwr, qualityFractions, totalCards: cards.length, pairs };
}

/** z-score of a card's quality on the set's GIH scale, or null if unknown. */
function cardZ(card, setMetrics) {
  const s = card?.stats;
  if (!s) return null;
  if (s.z != null) return s.z;
  const mean = setMetrics?.meanGihwr ?? 0.55;
  const std = setMetrics?.stdGihwr ?? 0.04;
  if (s.gihwr != null) return (s.gihwr - mean) / std;
  if (s.gihwrEst != null) return (s.gihwrEst - mean) / std;
  // Older cached data may carry only a letter grade — use the middle of its band.
  if (s.grade && GRADE_Z_MID[s.grade] != null) return GRADE_Z_MID[s.grade];
  return null;
}

/**
 * Pick number (1-based) at which 17Lands drafters typically take the card.
 * Falls back to ALSA (average last seen at) for data that predates ATA.
 */
const typicalPick = (card) => card?.stats?.ata ?? card?.stats?.alsa ?? null;

/**
 * Card quality in [0,1]: Φ(z). An average card scores 0.5, A+ ≈ 0.98, F ≈ 0.02.
 * Unknown cards: 17Lands lists it but has no numbers → slightly below average;
 * 17Lands doesn't list it at all (basic lands etc.) → near zero.
 */
function cardQuality(card, setMetrics) {
  const z = cardZ(card, setMetrics);
  if (z != null) return normCdf(z);
  if (card?.stats) return 0.42;
  return 0.05;
}

// ─── Color Signals ────────────────────────────────────────────────────────────

const SIGNAL_LABELS = [
  [80, 'Wide Open'],
  [60, 'Open'],
  [40, 'Contested'],
  [20, 'Cut Off'],
  [0,  'Hard Cut'],
];

function signalLabel(score) {
  for (const [t, l] of SIGNAL_LABELS) if (score >= t) return l;
  return 'Hard Cut';
}

/**
 * How surprising it is to see `card` at 0-based `pickNumber`, given how early
 * 17Lands drafters normally take it. Only playable cards count.
 */
function lateness(card, pickNumber, setMetrics) {
  const ata = typicalPick(card);
  if (ata == null) return 0;
  const z = cardZ(card, setMetrics);
  if (z == null || z < -0.5) return 0;            // nobody is signalling with chaff
  const picksLate = (pickNumber + 1) - ata;        // ATA is 1-based
  if (picksLate <= 0) return 0;
  return Math.min(picksLate, 8) * (0.5 + normCdf(z)); // better cards → louder signal
}

/**
 * Color openness from pack history. Score 0–100, 50 = typical.
 *
 * For every pack you were passed (pick 2+ of each pack — a fresh pack says
 * nothing about your neighbours), sum the lateness of each playable card per
 * color, then compare colors against each other. Packs from earlier rounds
 * count less: pack 2 passes the other way, and the table shifts over time.
 */
function computeColorSignals(packHistory, setMetrics, confidenceThreshold, currentPackNumber = null) {
  const threshold = confidenceThreshold ?? 4;
  const lastPack = currentPackNumber ?? packHistory[packHistory.length - 1]?.packNumber ?? 0;

  const raw = {};
  const best = {};
  for (const c of COLORS) { raw[c] = 0; best[c] = null; }
  let informativePacks = 0;

  for (const pack of packHistory) {
    if (pack.pickNumber < 1) continue;
    informativePacks++;
    // Picks ~4–9 are when neighbours have settled; picks 2–3 say little
    // (the drafter upstream may simply have had a better card).
    const pickWeight = pack.pickNumber <= 2 ? TUNE.earlySignalWeight : pack.pickNumber <= 8 ? 1 : 0.6;
    const weight = (pack.packNumber === lastPack ? 1 : 0.6) * pickWeight;
    for (const card of pack.cards ?? []) {
      const l = lateness(card, pack.pickNumber, setMetrics);
      if (l <= 0) continue;
      const colors = cardColorsOf(card);
      for (const c of colors) {
        raw[c] += (l * weight) / colors.length;
        if (!best[c] || l > best[c].l) {
          best[c] = { l, name: card.name ?? `#${card.grpId}`, pick: pack.pickNumber + 1, ata: typicalPick(card), packNumber: pack.packNumber + 1 };
        }
      }
    }
  }

  const hasData = informativePacks >= threshold;
  // Compare each color with the *median* color: one very open color shouldn't
  // drag the other four down to "cut" just by raising the average.
  const sorted = COLORS.map(c => raw[c]).sort((a, b) => a - b);
  const median = sorted[2];
  const total = sorted.reduce((a, b) => a + b, 0);

  const signals = {};
  for (const color of COLORS) {
    let score = 50;
    if (hasData && total > 0) {
      const rel = (raw[color] - median) / Math.max(median, 1);
      score = Math.round(Math.max(0, Math.min(100, 50 + 20 * rel)));
    }
    const b = best[color];
    let evidence;
    if (!hasData) {
      evidence = `${informativePacks}/${threshold} passed packs seen`;
    } else if (b) {
      evidence = `${b.name} reached you at P${b.packNumber}p${b.pick} (17Lands avg pick ${b.ata.toFixed(1)})`;
    } else {
      evidence = 'Nothing good has arrived later than usual';
    }
    signals[color] = {
      score,
      label: signalLabel(score),
      lateValue: Math.round(raw[color] * 10) / 10,
      seenLate: best[color] ? 1 : 0,
      latePackCount: informativePacks,
      hasData,
      evidence,
      bestLate: b ? { name: b.name, pick: b.pick, packNumber: b.packNumber, ata: b.ata } : null,
    };
  }
  return signals;
}

// ─── Deck Composition ─────────────────────────────────────────────────────────

function computeDeckComposition(pickedCards) {
  let creatures = 0, nonCreatures = 0, removalCount = 0;
  let cardAdvantageCount = 0, fixingCount = 0;
  const colorCounts = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const curve = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };

  for (const card of pickedCards) {
    const tl = card.typeLine ?? '';
    const ot = card.oracleText ?? '';
    const isCreature = /\bCreature\b/i.test(tl);
    const isLand     = /\bLand\b/i.test(tl) && !isCreature;
    const isInstant  = /\bInstant\b/i.test(tl);
    const isSorcery  = /\bSorcery\b/i.test(tl);
    const hasType    = tl.length > 0;

    if (hasType && !isLand) {
      if (isCreature) creatures++;
      else nonCreatures++;
    }

    if ((isInstant || isSorcery || isCreature || /\b(Enchantment|Artifact)\b/i.test(tl)) && REMOVAL_RE.test(ot)) removalCount++;
    if (CARD_ADV_RE.test(ot)) cardAdvantageCount++;
    if ((isLand && /add \{[WUBRG]\} or \{[WUBRG]\}|any color/i.test(ot)) || FIXING_RE.test(card.name ?? '')) fixingCount++;

    for (const c of cardColorsOf(card)) if (colorCounts[c] !== undefined) colorCounts[c]++;

    if (!isLand && card.cmc != null) {
      const key = Math.min(6, Math.max(1, Math.round(card.cmc)));
      curve[key] = (curve[key] ?? 0) + 1;
    }
  }

  const primaryColors = Object.entries(colorCounts)
    .sort(([, a], [, b]) => b - a)
    .filter(([, v]) => v > 0)
    .slice(0, 2)
    .map(([c]) => c);

  return {
    totalPicked: pickedCards.length,
    creatures, nonCreatures, removalCount, cardAdvantageCount, fixingCount,
    colorCounts, curve, primaryColors,
  };
}

// ─── Mana Analysis ────────────────────────────────────────────────────────────

function computeManaAnalysis(pickedCards) {
  const colorCounts = {};
  let fixingCount = 0;
  for (const card of pickedCards) {
    for (const c of cardColorsOf(card)) colorCounts[c] = (colorCounts[c] || 0) + 1;
    const tl = card.typeLine ?? '';
    const ot = card.oracleText ?? '';
    if ((/\bLand\b/i.test(tl) && /add \{[WUBRG]\} or \{[WUBRG]\}|any color/i.test(ot)) || FIXING_RE.test(card.name ?? '')) {
      fixingCount++;
    }
  }

  const significantColors = Object.values(colorCounts).filter(v => v >= 2).length;
  let assessment, message;
  if (significantColors <= 1) {
    assessment = 'ok';
    message = significantColors === 0 ? 'No color commitment yet' : 'Mono-color — mana base is trivial';
  } else if (significantColors === 2) {
    assessment = 'ok';
    message = 'Clean 2-color deck, mana base looks solid';
  } else if (significantColors === 3 && fixingCount >= 2) {
    assessment = 'splash';
    message = `3-color supported by ${fixingCount} fixing source${fixingCount !== 1 ? 's' : ''}`;
  } else if (significantColors === 3) {
    assessment = 'warning';
    message = `Warning: 3-color deck needs more fixing (have ${fixingCount})`;
  } else {
    assessment = 'danger';
    message = `Warning: ${significantColors}-color deck — mana will be unreliable`;
  }

  return { significantColors, fixingCount, assessment, message };
}

// ─── Deck Needs ───────────────────────────────────────────────────────────────

/** `picksMade` is the number of cards drafted so far (across all packs). */
function computeDeckNeeds(composition, picksMade) {
  const needs = [];
  const { creatures, nonCreatures, removalCount, cardAdvantageCount,
          curve, fixingCount, colorCounts } = composition;
  const totalNonLand = creatures + nonCreatures;

  // Removal
  if (picksMade >= 6 && removalCount < 3) {
    needs.push({ id: 'removal', label: 'Need removal',
      detail: `${removalCount}/3 needed`,
      priority: removalCount === 0 && picksMade >= 12 ? 'high' : 'medium' });
  }

  // Thin at 2-drops
  const twoDrops = curve[2] ?? 0;
  const bigCards = (curve[5] ?? 0) + (curve[6] ?? 0);
  if (picksMade >= 8 && twoDrops < 4 && bigCards >= 4) {
    needs.push({ id: 'two_drops', label: 'Curve thin at 2',
      detail: `${twoDrops}/4 needed`, priority: 'medium' });
  }

  // Top-heavy
  if (picksMade >= 10 && bigCards >= 5 && twoDrops < 3) {
    needs.push({ id: 'top_heavy', label: 'Curve is top-heavy',
      detail: `${bigCards} cards at 5+`, priority: 'medium' });
  }

  // Mana fixing
  const sigColors = Object.values(colorCounts).filter(v => v >= 2).length;
  if (sigColors >= 3 && fixingCount < 2) {
    needs.push({ id: 'fixing', label: 'Need mana fixing',
      detail: `3 colors, ${fixingCount} fixer${fixingCount !== 1 ? 's' : ''}`,
      priority: sigColors >= 4 ? 'high' : 'medium' });
  }

  // Low creatures
  if (picksMade >= 12 && totalNonLand >= 8) {
    const ratio = creatures / totalNonLand;
    if (ratio < 0.55) {
      needs.push({ id: 'creatures', label: 'Low creature count',
        detail: `${creatures} creatures (target ~${Math.round(totalNonLand * 0.6)})`,
        priority: picksMade >= 28 ? 'high' : 'medium' });
    }
  }

  // Card advantage
  if (picksMade >= 12 && cardAdvantageCount === 0) {
    needs.push({ id: 'card_adv', label: 'Need card advantage',
      detail: 'No draw or token sources', priority: 'low' });
  }

  const P = { high: 0, medium: 1, low: 2 };
  return needs.sort((a, b) => (P[a.priority] ?? 2) - (P[b.priority] ?? 2));
}

// ─── Strengths / Weaknesses ───────────────────────────────────────────────────

function computeStrengthsWeaknesses(composition, deckNeeds) {
  const strengths = [], weaknesses = [];
  const { creatures, nonCreatures, removalCount, cardAdvantageCount, curve } = composition;
  const totalNonLand = creatures + nonCreatures;
  const needIds = new Set(deckNeeds.map(n => n.id));

  if (removalCount >= 4) strengths.push(`Strong removal suite (${removalCount} cards)`);
  if (cardAdvantageCount >= 3) strengths.push(`Good card advantage (${cardAdvantageCount} sources)`);
  const curvePeak = Object.entries(curve).filter(([,v])=>v>0).sort(([,a],[,b])=>b-a)[0]?.[0];
  if (curvePeak === '2' || curvePeak === '3') {
    if ((curve[2]??0)>=3 && (curve[3]??0)>=3) strengths.push('Solid mana curve (peaks at 2-3)');
  }
  if (totalNonLand >= 10) {
    const r = creatures / totalNonLand;
    if (r >= 0.6 && r <= 0.75) strengths.push(`Balanced creature/spell ratio (${creatures}/${nonCreatures})`);
  }

  if (removalCount === 0 && composition.totalPicked >= 10) weaknesses.push('No removal spells');
  if (cardAdvantageCount === 0 && composition.totalPicked >= 15) weaknesses.push('No card advantage sources');
  if (needIds.has('top_heavy')) weaknesses.push('Curve is top-heavy — prioritize 2-drops');
  if (needIds.has('fixing')) weaknesses.push('3-color deck without adequate fixing');
  if (needIds.has('creatures') && composition.totalPicked >= 14) weaknesses.push('Below-average creature count');

  return { strengths, weaknesses };
}

// ─── Deck grade summary ───────────────────────────────────────────────────────

const GRADE_SCORES = {
  'A+':1.0,'A':0.92,'A-':0.85,'B+':0.78,'B':0.70,'B-':0.62,
  'C+':0.54,'C':0.46,'C-':0.38,'D+':0.30,'D':0.22,'D-':0.14,'F':0.06,
};
const GRADE_Z = [
  ['A+', 2.0], ['A', 1.67], ['A-', 1.33], ['B+', 1.0], ['B', 0.67], ['B-', 0.33],
  ['C+', 0.0], ['C', -0.33], ['C-', -0.67], ['D+', -1.0], ['D', -1.33], ['D-', -1.67], ['F', -Infinity],
];
// Midpoint z of each grade band (open-ended ends use a representative value).
const GRADE_Z_MID = Object.fromEntries(GRADE_Z.map(([g, zMin], i) => {
  if (i === 0) return [g, 2.3];
  if (zMin === -Infinity) return [g, -2.0];
  return [g, (zMin + GRADE_Z[i - 1][1]) / 2];
}));

/**
 * Average quality of the non-land picks, expressed as a letter grade on the
 * same z-scale as individual card grades.
 */
function computeDeckGrade(pickedCards, setMetrics) {
  if (!pickedCards || pickedCards.length === 0) return null;
  const zs = pickedCards
    .filter(c => !isLandCard(c))
    .map(c => cardZ(c, setMetrics))
    .filter(z => z != null);
  if (zs.length === 0) return null;
  const avgZ = zs.reduce((a, b) => a + b, 0) / zs.length;
  const grade = GRADE_Z.find(([, zMin]) => avgZ >= zMin)[0];
  const mean = setMetrics?.meanGihwr ?? 0.55;
  const std = setMetrics?.stdGihwr ?? 0.04;
  return { grade, avgGihwr: mean + avgZ * std, avgZ, sampleSize: zs.length };
}

// ─── Late-pack signal insights ────────────────────────────────────────────────

const COLOR_NAME = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

/**
 * Human-readable signal insights for the current pack, driven by the same
 * "later than the community takes it" measure as computeColorSignals.
 *
 * Direction: packs 1 and 3 pass one way, pack 2 the other, so cards arriving
 * in pack 2 tell you about the opposite neighbour.
 */
function computeSignalInsights(trackerState, currentPackNumber, currentPickNumber, yourColors = [], colorSignals = null) {
  const { packHistory, setMetrics } = trackerState ?? {};
  if (!packHistory || packHistory.length === 0) return [];
  if (currentPickNumber < 3) return [];

  const neighborLabel = currentPackNumber === 1 ? 'player on your left' : 'player on your right';
  const packs = packHistory.filter(p => p.packNumber === currentPackNumber && p.pickNumber >= 1);
  const insights = [];

  // Most playables have a 17Lands ATA of ~5–10, so nothing can be "late" in
  // the first few picks of a pack; only picks 6+ can show a color drying up.
  const latePacks = packs.filter(p => p.pickNumber >= 5);

  for (const color of COLORS) {
    const lateCards = [];
    let evaluable = 0; // playable cards of this color seen at picks 6+, judged against 17Lands pick data
    for (const pack of packs) {
      for (const card of pack.cards ?? []) {
        if (!cardColorsOf(card).includes(color)) continue;
        if (pack.pickNumber >= 5 && typicalPick(card) != null && (cardZ(card, setMetrics) ?? -9) >= -0.5) evaluable++;
        const l = lateness(card, pack.pickNumber, setMetrics);
        if (l >= 2) lateCards.push({ name: card.name ?? `#${card.grpId}`, pick: pack.pickNumber + 1, ata: typicalPick(card), l });
      }
    }
    lateCards.sort((a, b) => b.l - a.l);
    const colorName = COLOR_NAME[color];

    if (lateCards.length >= 2 || (lateCards[0]?.l ?? 0) >= 5) {
      const top = lateCards[0];
      insights.push({
        tone: 'flowing', color,
        short: `${colorName} is flowing — ${top.name} came pick ${top.pick} (usually ~${top.ata.toFixed(1)}); ${neighborLabel} likely isn't ${colorName}`,
        detail: lateCards.slice(0, 4).map(c => `${c.name} p${c.pick} (ATA ${c.ata.toFixed(1)})`).join(', '),
        strength: lateCards.reduce((s, c) => s + c.l, 0),
      });
    } else if (lateCards.length === 0 && latePacks.length >= 3 && evaluable >= 3 && yourColors.includes(color) &&
               colorSignals?.[color]?.hasData && colorSignals[color].score < 35) {
      // Only worth warning about colors you're actually in, and only when the
      // overall (cross-color) signal agrees — otherwise text and meter disagree.
      insights.push({
        tone: 'cut', color,
        short: `Your ${colorName} may be cut — ${evaluable} playable ${colorName} cards at picks 6+, none later than usual`,
        detail: `Across ${latePacks.length} late packs (pick 6+) in pack ${currentPackNumber + 1}, no playable ${colorName} card arrived past its 17Lands average pick.`,
        strength: 0,
      });
    }
  }

  insights.sort((a, b) => {
    const order = { flowing: 0, cut: 1, neutral: 2 };
    return (order[a.tone] - order[b.tone]) || (b.strength - a.strength);
  });
  return insights;
}

// ─── Card Scoring ─────────────────────────────────────────────────────────────

// Component weights per draft phase. Rows are normalized over the components
// that are available (e.g. no `model` before a set's public data exists).
//   quality: card strength (archetype-adjusted once committed)
//   colorFit: matches your colors   needs: fills a deck hole
//   openness: color is flowing      archetype: strong 2-color pair
//   model: what top 17Lands drafters take from this pack given your pool
// Two sets, both tuned with scripts/tune-weights.js against held-out
// top-player drafts (tune on HOB, check on EOE):
//   BASE  — before a set's public data exists (no pick model yet)
//   MODEL — once the per-set pick model is available; it carries most of
//           the weight, with color fit and needs still adding signal.
// Tuning note: openness (signal reading) earned no weight in the balanced
// style — it didn't make picks more like top players' (consistent with
// published draft models, where pack signals add <1 point). The "signals"
// style keeps it for people who draft that way.
let WEIGHTS_BASE = {
  early:          { quality: 0.188, colorFit: 0.128, needs: 0,    openness: 0,    archetype: 0.05, model: 0 },
  'mid-balanced': { quality: 0.26,  colorFit: 0.24,  needs: 0,    openness: 0,    archetype: 0.05, model: 0 },
  'mid-best-card':{ quality: 0.364, colorFit: 0.168, needs: 0,    openness: 0,    archetype: 0.05, model: 0 },
  'mid-signals':  { quality: 0.26,  colorFit: 0.192, needs: 0,    openness: 0.15, archetype: 0.05, model: 0 },
  late:           { quality: 0.19,  colorFit: 0.34,  needs: 0.18, openness: 0.04, archetype: 0.15, model: 0 },
};
let WEIGHTS_MODEL = {
  early:          { quality: 0,    colorFit: 0.08, needs: 0,    openness: 0.12, archetype: 0.05, model: 0.5 },
  'mid-balanced': { quality: 0.05, colorFit: 0.6,  needs: 0.04, openness: 0.1,  archetype: 0.06, model: 1 },
  'mid-best-card':{ quality: 0.07, colorFit: 0.42, needs: 0.04, openness: 0.1,  archetype: 0.06, model: 1 },
  'mid-signals':  { quality: 0.05, colorFit: 0.48, needs: 0.04, openness: 0.2,  archetype: 0.06, model: 1 },
  late:           { quality: 0.19, colorFit: 0.34, needs: 0.18, openness: 0.04, archetype: 0.06, model: 1 },
};

/** Override / read weights (used by the tuning harness). */
function setWeights(w, which = 'model') { if (which === 'base') WEIGHTS_BASE = w; else WEIGHTS_MODEL = w; }
function getWeights(which = 'model') { return which === 'base' ? WEIGHTS_BASE : WEIGHTS_MODEL; }

/** Colored pips by color from a mana cost like "{1}{W}{W}" (hybrid counts ½ each). */
function pipsOf(card) {
  const out = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const cost = card?.manaCost;
  if (!cost) { for (const c of cardColorsOf(card)) out[c] += 1; return out; }
  for (const sym of cost.match(/\{[^}]+\}/g) ?? []) {
    const parts = sym.slice(1, -1).split('/').filter((p) => out[p] !== undefined);
    for (const p of parts) out[p] += 1 / parts.length;
  }
  return out;
}

/** Position in the draft. `overall` = cards drafted before this pick. */
function draftPosition(packNumber, pickNumber, packSize) {
  const size = packSize ?? DEFAULT_PACK_SIZE;
  return { packNumber, pickNumber, packSize: size, overall: packNumber * size + pickNumber };
}

function selectPhase(pos, draftStyle) {
  if (pos.packNumber === 0 && pos.pickNumber < 5) return 'early';
  if (pos.pickNumber >= pos.packSize - 4) return 'late';
  if (draftStyle === 'best-card') return 'mid-best-card';
  if (draftStyle === 'signals') return 'mid-signals';
  return 'mid-balanced';
}

/**
 * Quality-weighted color commitment from the picks so far.
 * Returns { weights: {W..G}, top: [c1, c2?], commitment 0..1, secondOpen }.
 */
const PAIRS = ['WU', 'WB', 'WR', 'WG', 'UB', 'UR', 'UG', 'BR', 'BG', 'RG'];

/**
 * Quality-weighted color commitment from the picks so far.
 *
 * Commitment grows with picks made *and* with how far the best two-color pair
 * leads the runner-up (17Lands' draft simulations: the right amount of
 * staying open depends on the table — commit when the lane is clear, not at
 * a fixed pick).
 * Returns { weights, top: [c1, c2?], pair, commitment 0..1, secondOpen, lead }.
 */
function colorCommitment(pickedCards, overall, setMetrics, pace = TUNE) {
  const weights = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const pairW = Object.fromEntries(PAIRS.map((p) => [p, 0]));
  for (const c of pickedCards) {
    const colors = cardColorsOf(c);
    const q = cardQuality(c, setMetrics);
    for (const ch of colors) weights[ch] += q / colors.length;
    for (const p of PAIRS) if ([...colors].every((ch) => p.includes(ch))) pairW[p] += colors ? q : q * 0.5;
  }
  const ranked = COLORS.filter(c => weights[c] > 0).sort((a, b) => weights[b] - weights[a]);
  const c1 = ranked[0] ?? null;
  const c2 = ranked[1] ?? null;
  // Second color is "decided" once it carries real weight relative to the first.
  const secondOpen = !c2 || weights[c2] < 0.45 * weights[c1];
  const pairRank = PAIRS.slice().sort((a, b) => pairW[b] - pairW[a]);
  const lead = pairW[pairRank[0]] > 0 ? (pairW[pairRank[0]] - pairW[pairRank[1]]) / pairW[pairRank[0]] : 0;
  const ramp = clamp01((overall - pace.commitStart) / pace.commitSpan);
  const commitment = clamp01(ramp * (pace.commitBase + pace.commitLead * lead));
  return {
    weights, top: secondOpen ? (c1 ? [c1] : []) : [c1, c2],
    pair: !secondOpen && c1 && c2 ? COLORS.filter((c) => c === c1 || c === c2).join('') : null,
    commitment, secondOpen, lead,
  };
}

// Tunable shape parameters (fitted with scripts/tune-weights.js).
let TUNE = {
  commitStart: 3, commitSpan: 15, commitBase: 0.7, commitLead: 1.0,
  pipPenalty: 0.15,          // double-pip cards outside your main color fit less
  pairQualityScale: 1.0,     // how strongly archetype-specific GIH WR adjusts quality
  modelSharpness: 1.0,       // exponent on the model's relative pick probability
  earlySignalWeight: 0.3,    // weight of picks 2–3 when reading signals
  pack1OffColorFloor: 0.25,  // color fit floor for off-color cards in pack 1 (pivot window)
};
// Without the pick model, committing earlier matched top players better.
let PACE_BASE = { commitStart: 0, commitSpan: 8, commitBase: 0.7, commitLead: 2 };
function setTuning(t, which = 'model') {
  if (which === 'base') PACE_BASE = { ...PACE_BASE, ...t };
  TUNE = { ...TUNE, ...(which === 'base' ? {} : t) };
}

function colorFitScore(card, commit, colorSignals, pos = null) {
  const colors = cardColorsOf(card);
  if (!colors) return isLandCard(card) ? 0.5 : 0.8; // colorless spells fit any deck
  if (commit.top.length === 0) return 0.6;

  const fitOne = (ch) => {
    if (commit.top.includes(ch)) return 1;
    if (commit.secondOpen) return 0.6;                       // still choosing a 2nd color
    const open = (colorSignals?.[ch]?.score ?? 50) >= 65;    // pivot room if wide open
    // Pack 1 is still a pivot window: a strong off-color card keeps some credit.
    const floor = pos && pos.packNumber === 0 ? TUNE.pack1OffColorFloor : 0;
    return Math.max(open ? 0.3 : 0, floor);
  };
  const fits = colors.split('').map(fitOne);
  let raw = (Math.min(...fits) + fits.reduce((a, b) => a + b, 0) / fits.length) / 2;
  // Heavy pips in anything but your main color are harder to cast (Karsten).
  const pips = pipsOf(card);
  if (COLORS.some((c) => c !== commit.top[0] && pips[c] >= 2)) raw *= 1 - TUNE.pipPenalty;
  // Blend with neutral while commitment is still forming.
  return 0.6 * (1 - commit.commitment) + raw * commit.commitment;
}

/**
 * Card quality for *your* deck: once you lean into a pair, shift the card's
 * z-score by how much better or worse it performs in that pair than overall
 * (17Lands' per-archetype GIH WR from the public game data). Fixes the
 * classic bias where gold cards and strong-archetype cards look better than
 * they play elsewhere.
 */
function deckQuality(card, ctx) {
  const base = cardQuality(card, ctx.setMetrics);
  const table = ctx.setMetrics?.table;
  const pair = ctx.commit?.pair;
  if (!table || !pair || !card?.grpId) return base;
  const colors = cardColorsOf(card);
  if (![...colors].every((c) => pair.includes(c))) return base;
  const pg = setDataLookups.pairGih(table, card.grpId, pair);
  const overall = table.cards?.[card.grpId]?.gih;
  if (!pg || overall == null || pg.shrunk) return base;
  const z = cardZ(card, ctx.setMetrics);
  if (z == null) return base;
  const std = ctx.setMetrics?.stdGihwr ?? 0.04;
  const shift = ((pg.gih - overall) / std) * TUNE.pairQualityScale * ctx.commit.commitment;
  return normCdf(z + shift);
}

function needsScore(card, deckNeeds) {
  if (!deckNeeds || deckNeeds.length === 0) return 0.5;
  let bonus = 0;
  for (const need of deckNeeds.slice(0, 3)) {
    const w = need.priority === 'high' ? 0.3 : need.priority === 'medium' ? 0.16 : 0.06;
    if (cardAddressesNeed(card, need.id)) bonus += w;
  }
  return Math.min(1, 0.5 + bonus);
}

function opennessScore(card, colorSignals) {
  const colors = cardColorsOf(card);
  if (!colors || !colorSignals) return 0.5;
  const s = colors.split('').map(c => (colorSignals[c]?.hasData ? colorSignals[c].score : 50) / 100);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

/**
 * How good the 2-color archetypes this card leads to are, per the field's
 * results. 0.5 = average pair; ±4 percentage points of win rate ≈ ±0.5.
 */
function archetypeScore(card, commit, setMetrics) {
  const pairs = setMetrics?.pairs;
  const colors = cardColorsOf(card);
  if (!pairs || !colors) return 0.5;
  const pairKey = (a, b) => COLORS.filter(c => c === a || c === b).join('');
  let candidates = [];
  if (colors.length >= 2) {
    candidates = [pairs[pairKey(colors[0], colors[1])]];
  } else if (commit.top.length === 2) {
    candidates = commit.top.includes(colors) ? [pairs[pairKey(commit.top[0], commit.top[1])]] : [];
  } else if (commit.top.length === 1 && commit.top[0] !== colors) {
    candidates = [pairs[pairKey(commit.top[0], colors)]];
  } else {
    // Mono-colored card, no second color yet: its best pairing.
    candidates = COLORS.filter(c => c !== colors).map(c => pairs[pairKey(colors, c)]);
  }
  const best = candidates.filter(Boolean).sort((a, b) => b.delta - a.delta)[0];
  return best ? clamp01(0.5 + best.delta * 12.5) : 0.5;
}

/**
 * Score one card. `ctx` = { pickedCards, colorSignals, deckNeeds, pos,
 * draftStyle, setMetrics, commit }. Returns { total, parts, phase }.
 */
function scoreCard(card, ctx) {
  const phase = selectPhase(ctx.pos, ctx.draftStyle);
  const modelP = ctx.modelScores?.get(card.grpId);
  const w = (ctx.modelScores ? WEIGHTS_MODEL : WEIGHTS_BASE)[phase];
  const parts = {
    quality:   deckQuality(card, ctx),
    colorFit:  colorFitScore(card, ctx.commit, ctx.colorSignals, ctx.pos),
    needs:     needsScore(card, ctx.deckNeeds),
    openness:  opennessScore(card, ctx.colorSignals),
    archetype: archetypeScore(card, ctx.commit, ctx.setMetrics),
    // Relative to the model's favourite in this pack, so it lives on 0..1.
    model:     modelP != null && ctx.modelMax > 0 ? Math.pow(modelP / ctx.modelMax, TUNE.modelSharpness) : null,
  };
  let total = 0, wSum = 0;
  for (const k of Object.keys(w)) {
    if (parts[k] == null || !w[k]) continue;
    total += w[k] * parts[k];
    wSum += w[k];
  }
  return { total: wSum > 0 ? total / wSum : 0, parts, phase };
}

// ─── Wheel prediction ─────────────────────────────────────────────────────────

/**
 * Chance this card is still in the pack when it comes back after a lap of
 * the table. Uses the per-card wheel rate measured in 17Lands' draft data
 * when available; otherwise a curve on ALSA fitted to Sierkovitz's numbers
 * (ALSA ≈ 4 → ~15%, 5 → ~30%, 6 → ~50% for an early-pick wheel).
 */
function wheelInfo(card, pos, packCardCount, table = null) {
  const returnPick = pos.pickNumber + POD_SIZE;            // 0-based pick it would come back at
  if (packCardCount <= POD_SIZE) return null;               // this pack won't come back
  const measured = table ? setDataLookups.wheelProb(table, card.grpId, pos.pickNumber) : null;
  const alsa = card?.stats?.alsa;
  let prob = measured;
  if (prob == null) {
    if (alsa == null) return null;
    prob = 1 / (1 + Math.exp(-1.1 * (alsa - (returnPick + 1 - 3))));
  }
  return { likely: prob >= 0.5, prob, alsa, returnPick: returnPick + 1, measured: measured != null };
}

// ─── Pick options ─────────────────────────────────────────────────────────────

const NEED_TO_FIT_LABEL = {
  removal: 'removal',
  two_drops: '2-drop',
  creatures: 'creature',
  card_adv: 'card advantage',
  fixing: 'mana fixing',
};

function cardAddressesNeed(card, needId) {
  const tl = card.typeLine ?? '';
  const ot = card.oracleText ?? '';
  if (needId === 'removal')   return REMOVAL_RE.test(ot);
  if (needId === 'two_drops') return Math.round(card.cmc ?? 99) === 2 && /\bCreature\b/i.test(tl);
  if (needId === 'top_heavy') return (card.cmc ?? 99) <= 2 && /\bCreature\b/i.test(tl);
  if (needId === 'creatures') return /\bCreature\b/i.test(tl);
  if (needId === 'card_adv')  return CARD_ADV_RE.test(ot);
  if (needId === 'fixing')    return FIXING_RE.test(card.name ?? '') || (/\bLand\b/i.test(tl) && /any color|\{[WUBRG]\} or \{[WUBRG]\}/i.test(ot));
  return false;
}

function gradeAtOrAbove(grade, threshold) {
  const s = GRADE_SCORES[grade];
  const t = GRADE_SCORES[threshold];
  return s != null && t != null && s >= t;
}

function communityNote(card) {
  const ata = card?.stats?.ata;
  return ata != null ? `17Lands drafters take it ~pick ${ata.toFixed(1)}` : null;
}

function buildPickOptions(scored, ctx) {
  const safeEntry = scored[0];
  const safe = safeEntry?.card ?? null;
  if (!safe) return [];
  const colorTag = (c) => cardColorsOf(c) || 'colorless';
  const inColors = ctx.commit.top.length > 0 && cardColorsOf(safe) &&
    cardColorsOf(safe).split('').every(c => ctx.commit.top.includes(c));

  // Highest raw quality in the pack — color-agnostic.
  const byQuality = scored
    .filter(s => cardZ(s.card, ctx.setMetrics) != null)
    .sort((a, b) => b.parts.quality - a.parts.quality);
  const upside = byQuality[0]?.card ?? null;

  const picks = [];
  const topModel = ctx.modelScores ? [...ctx.modelScores.entries()].sort((a, b) => b[1] - a[1])[0] : null;
  const modelNote = (card) => {
    const p = ctx.modelScores?.get(card.grpId);
    return p != null ? `top 17Lands drafters take it here ~${Math.round(p * 100)}% of the time` : null;
  };
  const safeReason = inColors
    ? `best for your ${ctx.commit.top.join('')} deck (${gradeLabel(safe)})`
    : `best overall pick (${gradeLabel(safe)})`;
  const isClear = upside && upside.grpId === safe.grpId;
  picks.push({
    kind: isClear ? 'clear' : 'safe',
    card: safe,
    reason: topModel && topModel[0] === safe.grpId ? `${safeReason} · top players' pick` : safeReason,
    reasonLong: [safeReason, modelNote(safe), communityNote(safe)].filter(Boolean).join(' · '),
  });

  const upsideQualifies = upside && !isClear && gradeAtOrAbove(upside.stats?.grade, 'B+');
  if (upsideQualifies) {
    const opennessBits = cardColorsOf(upside).split('').map(c => `${c} ${ctx.colorSignals?.[c]?.label ?? '?'}`).join(', ');
    const reason = `strongest card in the pack (${gradeLabel(upside)}) — ${cardColorsOf(upside).split('').every(c => ctx.commit.top.includes(c)) ? 'stays in' : 'pulls toward'} ${colorTag(upside)}`;
    picks.push({
      kind: 'upside',
      card: upside,
      reason,
      reasonLong: [reason, opennessBits && `signals: ${opennessBits}`, communityNote(upside)].filter(Boolean).join(' · '),
    });
  }

  // Best card that addresses the deck's top need.
  const topNeed = ctx.deckNeeds?.[0] ?? null;
  if (topNeed) {
    const needEntry = scored.find(s => cardAddressesNeed(s.card, topNeed.id));
    const needCard = needEntry?.card;
    if (needCard && needCard.grpId !== safe.grpId && !(upsideQualifies && needCard.grpId === upside.grpId)) {
      const reason = `fills ${NEED_TO_FIT_LABEL[topNeed.id] ?? 'a gap'} (${gradeLabel(needCard)})`;
      picks.push({
        kind: 'need',
        card: needCard,
        reason,
        reasonLong: `${reason} · your top weakness: ${topNeed.label} (${topNeed.detail})`,
      });
    }
  }

  // Wheel: if the top pick usually comes back around but the runner-up
  // doesn't, you may get both by taking the runner-up now.
  const runnerUp = scored[1];
  if (runnerUp && safeEntry.wheel?.likely && !(runnerUp.wheel?.prob >= 0.35) &&
      safeEntry.total - runnerUp.total < 0.06) {
    const reason = `${safe.name} comes back ~${Math.round(safeEntry.wheel.prob * 100)}% of the time (at pick ${safeEntry.wheel.returnPick}${safeEntry.wheel.measured ? ', per 17Lands draft data' : ''}) — take ${runnerUp.card.name} now and you may get both`;
    picks.push({ kind: 'wheel', card: runnerUp.card, wheelCard: safe, reason, reasonLong: reason });
  }

  return picks;
}

function computeRecommendation(packCards, ctx, tier3) {
  if (!packCards || packCards.length === 0) return null;

  // Tier 3 synergy bonus: up to +4% on top of the base score for cards that
  // synergize with the existing pile.
  const synergyByGrpId = new Map();
  for (const s of tier3?.synergies ?? []) synergyByGrpId.set(s.grpId, s);

  const table = ctx.setMetrics?.table;
  if (table) {
    ctx.modelScores = setDataLookups.modelScores(table, ctx.pickedCards.map((c) => c.grpId), packCards.map((c) => c.grpId));
    ctx.modelMax = ctx.modelScores ? Math.max(...ctx.modelScores.values()) : 0;
  }

  const scored = packCards
    .map(card => {
      const { total, parts, phase } = scoreCard(card, ctx);
      let score = total;
      const syn = synergyByGrpId.get(card.grpId);
      if (syn?.score) score += syn.score * 0.04;
      // Win-condition support: small nudge toward cards that protect or find a bomb
      if (tier3?.winConditions?.hasBomb && tier3.winConditions.supportPattern?.test(card.oracleText ?? '')) score += 0.015;
      return { card, total: score, parts, phase, synergy: syn ?? null, wheel: wheelInfo(card, ctx.pos, packCards.length, ctx.setMetrics?.table) };
    })
    .sort((a, b) => b.total - a.total);

  const primary = scored[0]?.card ?? null;
  if (!primary) return null;
  const secondary = scored.length > 1 && (scored[0].total - scored[1].total) < 0.03
    ? scored[1].card : null;

  const picks = buildPickOptions(scored, ctx);

  // Attach synergy notes to pick reasons so the UI can show them inline.
  for (const p of picks) {
    const syn = synergyByGrpId.get(p.card?.grpId);
    if (syn?.reason) {
      p.synergyNote = syn.reason;
      p.reasonLong = `${p.reasonLong} · Synergy: ${syn.reason}`;
    }
  }

  // Short explanation for the single-line rec bar.
  const phase = scored[0].phase;
  let explanation;
  if (phase === 'early') {
    explanation = 'Early pick — taking the strongest card';
  } else {
    const parts = [];
    if (ctx.commit.top.length > 0) parts.push(`Drafting ${ctx.commit.top.join('')}`);
    const top = scored[0].parts;
    if (top.needs > 0.6) parts.push('fills a deck need');
    else if (primary.stats?.grade && ['A+', 'A', 'A-'].includes(primary.stats.grade)) parts.push(`top-tier card (${primary.stats.grade})`);
    else parts.push('best fit by quality and colors');
    explanation = parts.join(' — ');
  }

  return {
    primary, secondary, explanation, colors: ctx.commit.top, picks,
    // Per-card breakdown so the UI / tests can explain any ranking.
    ranking: scored.map(s => ({
      grpId: s.card.grpId, name: s.card.name, score: Math.round(s.total * 1000) / 1000,
      parts: Object.fromEntries(Object.entries(s.parts).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      wheelLikely: !!s.wheel?.likely,
    })),
  };
}

// ─── Wheel report: what the table took from a pack you've seen before ────────

/**
 * When a pack comes back (8 picks later), list the cards that were taken from
 * it in between — direct evidence of what your neighbours are drafting.
 */
function computeWheelReport(packHistory, pickHistory, pos) {
  if (pos.pickNumber < POD_SIZE) return null;
  const earlierPick = pos.pickNumber - POD_SIZE;
  const earlier = packHistory.find(p => p.packNumber === pos.packNumber && p.pickNumber === earlierPick);
  const current = packHistory.find(p => p.packNumber === pos.packNumber && p.pickNumber === pos.pickNumber);
  if (!earlier || !current) return null;
  const remaining = new Map();
  for (const c of current.cards ?? []) remaining.set(c.grpId, (remaining.get(c.grpId) ?? 0) + 1);
  const mine = pickHistory.find(p => p.packNumber === pos.packNumber && p.pickNumber === earlierPick);
  let mineLeft = mine ? 1 : 0;
  const taken = [];
  for (const c of earlier.cards ?? []) {
    if (mineLeft && c.grpId === mine.grpId) { mineLeft = 0; continue; }
    const left = remaining.get(c.grpId) ?? 0;
    if (left > 0) { remaining.set(c.grpId, left - 1); continue; }
    taken.push({ grpId: c.grpId, name: c.name ?? `#${c.grpId}`, color: cardColorsOf(c), grade: c.stats?.grade ?? null });
  }
  const colorCounts = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const t of taken) for (const ch of t.color) colorCounts[ch]++;
  return { fromPick: earlierPick + 1, taken, colorCounts };
}

// ─── Playables meter ──────────────────────────────────────────────────────────

const PLAYABLES_TARGET = 23;        // spells in a 40-card deck
const PLAYABLE_MIN_Z = -1.0;        // about D+: a card you'd actually put in the deck

/** How many of your picks would make a deck in your current colors. */
function computePlayables(pickHistory, commit, setMetrics) {
  const colors = commit.top;
  let playables = 0, creatures = 0, twoDrops = 0;
  for (const c of pickHistory) {
    const cc = cardColorsOf(c);
    if (isLandCard(c)) continue;
    if (colors.length && ![...cc].every(ch => colors.includes(ch))) continue;
    const z = cardZ(c, setMetrics);
    if (z != null && z < PLAYABLE_MIN_Z) continue;
    playables++;
    if (/\bCreature\b/i.test(c.typeLine ?? '')) {
      creatures++;
      if (c.cmc != null && c.cmc <= 2) twoDrops++;
    }
  }
  return { colors: colors.join(''), playables, target: PLAYABLES_TARGET, creatures, twoDrops };
}

// ─── Main Analyze Function ────────────────────────────────────────────────────

function detectColors(pickedCards) {
  if (!pickedCards || pickedCards.length === 0) return [];
  const counts = { W:0, U:0, B:0, R:0, G:0 };
  for (const c of pickedCards) for (const ch of cardColorsOf(c)) counts[ch]++;
  return Object.entries(counts).sort(([,a],[,b])=>b-a).filter(([,v])=>v>0).slice(0,2).map(([k])=>k);
}

/**
 * @param trackerState  draftTracker.getState()
 * @param packCards     enriched cards in the current pack (or null after a pick)
 * @param position      { packNumber, pickNumber, packSize } — 0-based. A bare
 *                      number is accepted as pickNumber for older callers.
 * @param settings      assistant settings
 */
function analyze(trackerState, packCards, position, settings) {
  const { packHistory, pickHistory, setMetrics } = trackerState;
  const confidenceThreshold = settings?.confidenceThreshold ?? 4;
  const draftStyle = settings?.draftStyle ?? 'balanced';

  const lastPack = packHistory[packHistory.length - 1];
  const p = typeof position === 'object' && position !== null ? position : { pickNumber: position ?? 0 };
  const packSize = p.packSize ?? trackerState.packSize ?? DEFAULT_PACK_SIZE;
  const pos = draftPosition(p.packNumber ?? lastPack?.packNumber ?? 0, p.pickNumber ?? 0, packSize);
  const picksMade = pickHistory.length;

  const colorSignals = computeColorSignals(packHistory, setMetrics, confidenceThreshold, pos.packNumber);
  const hasColorData = Object.values(colorSignals).some(s => s.hasData);

  const composition = computeDeckComposition(pickHistory);
  const deckNeeds   = computeDeckNeeds(composition, picksMade);
  const { strengths, weaknesses } = computeStrengthsWeaknesses(composition, deckNeeds);
  const manaAnalysis = computeManaAnalysis(pickHistory);
  const deckGrade    = computeDeckGrade(pickHistory, setMetrics);
  const commit = colorCommitment(pickHistory, picksMade, setMetrics, setMetrics?.table?.model ? TUNE : PACE_BASE);
  const signalInsights = computeSignalInsights(trackerState, pos.packNumber, pos.pickNumber, commit.top, colorSignals);

  // ── Tier 3 detectors ────────────────────────────────────────────────────────
  const synergyResult      = synergyDetector.analyzeSynergies(pickHistory, packCards ?? []);
  const archetypeResult    = archetypeDetector.detectArchetype(pickHistory);
  const winConditionResult = winConditionAnalyzer.analyzeWinConditions(pickHistory);

  const ctx = {
    pickedCards: pickHistory, colorSignals, deckNeeds: deckNeeds.slice(0, 3),
    pos, draftStyle, setMetrics, commit,
  };
  const wheelReport = computeWheelReport(packHistory, pickHistory, pos);
  const playables = computePlayables(pickHistory, commit, setMetrics);

  const recommendation = (packCards && packCards.length > 0)
    ? computeRecommendation(packCards, ctx,
        { synergies: synergyResult.synergies, archetype: archetypeResult, winConditions: winConditionResult })
    : null;

  // Which archetypes the field is winning with, for the UI.
  const archetypeStandings = setMetrics?.pairs
    ? Object.entries(setMetrics.pairs)
        .map(([pair, v]) => ({ pair, wr: v.wr, overallWr: v.overallWr, cohort: v.cohort, share: v.share, delta: v.delta }))
        .sort((a, b) => b.wr - a.wr)
    : [];

  return {
    colorSignals,
    hasColorData,
    deckComposition: composition,
    deckNeeds: deckNeeds.slice(0, 3),
    strengths,
    weaknesses,
    manaAnalysis,
    deckGrade,
    signalInsights,
    currentPackNumber: pos.packNumber,
    commitment: { colors: commit.top, secondColorOpen: commit.secondOpen, strength: commit.commitment },
    wheelReport,
    playables,
    hasPickModel: !!setMetrics?.table?.model,
    archetypeStandings,
    // Tier 3 detector outputs
    synergies: synergyResult.synergies,
    synergyThemes: synergyResult.themes,
    archetype: archetypeResult,
    winConditions: { ...winConditionResult, supportPattern: undefined },
    pickHistory: pickHistory.map(ph => ({ ...ph, stats: undefined })),
    recommendation,
    pickNumber: pos.pickNumber,
    packSize: pos.packSize,
    lastUpdated: Date.now(),
  };
}

function emptyState() {
  const neutral = { score: 50, label: 'Contested', lateValue: 0, seenLate: 0, latePackCount: 0, hasData: false, evidence: 'No packs seen yet', bestLate: null };
  return {
    colorSignals: { W: { ...neutral }, U: { ...neutral }, B: { ...neutral }, R: { ...neutral }, G: { ...neutral } },
    hasColorData: false,
    deckComposition: { totalPicked:0, creatures:0, nonCreatures:0, removalCount:0, cardAdvantageCount:0, fixingCount:0, colorCounts:{W:0,U:0,B:0,R:0,G:0}, curve:{1:0,2:0,3:0,4:0,5:0,6:0}, primaryColors:[] },
    deckNeeds: [],
    strengths: [],
    weaknesses: [],
    manaAnalysis: { significantColors:0, fixingCount:0, assessment:'ok', message:'Draft not started' },
    deckGrade: null,
    signalInsights: [],
    currentPackNumber: 0,
    commitment: { colors: [], secondColorOpen: true, strength: 0 },
    archetypeStandings: [],
    synergies: [],
    synergyThemes: {},
    archetype: { primary: null, confidence: 0, fits: {}, label: 'Unknown' },
    winConditions: { hasBomb: false, bombs: [], types: [], weakness: null, message: '' },
    pickHistory: [],
    recommendation: null,
    pickNumber: 0,
    packSize: DEFAULT_PACK_SIZE,
    lastUpdated: Date.now(),
  };
}

module.exports = {
  computeSetMetrics, computeColorSignals, computeDeckComposition, computeManaAnalysis,
  computeDeckNeeds, computeStrengthsWeaknesses, computeRecommendation,
  computeSignalInsights, computeDeckGrade,
  analyze, emptyState, detectColors, scoreCard,
  // exported for tests
  cardQuality, wheelInfo, colorCommitment, lateness, normCdf, pipsOf,
  setWeights, getWeights, setTuning,
};
