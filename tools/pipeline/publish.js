#!/usr/bin/env node
/**
 * publish.js — upload built set tables to the `set-data` GitHub release,
 * where the overlay downloads them (see src/main/setData.js).
 *
 *   node tools/pipeline/publish.js data/sets/HOB.json data/sets/EOE.json …
 *
 * The release is a pre-release so electron-updater (which follows the latest
 * stable release) never mistakes it for an app update. Requires the GitHub CLI.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

const TAG = 'set-data';
const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: publish.js <SET.json>…');
  process.exit(1);
}
for (const f of files) {
  const t = JSON.parse(fs.readFileSync(f, 'utf-8'));
  if (t.schema !== 1 || !t.set || !t.model) throw new Error(`${f} doesn't look like a set table`);
}

const gh = (...args) => execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
try {
  gh('release', 'view', TAG);
} catch {
  gh('release', 'create', TAG, '--prerelease', '--title', 'Set data (17Lands public datasets)',
    '--notes', 'Per-set tables used by Arena Overlay: per-archetype win rates, wheel rates and a pick model, derived from the 17Lands public datasets (https://www.17lands.com/public_datasets, CC BY 4.0). Not an app release.');
}
gh('release', 'upload', TAG, ...files, '--clobber');
console.log(`uploaded ${files.length} table(s) to release ${TAG}`);
