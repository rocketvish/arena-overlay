/**
 * cardMatcher.js
 *
 * Matches Arena card GRP IDs / names to 17Lands card data.
 *
 * Flow:
 *  1. On draft-started, renderer calls electronAPI.fetchSetData(setCode, format)
 *     → main process fetches from 17Lands (or disk cache), returns normalized cards
 *  2. loadSetData() builds a by-name lookup map
 *  3. On each pack-opened event we receive cards with grpIds and maybe names
 *  4. matchCards() enriches them: name → 17Lands stats, with Scryfall fallback for missing names
 */

// setCode+format → Map<normalizedName, NormalizedCard>
const setLookup = new Map();

// grpId → { name, cmc, colorIdentity, rarity }  (from Scryfall)
const scryfallCache = new Map();

// ─── Name Normalization ───────────────────────────────────────────────────────

/**
 * Normalize a card name for fuzzy matching.
 * Handles apostrophes, hyphens, double-faced card front faces, etc.
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[''`]/g, "'")          // normalize apostrophes
    .replace(/\s*\/\/\s*.*/g, '')    // DFC: keep front face only
    .replace(/[^a-z0-9' ,\-]/g, '') // strip other punctuation
    .trim();
}

// ─── Set Data Management ─────────────────────────────────────────────────────

/**
 * Load 17Lands card data for a set into the lookup map.
 * @param {string} setCode
 * @param {string} format
 * @param {Array<object>} cards  Normalized cards from 17Lands (via main process)
 */
export function loadSetData(setCode, format, cards) {
  const key = `${setCode}:${format}`;
  const map = new Map();
  for (const card of cards) {
    if (card.name) {
      map.set(normalizeName(card.name), card);
    }
  }
  setLookup.set(key, map);
  console.log(`[cardMatcher] Loaded ${map.size} cards for ${key}`);
}

/**
 * Load color-pair specific data, overlaying pair stats onto base set data.
 * @param {string} setCode
 * @param {string} format
 * @param {string} colorPair  e.g. "WU"
 * @param {Array<object>} cards
 */
export function loadColorPairData(setCode, format, colorPair, cards) {
  const key = `${setCode}:${format}:${colorPair}`;
  const map = new Map();
  for (const card of cards) {
    if (card.name) map.set(normalizeName(card.name), card);
  }
  setLookup.set(key, map);
}

export function clearSetData(setCode) {
  for (const k of setLookup.keys()) {
    if (!setCode || k.startsWith(setCode)) setLookup.delete(k);
  }
}

// ─── Scryfall Cache ───────────────────────────────────────────────────────────

export function cacheArenaIds(idMap) {
  for (const [id, data] of Object.entries(idMap)) {
    scryfallCache.set(Number(id), data);
  }
}

export function getCachedCard(grpId) {
  return scryfallCache.get(grpId) ?? null;
}

// ─── Card Matching ────────────────────────────────────────────────────────────

/**
 * Look up a card by name against 17Lands data.
 * Tries exact normalized match first, then color-pair overlay if active.
 */
function lookupByName(name, setCode, format, colorPair) {
  if (!name) return null;
  const norm = normalizeName(name);

  // Color-pair lookup takes priority
  if (colorPair && colorPair !== 'all') {
    const pairKey = `${setCode}:${format}:${colorPair}`;
    const pairMap = setLookup.get(pairKey);
    if (pairMap) {
      const hit = pairMap.get(norm);
      if (hit) return hit;
    }
  }

  const baseKey = `${setCode}:${format}`;
  const baseMap = setLookup.get(baseKey);
  return baseMap ? (baseMap.get(norm) ?? null) : null;
}

/**
 * Enrich an array of raw pack cards with 17Lands data.
 * Cards that already have names are matched immediately.
 * Cards with only grpIds use the Scryfall cache.
 *
 * @param {Array<{grpId: number, name?: string}>} cards
 * @param {string} setCode
 * @param {string} format
 * @param {string} colorPair  Currently active color filter
 * @returns {Array<EnrichedCard>}
 */
export function matchCards(cards, setCode, format = 'PremierDraft', colorPair = 'all') {
  if (!cards || cards.length === 0) return [];

  return cards.map((card) => {
    // Resolve name: prefer what came from the log, fall back to Scryfall cache
    let name = card.name;
    let scryfallData = null;

    if (!name && card.grpId) {
      scryfallData = scryfallCache.get(card.grpId);
      name = scryfallData?.name;
    }

    // Look up 17Lands stats
    const lands = setCode ? lookupByName(name, setCode, format, colorPair) : null;

    return {
      grpId: card.grpId,
      name: name ?? (lands?.name ?? null),
      color: lands?.color ?? card.color ?? scryfallData?.colorIdentity ?? '',
      rarity: lands?.rarity ?? card.rarity ?? scryfallData?.rarity ?? 'common',
      cmc: lands?.cmc ?? card.cmc ?? scryfallData?.cmc ?? null,
      stats: lands?.stats ?? null,
    };
  });
}

/**
 * Get the IDs of cards in a pack that still need name resolution.
 */
export function getMissingIds(cards) {
  return cards
    .filter((c) => c.grpId && !c.name && !scryfallCache.has(c.grpId))
    .map((c) => c.grpId);
}
