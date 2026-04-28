/**
 * winConditionAnalyzer.js — identify the deck's win condition(s).
 *
 * A "bomb" is any picked card graded A or A+. If a bomb exists, downstream
 * scoring should slightly boost cards that protect or find it (counterspells,
 * protection, or card draw). The output also flags whether the deck has no
 * standout finisher.
 *
 * Pure: no I/O, no state.
 */

'use strict';

const BOMB_GRADES = new Set(['A+', 'A']);

const BIG_FINISHER_RE = /\b(flying|trample|double strike|menace)\b/i;
const TOKEN_SWARM_RE  = /\bcreate \w+ .* token|amass\b/i;
const BURN_RE         = /\bdeal[s]? \d+ damage to (any target|target player|target creature or)\b/i;
const COUNTER_PROT_RE = /\bcounter target spell|hexproof|indestructible|protection from\b/i;

function isCreature(c) { return /\bCreature\b/i.test(c.typeLine ?? ''); }

function describeBomb(card) {
  const grade = card.grade ?? card.stats?.grade ?? '?';
  const name  = card.name ?? `#${card.grpId}`;
  return `${name} (${grade})`;
}

function analyzeWinConditions(pickedCards) {
  if (!pickedCards || pickedCards.length === 0) {
    return { hasBomb: false, bombs: [], types: [], weakness: null, message: '', supportPattern: null };
  }

  // Bombs = any picked card graded A or A+.
  const bombs = pickedCards.filter(c => {
    const g = c.grade ?? c.stats?.grade;
    return g && BOMB_GRADES.has(g);
  });

  const hasBomb = bombs.length > 0;
  const types = [];

  // Inspect deck-wide patterns
  let bigFinishers = 0, tokenSwarm = 0, burnReach = 0, combatTricks = 0;
  for (const c of pickedCards) {
    const ot = c.oracleText ?? '';
    if (isCreature(c) && (c.cmc ?? 0) >= 5 && BIG_FINISHER_RE.test(ot)) bigFinishers++;
    if (TOKEN_SWARM_RE.test(ot)) tokenSwarm++;
    if (BURN_RE.test(ot)) burnReach++;
    if (/\bInstant\b/i.test(c.typeLine ?? '') && /\b(target creature gets|until end of turn|\+\d+\/\+\d+)\b/i.test(ot)) combatTricks++;
  }

  if (bigFinishers >= 1) types.push('Big finishers');
  if (tokenSwarm >= 3)   types.push('Token swarm');
  if (burnReach >= 2)    types.push('Burn reach');
  if (combatTricks >= 3) types.push('Combat tricks');
  if (hasBomb)           types.unshift('Bomb');

  // Weakness: noticeable lack of finishers in a control-leaning pile.
  let weakness = null;
  const totalNonLand = pickedCards.filter(c => !/\bLand\b/i.test(c.typeLine ?? '')).length;
  if (!hasBomb && bigFinishers === 0 && tokenSwarm < 2 && totalNonLand >= 12) {
    weakness = 'No standout finisher — build a consistent curve deck';
  }

  // Build user-facing message.
  let message;
  if (hasBomb) {
    const bombList = bombs.slice(0, 2).map(describeBomb).join(', ');
    message = `Win condition: ${bombList} — consider protection or card draw to support it`;
  } else if (types.length > 0) {
    message = `Win plan: ${types.join(' + ')}`;
  } else if (weakness) {
    message = weakness;
  } else {
    message = 'Building toward a curve deck — no clear win condition yet';
  }

  // If there's a bomb, define the support pattern that scoreCard uses to
  // nudge cards that protect or find it.
  const supportPattern = hasBomb ? COUNTER_PROT_RE : null;

  return {
    hasBomb,
    bombs: bombs.map(b => ({
      grpId: b.grpId,
      name: b.name,
      grade: b.grade ?? b.stats?.grade,
      isCreature: isCreature(b),
    })),
    types,
    weakness,
    message,
    supportPattern,
  };
}

module.exports = { analyzeWinConditions };
