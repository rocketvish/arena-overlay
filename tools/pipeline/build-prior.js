#!/usr/bin/env node
/**
 * build-prior.js — the cross-set prior behind the win model for new sets.
 *
 *   node tools/pipeline/build-prior.js <dir of published set tables> [--out src/main/valuePrior.json]
 *
 * Reads every table with a `value` block (download them with
 * `gh release download set-data -p '*.json'`) and writes the averaged
 * prior (see src/main/valuePrior.js). Re-run when new sets are published.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { derivePrior } = require('../../src/main/valuePrior');

function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: build-prior.js <tables dir> [--out file]');
  const oi = process.argv.indexOf('--out');
  const out = oi > 0 ? process.argv[oi + 1] : path.join(__dirname, '..', '..', 'src', 'main', 'valuePrior.json');
  const tables = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((t) => t.value);
  const prior = derivePrior(tables);
  if (!prior) throw new Error('no tables with a value block');
  fs.writeFileSync(out, JSON.stringify(prior));
  console.log(`prior from ${prior.sets.join(', ')}: ${prior.wPerZ} log-odds per z, pair slope ${prior.pairSlope}, filler z ${prior.fillerZ}`);
  console.log(`  wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.stack); process.exit(1); }
}
