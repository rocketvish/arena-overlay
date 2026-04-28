/**
 * signalAnalyzer.js — Draft signal analysis engine.
 *
 * All functions are pure (no stored state). Input is the tracker state plus
 * current pack data; output is the full assistant analysis object.
 *
 * Designed to be pluggable: Tier 3 modules can be uncommented below when ready.
 */

// ─── Tier 3 detectors ─────────────────────────────────────────────────────────
const synergyDetector    = require('./analysis/synergyDetector');
const archetypeDetector  = require('./analysis/archetypeDetector');
const winConditionAnalyzer = require('./analysis/winConditionAnalyzer');

const COLORS = ['W', 'U', 'B', 'R', 'G'];
const LATE_PICK_THRESHOLD = 5; // picks 5+ (0-indexed) are "late"

// Patterns for card classification
const REMOVAL_RE = /\b(destroy|exile target|deal[s]? \d+ damage|−\d+\/−\d+|loses all abilities|return[s]? target .* to .* hand|tap[s]? target|counter target)/i;
const CARD_ADV_RE = /\b(draw a card|draw two|draw \d+ card|create .* token|investigate|surveil \d|scry \d|proliferate)/i;
const FIXING_RE   = /(guildgate|locket|signpost|pathway|triome|talisman|cultivate|kodama|farseek|growth spiral|expedition map|arcane signet|chromatic|wayfarer|bounty|font of .* )/i;

// ─── Set Metrics ─────────────────────────────────────────────────────────────

/**
 * Compute per-color quality baselines from a set's 17Lands data.
 * "Quality" cards are those with gihwr above the set mean.
 */
function computeSetMetrics(cards) {
  const withGih = cards.filter(c => c.stats?.gihwr != null);
  const meanGihwr = withGih.length > 0
    ? withGih.reduce((s, c) => s + c.stats.gihwr, 0) / withGih.length
    : 0.55;

  const qualityFractions = {};
  for (const color of COLORS) {
    const qualityCount = withGih.filter(c =>
      c.stats.gihwr > meanGihwr &&
      (c.color ?? '').replace(/[^WUBRG]/g, '').includes(color)
    ).length;
    qualityFractions[color] = cards.length > 0 ? qualityCount / cards.length : 0.05;
  }

  return { meanGihwr, qualityFractions, totalCards: cards.length };
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
 * Compute color openness signals from pack history.
 * Score 0–100: 100 = very open, 50 = expected rate, 0 = fully cut.
 */
function computeColorSignals(packHistory, setMetrics, confidenceThreshold) {
  const threshold = confidenceThreshold ?? 4;
  const signals = {};

  for (const color of COLORS) {
    let seenTotal = 0, seenLate = 0, latePackCount = 0;
    const qFrac = setMetrics?.qualityFractions?.[color] ?? 0.05;
    const meanGih = setMetrics?.meanGihwr ?? 0.55;

    for (const pack of packHistory) {
      const qualityInPack = (pack.cards ?? []).filter(c =>
        (c.color ?? '').replace(/[^WUBRG]/g, '').includes(color) &&
        (c.stats?.gihwr ?? 0) > meanGih
      ).length;

      seenTotal += qualityInPack;
      if (pack.pickNumber >= LATE_PICK_THRESHOLD) {
        seenLate += qualityInPack;
        latePackCount++;
      }
    }

    const hasData = latePackCount >= threshold;
    let score = 50;

    if (hasData && latePackCount > 0) {
      // Expected quality cards per late pack ≈ remaining cards × quality fraction
      const avgRemainingAtLate = 15 - LATE_PICK_THRESHOLD; // ~10
      const expected = Math.max(0.3, latePackCount * avgRemainingAtLate * qFrac);
      score = Math.round(Math.min(100, Math.max(0, (seenLate / expected) * 50)));
    }

    let evidence;
    if (!hasData) {
      evidence = latePackCount === 0
        ? 'No late packs yet'
        : `${latePackCount}/${threshold} late packs seen`;
    } else {
      evidence = seenLate === 0
        ? `0 quality cards seen at picks ${LATE_PICK_THRESHOLD + 1}+`
        : `${seenLate} quality card${seenLate !== 1 ? 's' : ''} seen at late picks`;
    }

    signals[color] = { score, label: signalLabel(score), seenTotal, seenLate, latePackCount, hasData, evidence };
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
    const isLand     = /\bLand\b/i.test(tl);
    const isInstant  = /\bInstant\b/i.test(tl);
    const isSorcery  = /\bSorcery\b/i.test(tl);
    const hasType    = tl.length > 0;

    if (hasType && !isLand) {
      if (isCreature) creatures++;
      else nonCreatures++;
    }

    if ((isInstant || isSorcery || isCreature) && REMOVAL_RE.test(ot)) removalCount++;
    if (CARD_ADV_RE.test(ot)) cardAdvantageCount++;
    if ((isLand && /\b[WUBRG]\b.*\b[WUBRG]\b/i.test(ot)) || FIXING_RE.test(card.name ?? '')) fixingCount++;

    const cardColors = (card.color ?? '').replace(/[^WUBRG]/g, '');
    for (const c of cardColors) if (colorCounts[c] !== undefined) colorCounts[c]++;

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
    for (const c of (card.color ?? '').replace(/[^WUBRG]/g, '')) {
      colorCounts[c] = (colorCounts[c] || 0) + 1;
    }
    const tl = card.typeLine ?? '';
    const ot = card.oracleText ?? '';
    if ((/\bLand\b/i.test(tl) && /\b[WUBRG]\b.*\b[WUBRG]\b/i.test(ot)) || FIXING_RE.test(card.name ?? '')) {
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

function computeDeckNeeds(composition, pickNumber) {
  const needs = [];
  const { creatures, nonCreatures, removalCount, cardAdvantageCount,
          curve, fixingCount, colorCounts, totalPicked } = composition;
  const totalNonLand = creatures + nonCreatures;

  // Removal
  if (pickNumber >= 6 && removalCount < 3) {
    needs.push({ id: 'removal', label: 'Need removal',
      detail: `${removalCount}/3 needed`,
      priority: removalCount === 0 && pickNumber >= 12 ? 'high' : 'medium' });
  }

  // Thin at 2-drops
  const twoDrops = curve[2] ?? 0;
  const bigCards = (curve[5] ?? 0) + (curve[6] ?? 0);
  if (pickNumber >= 8 && twoDrops < 4 && bigCards >= 4) {
    needs.push({ id: 'two_drops', label: 'Curve thin at 2',
      detail: `${twoDrops}/4 needed`, priority: 'medium' });
  }

  // Top-heavy
  if (pickNumber >= 10 && bigCards >= 5 && twoDrops < 3) {
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
  if (pickNumber >= 12 && totalNonLand >= 8) {
    const ratio = creatures / totalNonLand;
    if (ratio < 0.55) {
      needs.push({ id: 'creatures', label: 'Low creature count',
        detail: `${creatures} creatures (target ~${Math.round(totalNonLand * 0.6)})`,
        priority: 'medium' });
    }
  }

  // Card advantage
  if (pickNumber >= 12 && cardAdvantageCount === 0) {
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

// ─── Deck grade summary (Section 5) ───────────────────────────────────────────

/**
 * Average GIHWR of all picked cards, mapped back to a single letter grade.
 * Lands and cards without 17Lands data are excluded.
 */
function computeDeckGrade(pickedCards) {
  if (!pickedCards || pickedCards.length === 0) return null;

  const valid = pickedCards.filter(c => {
    const tl = c.typeLine ?? '';
    if (/\bLand\b/i.test(tl)) return false;
    return c.stats?.gihwr != null || (c.grade && GRADE_SCORES[c.grade] != null);
  });

  if (valid.length === 0) return null;

  const avgGihwr = valid.reduce((s, c) => {
    if (c.stats?.gihwr != null) return s + c.stats.gihwr;
    if (c.grade && GRADE_SCORES[c.grade] != null) return s + GRADE_SCORES[c.grade];
    return s;
  }, 0) / valid.length;

  // Map average GIHWR back to a grade by finding the closest GRADE_SCORES entry.
  const entries = Object.entries(GRADE_SCORES).sort(([, a], [, b]) => b - a);
  let best = entries[0];
  let bestDiff = Math.abs(avgGihwr - best[1]);
  for (const e of entries) {
    const diff = Math.abs(avgGihwr - e[1]);
    if (diff < bestDiff) { best = e; bestDiff = diff; }
  }

  return {
    grade: best[0],
    avgGihwr,
    sampleSize: valid.length,
  };
}

// ─── Late-pack signal insights (Section 4) ────────────────────────────────────

const COLOR_NAME = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

/**
 * Generate human-readable insights about color signals once the late-pack
 * window opens (pick 6+ within the current pack).
 *
 * Direction handling: in pack 2 the player passes left, so quality cards seen
 * late tell us about the *left* neighbor. P1 and P3 pass right.
 *
 * @param {object} trackerState  draftTracker.getState()
 * @param {number} currentPackNumber  0-indexed pack the player is currently in
 * @param {number} currentPickNumber  0-indexed pick within that pack
 * @returns {Array<{tone: 'flowing'|'cut'|'neutral', short: string, detail: string, color: string}>}
 */
function computeSignalInsights(trackerState, currentPackNumber, currentPickNumber) {
  const { packHistory, setMetrics } = trackerState ?? {};
  if (!packHistory || packHistory.length === 0) return [];

  // Insights only kick in once we're at pick 6+ OR we have data from a prior pack.
  const enoughLateData = currentPickNumber >= 5
    || (packHistory.some(p => p.packNumber < currentPackNumber && p.pickNumber >= 5));
  if (!enoughLateData) return [];

  const meanGih = setMetrics?.meanGihwr ?? 0.55;
  const direction = currentPackNumber === 1 ? 'left' : 'right';
  const neighborLabel = direction === 'left' ? 'player to your left' : 'player to your right';

  const insights = [];

  for (const color of COLORS) {
    // Look at quality cards seen at late picks (6+) of the *current* pack only —
    // each pack's signals are independent (a new pack means new neighbor).
    const latePacksThisPack = packHistory.filter(p =>
      p.packNumber === currentPackNumber && p.pickNumber >= 5);
    if (latePacksThisPack.length === 0) continue;

    const lateCards = [];
    for (const pack of latePacksThisPack) {
      for (const card of (pack.cards ?? [])) {
        const cardColors = (card.color ?? '').replace(/[^WUBRG]/g, '');
        if (!cardColors.includes(color)) continue;
        const gih = card.stats?.gihwr ?? 0;
        if (gih > meanGih) {
          lateCards.push({
            name: card.name ?? `#${card.grpId}`,
            pickNumber: pack.pickNumber,
            grade: card.stats?.grade,
          });
        }
      }
    }

    const colorName = COLOR_NAME[color];

    if (lateCards.length >= 3) {
      // Quality cards consistently appearing late → color is open / flowing.
      const pickRange = `picks ${Math.min(...lateCards.map(c => c.pickNumber)) + 1}-${Math.max(...lateCards.map(c => c.pickNumber)) + 1}`;
      insights.push({
        tone: 'flowing',
        color,
        short: `${colorName} is flowing — ${lateCards.length} quality cards late, ${neighborLabel} likely isn't in ${colorName}`,
        detail: `${lateCards.length} quality ${colorName} cards seen at ${pickRange}: ${lateCards.slice(0, 4).map(c => c.name).join(', ')}${lateCards.length > 4 ? '…' : ''}`,
      });
    } else if (lateCards.length === 0 && latePacksThisPack.length >= 3) {
      // Multiple late packs and zero quality in this color → cut.
      insights.push({
        tone: 'cut',
        color,
        short: `${colorName} appears cut — no playable ${colorName} since pick ${latePacksThisPack[0].pickNumber + 1}`,
        detail: `Across ${latePacksThisPack.length} late packs (pick 6+) in pack ${currentPackNumber + 1}, zero quality ${colorName} cards reached you.`,
      });
    }
  }

  // Sort: flowing first (actionable), then cut.
  insights.sort((a, b) => {
    const order = { flowing: 0, cut: 1, neutral: 2 };
    return (order[a.tone] ?? 9) - (order[b.tone] ?? 9);
  });

  return insights;
}

// ─── Card Scoring (for recommendation) ────────────────────────────────────────

const GRADE_SCORES = {
  'A+':1.0,'A':0.92,'A-':0.85,'B+':0.78,'B':0.70,'B-':0.62,
  'C+':0.54,'C':0.46,'C-':0.38,'D+':0.30,'D':0.22,'D-':0.14,'F':0.06,
};

function cardBaseScore(card) {
  if (card.stats?.gihwr != null) return card.stats.gihwr;
  const g = card.stats?.grade;
  if (g && GRADE_SCORES[g] != null) return GRADE_SCORES[g];
  if (card.stats?.gpwr != null) return card.stats.gpwr * 0.95;
  return 0.5;
}

function detectColors(pickedCards) {
  if (!pickedCards || pickedCards.length === 0) return [];
  const counts = { W:0, U:0, B:0, R:0, G:0 };
  for (const c of pickedCards) {
    for (const ch of (c.color ?? '').replace(/[^WUBRG]/g, '')) {
      if (counts[ch] !== undefined) counts[ch]++;
    }
  }
  return Object.entries(counts).sort(([,a],[,b])=>b-a).filter(([,v])=>v>0).slice(0,2).map(([k])=>k);
}

function scoreCard(card, pickedCards, colorSignals, deckNeeds, pickNumber, draftStyle) {
  const isEarly = pickNumber < 5;
  const isLate  = pickNumber >= 10;

  let wA, wB, wC, wD;
  if (isEarly) {
    [wA,wB,wC,wD] = [0.70, 0.15, 0.05, 0.10];
  } else if (isLate) {
    [wA,wB,wC,wD] = [0.30, 0.25, 0.35, 0.10];
  } else if (draftStyle === 'best-card') {
    [wA,wB,wC,wD] = [0.55, 0.20, 0.15, 0.10];
  } else if (draftStyle === 'signals') {
    [wA,wB,wC,wD] = [0.25, 0.25, 0.20, 0.30];
  } else { // balanced
    [wA,wB,wC,wD] = [0.40, 0.25, 0.20, 0.15];
  }

  // A: base win rate
  const sA = cardBaseScore(card);

  // B: color alignment
  const primaryColors = detectColors(pickedCards);
  const cardColors = (card.color ?? '').replace(/[^WUBRG]/g, '');
  let sB = 0.5;
  if (cardColors.length === 0) sB = 0.7; // colorless
  else if (primaryColors.length === 0) sB = 0.5;
  else sB = cardColors.split('').some(c => primaryColors.includes(c)) ? 1.0 : 0.0;

  // C: deck needs
  let sC = 0.5;
  if (deckNeeds.length > 0 && pickNumber >= 8) {
    let bonus = 0;
    const tl = card.typeLine ?? '';
    const ot = card.oracleText ?? '';
    for (const need of deckNeeds.slice(0, 3)) {
      const w = need.priority === 'high' ? 0.15 : need.priority === 'medium' ? 0.08 : 0.03;
      if (need.id === 'removal'    && REMOVAL_RE.test(ot))                    bonus += w;
      if (need.id === 'two_drops'  && Math.round(card.cmc ?? 99) === 2)       bonus += w;
      if (need.id === 'creatures'  && /\bCreature\b/i.test(tl))               bonus += w;
      if (need.id === 'card_adv'   && CARD_ADV_RE.test(ot))                   bonus += w;
      if (need.id === 'fixing'     && FIXING_RE.test(card.name ?? ''))        bonus += w;
    }
    sC = Math.min(1, 0.5 + bonus);
  }

  // D: color openness
  let sD = 0.5;
  if (colorSignals && cardColors.length > 0) {
    const scores = cardColors.split('').map(c => (colorSignals[c]?.score ?? 50) / 100);
    sD = scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  return wA * sA + wB * sB + wC * sC + wD * sD;
}

// ─── Multi-option recommendation helpers (Section 3) ──────────────────────────

const NEED_TO_FIT_LABEL = {
  removal: 'removal',
  two_drops: '2-drop',
  creatures: 'creature',
  card_adv: 'card draw',
  fixing: 'mana fixing',
};

function cardAddressesNeed(card, needId) {
  const tl = card.typeLine ?? '';
  const ot = card.oracleText ?? '';
  if (needId === 'removal')   return REMOVAL_RE.test(ot) && (/\b(Instant|Sorcery|Creature)\b/i.test(tl) || tl === '');
  if (needId === 'two_drops') return Math.round(card.cmc ?? 99) === 2 && /\bCreature\b/i.test(tl);
  if (needId === 'creatures') return /\bCreature\b/i.test(tl);
  if (needId === 'card_adv')  return CARD_ADV_RE.test(ot);
  if (needId === 'fixing')    return FIXING_RE.test(card.name ?? '');
  return false;
}

function gradeAtOrAbove(grade, threshold) {
  const s = GRADE_SCORES[grade];
  const t = GRADE_SCORES[threshold];
  return s != null && t != null && s >= t;
}

function shortReason(card, kind, ctx) {
  const grade = card.stats?.grade ?? '?';
  const gih = card.stats?.gihwr != null ? `${(card.stats.gihwr * 100).toFixed(1)}%` : '—';
  const colors = (card.color ?? '').replace(/[^WUBRG]/g, '');
  const colorTag = colors || 'colorless';

  if (kind === 'safe' || kind === 'clear') {
    if (ctx.primaryColors.length > 0 && colors && colors.split('').every(c => ctx.primaryColors.includes(c))) {
      return `best in your ${ctx.primaryColors.join('')} colors (${grade}, ${gih})`;
    }
    return `top score in pack (${grade}, ${gih})`;
  }
  if (kind === 'upside') {
    return `strongest raw card (${grade}, ${gih}) — pivot to ${colorTag}`;
  }
  if (kind === 'need') {
    const label = NEED_TO_FIT_LABEL[ctx.needId] ?? 'gap';
    return `fills ${label} gap (${grade}, ${gih})`;
  }
  return `${grade}, ${gih}`;
}

function longReason(card, kind, ctx) {
  const grade = card.stats?.grade ?? '?';
  const gih = card.stats?.gihwr != null ? `${(card.stats.gihwr * 100).toFixed(1)}%` : '—';
  const colors = (card.color ?? '').replace(/[^WUBRG]/g, '');
  const inColor = colors && colors.split('').every(c => ctx.primaryColors.includes(c));
  const colorPhrase = ctx.primaryColors.length > 0 ? ` in your colors (${ctx.primaryColors.join('')})` : '';

  if (kind === 'safe' || kind === 'clear') {
    if (ctx.needId && cardAddressesNeed(card, ctx.needId)) {
      const needDetail = ctx.needs?.find(n => n.id === ctx.needId)?.detail ?? '';
      return `${grade}, ${gih} GIHWR — best overall pick${colorPhrase}, also addresses ${NEED_TO_FIT_LABEL[ctx.needId] ?? 'need'} (${needDetail})`;
    }
    return `${grade}, ${gih} GIHWR — best overall pick${colorPhrase}`;
  }
  if (kind === 'upside') {
    const opennessBits = colors ? colors.split('').map(c => `${c}: ${ctx.colorSignals?.[c]?.score ?? 50}`).join(', ') : '';
    return `${grade}, ${gih} GIHWR — strongest card in pack, would require ${inColor ? 'staying in' : 'pivoting to'} ${colors || 'colorless'}${opennessBits ? ` (signals — ${opennessBits})` : ''}`;
  }
  if (kind === 'need') {
    const need = ctx.needs?.find(n => n.id === ctx.needId);
    const needDetail = need ? need.detail : '';
    return `${grade}, ${gih} GIHWR — addresses your top weakness: ${need?.label ?? NEED_TO_FIT_LABEL[ctx.needId] ?? 'gap'}${needDetail ? ` (${needDetail})` : ''}`;
  }
  return `${grade}, ${gih} GIHWR`;
}

/**
 * Build SAFE / UPSIDE / NEED / CLEAR pick options.
 *
 * - SAFE: highest combined-score card (uses scoreCard's existing weights).
 * - UPSIDE: highest raw GIHWR in the pack regardless of color, only shown if
 *           it differs from SAFE and grades B+ or higher.
 * - NEED:   best card that addresses the deck's #1 need, only shown if there
 *           is a clear need AND that card differs from SAFE.
 * - CLEAR:  shown instead of SAFE+UPSIDE when SAFE and UPSIDE are the same card.
 */
function buildPickOptions(scored, packCards, primaryColors, deckNeeds, colorSignals) {
  const safe = scored[0]?.card ?? null;
  if (!safe) return [];

  // Highest raw GIHWR in the pack — color-agnostic.
  const byGih = packCards
    .filter(c => c.stats?.gihwr != null || c.stats?.grade != null)
    .map(c => ({ card: c, score: cardBaseScore(c) }))
    .sort((a, b) => b.score - a.score);
  const upsideCard = byGih[0]?.card ?? null;

  // Best card that addresses the deck's top need.
  const topNeed = deckNeeds?.[0] ?? null;
  let needCard = null;
  if (topNeed) {
    const candidates = packCards
      .filter(c => cardAddressesNeed(c, topNeed.id))
      .map(c => ({ card: c, score: cardBaseScore(c) }))
      .sort((a, b) => b.score - a.score);
    needCard = candidates[0]?.card ?? null;
  }

  const ctx = { primaryColors, needs: deckNeeds, needId: topNeed?.id ?? null, colorSignals };
  const picks = [];

  const upsideQualifies = upsideCard
    && upsideCard.grpId !== safe.grpId
    && gradeAtOrAbove(upsideCard.stats?.grade, 'B+');

  if (upsideCard && upsideCard.grpId === safe.grpId && safe.stats?.grade) {
    picks.push({
      kind: 'clear', card: safe,
      reason: shortReason(safe, 'clear', ctx),
      reasonLong: longReason(safe, 'clear', ctx),
    });
  } else {
    picks.push({
      kind: 'safe', card: safe,
      reason: shortReason(safe, 'safe', ctx),
      reasonLong: longReason(safe, 'safe', ctx),
    });
    if (upsideQualifies) {
      picks.push({
        kind: 'upside', card: upsideCard,
        reason: shortReason(upsideCard, 'upside', ctx),
        reasonLong: longReason(upsideCard, 'upside', ctx),
      });
    }
  }

  if (needCard && needCard.grpId !== safe.grpId
      && (!upsideCard || needCard.grpId !== upsideCard.grpId || !upsideQualifies)) {
    picks.push({
      kind: 'need', card: needCard,
      reason: shortReason(needCard, 'need', { ...ctx, needId: topNeed.id }),
      reasonLong: longReason(needCard, 'need', { ...ctx, needId: topNeed.id }),
    });
  }

  return picks;
}

function computeRecommendation(packCards, pickedCards, colorSignals, deckNeeds, pickNumber, draftStyle, tier3) {
  if (!packCards || packCards.length === 0) return null;

  // Tier 3 synergy bonus: up to +5% on top of the base score for cards
  // that synergize with the existing pile.
  const synergyByGrpId = new Map();
  if (tier3?.synergies) {
    for (const s of tier3.synergies) synergyByGrpId.set(s.grpId, s);
  }

  const scored = packCards
    .map(card => {
      let score = scoreCard(card, pickedCards, colorSignals, deckNeeds, pickNumber, draftStyle ?? 'balanced');
      const syn = synergyByGrpId.get(card.grpId);
      if (syn?.score) score += syn.score * 0.05;
      // Win-condition support: small nudge toward cards that protect or find a bomb
      if (tier3?.winConditions?.hasBomb && tier3.winConditions.supportPattern) {
        const ot = card.oracleText ?? '';
        if (tier3.winConditions.supportPattern.test(ot)) score += 0.02;
      }
      return { card, score, synergy: syn ?? null };
    })
    .sort((a, b) => b.score - a.score);

  const primary = scored[0]?.card ?? null;
  if (!primary) return null;
  const secondary = scored.length > 1 && (scored[0].score - scored[1].score) < 0.04
    ? scored[1].card : null;

  const primaryColors = detectColors(pickedCards);
  const picks = buildPickOptions(scored, packCards, primaryColors, deckNeeds, colorSignals);

  // Attach synergy notes to pick reasons so the UI can show them inline.
  for (const p of picks) {
    const syn = synergyByGrpId.get(p.card?.grpId);
    if (syn?.reason) {
      p.synergyNote = syn.reason;
      p.reasonLong = `${p.reasonLong} · Synergy: ${syn.reason}`;
    }
  }

  // Build short explanation (kept for the overlay's existing rec bar).
  const isEarly = pickNumber < 5;
  const needIds = new Set(deckNeeds.map(n => n.id));
  let explanation = '';

  if (isEarly) {
    explanation = 'Early pick — best card by win rate';
  } else {
    const parts = [];
    if (primaryColors.length > 0) parts.push(`Drafting ${primaryColors.join('')}`);
    const ot = primary.oracleText ?? '';
    if (needIds.has('removal') && REMOVAL_RE.test(ot)) {
      const n = deckNeeds.find(x => x.id === 'removal');
      parts.push(`fills removal need (${n?.detail ?? ''})`);
    } else if (needIds.has('two_drops') && Math.round(primary.cmc ?? 99) === 2 && pickNumber >= 10) {
      parts.push('fills curve need at 2');
    } else if (primary.stats?.grade && ['A+','A','A-'].includes(primary.stats.grade)) {
      parts.push(`top-tier card (${primary.stats.grade})`);
    } else {
      parts.push('best in colors by win rate');
    }
    explanation = parts.join(' — ');
  }

  return { primary, secondary, explanation, colors: primaryColors, picks };
}

// ─── Main Analyze Function ────────────────────────────────────────────────────

function analyze(trackerState, packCards, pickNumber, settings) {
  const { packHistory, pickHistory, setMetrics } = trackerState;
  const confidenceThreshold = settings?.confidenceThreshold ?? 4;
  const draftStyle = settings?.draftStyle ?? 'balanced';

  const colorSignals = computeColorSignals(packHistory, setMetrics, confidenceThreshold);
  const hasColorData = Object.values(colorSignals).some(s => s.hasData);

  const composition = computeDeckComposition(pickHistory);
  const deckNeeds   = computeDeckNeeds(composition, pickNumber);
  const { strengths, weaknesses } = computeStrengthsWeaknesses(composition, deckNeeds);
  const manaAnalysis = computeManaAnalysis(pickHistory);
  const deckGrade    = computeDeckGrade(pickHistory);

  // Determine current pack number from the most recent pack-seen event.
  const lastPack = packHistory[packHistory.length - 1];
  const currentPackNumber = lastPack?.packNumber ?? 0;
  const signalInsights = computeSignalInsights(trackerState, currentPackNumber, pickNumber);

  // ── Tier 3 detectors (Section 6) ────────────────────────────────────────────
  const synergyResult     = synergyDetector.analyzeSynergies(pickHistory, packCards ?? []);
  const archetypeResult   = archetypeDetector.detectArchetype(pickHistory);
  const winConditionResult = winConditionAnalyzer.analyzeWinConditions(pickHistory);

  const recommendation = (packCards && packCards.length > 0)
    ? computeRecommendation(
        packCards, pickHistory, colorSignals, deckNeeds.slice(0,3), pickNumber, draftStyle,
        { synergies: synergyResult.synergies, archetype: archetypeResult, winConditions: winConditionResult }
      )
    : null;

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
    currentPackNumber,
    // Tier 3 detector outputs (Section 6)
    synergies: synergyResult.synergies,
    synergyThemes: synergyResult.themes,
    archetype: archetypeResult,
    winConditions: winConditionResult,
    pickHistory: pickHistory.map(p => ({ ...p })),
    recommendation,
    pickNumber,
    lastUpdated: Date.now(),
  };
}

function emptyState() {
  const neutral = { score: 50, label: 'Contested', seenTotal: 0, seenLate: 0, latePackCount: 0, hasData: false, evidence: 'No packs seen yet' };
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
    synergies: [],
    synergyThemes: {},
    archetype: { primary: null, confidence: 0, fits: {}, label: 'Unknown' },
    winConditions: { hasBomb: false, bombs: [], types: [], weakness: null, message: '' },
    pickHistory: [],
    recommendation: null,
    pickNumber: 0,
    lastUpdated: Date.now(),
  };
}

module.exports = {
  computeSetMetrics, computeColorSignals, computeDeckComposition, computeManaAnalysis,
  computeDeckNeeds, computeStrengthsWeaknesses, computeRecommendation,
  computeSignalInsights, computeDeckGrade,
  analyze, emptyState, detectColors, scoreCard,
};
