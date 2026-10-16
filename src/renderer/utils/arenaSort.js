/**
 * Pack order as Arena shows it, and names for basic lands (which 17Lands
 * doesn't list). Shared by the side window's pack list.
 */

// ── Arena visual sort ─────────────────────────────────────────────────────────
// The log lists a pack in booster order (commons first), not the order Arena
// shows it. Arena's card database carries its own sort keys
// (Order_MythicToCommon, Order_LandLast, Order_ColorOrder, Order_CMCWithXLast,
// Order_Title); the pack is shown by rarity, then color — W, U, B, R, G, then
// two-color pairs in guild order — with lands last. Collector number is NOT
// the key: sets with a bonus sheet (FRA's cards numbered 197+) put those
// cards among their own color, not after the main set.
const RARITY_ORDER = { mythic: 0, rare: 1, uncommon: 2, common: 3 };
const MONO_ORDER = { W: 0, U: 1, B: 2, R: 3, G: 4 };
// Order_ColorOrder for two-color cards (Arena DB: WU 5, UR 8, BR 9, WG 13).
const PAIR_ORDER = { WU: 5, WB: 6, UB: 7, UR: 8, BR: 9, BG: 10, RG: 11, WR: 12, WG: 13, UG: 14 };

function colorOrder(card) {
  const cs = (card.color ?? '').replace(/[^WUBRG]/g, '');
  if (cs.length === 1) return MONO_ORDER[cs];
  if (cs.length === 2) return PAIR_ORDER[['W', 'U', 'B', 'R', 'G'].filter((c) => cs.includes(c)).join('')] ?? 15;
  if (cs.length > 2) return 15;
  return 16; // colorless
}

const BASIC_NAMES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']);
const isBasic = (card) => BASIC_NAMES.has(card.name);
const isLand = (card) => isBasic(card) || (/\bLand\b/.test(card.typeLine ?? '') && !/\bCreature\b/.test(card.typeLine ?? ''));
// Arena sorts X spells after everything else of their color.
const cmcKey = (card) => (card.cmc ?? 99) + (/\{X\}/.test(card.manaCost ?? '') ? 100 : 0);

export function arenaVisualSort(cards) {
  const key = (c) => [
    c.name ? 0 : 1,                     // unknown cards (no data) last, in log order
    isBasic(c) ? 4 : RARITY_ORDER[c.rarity] ?? 3, // basics after commons
    isLand(c) ? 1 : 0,
    isLand(c) ? 1 : 0,
    colorOrder(c),
    cmcKey(c),
  ];
  return cards.map((c, i) => ({ card: c, i, k: key(c) })).sort((a, b) => {
    for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j];
    const byName = (a.card.name ?? '').localeCompare(b.card.name ?? '');
    return byName || a.i - b.i;
  }).map(({ card }) => card);
}

// ── Basic land name resolution ────────────────────────────────────────────────
// Basic lands are not in the 17Lands card pool (they're not drafted normally)
// so they arrive with no name. Hardcode the standard basic land names so the
// pack list shows "Forest" instead of "#100652".
const BASIC_LAND_NAMES = {
  // TMT (TMNT) set basic land Arena IDs — inferred from gap in 17Lands data
  100648: 'Plains', 100649: 'Island', 100650: 'Swamp',
  100651: 'Mountain', 100652: 'Forest',
  // FDN (Foundations) basic land Arena IDs — 4 art variants each
  95181: 'Plains',  95182: 'Plains',  95191: 'Plains',  95192: 'Plains',
  95183: 'Island',  95184: 'Island',  95193: 'Island',  95194: 'Island',
  95185: 'Swamp',   95186: 'Swamp',   95195: 'Swamp',   95196: 'Swamp',
  95187: 'Mountain', 95188: 'Mountain', 95197: 'Mountain', 95198: 'Mountain',
  95189: 'Forest',  95190: 'Forest',  95199: 'Forest',  95200: 'Forest',
};

export function resolveBasicLandName(card) {
  if (card.name) return card.name;
  return BASIC_LAND_NAMES[card.grpId] ?? null;
}
