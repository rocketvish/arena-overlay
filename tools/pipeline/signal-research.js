#!/usr/bin/env node
/**
 * signal-research.js — how to read "what's open" during a pack.
 *
 *   node --max-old-space-size=8192 tools/pipeline/signal-research.js HOB
 *
 * The overlay reads a color as open when its playable cards reach you later
 * than 17Lands drafters usually take them ("lateness", as in
 * signalAnalyzer.js). Within a pack, after pick i, predict each color's
 * lateness over the next 3 picks from the picks so far, weighting pick j by
 * 0.5^((i − j) / half-life). A short half-life follows neighbors who pivot;
 * a long one averages out noise. Colors are compared within each draft
 * (demeaned), pooled over drafts: the correlation by pick is how much a read
 * at that point can be trusted.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCsvGz, normCardName } = require('./csv');
const { ensureDataset } = require('./build-set');
const { cardTable } = require('./cards');

const COLORS = 'WUBRG'.split('');
const HALF_LIVES = [Infinity, 8, 4, 2, 1];
const AHEAD = 3;

function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

async function main() {
  const set = (process.argv[2] ?? 'HOB').toUpperCase();
  const cache = path.join(os.tmpdir(), 'arena-overlay-datasets');
  const table = JSON.parse(fs.readFileSync(path.join(cache, 'tables', `${set}.json`), 'utf8'));
  const { cards } = await cardTable(set, cache);
  const draft = await ensureDataset('draft_data', set, 'PremierDraft', cache);
  const gihs = Object.values(table.cards).filter((c) => c.gih != null && (c.gihN ?? 0) >= 200).map((c) => c.gih);
  const m = gihs.reduce((a, b) => a + b, 0) / gihs.length;
  const sd = Math.sqrt(gihs.reduce((a, b) => a + (b - m) ** 2, 0) / gihs.length);
  const meta = new Map(); // dataset card name → { colors, z, ata }
  for (const [name, c] of cards) {
    const t = table.cards[c.mtgaId];
    meta.set(name, { colors: String(c.color ?? '').replace(/[^WUBRG]/g, ''), z: t?.gih != null ? (t.gih - m) / sd : null, ata: t?.ata ?? null });
  }
  // Lateness of one card seen at 0-based pick i (signalAnalyzer.lateness).
  const late = (k, i) => {
    if (!k || k.ata == null || k.z == null || k.z < -0.5) return 0;
    const l = i + 1 - k.ata;
    return l > 0 ? Math.min(l, 8) * (0.5 + normCdf(k.z)) : 0;
  };

  // Accumulate (prediction, outcome) moments per half-life and pick.
  const acc = HALF_LIVES.map(() => new Map()); // pick → { sxy, sxx, syy, n }
  let cols = null, cur = null, drafts = 0;
  const flush = () => {
    if (!cur) return;
    drafts++;
    for (const pack of [0, 1, 2]) {
      const byPick = cur.get(pack);
      if (!byPick) continue;
      // L[i][c]: lateness by color of the pack seen at pick i.
      const L = [];
      for (let i = 0; i < 14; i++) {
        const row = byPick.get(i);
        const v = Object.fromEntries(COLORS.map((c) => [c, 0]));
        if (row) for (const k of row) { const l = late(k, i); if (l) for (const ch of k.colors) v[ch] += l / k.colors.length; }
        L.push(row ? v : null);
      }
      for (let i = 2; i + AHEAD < 14; i++) {
        if (!L[i] || L.slice(i + 1, i + 1 + AHEAD).some((x) => !x)) continue;
        const y = COLORS.map((c) => L.slice(i + 1, i + 1 + AHEAD).reduce((s, v) => s + v[c], 0));
        const ym = y.reduce((a, b) => a + b, 0) / 5;
        HALF_LIVES.forEach((hl, h) => {
          const x = COLORS.map((c) => {
            let s = 0;
            for (let j = 1; j <= i; j++) if (L[j]) s += L[j][c] * (Number.isFinite(hl) ? 0.5 ** ((i - j) / hl) : 1);
            return s;
          });
          const xm = x.reduce((a, b) => a + b, 0) / 5;
          const a = acc[h].get(i) ?? { sxy: 0, sxx: 0, syy: 0, n: 0 };
          for (let c = 0; c < 5; c++) { const dx = x[c] - xm, dy = y[c] - ym; a.sxy += dx * dy; a.sxx += dx * dx; a.syy += dy * dy; }
          a.n++;
          acc[h].set(i, a);
        });
      }
    }
    cur = null;
  };
  for await (const { header, row } of readCsvGz(draft.file)) {
    if (!cols) {
      cols = { id: header.indexOf('draft_id'), pack: header.indexOf('pack_number'), pick: header.indexOf('pick_number'), cards: [] };
      header.forEach((h, i) => { if (h.startsWith('pack_card_')) { const k = meta.get(normCardName(h.slice(10))); if (k) cols.cards.push([i, k]); } });
    }
    const id = row[cols.id];
    if (!cur || cur.id !== id) { flush(); cur = new Map(); cur.id = id; }
    const p = Number(row[cols.pack]), i = Number(row[cols.pick]);
    const list = [];
    for (const [ci, k] of cols.cards) { const n = Number(row[ci]); for (let j = 0; j < n; j++) list.push(k); }
    if (!cur.has(p)) cur.set(p, new Map());
    cur.get(p).set(i, list);
  }
  flush();

  console.log(`${set}: ${drafts} drafts; correlation of each color's read with its flow over the next ${AHEAD} picks`);
  console.log(`  pick   ${HALF_LIVES.map((h) => (Number.isFinite(h) ? `hl ${h}` : 'no decay').padStart(9)).join('')}`);
  const picks = [...acc[0].keys()].sort((a, b) => a - b);
  const totals = HALF_LIVES.map(() => ({ sxy: 0, sxx: 0, syy: 0 }));
  for (const i of picks) {
    const rs = HALF_LIVES.map((_, h) => {
      const a = acc[h].get(i);
      totals[h].sxy += a.sxy; totals[h].sxx += a.sxx; totals[h].syy += a.syy;
      return a.sxy / Math.sqrt(a.sxx * a.syy);
    });
    console.log(`  ${String(i + 1).padStart(4)}   ${rs.map((r) => r.toFixed(3).padStart(9)).join('')}`);
  }
  console.log(`  all    ${totals.map((t) => (t.sxy / Math.sqrt(t.sxx * t.syy)).toFixed(3).padStart(9)).join('')}`);
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });
