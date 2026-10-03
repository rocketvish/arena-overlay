/**
 * 17Lands data fetcher, cache manager, and grade calculator.
 *
 * Endpoints (the legacy public ones — 17Lands' newer /api/card_data is marked
 * "only for use on 17Lands.com", so we deliberately don't use it):
 *   https://www.17lands.com/card_ratings/data?expansion=FRA&format=PremierDraft
 *   https://www.17lands.com/color_ratings/data?expansion=FRA&event_type=PremierDraft&combine_splash=true[&user_group=top]
 *
 * Notes on the card endpoint's current behaviour (verified Oct 2026):
 *   - It ignores `colors`, `user_group`, `start_date` and `end_date`, so
 *     per-color-pair card stats are not available from it.
 *   - It serves a recent window only: once a set leaves the live queues its
 *     numbers drop to ~zero. We therefore never let a much thinner response
 *     overwrite a good cached snapshot.
 *   - GIH WR is null for cards with < 500 drawn games (often the rares and
 *     mythics that matter most). Those cards get an *estimated* grade from
 *     their GP WR, flagged so the UI can show it as an estimate.
 *
 * Usage guidelines (17lands.com/usage_guidelines): cite 17Lands visibly, and
 * keep request volume low — hence the 12h cache and in-flight de-duplication.
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

const CACHE_SCHEMA = 2;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;     // 17Lands refreshes roughly daily
const MIN_SAMPLE = 200;                        // min drawn games for a GIH-based grade
const MIN_EST_GAMES = 100;                     // min GP games to estimate a grade
const THIN_RESPONSE_RATIO = 0.5;               // fresh data with < 50% of cached games ⇒ keep cache
const STALE_RETRY_MS = 60 * 60 * 1000;         // re-check a stale fallback at most hourly
const FAILURE_RETRY_MS = 5 * 60 * 1000;        // don't re-request after an error / no-data for 5 min
const RECENT_SNAPSHOT_MS = 7 * 24 * 60 * 60 * 1000; // thin-response guard only trusts snapshots this fresh
const USER_AGENT = 'ArenaOverlay (github.com/rocketvish/arena-overlay)';

// Memory cache: cacheKey → { cards, fetchedAt, stale? }
const memCache = new Map();
// cacheKey → Promise, so concurrent callers (overlay, control window and the
// assistant all ask at draft start) share one network request.
const inflight = new Map();
// cacheKey → { at, result } for recent errors / no-data answers.
const recentFailures = new Map();

// ─── File Cache ──────────────────────────────────────────────────────────────

function ensureCacheDir() {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cacheFilePath(key) {
  return path.join(getCacheDir(), `${key}.json`);
}

function readJSONFile(fp) {
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) {
    console.error('[17lands] Cache read error:', fp, e.message);
  }
  return null;
}

/** Read a cache entry in the current schema ({ schema, fetchedAt, ... }). */
function readCacheEntry(key) {
  const entry = readJSONFile(cacheFilePath(key));
  if (entry && entry.schema === CACHE_SCHEMA && typeof entry.fetchedAt === 'number') return entry;
  return null;
}

function writeCacheEntry(key, entry) {
  ensureCacheDir();
  try {
    fs.writeFileSync(cacheFilePath(key), JSON.stringify({ schema: CACHE_SCHEMA, ...entry }), 'utf-8');
  } catch (e) {
    console.error('[17lands] Disk cache write error:', e.message);
  }
}

const isFresh = (entry) => entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS;

/**
 * v0.5 and earlier cached a bare array of normalized cards per set+format.
 * Used only as a last resort when 17Lands no longer serves a set's data.
 */
function readLegacySetCache(setCode) {
  for (const fmt of ['PremierDraft', 'QuickDraft', 'TradDraft']) {
    const fp = cacheFilePath(`${setCode}_${fmt}`);
    const arr = readJSONFile(fp);
    if (Array.isArray(arr) && arr.length > 0 && totalGames(arr) > 0) {
      return { cards: arr, fetchedAt: fs.statSync(fp).mtimeMs, legacyFormat: fmt };
    }
  }
  return null;
}

// ─── Network ─────────────────────────────────────────────────────────────────

