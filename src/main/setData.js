/**
 * setData.js — per-set tables derived from 17Lands' public datasets.
 *
 * Built offline by tools/pipeline/build-set.js and published as release assets
 * (tag `set-data`), so the overlay only ever downloads ~100 KB per set:
 *   - per-card GIH WR within each two-color deck (the per-archetype view)
 *   - per-card wheel probabilities by pick
 *   - two-color deck win rates (overall + top players)
 *   - full card stats (used when 17Lands' live endpoint no longer serves a set)
 *   - a small pick model trained on top players' drafts
 *
 * Data: 17Lands public datasets, CC BY 4.0. Tables only exist ~2–3 weeks into
 * a set; until then everything here returns null and callers fall back to
 * the live 17Lands numbers.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');

const REMOTE_BASE = 'https://github.com/rocketvish/arena-overlay/releases/download/set-data';
const TABLE_SCHEMA = 1;
const REFRESH_MS = 24 * 60 * 60 * 1000;    // re-check the published table daily
const MISSING_RETRY_MS = 6 * 60 * 60 * 1000; // not published yet → ask again in 6h
// Shrink per-pair GIH WR toward the card's overall GIH WR with this many
// pseudo-games (empirical Bayes; pair samples can be small).
const PAIR_PRIOR_GAMES = 150;

const tables = new Map();   // setCode → prepared table
const inflight = new Map();
const missing = new Map();  // setCode → time we learned it isn't published

const SET_CODE_RE = /^[A-Z0-9]{2,8}$/;

function cacheFile(setCode) {
  return path.join(app.getPath('userData'), '17lands-cache', `derived-${setCode}.json`);
}

function bundledFile(setCode) {
  // Tables shipped inside the app (data/sets/*.json), if any.
  return path.join(__dirname, '..', '..', 'data', 'sets', `${setCode}.json`);
}

function readTableFile(fp) {
  try {
    if (!fs.existsSync(fp)) return null;
    const t = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return t?.schema === TABLE_SCHEMA ? t : null;
  } catch {
    return null;
  }
}

const MAX_TABLE_BYTES = 8 * 1024 * 1024; // real tables are ~100–200 KB
// GitHub release downloads redirect to its asset CDN; nothing else is followed.
const ALLOWED_HOSTS = /^(github\.com|[a-z0-9-]+\.githubusercontent\.com)$/;

function download(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    let host;
    try { host = new URL(url).hostname; } catch { return reject(new Error('bad url')); }
    if (!url.startsWith('https://') || !ALLOWED_HOSTS.test(host)) return reject(new Error(`refusing to fetch from ${host}`));
    https.get(url, { headers: { 'User-Agent': 'ArenaOverlay' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, redirects - 1));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_TABLE_BYTES) { res.destroy(new Error('set table too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', reject);
    }).on('error', reject).setTimeout(20000, function () { this.destroy(new Error('timeout')); });
  });
}

/**
 * Basic shape checks so a corrupt or hostile table can't make the main
 * process allocate absurd arrays or index out of bounds. A bad model is
 * dropped; the rest of the table is still usable.
 */
function validModel(m) {
  if (!m || !Array.isArray(m.ids) || !Number.isInteger(m.dim) || m.dim < 1 || m.dim > 64) return false;
  const n = m.ids.length;
  return n > 0 && n < 5000 &&
    Array.isArray(m.b) && m.b.length === n &&
    Array.isArray(m.u) && m.u.length === n * m.dim &&
    Array.isArray(m.v) && m.v.length === n * m.dim &&
    [m.b, m.u, m.v].every((arr) => arr.every((x) => typeof x === 'number' && Number.isFinite(x)));
}

/** Index the raw table for fast lookups. */
function prepare(raw, fetchedAt) {
  const m = validModel(raw.model) ? raw.model : null;
  const modelIndex = new Map();
  if (m) m.ids.forEach((id, i) => modelIndex.set(id, i));
  const cards = raw.cards && typeof raw.cards === 'object' && !Array.isArray(raw.cards) ? raw.cards : {};
  return { ...raw, cards, model: m, fetchedAt, modelIndex };
}

/**
 * Load the table for a set: memory → disk cache → published asset → bundled.
 * Resolves to the prepared table or null when none exists yet.
 */
