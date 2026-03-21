/**
 * draftAdvisor.js — Draft pick recommendation engine
 *
 * Uses 17Lands stats (GIHWR) + color detection + mana curve analysis
 * to recommend the best pick from the current pack.
 */

const GRADE_ORDER = ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F'];

// Target mana curve for a 40-card draft deck (nonland spells)
// Lower urgency = slot is filled; higher = need more
const CURVE_TARGETS = { 1: 2, 2: 4, 3: 5, 4: 4, 5: 2, 6: 1 };

/**
 * Detect colors being drafted based on picked card colors.
 * @param {Array<{color?: string}>} pickedCards
 * @returns {string[]} top 1-2 colors by frequency
 */
function detectColors(pickedCards) {
  if (!pickedCards || pickedCards.length === 0) return [];

  const counts = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const card of pickedCards) {
    const c = card.color ?? '';
    const chars = c.replace(/[^WUBRG]/g, '');
    for (const ch of chars) {
      if (counts[ch] !== undefined) counts[ch]++;
    }
  }

  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .filter(([, v]) => v > 0)
    .slice(0, 2)
    .map(([k]) => k);
}

/**
 * Get mana curve urgency — which CMC slots need more cards.
 * @param {Array<{cmc?: number}>} pickedCards
 * @returns {Object} { [cmc]: urgency 0-1 }
 */
function getManaCurveNeeds(pickedCards) {
  if (!pickedCards || pickedCards.length === 0) return {};

  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const card of pickedCards) {
    const cmc = card.cmc ?? null;
    if (cmc == null) continue;
    const key = Math.min(6, Math.max(1, Math.round(cmc)));
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const urgency = {};
  for (const [cmc, target] of Object.entries(CURVE_TARGETS)) {
    const current = counts[cmc] ?? 0;
    const need = Math.max(0, target - current);
    urgency[cmc] = need / target; // 0 = full, 1 = empty
  }
  return urgency;
}

/**
 * Get recommendation for current pack.
 *
 * @param {Array<EnrichedCard>} enrichedPack  Cards with 17Lands stats
 * @param {Array<EnrichedCard>} pickedCards   Cards picked so far
 * @param {number} pickNumber                  Current pick number (0-indexed)
 * @returns {{ primary: EnrichedCard, secondary: EnrichedCard|null, explanation: string, colors: string[] }}
 */
function getRecommendation(enrichedPack, pickedCards, pickNumber) {
  if (!enrichedPack || enrichedPack.length === 0) return null;

  // Cards with stats
  const withStats = enrichedPack.filter(c => c.stats?.gihwr != null);
  const withGrade = enrichedPack.filter(c => c.stats?.grade != null);

  // Early picks (1-5): best by GIHWR overall
  if (pickNumber < 5 || withStats.length === 0) {
    const best = getBestByGihwr(withStats) ?? getBestByGrade(withGrade) ?? enrichedPack[0];
    const explanation = pickNumber < 5
      ? 'Early pick — taking best card by win rate'
      : 'No 17Lands data — showing first card';
    return {
      primary: best,
      secondary: null,
      explanation,
      colors: [],
    };
  }

  // Detect drafted colors
  const colors = detectColors(pickedCards ?? []);
  const curveNeeds = pickNumber >= 12 ? getManaCurveNeeds(pickedCards ?? []) : {};

  // Filter cards in color
  const inColor = withStats.filter(c => {
    if (colors.length === 0) return true;
    const cardColor = (c.color ?? '').replace(/[^WUBRG]/g, '');
    if (cardColor.length === 0) return true; // colorless — always valid
    return cardColor.split('').some(ch => colors.includes(ch));
  });

  const outOfColor = withStats.filter(c => !inColor.includes(c));

  // Pick 6+: best GIHWR in color
  let primary = getBestByGihwr(inColor, curveNeeds) ?? getBestByGihwr(withStats, curveNeeds);
  let secondary = null;

  // Show best overall if different from best in color
  const bestOverall = getBestByGihwr(withStats);
  if (bestOverall && primary && bestOverall.grpId !== primary.grpId) {
    secondary = bestOverall;
  }

  // Curve bonus: pick 12+
  let explanation = '';
  if (colors.length > 0) {
    explanation = `Drafting ${colors.join('')} — `;
  }

  if (pickNumber >= 12 && primary) {
    const cmc = primary.cmc ?? null;
    if (cmc != null) {
      const key = String(Math.min(6, Math.max(1, Math.round(cmc))));
      const urgency = curveNeeds[key] ?? 0;
      if (urgency > 0.5) {
        explanation += `filling ${cmc}-drop slot (urgency ${Math.round(urgency * 100)}%)`;
      } else {
        explanation += 'best in colors by win rate';
      }
    } else {
      explanation += 'best in colors by win rate';
    }
  } else {
    explanation += 'best in colors by win rate';
  }

  if (!primary) {
    primary = enrichedPack[0];
    explanation = 'No data — showing first card';
  }

  return { primary, secondary, explanation, colors };
}

function getBestByGihwr(cards, curveNeeds) {
  if (!cards || cards.length === 0) return null;

  if (!curveNeeds || Object.keys(curveNeeds).length === 0) {
    return cards.reduce((best, c) =>
      (c.stats?.gihwr ?? 0) > (best.stats?.gihwr ?? 0) ? c : best
    );
  }

  // Apply curve bonus: add 0.5% per urgency point
  return cards.reduce((best, c) => {
    const cmc = c.cmc ?? null;
    const urgency = cmc != null ? (curveNeeds[String(Math.min(6, Math.max(1, Math.round(cmc))))] ?? 0) : 0;
    const score = (c.stats?.gihwr ?? 0) + urgency * 0.005;
    const bestCmc = best?.cmc ?? null;
    const bestUrgency = bestCmc != null ? (curveNeeds[String(Math.min(6, Math.max(1, Math.round(bestCmc))))] ?? 0) : 0;
    const bestScore = (best?.stats?.gihwr ?? 0) + bestUrgency * 0.005;
    return score > bestScore ? c : best;
  });
}

function getBestByGrade(cards) {
  if (!cards || cards.length === 0) return null;
  return cards.reduce((best, c) => {
    const ai = GRADE_ORDER.indexOf(c.stats?.grade ?? '');
    const bi = GRADE_ORDER.indexOf(best?.stats?.grade ?? '');
    const aScore = ai === -1 ? GRADE_ORDER.length : ai;
    const bScore = bi === -1 ? GRADE_ORDER.length : bi;
    return aScore < bScore ? c : best;
  });
}

module.exports = { getRecommendation, detectColors, getManaCurveNeeds };