function requestJSON(url, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode !== 200) {
          const err = new Error(`HTTP ${res.statusCode} for ${url}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    if (body) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Grade every card on the GIH WR scale.
 *
 * - Cards with a GIH WR (≥ MIN_SAMPLE drawn games) are graded by z-score
 *   against the set's GIH distribution — unchanged from before.
 * - Cards whose GIH WR 17Lands withholds (< 500 drawn games) previously got a
 *   GP-WR grade relative to *only the other withheld cards* — a tiny, noisy,
 *   rare-heavy pool, so those grades were close to meaningless. Now their GIH
 *   WR is estimated from GP WR: GP WR is first shrunk toward the set mean in
 *   proportion to its sampling noise (empirical Bayes), then mapped onto the
 *   GIH scale with a regression fitted on cards that have both. (On FRA the
 *   fit has r ≈ 0.94.) These grades are flagged `gradeEstimated`.
 *
 * Returns a parallel array of { grade, z, gihwrEst, gradeEstimated, lowSample }.
 */
function computeGrades(rawCards) {
  const gihOk = (c) => c.ever_drawn_win_rate != null && (c.ever_drawn_game_count ?? 0) >= MIN_SAMPLE;
  const gihCards = rawCards.filter(gihOk);
  const gih = computeMeanStd(gihCards.map((c) => c.ever_drawn_win_rate));

  const none = () => rawCards.map(() => ({ grade: null, z: null, gihwrEst: null, gradeEstimated: false, lowSample: true }));

  // ── Very early set: no GIH at all yet — grade on GP WR across every card ──
  if (gihCards.length < 5 || gih.std <= 0) {
    const gpCards = rawCards.filter((c) => c.win_rate != null && (c.game_count ?? 0) >= MIN_SAMPLE);
    const gp = computeMeanStd(gpCards.map((c) => c.win_rate));
    if (gpCards.length < 5 || gp.std <= 0) return none();
    return rawCards.map((c) => {
      if (c.win_rate == null || (c.game_count ?? 0) < MIN_SAMPLE) {
        return { grade: null, z: null, gihwrEst: null, gradeEstimated: false, lowSample: true };
      }
      const z = (c.win_rate - gp.mean) / gp.std;
      return { grade: calcGrade(z), z, gihwrEst: null, gradeEstimated: true, lowSample: false };
    });
  }

  // ── GP → GIH regression on cards that have both ──────────────────────────
  const both = gihCards.filter((c) => c.win_rate != null && (c.game_count ?? 0) > 0);
  let a = null, b = null, gpMean = null, tau2 = null;
  if (both.length >= 10) {
    const xs = both.map((c) => c.win_rate);
    const ys = both.map((c) => c.ever_drawn_win_rate);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
    }
    if (sxx > 0) {
      b = sxy / sxx;
      a = my - b * mx;
      gpMean = mx;
      // True-score variance of GP WR = observed variance − average sampling variance.
      const obsVar = sxx / xs.length;
      const noiseVar = both.reduce((s, c) => s + (c.win_rate * (1 - c.win_rate)) / c.game_count, 0) / both.length;
      tau2 = Math.max(obsVar - noiseVar, obsVar * 0.25);
    }
  }

  return rawCards.map((c) => {
    if (gihOk(c)) {
      const z = (c.ever_drawn_win_rate - gih.mean) / gih.std;
      return { grade: calcGrade(z), z, gihwrEst: null, gradeEstimated: false, lowSample: false };
    }
    const n = c.game_count ?? 0;
    if (b != null && c.win_rate != null && n >= MIN_EST_GAMES) {
      const p = c.win_rate;
      const noise = (p * (1 - p)) / n;
      const shrunk = gpMean + (tau2 / (tau2 + noise)) * (p - gpMean);
      const est = a + b * shrunk;
      const z = (est - gih.mean) / gih.std;
      return { grade: calcGrade(z), z, gihwrEst: est, gradeEstimated: true, lowSample: true };
    }
    return { grade: null, z: null, gihwrEst: null, gradeEstimated: false, lowSample: true };
  });
}

// ─── Normalization ───────────────────────────────────────────────────────────

// 17Lands has used both single-letter (C/U/R/M) and full-word rarities.
const RARITY_MAP = {
  C: 'common',   U: 'uncommon',  R: 'rare',  M: 'mythic',
  COMMON: 'common', UNCOMMON: 'uncommon', RARE: 'rare', MYTHIC: 'mythic',
};

function normalizeCard(c, index, g) {
  return {
    name: c.name,
    mtgaId: c.mtga_id ?? null, // Arena grpId — present in 17Lands raw data
    color: c.color ?? '',
    rarity: RARITY_MAP[(c.rarity ?? '').toUpperCase()] ?? 'common',
    // 17Lands doesn't provide mana value or rules text; attachCardText()
    // fills cmc / manaCost / oracleText from Scryfall. typeLine starts from
    // 17Lands' own `types` so creature/removal checks work even offline.
    cmc: null,
    manaCost: null,
    typeLine: Array.isArray(c.types) ? c.types.join(' // ') : '',
    oracleText: '',
    // Position in the 17Lands data array ≈ collector number − 1.
    // Used by the overlay to reproduce Arena's visual pack sort order
    // (rarity descending, then collector number ascending within rarity).
    collectorNumber: typeof index === 'number' ? index : null,
    stats: {
      grade: g.grade,
      gradeEstimated: g.gradeEstimated,
      z: g.z,
      gihwr: c.ever_drawn_win_rate ?? null,
      gihwrEst: g.gihwrEst,
      ohwr: c.opening_hand_win_rate ?? null,
      gpwr: c.win_rate ?? null,
      alsa: c.avg_seen ?? null,       // average last seen at (pick #, 1-based)
      ata: c.avg_pick ?? null,        // average taken at (pick #, 1-based)
      iwd: c.drawn_improvement_win_rate ?? null,
      playRate: c.play_rate ?? null,
      sampleSize: c.ever_drawn_game_count ?? 0, // drawn games (GIH sample)
      gameCount: c.game_count ?? 0,             // games in deck (GP sample)
      lowSample: g.lowSample,
    },
  };
}

function buildCardData(raw) {
  const grades = computeGrades(raw);
  return raw.map((c, i) => normalizeCard(c, i, grades[i]));
}

function totalGames(cards) {
  return cards.reduce((s, c) => s + (c.stats?.gameCount ?? c.stats?.sampleSize ?? c.game_count ?? 0), 0);
}

// ─── Scryfall card text (mana value, type line, rules text) ──────────────────
//
// Scryfall's /cards/collection does NOT accept `arena_id` identifiers (400),
// and brand-new sets often lack arena_ids entirely, so we match by name:
// one paginated set search, then a by-name collection lookup for bonus-sheet
// cards from other sets. Card text never changes, so this cache is long-lived.

const TEXT_RETRY_MS = 24 * 60 * 60 * 1000;

function normName(name) {
  return (name ?? '')
    .split(' // ')[0]
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`]/g, "'")
    .trim();
}

