#!/usr/bin/env node
/**
 * update-sets.js — rebuild and publish set tables whose 17Lands public
 * datasets are new or have changed since the published table was built.
 *
 *   node tools/pipeline/update-sets.js                 # the 8 newest expansions
 *   node tools/pipeline/update-sets.js FRA SOS         # specific sets
 *   node tools/pipeline/update-sets.js --force HOB     # rebuild even if unchanged
 *   node tools/pipeline/update-sets.js --dry-run       # report only
 *
 * Runs daily in GitHub Actions (.github/workflows/set-data.yml), so a new
 * set's table appears within a day of 17Lands publishing its data (~2–3
 * weeks after release) without anyone remembering to do it.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const REMOTE = 'https://github.com/rocketvish/arena-overlay/releases/download/set-data';
const FORMAT = 'PremierDraft';
const NEWEST = 8;

// Every hop must be https to one of these: 17Lands (site + public dataset
// bucket, incl. a regional S3 redirect) and GitHub release downloads, which
// redirect to its asset CDN.
const ALLOWED_HOSTS = [
  /^www\.17lands\.com$/,
  /^17lands-public\.s3(\.[a-z0-9-]+)?\.amazonaws\.com$/,
  /^github\.com$/,
  /^(release-assets|objects)\.githubusercontent\.com$/,
];
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 64 * 1024 * 1024; // set tables are ~200 KB

function getOnce(url, method, redirects) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error(`bad URL: ${url}`)); }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.some((h) => h.test(u.hostname))) return reject(new Error(`refusing to fetch ${u.protocol}//${u.host}`));
    const req = https.request(u, { method, headers: { 'User-Agent': 'ArenaOverlay-pipeline' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error(`too many redirects for ${url}`));
        return resolve(getOnce(new URL(res.headers.location, u).href, method, redirects - 1));
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_BODY_BYTES) req.destroy(new Error(`response over ${MAX_BODY_BYTES} bytes from ${u.host}`));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** GET/HEAD with retries — CI runners see the occasional dropped connection. */
async function get(url, method = 'GET') {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await getOnce(url, method, MAX_REDIRECTS);
      if (r.status < 500) return r;
      lastErr = new Error(`HTTP ${r.status} for ${url}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
  throw lastErr;
}

async function datasetDates(set) {
  const out = {};
  for (const kind of ['draft_data', 'game_data']) {
    const r = await get(`https://17lands-public.s3.amazonaws.com/analysis_data/${kind}/${kind}_public.${set}.${FORMAT}.csv.gz`, 'HEAD');
    out[kind] = r.status === 200 ? r.headers['last-modified'] : null;
  }
  return out;
}

async function publishedSource(set) {
  const r = await get(`${REMOTE}/${set}.json`);
  if (r.status !== 200) return null;
  try { return JSON.parse(r.body).source ?? null; } catch { return null; }
}

/** Newest draftable expansions per 17Lands (three-letter set codes, newest first). */
async function newestSets(n) {
  const r = await get('https://www.17lands.com/data/filters');
  const filters = JSON.parse(r.body);
  const starts = filters.start_dates ?? {};
  return (filters.expansions ?? [])
    .filter((e) => /^[A-Z0-9]{3}$/.test(e) && starts[e])
    .sort((a, b) => Date.parse(starts[b]) - Date.parse(starts[a]))
    .slice(0, n);
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const dry = argv.includes('--dry-run');
  let sets = argv.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());
  const bad = sets.filter((s) => !/^[A-Z0-9]{2,8}$/.test(s));
  if (bad.length) throw new Error(`invalid set code(s): ${bad.join(', ')}`);
  if (!sets.length) sets = await newestSets(NEWEST);
  const outDir = path.join(os.tmpdir(), 'arena-overlay-set-tables');
  const cacheDir = process.env.DATASET_CACHE ?? path.join(os.tmpdir(), 'arena-overlay-datasets');
  fs.mkdirSync(outDir, { recursive: true });

  const built = [];
  for (const set of sets) {
    try {
      await updateOne(set);
    } catch (e) {
      // One set's failure shouldn't stop the others from being published.
      console.error(`${set}: ${e.message}`);
      process.exitCode = 1;
    }
  }

  async function updateOne(set) {
    const dates = await datasetDates(set);
    if (!dates.draft_data) {
      console.log(`${set}: public datasets not published yet — skipping`);
      return;
    }
    // Draft data alone builds a draft-only table (pick model, wheel rates);
    // the full table follows when game data appears (its date changes).
    const pub = await publishedSource(set);
    const unchanged = pub && pub.draftDataModified === dates.draft_data && (pub.gameDataModified ?? null) === (dates.game_data ?? null);
    if (unchanged && !force) {
      console.log(`${set}: up to date (data from ${dates.game_data ?? `${dates.draft_data}, draft data only`})`);
      return;
    }
    console.log(`${set}: ${pub ? 'datasets changed' : 'no published table yet'} — ${dry ? 'would build' : 'building'}`);
    if (dry) return;
    const r = spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(__dirname, 'build-set.js'), set, '--out', outDir, '--cache', cacheDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('build failed');
    built.push(path.join(outDir, `${set}.json`));
    // Raw datasets are large; don't keep them around on CI.
    if (process.env.CI) for (const f of fs.readdirSync(cacheDir)) if (f.includes(`.${set}.`)) fs.rmSync(path.join(cacheDir, f), { force: true });
  }

  if (!built.length) { console.log('Nothing to publish.'); return; }
  // Rebuild the cross-set prior (deck win model for sets without public data)
  // from every published table plus the ones just built; the app downloads it.
  try {
    const all = path.join(os.tmpdir(), 'arena-overlay-all-tables');
    fs.rmSync(all, { recursive: true, force: true });
    fs.mkdirSync(all, { recursive: true });
    spawnSync('gh', ['release', 'download', 'set-data', '-p', '*.json', '-D', all, '--clobber'], { stdio: 'inherit' });
    fs.rmSync(path.join(all, 'valuePrior.json'), { force: true });
    for (const f of built) fs.copyFileSync(f, path.join(all, path.basename(f)));
    const priorFile = path.join(outDir, 'valuePrior.json');
    const pr = spawnSync(process.execPath, [path.join(__dirname, 'build-prior.js'), all, '--out', priorFile], { stdio: 'inherit' });
    if (pr.status === 0) built.push(priorFile);
  } catch (e) {
    console.error(`prior rebuild skipped: ${e.message}`);
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, 'publish.js'), ...built], { stdio: 'inherit' });
  if (r.status !== 0) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
