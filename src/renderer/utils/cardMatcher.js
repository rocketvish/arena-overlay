/**
 * cardMatcher.js
 *
 * Maps Arena card GRP IDs to 17Lands data.
 *
 * The full integration flow (not yet implemented) will be:
 *   1. Fetch card data CSV from 17Lands API for the current set:
 *      https://www.17lands.com/card_ratings/data?expansion=<SET>&format=PremierDraft
 *   2. Build a lookup map: grpId → { name, stats: { grade, gihwr, ohwr, ... } }
 *   3. On each pack-opened event, enrich the raw card list using this map.
 *
 * For now, matchCards returns the raw cards with stub stats so the overlay
 * renders card IDs in place of names until real data is loaded.
 */

// In-memory cache: setCode → Map<grpId, cardData>
const setCache = new Map();

/**
 * Enrich an array of raw pack cards with name/stats from cached 17Lands data.
 * Falls back gracefully — unknown cards are shown with '?' grade.
 *
 * @param {Array<{grpId: number, [key: string]: any}>} cards
 * @param {string|null} setCode
 * @returns {Array<object>}
 */
export function matchCards(cards, setCode) {
  if (!cards || cards.length === 0) return [];

  const lookup = setCode ? setCache.get(setCode) : null;

  return cards.map(card => {
    if (!lookup) return { ...card };

    const data = lookup.get(card.grpId);
    if (!data) return { ...card };

    return {
      ...card,
      name: data.name ?? card.name,
      rarity: data.rarity ?? card.rarity,
      colorIdentity: data.colorIdentity ?? card.colorIdentity,
      stats: data.stats ?? null,
    };
  });
}

/**
 * Load 17Lands card data for a set into the cache.
 * Call this once per set when a draft starts.
 *
 * @param {string} setCode  e.g. "DSK"
 * @param {Array<object>} cardDataArray  Array of objects from 17Lands CSV/API
 */
export function loadSetData(setCode, cardDataArray) {
  const map = new Map();
  for (const card of cardDataArray) {
    if (card.grpId) {
      map.set(card.grpId, card);
    }
  }
  setCache.set(setCode, map);
}

/**
 * Clear cached data for a set (e.g., after a format update).
 */
export function clearSetData(setCode) {
  if (setCode) {
    setCache.delete(setCode);
  } else {
    setCache.clear();
  }
}
