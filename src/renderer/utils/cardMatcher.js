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

// setCode+format → Map<mtgaId (number), NormalizedCard>
const idLookup = new Map();

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
  const nameMap = new Map();
  const idMap = new Map();
  for (const card of cards) {
    if (card.name) nameMap.set(normalizeName(card.name), card);
    if (card.mtgaId != null) idMap.set(card.mtgaId, card);
  }
  setLookup.set(key, nameMap);
  idLookup.set(key, idMap);
  console.log(`[cardMatcher] Loaded ${nameMap.size} cards for ${key} (${idMap.size} with Arena IDs)`);
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
  for (const k of idLookup.keys()) {
    if (!setCode || k.startsWith(setCode)) idLookup.delete(k);
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
 * Look up a card by Arena grpId directly against 17Lands data.
 */
function lookupByGrpId(grpId, setCode, format) {
  if (!grpId || !setCode) return null;
  const baseKey = `${setCode}:${format}`;
  return idLookup.get(baseKey)?.get(grpId) ?? null;
}

/**
 * Look up a card by name against 17Lands data.
 * Tries color-pair overlay first, then base set data.
 */
function lookupByName(name, setCode, format, colorPair) {
  if (!name) return null;
  const norm = normalizeName(name);

  if (colorPair && colorPair !== 'all') {
    const pairKey = `${setCode}:${format}:${colorPair}`;
    const hit = setLookup.get(pairKey)?.get(norm);
    if (hit) return hit;
  }

  const baseKey = `${setCode}:${format}`;
  return setLookup.get(baseKey)?.get(norm) ?? null;
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
    // 1. Try direct grpId → 17Lands lookup (works when 17Lands includes mtga_id)
    const byId = setCode ? lookupByGrpId(card.grpId, setCode, format) : null;

    // 2. Resolve name: prefer log name → Scryfall cache → 17Lands by-id name
    let name = card.name;
    let scryfallData = null;
    if (!name && card.grpId) {
      scryfallData = scryfallCache.get(card.grpId);
      name = scryfallData?.name ?? byId?.name ?? null;
    }

    // 3. Name-based 17Lands lookup (used when byId didn't hit, e.g. color-pair overlay)
    const byName = (!byId && name && setCode)
      ? lookupByName(name, setCode, format, colorPair)
      : null;

    // For color-pair overlay, prefer byName (which uses pair data) over byId (which uses base)
    const lands = (colorPair && colorPair !== 'all')
      ? (byName ?? byId)
      : (byId ?? byName);

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
 * Get the IDs of cards in a pack that still need Scryfall name resolution.
 * Skips cards already resolvable via 17Lands idLookup or scryfallCache.
 */
export function getMissingIds(cards, setCode, format = 'PremierDraft') {
  return cards
    .filter((c) => {
      if (!c.grpId || c.name) return false;
      if (scryfallCache.has(c.grpId)) return false;
      if (setCode && lookupByGrpId(c.grpId, setCode, format)) return false;
      return true;
    })
    .map((c) => c.grpId);
}
