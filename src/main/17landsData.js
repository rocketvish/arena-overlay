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

const CACHE_DIR = path.join(app.getPath('userData'), '17lands-cache');
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
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(setCode, format, colorPair) {
  return colorPair
    ? `${setCode}_${format}_${colorPair}`
    : `${setCode}_${format}`;
}

function cacheFilePath(key) {
  return path.join(CACHE_DIR, `${key}.json`);
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

// Batch-resolve Arena IDs via Scryfall collection endpoint
// Returns: { [grpId]: { name, cmc, colorIdentity } }
async function resolveArenaIds(grpIds) {
  if (!grpIds || grpIds.length === 0) return {};

  // Build request body — Scryfall accepts up to 75 per request
  const BATCH = 75;
  const result = {};

  for (let i = 0; i < grpIds.length; i += BATCH) {
    const batch = grpIds.slice(i, i + BATCH);
    const body = JSON.stringify({
      identifiers: batch.map((id) => ({ arena_id: id })),
    });

    try {
      const data = await postJSON('https://api.scryfall.com/cards/collection', body);
      if (data && Array.isArray(data.data)) {
        for (const card of data.data) {
          if (card.arena_id != null) {
            result[card.arena_id] = {
              name: card.name,
              cmc: card.cmc ?? null,
              colorIdentity: card.color_identity?.join('') ?? (card.colors?.join('') ?? ''),
              rarity: card.rarity ?? 'common',
            };
          }
        }
      }
    } catch (e) {
      console.error('[17lands] Scryfall batch error:', e.message);
    }
  }

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

function attachGrades(rawCards) {
  // Only cards with sufficient data participate in mean/std calculation
  const eligible = rawCards.filter(
    (c) => c.ever_drawn_win_rate != null && (c.ever_drawn_game_count ?? 0) >= MIN_SAMPLE
  );

  if (eligible.length < 5) {
    // Not enough data for reliable grades
    return rawCards.map((c) => ({ ...c, _grade: null, _lowSample: true }));
  }

  const rates = eligible.map((c) => c.ever_drawn_win_rate);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const variance = rates.reduce((s, r) => s + (r - mean) ** 2, 0) / rates.length;
  const std = Math.sqrt(variance);

  return rawCards.map((c) => {
    const wr = c.ever_drawn_win_rate;
    const sample = c.ever_drawn_game_count ?? 0;
    const lowSample = sample < MIN_SAMPLE;
    let grade = null;
    if (wr != null && std > 0) {
      grade = calcGrade((wr - mean) / std);
    }
    return { ...c, _grade: grade, _lowSample: lowSample };
  });
}

// ─── Normalization ───────────────────────────────────────────────────────────

const RARITY_MAP = { C: 'common', U: 'uncommon', R: 'rare', M: 'mythic' };

function normalizeCard(c) {
  return {
    name: c.name,
    color: c.color ?? '',
    rarity: RARITY_MAP[(c.rarity ?? '').toUpperCase()] ?? 'common',
    cmc: c.cmc ?? null,
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
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('Empty or invalid response from 17Lands');
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

  try {
    const raw = await fetchJSON(url);
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('Empty response');

    const withGrades = attachGrades(raw);
    const normalized = withGrades.map(normalizeCard);

    writeDiskCache(key, normalized);
    memCache.set(key, { data: normalized, timestamp: Date.now() });
    return { data: normalized, fromCache: false };
  } catch (err) {
    console.error('[17lands] Color pair fetch error:', colorPair, err.message);
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
    try {
      for (const f of fs.readdirSync(CACHE_DIR)) {
        if (f.startsWith(prefix)) fs.unlinkSync(path.join(CACHE_DIR, f));
      }
    } catch {}
    for (const k of memCache.keys()) {
      if (k.startsWith(setCode)) memCache.delete(k);
    }
  } else {
    try {
      for (const f of fs.readdirSync(CACHE_DIR)) {
        fs.unlinkSync(path.join(CACHE_DIR, f));
      }
    } catch {}
    memCache.clear();
  }
}

function sendStatus(win, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('17lands-status', payload);
  }
}

module.exports = { fetchSetData, fetchColorPairData, clearCache, resolveArenaIds };