async function loadSetTable(setCode, { force = false } = {}) {
  if (typeof setCode !== 'string' || !SET_CODE_RE.test(setCode)) return null;
  const mem = tables.get(setCode);
  if (!force && mem && Date.now() - mem.fetchedAt < REFRESH_MS) return mem;
  if (inflight.has(setCode)) return inflight.get(setCode);

  const p = (async () => {
    const cached = readTableFile(cacheFile(setCode));
    const cachedAt = cached ? fs.statSync(cacheFile(setCode)).mtimeMs : 0;
    if (!force && cached && Date.now() - cachedAt < REFRESH_MS) {
      const t = prepare(cached, cachedAt);
      tables.set(setCode, t);
      return t;
    }
    const useLocal = () => {
      const local = cached ?? readTableFile(bundledFile(setCode));
      if (!local) return null;
      const t = prepare(local, cachedAt || 0);
      tables.set(setCode, t);
      return t;
    };
    const gone = missing.get(setCode);
    if (!force && gone && Date.now() - gone < MISSING_RETRY_MS) return useLocal();
    try {
      const res = await download(`${REMOTE_BASE}/${encodeURIComponent(setCode)}.json`);
      if (res.status === 200) {
        const raw = JSON.parse(res.body);
        if (raw?.schema === TABLE_SCHEMA) {
          fs.mkdirSync(path.dirname(cacheFile(setCode)), { recursive: true });
          fs.writeFileSync(cacheFile(setCode), res.body, 'utf-8');
          const t = prepare(raw, Date.now());
          tables.set(setCode, t);
          missing.delete(setCode);
          return t;
        }
      } else if (res.status === 404) {
        missing.set(setCode, Date.now());
      }
    } catch (e) {
      console.warn('[setData] download failed:', setCode, e.message);
    }
    return useLocal();
  })().finally(() => inflight.delete(setCode));
  inflight.set(setCode, p);
  return p;
}

function getSetTable(setCode) {
  return tables.get(setCode) ?? null;
}

// ─── Lookups (pure, given a prepared table) ──────────────────────────────────

/** GIH WR of a card within a two-color deck, shrunk toward its overall GIH WR. */
function pairGih(table, grpId, pair) {
  const c = table?.cards?.[grpId];
  if (!c || c.gih == null) return null;
  const p = c.pairs?.[pair];
  if (!p) return { gih: c.gih, n: 0, shrunk: true };
  const [rate, n] = p;
  return { gih: (rate * n + c.gih * PAIR_PRIOR_GAMES) / (n + PAIR_PRIOR_GAMES), n, shrunk: false };
}

/** P(card is still in the pack when it comes back), for 0-based picks 0–5. */
function wheelProb(table, grpId, pickNumber) {
  const w = table?.cards?.[grpId]?.wheel;
  if (!w || pickNumber < 0 || pickNumber >= w.length) return null;
  return w[pickNumber];
}

/**
 * Pick model: probability a top player takes each card in `packIds` given
 * `poolIds`. Returns Map(grpId → probability) or null if there's no model.
 */
function modelScores(table, poolIds, packIds) {
  const m = table?.model;
  if (!m?.ids || !table.modelIndex) return null;
  const dim = m.dim;
  const h = new Float64Array(dim);
  let n = 0;
  for (const id of poolIds) {
    const i = table.modelIndex.get(id);
    if (i == null) continue;
    for (let d = 0; d < dim; d++) h[d] += m.v[i * dim + d];
    n++;
  }
  if (n) for (let d = 0; d < dim; d++) h[d] /= n;
  const uniq = [...new Set(packIds)];
  const logits = uniq.map((id) => {
    const i = table.modelIndex.get(id);
    if (i == null) return null;
    let s = m.b[i];
    for (let d = 0; d < dim; d++) s += m.u[i * dim + d] * h[d];
    return s;
  });
  const known = logits.filter((x) => x != null);
  if (known.length === 0) return null;
  const mx = Math.max(...known);
  const ex = logits.map((x) => (x == null ? 0 : Math.exp(x - mx)));
  const Z = ex.reduce((a, b) => a + b, 0);
  return new Map(uniq.map((id, k) => [id, ex[k] / Z]));
}

/**
 * The table's card stats in 17Lands' raw card_ratings shape, so
 * 17landsData.buildCardData() can grade them exactly like live data.
 */
function toRawRatings(table) {
  if (!table?.cards) return [];
  return Object.entries(table.cards)
    .sort(([, a], [, b]) => (a.order ?? 1e9) - (b.order ?? 1e9))
    .map(([id, c]) => ({
      name: c.name,
      mtga_id: Number(id),
      color: c.color ?? '',
      rarity: c.rarity ?? 'common',
      types: c.types ?? [],
      ever_drawn_win_rate: c.gih, ever_drawn_game_count: c.gihN ?? 0,
      opening_hand_win_rate: c.oh, opening_hand_game_count: c.ohN ?? 0,
      win_rate: c.gp, game_count: c.gpN ?? 0,
      never_drawn_win_rate: c.gns ?? null,
      drawn_improvement_win_rate: c.gih != null && c.gns != null ? c.gih - c.gns : null,
      avg_pick: c.ata ?? null,
      avg_seen: null,
    }));
}

module.exports = {
  loadSetTable, getSetTable, pairGih, wheelProb, modelScores, toRawRatings,
  PAIR_PRIOR_GAMES,
};