function scryfallText(card) {
  const faces = Array.isArray(card.card_faces) ? card.card_faces : null;
  return {
    cmc: card.cmc ?? null,
    manaCost: card.mana_cost ?? faces?.[0]?.mana_cost ?? null,
    typeLine: card.type_line ?? faces?.map((f) => f.type_line).join(' // ') ?? '',
    oracleText: card.oracle_text ?? faces?.map((f) => f.oracle_text ?? '').join('\n//\n') ?? '',
    colorIdentity: (card.color_identity ?? []).join(''),
    rarity: card.rarity ?? null,
    name: card.name,
  };
}

async function fetchScryfallSetText(setCode) {
  const out = {};
  let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`e:${setCode.toLowerCase()}`)}&unique=cards`;
  while (url) {
    const page = await requestJSON(url);
    for (const card of page.data ?? []) out[normName(card.name)] = scryfallText(card);
    url = page.has_more ? page.next_page : null;
    if (url) await sleep(120); // Scryfall asks for ≤ 10 requests/second
  }
  return out;
}

async function fetchScryfallByName(names) {
  const out = {};
  for (let i = 0; i < names.length; i += 75) {
    const body = JSON.stringify({ identifiers: names.slice(i, i + 75).map((name) => ({ name })) });
    const res = await requestJSON('https://api.scryfall.com/cards/collection', { method: 'POST', body });
    for (const card of res.data ?? []) out[normName(card.name)] = scryfallText(card);
    await sleep(120);
  }
  return out;
}

/**
 * Fill cmc / manaCost / typeLine / oracleText on normalized cards in place.
 * Never throws — missing text only degrades deck analysis, not card stats.
 */
async function attachCardText(setCode, cards) {
  const key = `scryfall-text-${setCode}`;
  const entry = readCacheEntry(key) ?? { fetchedAt: 0, byName: {}, misses: {} };
  const byName = entry.byName ?? {};
  const misses = entry.misses ?? {};
  const now = Date.now();
  const wanted = cards.filter((c) => {
    const n = normName(c.name);
    return n && !byName[n] && !(misses[n] && now - misses[n] < TEXT_RETRY_MS);
  });

  if (wanted.length > 0) {
    try {
      if (!entry.setFetched) {
        Object.assign(byName, await fetchScryfallSetText(setCode));
        entry.setFetched = true;
      }
      const stillMissing = wanted.map((c) => c.name).filter((n) => !byName[normName(n)]);
      if (stillMissing.length > 0) Object.assign(byName, await fetchScryfallByName(stillMissing));
      for (const c of wanted) {
        const n = normName(c.name);
        if (!byName[n]) misses[n] = now;
      }
      writeCacheEntry(key, { fetchedAt: now, setFetched: entry.setFetched, byName, misses });
    } catch (e) {
      console.error('[17lands] Scryfall text fetch failed:', e.message);
    }
  }

  let attached = 0;
  for (const c of cards) {
    const t = byName[normName(c.name)];
    if (!t) continue;
    c.cmc = t.cmc;
    c.manaCost = t.manaCost;
    c.typeLine = t.typeLine || c.typeLine;
    c.oracleText = t.oracleText;
    attached++;
  }
  return attached;
}

// ─── Public API: card ratings ────────────────────────────────────────────────

/**
 * Fetch (or return cached) 17Lands card data for a set.
 *
 * Always uses PremierDraft data: it has by far the largest sample, and the
 * other formats' numbers are thin or empty for most sets. `format` is
 * accepted for API compatibility and ignored.
 *
 * Returns:
 *   { data: NormalizedCard[], fromCache, fetchedAt, stale?, staleReason? }
 *   { data: null, noData: true } | { data: null, error }
 */
async function fetchSetData(setCode, _format = 'PremierDraft', win = null, { force = false } = {}) {
  const key = `${setCode}_PremierDraft`;

  if (!force) {
    const mem = memCache.get(key);
    if (isFresh(mem)) return result(mem, true);
    if (mem?.stale && Date.now() - mem.checkedAt < STALE_RETRY_MS) return result(mem, true);
    const disk = readCacheEntry(key);
    if (isFresh(disk)) {
      memCache.set(key, disk);
      return result(disk, true);
    }
    const failure = recentFailures.get(key);
    if (failure && Date.now() - failure.at < FAILURE_RETRY_MS) return failure.result;
  }

  if (inflight.has(key)) return inflight.get(key);
  const p = refreshSetData(setCode, key, win)
    .then((res) => {
      if (res.data) recentFailures.delete(key);
      else recentFailures.set(key, { at: Date.now(), result: res });
      return res;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function result(entry, fromCache) {
  return {
    data: entry.cards,
    fromCache,
    fetchedAt: entry.fetchedAt,
    stale: !!entry.stale,
    staleReason: entry.staleReason ?? null,
  };
}

async function refreshSetData(setCode, key, win) {
  const url = `https://www.17lands.com/card_ratings/data?expansion=${encodeURIComponent(setCode)}&format=PremierDraft`;
  console.log('[17lands] Fetching:', url);
  sendStatus(win, { status: 'fetching', setCode });

  // Best snapshot we already have, for fallback. Older-version caches (other
  // formats' numbers) are only a last resort when 17Lands has nothing at all.
  const current = readCacheEntry(key);
  const previous = current ?? readLegacySetCache(setCode);

  const fallback = async (reason) => {
    if (!previous) return null;
    const entry = { ...previous, stale: true, staleReason: previous.legacyFormat ? `${reason} (older ${previous.legacyFormat} snapshot)` : reason, checkedAt: Date.now() };
    // v0.5 caches predate card text; fill it in (served from the Scryfall cache when possible).
    if (!entry.cards.some((c) => c.oracleText)) {
      entry.cards = entry.cards.map((c) => ({ ...c }));
      await attachCardText(setCode, entry.cards);
    }
    memCache.set(key, entry);
    sendStatus(win, { status: 'loaded', setCode, count: entry.cards.length, fetchedAt: entry.fetchedAt, stale: true, staleReason: reason });
    return result(entry, true);
  };

  let raw;
  try {
    raw = await requestJSON(url);
    if (!Array.isArray(raw)) throw new Error('Invalid response from 17Lands');
  } catch (err) {
    console.error('[17lands] Fetch failed:', err.message);
    const fb = await fallback(`17Lands unreachable (${err.message})`);
    if (fb) return fb;
    sendStatus(win, { status: 'error', setCode, error: err.message });
    return { data: null, error: err.message };
  }

  const cards = buildCardData(raw);
  const games = totalGames(cards);

  // Empty, or far thinner than a *recent* snapshot of the same data: the set
  // has most likely left 17Lands' live window, so keep the richer snapshot.
  // Only snapshots under a week old count, so one thin response can't pin the
  // overlay to old numbers forever.
  const recentSnapshot = current && Date.now() - current.fetchedAt < RECENT_SNAPSHOT_MS;
  if (games === 0 || (recentSnapshot && games < totalGames(current.cards) * THIN_RESPONSE_RATIO)) {
    const fb = await fallback('17Lands is no longer serving recent data for this set');
    if (fb) return fb;
    if (games === 0) {
      console.log(`[17lands] No data available for ${setCode} (set may be too new or no longer live)`);
      sendStatus(win, { status: 'no-data', setCode });
      return { data: null, noData: true };
    }
  }

  await attachCardText(setCode, cards);

  const entry = { fetchedAt: Date.now(), cards };
  writeCacheEntry(key, entry);
  memCache.set(key, entry);
  sendStatus(win, { status: 'loaded', setCode, count: cards.length, fetchedAt: entry.fetchedAt });
  return result(entry, false);
}

