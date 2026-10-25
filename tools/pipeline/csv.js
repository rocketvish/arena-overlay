/**
 * Minimal streaming reader for 17Lands' public .csv.gz datasets.
 * No dependencies; handles quoted fields (card names contain apostrophes and
 * were written with quotes).
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline, Transform } = require('stream');

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

// Bounds on a decompressed file: readline buffers a whole line in memory, so a
// gzip bomb (or a corrupt file with no newlines) must not be able to grow one
// without limit. Real rows are a few KB; real files a few GB.
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 ** 3;

/** Pass-through that enforces the bounds above; works per chunk, not per line. */
function sizeGuard(file) {
  let total = 0, sinceNewline = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > MAX_TOTAL_BYTES) return cb(new Error(`${file}: decompressed size exceeds ${MAX_TOTAL_BYTES} bytes`));
      const nl = chunk.lastIndexOf(10);
      sinceNewline = nl < 0 ? sinceNewline + chunk.length : chunk.length - nl - 1;
      if (sinceNewline > MAX_LINE_BYTES) return cb(new Error(`${file}: line longer than ${MAX_LINE_BYTES} bytes`));
      cb(null, chunk);
    },
  });
}

/** Yields { header, row } for every data row of a .csv.gz file. */
async function* readCsvGz(file) {
  // pipeline() propagates a read, gunzip or size-guard error to readline
  // (and so to the caller) instead of leaving the stream hanging.
  const input = pipeline(fs.createReadStream(file), zlib.createGunzip(), sizeGuard(file), () => {});
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    let header = null;
    for await (const line of rl) {
      if (!header) { header = splitCsvLine(line); continue; }
      if (line) yield { header, row: splitCsvLine(line) };
    }
  } finally {
    rl.close();
    input.destroy(); // callers may stop early (e.g. after the header)
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
