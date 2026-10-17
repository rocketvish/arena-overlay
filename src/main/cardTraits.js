/**
 * cardTraits.js — what a card does for a deck's shape and mana, from its
 * type line, mana cost and rules text. Shared by the app (live cards) and
 * the set-data pipeline (tools/pipeline/cards.js) so both classify alike.
 */
'use strict';

const TRAIT = { creature: 1, twoDrop: 2, removal: 4, topEnd: 8 };
const TRAIT_LIST = [TRAIT.creature, TRAIT.twoDrop, TRAIT.removal, TRAIT.topEnd];
const COLORS = 'WUBRG';

// Same idea as deckBuilder.js's REMOVAL_RE.
const REMOVAL_RE = /\b(destroy target|exile target|deal[s]? \d+ damage to (any target|target)|deals damage equal to .* to (any target|target)|gets? [-−]\d+\/[-−]\d+|[-−]\d+\/[-−]\d+ until|[-−]x\/[-−]x|fights? (another |up to one )?target|target creature .* fights|return[s]? target (creature|nonland permanent) to its owner's hand)/i;

const typesOf = (card) => (Array.isArray(card.types) ? card.types.join(' ') : String(card.typeLine ?? ''));
const isLandType = (tl) => /\bLand\b/.test(tl) && !/\bCreature\b/.test(tl);

/** Trait bits: { types | typeLine, cmc, oracle | oracleText }. Lands have none. */
function cardTraits(card) {
  const tl = typesOf(card);
  if (isLandType(tl)) return 0;
  const cmc = card.cmc ?? null;
  const oracle = card.oracle ?? card.oracleText ?? '';
  let t = 0;
  const creature = /\bCreature\b/.test(tl);
  if (creature) t |= TRAIT.creature;
  if (creature && cmc != null && cmc <= 2) t |= TRAIT.twoDrop;
  if (REMOVAL_RE.test(oracle)) t |= TRAIT.removal;
  if (cmc != null && cmc >= 6) t |= TRAIT.topEnd;
  return t;
}

/**
 * Colors of mana a nonbasic land or mana rock can make — the fixing it gives.
 * "Any color" and basic-land fetchers count as every color. '' for none.
 */
function fixingColors(card) {
  const tl = typesOf(card);
  const oracle = card.oracle ?? card.oracleText ?? '';
  const land = isLandType(tl);
  if (!land && !/\bArtifact\b/.test(tl)) return '';
  if (/mana of any (one )?color|any color of mana|search your library for a basic land/i.test(oracle)) return COLORS;
  const out = new Set();
  // "Add {W} or {U}", "Add {W}, {U}, or {B}", "{T}: Add {G}."
  for (const m of oracle.matchAll(/\badd\s+((?:\{[WUBRGC]\}(?:,?\s*(?:or\s+)?)?)+)/gi)) {
    for (const c of m[1].match(/[WUBRG]/g) ?? []) out.add(c);
  }
  // A mono-color land only fixes if it makes more than one color.
  if (land && out.size < 2) return '';
  return COLORS.split('').filter((c) => out.has(c)).join('');
}

/** Colored pips by color from a mana cost like "{1}{W}{W}" (hybrid counts ½ each). */
function pipsOf(manaCost, color = '') {
  const out = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  if (!manaCost) {
    for (const c of String(color).replace(/[^WUBRG]/g, '')) out[c] += 1;
    return out;
  }
  for (const sym of manaCost.match(/\{[^}]+\}/g) ?? []) {
    const parts = sym.slice(1, -1).split('/').filter((p) => out[p] !== undefined);
    for (const p of parts) out[p] += 1 / parts.length;
  }
  return out;
}

module.exports = { TRAIT, TRAIT_LIST, REMOVAL_RE, cardTraits, fixingColors, pipsOf, isLandType };
