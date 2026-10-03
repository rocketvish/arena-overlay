/**
 * cardMatcher.js
 *
 * Matches Arena card GRP IDs / names to 17Lands card data.
 *
 * Flow:
 *  1. On draft-started, renderer calls electronAPI.fetchSetData(setCode)
 *     → main process fetches from 17Lands (or disk cache), returns normalized cards
 *  2. loadSetData() builds by-name and by-id lookup maps
 *  3. On each pack-opened event we receive cards with grpIds and maybe names
 *  4. matchCards() enriches them: id/name → 17Lands stats, with Scryfall fallback for missing names
 *
 * Name matching passes (in order):
 *  A. Direct Arena grpId → 17Lands mtgaId  (most reliable, no name needed)
 *  B. Exact normalized name match           (lowercase + strip diacritics)
 *  C. Strict stripped name match            (also strip hyphens, apostrophes, punctuation)
 *  D. Levenshtein distance ≤ 2              (catches minor typos / unicode edge cases)
 */

// setCode → Map<normalizedName, NormalizedCard>
// (17Lands data is always PremierDraft, so the set code alone is the key.)
const setLookup = new Map();

// setCode → Map<strippedName, NormalizedCard>  (secondary lookup)
const strippedLookup = new Map();

// setCode → Map<mtgaId (number), NormalizedCard>
const idLookup = new Map();

// grpId → { name, cmc, colorIdentity, rarity }  (from Scryfall)
const scryfallCache = new Map();

// ─── Name Normalization ───────────────────────────────────────────────────────

/**
 * Standard normalization: lowercase, strip diacritics, normalize apostrophes,
 * strip DFC back-face, strip characters other than a-z 0-9 ' , -
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

/**
 * Strict normalization for secondary lookup: keep only letters and digits,
 * replace everything else (hyphens, apostrophes, commas, spaces) with a
 * single space, then collapse runs. This catches mismatches like:
 *   "Quick-Draw"  vs "Quick Draw"   (hyphen vs space)
 *   "Master's Call" vs "Masters Call" (apostrophe dropped)
 *   "Arahbo, the First Fang" vs "Arahbo the First Fang" (comma dropped)
 */
function normalizeStrict(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/\s*\/\/\s*.*/g, '')    // DFC: keep front face only
    .replace(/[^a-z0-9]/g, ' ')     // replace ALL punctuation with space
    .replace(/\s+/g, ' ')           // collapse multiple spaces
    .trim();
}

// ─── Levenshtein Distance ─────────────────────────────────────────────────────

/**
 * Compute the Levenshtein edit distance between two strings.
 * Uses a memory-efficient two-row approach.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// ─── Set Data Management ─────────────────────────────────────────────────────

/**
 * Load 17Lands card data for a set into the lookup maps.
 * @param {string} setCode
 * @param {Array<object>} cards  Normalized cards from 17Lands (via main process)
 */
export function loadSetData(setCode, cards) {
  const nameMap     = new Map();
  const strippedMap = new Map();
  const idMap       = new Map();
  for (let i = 0; i < cards.length; i++) {
    // Back-fill collectorNumber from array index for caches written before the field was added
    const card = cards[i].collectorNumber != null ? cards[i] : { ...cards[i], collectorNumber: i };
    if (card.name) {
      nameMap.set(normalizeName(card.name), card);
      strippedMap.set(normalizeStrict(card.name), card);
    }
    if (card.mtgaId != null) idMap.set(card.mtgaId, card);
  }
  setLookup.set(setCode, nameMap);
  strippedLookup.set(setCode, strippedMap);
  idLookup.set(setCode, idMap);
  console.log(`[cardMatcher] Loaded ${nameMap.size} cards for ${setCode} (${idMap.size} with Arena IDs)`);
}

