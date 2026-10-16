/**
 * opponentRead.js — what the opponent is likely playing and holding.
 *
 * From the set table (tools/pipeline/build-set.js): per two-color archetype,
 * how many 17Lands games it appears in (`pairs[P].games`) and, per card, the
 * share of that archetype's decks running it plus mean copies when they do
 * (`cards[id].deck[P] = [share, copies]`).
 *
 *   archetype   Bayes over the 10 pairs: prior = how often the pair is
 *               played; each card the opponent has revealed multiplies in
 *               the share of that pair's decks that run it; each land color
 *               outside the pair counts as a likely splash (a penalty).
 *   holding c   Σ_P P(P) · P(deck runs c | P) · P(an unrevealed copy is in
 *               hand), the last by drawing their hand at random from all the
 *               cards they haven't revealed (hand + library).
 *
 * The random-hand part is a floor for instants: players hold tricks rather
 * than cast them on their own turn. Pure functions, no Electron.
 */
'use strict';

const PAIRS = ['WU', 'WB', 'WR', 'WG', 'UB', 'UR', 'UG', 'BR', 'BG', 'RG'];
const ABSENT_SHARE = 0.003;   // a revealed card no deck of this pair ran (splash, rare)
const OFF_COLOR_LAND = 0.15;  // per land color outside the pair (splash or fixing)

/** P(pair) given the revealed cards ({grpId: count}) and land colors (['W', …]). */
function archetypeOdds(table, seenCounts, landColors = []) {
  if (!table?.cards) return null;
  const totalGames = PAIRS.reduce((s, p) => s + (table.pairs?.[p]?.games ?? 0), 0);
  const logp = PAIRS.map((p) => Math.log(totalGames ? Math.max(table.pairs?.[p]?.games ?? 0, 1) / totalGames : 1 / PAIRS.length));
  let evidence = 0;
  for (const id of Object.keys(seenCounts ?? {})) {
    const deck = table.cards[id]?.deck;
    if (!deck) continue; // basics, tokens, cards outside the set
    evidence++;
    PAIRS.forEach((p, i) => { logp[i] += Math.log(deck[p]?.[0] ?? ABSENT_SHARE); });
  }
  for (const c of new Set(landColors)) {
    PAIRS.forEach((p, i) => { if (!p.includes(c)) logp[i] += Math.log(OFF_COLOR_LAND); });
  }
  const mx = Math.max(...logp);
  const ex = logp.map((x) => Math.exp(x - mx));
  const Z = ex.reduce((a, b) => a + b, 0);
  return { probs: Object.fromEntries(PAIRS.map((p, i) => [p, ex[i] / Z])), evidence };
}

/** P(at least one of `copies` hidden copies is among `hand` of `hidden` unrevealed cards). */
function inHand(copies, hand, hidden) {
  if (copies <= 0 || hand <= 0 || hidden <= 0) return 0;
  return 1 - (1 - Math.min(1, hand / hidden)) ** copies;
}

/**
 * Odds the opponent's deck runs card `id`, and that a copy is in their hand
 * now. `seen` = copies they've revealed; `hand` / `hidden` = their hand size
 * and hand + library.
 */
function cardOdds(table, odds, id, { seen = 0, hand = 0, hidden = 0 } = {}) {
  const deck = table?.cards?.[id]?.deck;
  if (!deck || !odds) return { inDeck: 0, inHand: 0 };
  let inDeck = 0, held = 0;
  for (const p of PAIRS) {
    const w = odds.probs[p];
    const d = deck[p];
    if (!w || !d) continue;
    const [share, copies] = d;
    if (seen > 0) {
      inDeck += w;
      held += w * inHand(Math.max(0, copies - seen), hand, hidden);
    } else {
      inDeck += w * share;
      held += w * share * inHand(copies, hand, hidden);
    }
  }
  return { inDeck: seen > 0 ? 1 : inDeck, inHand: held };
}

/** P(at least one of several cards), treating them as independent. */
function anyOf(probs) {
  return 1 - probs.reduce((q, p) => q * (1 - p), 1);
}

module.exports = { PAIRS, archetypeOdds, cardOdds, inHand, anyOf, ABSENT_SHARE, OFF_COLOR_LAND };