// ─── Public API: archetype (color pair) win rates ────────────────────────────

/**
 * Two-color deck win rates for a set, overall and for 17Lands' top-tier
 * players. This is how the recommendation engine learns which archetypes
 * the field is actually winning with.
 *
 * Returns { pairs: { WU: { games, wins, wr, topGames, topWins, topWr }, … },
 *           fetchedAt, totalGames } | null
 */
async function fetchColorRatings(setCode, { force = false } = {}) {
  const key = `${setCode}_color_ratings`;
  if (!force) {
    const mem = memCache.get(key);
    if (isFresh(mem)) return mem.ratings;
    const disk = readCacheEntry(key);
    if (isFresh(disk)) {
      memCache.set(key, disk);
      return disk.ratings;
    }
  }
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const base = `https://www.17lands.com/color_ratings/data?expansion=${encodeURIComponent(setCode)}&event_type=PremierDraft&combine_splash=true`;
    const previous = readCacheEntry(key);
    try {
      const [all, top] = await Promise.all([requestJSON(base), requestJSON(`${base}&user_group=top`)]);
      const pairs = {};
      const add = (rows, prefix) => {
        for (const r of Array.isArray(rows) ? rows : []) {
          if (r.is_summary || typeof r.short_name !== 'string' || r.short_name.length !== 2) continue;
          const k = r.short_name;
          pairs[k] = pairs[k] ?? {};
          pairs[k][`${prefix}games`] = r.games ?? 0;
          pairs[k][`${prefix}wins`] = r.wins ?? 0;
        }
      };
      add(all, '');
      add(top, 'top');
      let total = 0;
      for (const v of Object.values(pairs)) {
        v.games = v.games ?? 0; v.wins = v.wins ?? 0;
        v.topgames = v.topgames ?? 0; v.topwins = v.topwins ?? 0;
        v.wr = v.games > 0 ? v.wins / v.games : null;
        v.topWr = v.topgames > 0 ? v.topwins / v.topgames : null;
        total += v.games;
      }
      // Same "set left the live window" guard as the card data.
      if (total === 0 || (previous && Date.now() - previous.fetchedAt < RECENT_SNAPSHOT_MS && total < previous.ratings.totalGames * THIN_RESPONSE_RATIO)) {
        if (previous) return previous.ratings;
        if (total === 0) return null;
      }
      const ratings = { pairs, fetchedAt: Date.now(), totalGames: total };
      const entry = { fetchedAt: ratings.fetchedAt, ratings };
      writeCacheEntry(key, entry);
      memCache.set(key, entry);
      return ratings;
    } catch (e) {
      console.error('[17lands] Color ratings fetch failed:', e.message);
      return previous?.ratings ?? null;
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ─── Scryfall lookup for cards 17Lands doesn't list (e.g. basic lands) ───────

const SCRYFALL_CACHE_FILE = 'scryfall-arena-ids.json';
let scryfallDiskCache = null; // lazy-loaded: grpId (string) → card data

function getScryfallCacheFile() {
  return path.join(getCacheDir(), SCRYFALL_CACHE_FILE);
}

function loadScryfallCache() {
  if (scryfallDiskCache !== null) return scryfallDiskCache;
  scryfallDiskCache = readJSONFile(getScryfallCacheFile()) ?? {};
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

/**
 * Resolve Arena grpIds to names via Scryfall's /cards/arena/:id endpoint.
 * Only used for the handful of pack cards 17Lands doesn't know. (The batch
 * /cards/collection endpoint rejects arena_id identifiers, so it can't be used.)
 * Returns: { [grpId]: { name, cmc, colorIdentity, rarity, typeLine, oracleText } }
 */
const scryfallMisses = new Map(); // grpId -> when Scryfall said "not found"

async function resolveArenaIds(grpIds) {
  if (!grpIds || grpIds.length === 0) return {};
  const cache = loadScryfallCache();
  const out = {};
  let changed = false;
  for (const id of grpIds) {
    const hit = cache[String(id)];
    if (hit) { out[id] = hit; continue; }
    if (Date.now() - (scryfallMisses.get(id) ?? 0) < TEXT_RETRY_MS) continue;
    try {
      const card = await requestJSON(`https://api.scryfall.com/cards/arena/${id}`, { timeoutMs: 10000 });
      const t = scryfallText(card);
      out[id] = cache[String(id)] = t;
      changed = true;
    } catch (e) {
      if (e.statusCode === 404) scryfallMisses.set(id, Date.now());
      else console.warn(`[17lands] Scryfall lookup failed for ${id}:`, e.message);
    }
    await sleep(100);
  }
  if (changed) saveScryfallCache();
  return out;
}

function getScryfallCardData(grpId) {
  return loadScryfallCache()[String(grpId)] ?? null;
}

// ─── Set inference from card IDs ─────────────────────────────────────────────

/**
 * Which cached set do these Arena grpIds belong to? Used when a human draft's
 * packs arrive without the EventJoin that names the set (e.g. Arena restarted
 * mid-draft). Synchronous — reads only local cache files. Returns null if no
 * cached set covers most of the cards.
 */
function inferSetFromGrpIds(grpIds) {
  const ids = (grpIds ?? []).filter(Boolean);
  if (ids.length === 0) return null;
  let best = null, bestHits = 0;
  let files = [];
  try { files = fs.readdirSync(getCacheDir()); } catch { return null; }
  for (const f of files) {
    const m = f.match(/^([A-Z0-9]+)_(PremierDraft|QuickDraft|TradDraft)\.json$/);
    if (!m) continue;
    const entry = readJSONFile(path.join(getCacheDir(), f));
    const cards = Array.isArray(entry) ? entry : entry?.cards;
    if (!Array.isArray(cards)) continue;
    const known = new Set(cards.map((c) => c.mtgaId));
    const hits = ids.filter((id) => known.has(id)).length;
    if (hits > bestHits) { bestHits = hits; best = m[1]; }
  }
  return bestHits >= Math.ceil(ids.length / 2) ? best : null;
}

// ─── Cache management ────────────────────────────────────────────────────────

/**
 * Clear cached 17Lands data (disk + memory) for a set, or everything.
 * Scryfall card text is kept — it never changes.
 */
function clearCache(setCode) {
  ensureCacheDir();
  const dir = getCacheDir();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('scryfall-')) continue;
      if (!setCode || f.startsWith(`${setCode}_`)) fs.unlinkSync(path.join(dir, f));
    }
  } catch {}
  for (const k of memCache.keys()) {
    if (!setCode || k.startsWith(`${setCode}_`)) memCache.delete(k);
  }
}

// App-wide status channel. Every fetch reports through it (not only fetches
// started by a renderer), so a window whose own request failed still hears
// when a later request succeeds.
let statusSink = null;
function setStatusSink(fn) {
  statusSink = fn;
}

function sendStatus(win, payload) {
  // win can be a BrowserWindow, a broadcastFn object { send: fn }, or a direct function
  if (!win && statusSink) win = statusSink;
  if (!win) return;
  if (typeof win === 'function') {
    win('17lands-status', payload);
  } else if (typeof win?.send === 'function') {
    win.send('17lands-status', payload);
  } else if (win && !win.isDestroyed?.()) {
    win.webContents?.send('17lands-status', payload);
  }
}

module.exports = {
  fetchSetData, fetchColorRatings, clearCache, resolveArenaIds, getScryfallCardData,
  inferSetFromGrpIds, setStatusSink,
  // exported for tests
  computeGrades, buildCardData,
};
