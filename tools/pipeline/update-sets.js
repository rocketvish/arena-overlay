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

function get(url, method = 'GET', redirects = 4) {
  return new Promise((resolve, reject) => {
    https.request(url, { method, headers: { 'User-Agent': 'ArenaOverlay-pipeline' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(res.headers.location, method, redirects - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    }).on('error', reject).end();
  });
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
  if (!sets.length) sets = await newestSets(NEWEST);
  const outDir = path.join(os.tmpdir(), 'arena-overlay-set-tables');
  const cacheDir = process.env.DATASET_CACHE ?? path.join(os.tmpdir(), 'arena-overlay-datasets');
  fs.mkdirSync(outDir, { recursive: true });

  const built = [];
  for (const set of sets) {
    const dates = await datasetDates(set);
    if (!dates.draft_data || !dates.game_data) {
      console.log(`${set}: public datasets not published yet — skipping`);
      continue;
    }
    const pub = await publishedSource(set);
    const unchanged = pub && pub.draftDataModified === dates.draft_data && pub.gameDataModified === dates.game_data;
    if (unchanged && !force) {
      console.log(`${set}: up to date (data from ${dates.game_data})`);
      continue;
    }
    console.log(`${set}: ${pub ? 'datasets changed' : 'no published table yet'} — ${dry ? 'would build' : 'building'}`);
    if (dry) continue;
    const r = spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(__dirname, 'build-set.js'), set, '--out', outDir, '--cache', cacheDir], { stdio: 'inherit' });
    if (r.status !== 0) { console.error(`${set}: build failed`); process.exitCode = 1; continue; }
    built.push(path.join(outDir, `${set}.json`));
    // Raw datasets are large; don't keep them around on CI.
    if (process.env.CI) for (const f of fs.readdirSync(cacheDir)) if (f.includes(`.${set}.`)) fs.rmSync(path.join(cacheDir, f), { force: true });
  }

  if (!built.length) { console.log('Nothing to publish.'); return; }
  const r = spawnSync(process.execPath, [path.join(__dirname, 'publish.js'), ...built], { stdio: 'inherit' });
  if (r.status !== 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
