/**
 * archetypeDetector.js — classify the deck-in-progress as Aggro / Midrange /
 * Control / Unknown.
 *
 * Pure heuristic: average mana value, creature count, removal density,
 * curve shape. Outputs a primary archetype, a confidence score, and a
 * fits map for downstream UI.
 */

'use strict';

const REMOVAL_RE = /\b(destroy|exile target|deal[s]? \d+ damage|−\d+\/−\d+|loses all abilities|return[s]? target .* to .* hand|tap[s]? target|counter target)/i;
const CARD_ADV_RE = /\b(draw a card|draw two|draw \d+ card|investigate|surveil \d|scry \d)/i;

function isCreature(c) { return /\bCreature\b/i.test(c.typeLine ?? ''); }
function isLand(c)     { return /\bLand\b/i.test(c.typeLine ?? ''); }

function deckSnapshot(pickedCards) {
  let creatures = 0, removal = 0, cardAdv = 0, mvSum = 0, mvCount = 0;
  const curve = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };

  for (const c of pickedCards) {
    if (isLand(c)) continue;
    if (isCreature(c)) creatures++;
    const ot = c.oracleText ?? '';
    if (REMOVAL_RE.test(ot)) removal++;
    if (CARD_ADV_RE.test(ot)) cardAdv++;
    if (c.cmc != null) {
      mvSum += c.cmc;
      mvCount++;
      const k = Math.min(6, Math.max(1, Math.round(c.cmc)));
      curve[k] = (curve[k] ?? 0) + 1;
    }
  }

  const avgMv = mvCount > 0 ? mvSum / mvCount : 0;
  return { creatures, removal, cardAdv, avgMv, curve, totalNonLand: mvCount };
}

/**
 * Classify the picked deck.
 *
 * Thresholds (per spec):
 *   Aggro:    avg MV < 2.8, high creature count, low curve
 *   Control:  avg MV > 3.2, high removal count, card advantage
 *   Midrange: everything else
 */
function detectArchetype(pickedCards) {
  if (!pickedCards || pickedCards.length < 4) {
    return { primary: null, confidence: 0, fits: {}, label: 'Unknown', snapshot: null };
  }

  const snap = deckSnapshot(pickedCards);
  const fits = { aggro: 0, midrange: 0, control: 0 };

  // Aggro
  if (snap.avgMv < 2.8) fits.aggro += 0.35;
  else if (snap.avgMv < 3.0) fits.aggro += 0.15;
  if (snap.totalNonLand > 0 && snap.creatures / snap.totalNonLand >= 0.65) fits.aggro += 0.30;
  const lowCurve = (snap.curve[1] ?? 0) + (snap.curve[2] ?? 0);
  if (lowCurve >= 5) fits.aggro += 0.25;
  else if (lowCurve >= 3) fits.aggro += 0.10;

  // Control
  if (snap.avgMv > 3.2) fits.control += 0.30;
  else if (snap.avgMv > 3.0) fits.control += 0.10;
  if (snap.removal >= 4) fits.control += 0.30;
  else if (snap.removal >= 3) fits.control += 0.15;
  if (snap.cardAdv >= 2) fits.control += 0.20;
  const topCurve = (snap.curve[5] ?? 0) + (snap.curve[6] ?? 0);
  if (topCurve >= 4) fits.control += 0.15;

  // Midrange = baseline; gets a moderate floor and rewards balanced curves.
  fits.midrange = 0.4;
  const midCurve = (snap.curve[3] ?? 0) + (snap.curve[4] ?? 0);
  if (midCurve >= 4) fits.midrange += 0.20;
  if (snap.removal >= 2 && snap.removal <= 3) fits.midrange += 0.10;

  // Pick the archetype with the highest fit score.
  const ranked = Object.entries(fits).sort(([, a], [, b]) => b - a);
  const [primary, topScore] = ranked[0];
  const secondScore = ranked[1]?.[1] ?? 0;
  const margin = topScore - secondScore;

  // Confidence is the margin between top and runner-up (capped at 1.0).
  const confidence = Math.min(1.0, Math.max(0, margin * 1.5));

  // Label: include a "leaning" tag when confidence is low.
  let label = primary[0].toUpperCase() + primary.slice(1);
  if (confidence < 0.3 && secondScore > 0.4) {
    const second = ranked[1][0];
    label = `${label} (leaning ${second})`;
  }

  return { primary, confidence, fits, label, snapshot: snap };
}

module.exports = { detectArchetype, deckSnapshot };
