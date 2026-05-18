/**
 * 17Lands data fetcher, cache manager, and grade calculator.
 *
 * API endpoint:
 *   https://www.17lands.com/card_ratings/data?expansion=DSK&format=PremierDraft
 *   https://www.17lands.com/card_ratings/data?expansion=DSK&format=PremierDraft&colors=WU
 *
 * Data is cached per set+format+colorPair on disk in userData/17lands-cache/
 * and also kept in memory for fast repeated access. Cache expires after 24h.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Lazy — must not call app.getPath() at module load time
let CACHE_DIR = null;
function getCacheDir() {
  if (!CACHE_DIR) CACHE_DIR = path.join(app.getPath('userData'), '17lands-cache');
  return CACHE_DIR;
}
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_SAMPLE = 200; // cards below this get flagged as low-sample

// 17Lands format param names
const FORMAT_PARAMS = {
  PremierDraft: 'PremierDraft',
  QuickDraft: 'QuickDraft',
  TradDraft: 'TradDraft',
  Sealed: 'Sealed',
};

// Memory cache: cacheKey → { data: [...], timestamp: ms }
const memCache = new Map();

// ─── File Cache ──────────────────────────────────────────────────────────────

function ensureCacheDir() {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cacheKey(setCode, format, colorPair) {
  return colorPair
    ? `${setCode}_${format}_${colorPair}`
    : `${setCode}_${format}`;
}

function cacheFilePath(key) {
  return path.join(getCacheDir(), `${key}.json`);
}

function isCacheStale(filePath) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs > CACHE_TTL_MS;
  } catch {
    return true;
  }
}

function readDiskCache(key) {
  const fp = cacheFilePath(key);
  try {
    if (fs.existsSync(fp) && !isCacheStale(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    }
  } catch (e) {
    console.error('[17lands] Disk cache read error:', e.message);
  }
  return null;
}

function writeDiskCache(key, data) {
  ensureCacheDir();
  try {
    fs.writeFileSync(cacheFilePath(key), JSON.stringify(data), 'utf-8');
  } catch (e) {
    console.error('[17lands] Disk cache write error:', e.message);
  }
}

// ─── Network ─────────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'ArenaOverlay/0.2 (github.com/rocketvish/arena-overlay)',
          Accept: 'application/json',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch (e) {
            reject(new Error(`JSON parse failed: ${e.message}`));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

// ─── Scryfall disk cache ──────────────────────────────────────────────────────

const SCRYFALL_CACHE_FILE = 'scryfall-arena-ids.json';
let scryfallDiskCache = null; // lazy-loaded: grpId (string) → card data

function getScryfallCacheFile() {
  return path.join(getCacheDir(), SCRYFALL_CACHE_FILE);
}

function loadScryfallCache() {
  if (scryfallDiskCache !== null) return scryfallDiskCache;
  try {
    ensureCacheDir();
    const fp = getScryfallCacheFile();
    scryfallDiskCache = fs.existsSync(fp)
      ? JSON.parse(fs.readFileSync(fp, 'utf-8'))
      : {};
  } catch {
    scryfallDiskCache = {};
  }
  return scryfallDiskCache;
}

function saveScryfallCache() {
  try {
    ensureCacheDir();
    fs.writeFileSync(getScryfallCacheFile(), JSON.stringify(scryfallDiskCache), 'utf-8');
  } catch (e) {
    console.error('[17lands] Scryfall cache write error:', e.message);
  }
}

function scryfallCardData(card) {
  return {
    name: card.name,
    cmc: card.cmc ?? null,
    colorIdentity: card.color_identity?.join('') ?? (card.colors?.join('') ?? ''),
    rarity: card.rarity ?? 'common',
    typeLine: card.type_line ?? '',
    oracleText: card.oracle_text ?? '',
  };
}

// Individual fallback for cards not in the batch response (e.g. brand-new sets)
async function fetchScryfallById(grpId) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.scryfall.com/cards/arena/${grpId}`,
      { headers: { 'User-Agent': 'ArenaOverlay/0.2', Accept: 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) { resolve(null); return; }
            resolve(scryfallCardData(JSON.parse(Buffer.concat(chunks).toString('utf-8'))));
          } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

// Batch-resolve Arena IDs via Scryfall, with individual fallback for misses
// Returns: { [grpId]: { name, cmc, colorIdentity, rarity } }
async function resolveArenaIds(grpIds) {
  if (!grpIds || grpIds.length === 0) return {};

  const cache = loadScryfallCache();
  const result = {};
  const missing = [];

  // Serve already-cached IDs immediately
  for (const id of grpIds) {
    const hit = cache[String(id)];
    if (hit) result[id] = hit;
    else missing.push(id);
  }

  if (missing.length === 0) return result;

  // Batch endpoint (up to 75 per request)
  const BATCH = 75;
  const unresolved = [];

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const body = JSON.stringify({ identifiers: batch.map((id) => ({ arena_id: id })) });

    try {
      const data = await postJSON('https://api.scryfall.com/cards/collection', body);
      const resolvedSet = new Set();
      if (data && Array.isArray(data.data)) {
        for (const card of data.data) {
          if (card.arena_id != null) {
            const d = scryfallCardData(card);
            result[card.arena_id] = d;
            cache[String(card.arena_id)] = d;
            resolvedSet.add(card.arena_id);
          }
        }
      }
      for (const id of batch) {
        if (!resolvedSet.has(id)) unresolved.push(id);
      }
    } catch (e) {
      console.error('[17lands] Scryfall batch error:', e.message);
      unresolved.push(...batch);
    }
  }

  // Individual fallback for IDs the batch missed (brand-new cards, etc.)
  if (unresolved.length > 0) {
    console.log(`[17lands] Scryfall individual fallback for ${unresolved.length} IDs`);
    const settled = await Promise.all(
      unresolved.map(async (id) => ({ id, d: await fetchScryfallById(id) }))
    );
    for (const { id, d } of settled) {
      if (d) {
        result[id] = d;
        cache[String(id)] = d;
        console.log(`[17lands] Resolved via individual: ${id} → ${d.name}`);
      } else {
        console.warn(`[17lands] Could not resolve Arena ID: ${id}`);
      }
    }
  }

  saveScryfallCache();
  return result;
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ArenaOverlay/0.2',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch (e) {
            reject(e);
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Scryfall request timed out'));
    });
    req.write(body);
    req.end();
  });
}

// ─── Grade Calculation ───────────────────────────────────────────────────────

const GRADE_THRESHOLDS = [
  { grade: 'A+', zMin: 2.0 },
  { grade: 'A',  zMin: 1.67 },
  { grade: 'A-', zMin: 1.33 },
  { grade: 'B+', zMin: 1.0 },
  { grade: 'B',  zMin: 0.67 },
  { grade: 'B-', zMin: 0.33 },
  { grade: 'C+', zMin: 0.0 },
  { grade: 'C',  zMin: -0.33 },
  { grade: 'C-', zMin: -0.67 },
  { grade: 'D+', zMin: -1.0 },
  { grade: 'D',  zMin: -1.33 },
  { grade: 'D-', zMin: -1.67 },
  { grade: 'F',  zMin: -Infinity },
];

function calcGrade(z) {
  const entry = GRADE_THRESHOLDS.find((t) => z >= t.zMin);
  return entry ? entry.grade : 'F';
}

function computeMeanStd(values) {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std  = Math.sqrt(values.reduce((s, r) => s + (r - mean) ** 2, 0) / values.length);
  return { mean, std };
}

function attachGrades(rawCards) {
  // Primary metric: GIH% (ever_drawn_win_rate) — best signal for Limited quality.
  // Fallback metric: GP% (win_rate) — used when GIH% is unavailable (e.g. FDN QuickDraft).
  // Each metric is graded against its own distribution so z-scores are calibrated correctly.

  const gihEligible = rawCards.filter(
    (c) => c.ever_drawn_win_rate != null && (c.ever_drawn_game_count ?? 0) >= MIN_SAMPLE
  );
  const gpEligible = rawCards.filter(
    (c) => c.ever_drawn_win_rate == null && c.win_rate != null && (c.game_count ?? 0) >= MIN_SAMPLE
  );

  // Build separate distributions so GP% grades are relative to other GP% cards
  const gihStats = computeMeanStd(gihEligible.map((c) => c.ever_drawn_win_rate));
  const gpStats  = computeMeanStd(gpEligible.map((c) => c.win_rate));

  const hasGih = gihEligible.length >= 5 && gihStats.std > 0;
  const hasGp  = gpEligible.length  >= 5 && gpStats.std  > 0;

  if (!hasGih && !hasGp) {
    return rawCards.map((c) => ({ ...c, _grade: null, _lowSample: true }));
  }

  return rawCards.map((c) => {
    const gihWr    = c.ever_drawn_win_rate;
    const gpWr     = c.win_rate;
    const gihCount = c.ever_drawn_game_count ?? 0;
    const gpCount  = c.game_count ?? 0;

    let grade     = null;
    let lowSample = true;

    if (gihWr != null && hasGih) {
      // Primary: grade by GIH%
      lowSample = gihCount < MIN_SAMPLE;
      if (!lowSample) {
        grade = calcGrade((gihWr - gihStats.mean) / gihStats.std);
      }
    } else if (gpWr != null && hasGp && gihWr == null) {
      // Fallback: grade by GP% (only when GIH% is genuinely unavailable)
      lowSample = gpCount < MIN_SAMPLE;
      if (!lowSample) {
        grade = calcGrade((gpWr - gpStats.mean) / gpStats.std);
      }
    }

    return { ...c, _grade: grade, _lowSample: lowSample };
  });
}

// ─── Normalization ───────────────────────────────────────────────────────────

// 17Lands API has historically used single-letter codes (C/U/R/M) but newer
// endpoints return full English words — handle both to be safe.
const RARITY_MAP = {
  C: 'common',   U: 'uncommon',  R: 'rare',  M: 'mythic',
  COMMON: 'common', UNCOMMON: 'uncommon', RARE: 'rare', MYTHIC: 'mythic',
};

function normalizeCard(c, index) {
  return {
    name: c.name,
    mtgaId: c.mtga_id ?? null, // Arena grpId — present in 17Lands raw data
    color: c.color ?? '',
    rarity: RARITY_MAP[(c.rarity ?? '').toUpperCase()] ?? 'common',
    cmc: c.cmc ?? null,
    // Position in the 17Lands data array ≈ collector number − 1.
    // Used by the overlay to reproduce Arena's visual pack sort order
    // (rarity descending, then collector number ascending within rarity).
    collectorNumber: typeof index === 'number' ? index : null,
    stats: {
      grade: c._grade,
      gihwr: c.ever_drawn_win_rate ?? null,
      ohwr: c.opening_hand_win_rate ?? null,
      gpwr: c.win_rate ?? null,
      alsa: c.avg_seen ?? null,
      iwd: c.drawn_improvement_win_rate ?? null,
      sampleSize: c.ever_drawn_game_count ?? 0,
      lowSample: c._lowSample ?? false,
    },
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch (or return cached) 17Lands card data for a given set+format.
 * Sends progress events to the overlay window if provided.
 *
 * Returns: { data: NormalizedCard[], fromCache: bool } | { data: null, error: string }
 */