export function clearSetData(setCode) {
  for (const map of [setLookup, strippedLookup, idLookup]) {
    if (setCode) map.delete(setCode);
    else map.clear();
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
function lookupByGrpId(grpId, setCode) {
  if (!grpId || !setCode) return null;
  return idLookup.get(setCode)?.get(grpId) ?? null;
}

/**
 * Look up a card by name against 17Lands data.
 * Tries (in order):
 *   A. Standard normalized name (color-pair overlay first, then base set)
 *   B. Strict stripped name (all punctuation removed)
 *   C. Levenshtein distance ≤ 2 against the base set
 *
 * Returns { card, method } so the caller can log how the match was found.
 */
function lookupByName(name, setCode) {
  if (!name) return null;

  // ── Pass A: standard normalization ───────────────────────────────────────
  const norm = normalizeName(name);
  const hitBase = setLookup.get(setCode)?.get(norm);
  if (hitBase) return { card: hitBase, method: 'name-exact' };

  // ── Pass B: strict stripped normalization ─────────────────────────────────
  const hitStripped = strippedLookup.get(setCode)?.get(normalizeStrict(name));
  if (hitStripped) return { card: hitStripped, method: 'name-stripped' };

  // ── Pass C: Levenshtein distance ≤ 2 ─────────────────────────────────────
  const nameMap = setLookup.get(setCode);
  if (nameMap && nameMap.size > 0) {
    let bestCard = null, bestDist = 3; // threshold: accept distance ≤ 2
    for (const [candidateNorm, candidate] of nameMap) {
      const dist = levenshtein(norm, candidateNorm);
      if (dist < bestDist) {
        bestDist = dist;
        bestCard = candidate;
      }
    }
    if (bestCard) return { card: bestCard, method: `name-fuzzy(d=${bestDist})` };
  }

  return null;
}

/**
 * Enrich an array of raw pack cards with 17Lands data.
 * Logs a detailed match report to console for every card.
 *
 * @param {Array<{grpId: number, name?: string}>} cards
 * @param {string} setCode
 * @returns {Array<EnrichedCard>}
 */
export function matchCards(cards, setCode) {
  if (!cards || cards.length === 0) return [];

  const results = cards.map((card) => {
    // 1. Try direct grpId → 17Lands lookup (most reliable)
    const byId = setCode ? lookupByGrpId(card.grpId, setCode) : null;

    // 2. Resolve name: log name → Scryfall cache → 17Lands by-id name
    let name = card.name;
    let scryfallData = null;
    if (!name && card.grpId) {
      scryfallData = scryfallCache.get(card.grpId);
      name = scryfallData?.name ?? byId?.name ?? null;
    }

    // 3. Name-based 17Lands lookup (fallback when the grpId isn't in 17Lands' data)
    const byNameResult = !byId && name && setCode ? lookupByName(name, setCode) : null;
    const byName = byNameResult?.card ?? null;
    const lands = byId ?? byName;

    // ── Debug log ────────────────────────────────────────────────────────────
    const displayName = name ?? `#${card.grpId}`;
    const gradeStr = lands?.stats?.grade ?? (lands ? 'no-grade' : null);
    const gihwr = lands?.stats?.gihwr;
    if (byId) {
      console.log(`[cardMatcher] ID-MATCH  "${displayName}" grpId=${card.grpId} → grade=${gradeStr} GIH%=${gihwr != null ? (gihwr*100).toFixed(1)+'%' : 'null'}`);
    } else if (lands) {
      const method = byNameResult?.method ?? 'name';
      console.log(`[cardMatcher] NAME-MATCH(${method}) "${displayName}" → "${lands.name}" grade=${gradeStr} GIH%=${gihwr != null ? (gihwr*100).toFixed(1)+'%' : 'null'}`);
    } else {
      const nearest = findNearest(displayName, setCode);
      console.warn(`[cardMatcher] NO-MATCH  "${displayName}" grpId=${card.grpId} — nearest: "${nearest?.name ?? 'none'}" (stripped: "${normalizeStrict(displayName)}")`);
    }

    return {
      grpId:    card.grpId,
      name:     name ?? (lands?.name ?? null),
      color:    lands?.color ?? card.color ?? scryfallData?.colorIdentity ?? '',
      rarity:   lands?.rarity ?? card.rarity ?? scryfallData?.rarity ?? 'common',
      cmc:      lands?.cmc ?? card.cmc ?? scryfallData?.cmc ?? null,
      // Collector number from 17Lands array index — drives Arena visual sort order.
      collectorNumber: lands?.collectorNumber ?? null,
      stats:    lands?.stats ?? null,
      // true = found in 17Lands (may still have null grade if data not yet available)
      // false/absent = not found in 17Lands at all (only Scryfall or no data)
      hasLandsData: lands != null,
    };
  });

  return results;
}

/**
 * Find the nearest card name in 17Lands data (for debug logging on misses).
 */
function findNearest(name, setCode) {
  if (!name || !setCode) return null;
  const nameMap = setLookup.get(setCode);
  if (!nameMap) return null;
  const norm = normalizeStrict(name);
  let bestCard = null, bestDist = Infinity;
  for (const [candidateNorm, candidate] of nameMap) {
    const dist = levenshtein(norm, candidateNorm);
    if (dist < bestDist) { bestDist = dist; bestCard = candidate; }
  }
  return bestCard;
}

/**
 * Get the IDs of cards in a pack that still need Scryfall name resolution.
 * Skips cards already resolvable via 17Lands idLookup or scryfallCache.
 */
export function getMissingIds(cards, setCode) {
  return cards
    .filter((c) => {
      if (!c.grpId || c.name) return false;
      if (scryfallCache.has(c.grpId)) return false;
      if (setCode && lookupByGrpId(c.grpId, setCode)) return false;
      return true;
    })
    .map((c) => c.grpId);
}
