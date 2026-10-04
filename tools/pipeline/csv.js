/**
 * Minimal streaming reader for 17Lands' public .csv.gz datasets.
 * No dependencies; handles quoted fields (card names contain apostrophes and
 * were written with quotes).
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Yields { header, row } for every data row of a .csv.gz file. */
async function* readCsvGz(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  let header = null;
  for await (const line of rl) {
    if (!header) { header = splitCsvLine(line); continue; }
    if (line) yield { header, row: splitCsvLine(line) };
  }
}

/**
 * 17Lands dataset column names drop commas from card names
 * ("Azog, Moria's Ruin" → "Azog  Moria's Ruin"). Normalize both sides.
 */
function normCardName(name) {
  return String(name ?? '')
    .split(' // ')[0]
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

module.exports = { splitCsvLine, readCsvGz, normCardName };