async function fetchSetData(setCode, format = 'PremierDraft', win = null) {
  // Always use PremierDraft — it has the largest sample size on 17Lands (~10x more
  // games than QuickDraft) and gives the most reliable grades for card evaluation.
  // The detected draft format from the Arena log is intentionally ignored here.
  format = 'PremierDraft';
  const key = cacheKey(setCode, format, '');

  // 1. Memory cache
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.timestamp < CACHE_TTL_MS) {
    return { data: mem.data, fromCache: true };
  }

  // 2. Disk cache
  const disk = readDiskCache(key);
  if (disk) {
    memCache.set(key, { data: disk, timestamp: Date.now() });
    return { data: disk, fromCache: true };
  }

  // 3. Network
  const fmtParam = FORMAT_PARAMS[format] ?? format;
  const url = `https://www.17lands.com/card_ratings/data?expansion=${setCode.toUpperCase()}&format=${fmtParam}`;
  console.log('[17lands] Fetching:', url);

  sendStatus(win, { status: 'fetching', setCode, format });

  try {
    const raw = await fetchJSON(url);
    if (!Array.isArray(raw)) {
      throw new Error('Invalid response from 17Lands');
    }
    if (raw.length === 0) {
      console.log(`[17lands] No data available for ${setCode} ${fmtParam} (set may be too new)`);
      sendStatus(win, { status: 'no-data', setCode, format });
      return { data: null, noData: true };
    }

    const withGrades = attachGrades(raw);
    const normalized = withGrades.map(normalizeCard);

    writeDiskCache(key, normalized);
    memCache.set(key, { data: normalized, timestamp: Date.now() });

    sendStatus(win, { status: 'loaded', setCode, format, count: normalized.length });
    return { data: normalized, fromCache: false };
  } catch (err) {
    console.error('[17lands] Fetch failed:', err.message);
    sendStatus(win, { status: 'error', setCode, format, error: err.message });
    return { data: null, error: err.message };
  }
}

/**
 * Fetch color-pair specific win rates (e.g., WU, BR) for a set.
 * Returns normalized card data with pair-specific stats.
 */
async function fetchColorPairData(setCode, format = 'PremierDraft', colorPair, win = null) {
  format = 'PremierDraft'; // always use PremierDraft for best sample size
  const key = cacheKey(setCode, format, colorPair);

  const mem = memCache.get(key);
  if (mem && Date.now() - mem.timestamp < CACHE_TTL_MS) {
    return { data: mem.data, fromCache: true };
  }

  const disk = readDiskCache(key);
  if (disk) {
    memCache.set(key, { data: disk, timestamp: Date.now() });
    return { data: disk, fromCache: true };
  }

  const fmtParam = FORMAT_PARAMS[format] ?? format;
  const url = `https://www.17lands.com/card_ratings/data?expansion=${setCode.toUpperCase()}&format=${fmtParam}&colors=${colorPair}`;
  console.log('[17lands] Fetching color pair:', colorPair, url);
  sendStatus(win, { status: 'fetching', setCode, format, colorPair });

  try {
    const raw = await fetchJSON(url);
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('Empty response');

    const withGrades = attachGrades(raw);
    const normalized = withGrades.map(normalizeCard);

    writeDiskCache(key, normalized);
    memCache.set(key, { data: normalized, timestamp: Date.now() });
    sendStatus(win, { status: 'loaded', setCode, format, colorPair, count: normalized.length });
    return { data: normalized, fromCache: false };
  } catch (err) {
    console.error('[17lands] Color pair fetch error:', colorPair, err.message);
    sendStatus(win, { status: 'error', setCode, format, colorPair, error: err.message });
    return { data: null, error: err.message };
  }
}

/**
 * Clear all cached data (disk + memory) for a specific set, or everything.
 */
function clearCache(setCode, format) {
  ensureCacheDir();
  if (setCode) {
    const prefix = format ? `${setCode}_${format}` : setCode;
    const dir = getCacheDir();
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(prefix)) fs.unlinkSync(path.join(dir, f));
      }
    } catch {}
    for (const k of memCache.keys()) {
      if (k.startsWith(setCode)) memCache.delete(k);
    }
  } else {
    const dir = getCacheDir();
    try {
      for (const f of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, f));
      }
    } catch {}
    memCache.clear();
  }
}

function sendStatus(win, payload) {
  // win can be a BrowserWindow, a broadcastFn object { send: fn }, or a direct function
  if (!win) return;
  if (typeof win === 'function') {
    win('17lands-status', payload);
  } else if (typeof win?.send === 'function') {
    win.send('17lands-status', payload);
  } else if (win && !win.isDestroyed?.()) {
    win.webContents?.send('17lands-status', payload);
  }
}

function getScryfallCardData(grpId) {
  const cache = loadScryfallCache();
  return cache[String(grpId)] ?? null;
}

module.exports = { fetchSetData, fetchColorPairData, clearCache, resolveArenaIds, getScryfallCardData };
