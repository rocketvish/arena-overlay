#!/usr/bin/env node
/**
 * pack2-research.js — can pack 1 predict which colors flow to you in pack 2?
 *
 *   node --max-old-space-size=8192 tools/pipeline/pack2-research.js HOB [--table data/sets/HOB.json]
 *
 * Pack 2 is passed by the players on your LEFT. In pack 1 you can see what
 * they took: when one of your early packs comes back (8 picks later), the
 * missing cards went to them. Candidates for each color's pack-2 flow:
 *   left   — quality of cards of that color the left side took from your
 *            pack-1 packs (they're in it → less of it for you)
 *   right  — the usual pack-1 signal: how late that color reached you in
 *            pack 1 (it comes from the right, the other side in pack 2)
 * Outcome: the same lateness signal measured over pack 2 itself. Colors are
 * compared within each draft (demeaned across the five colors).
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { readCsvGz, normCardName } = require('./csv');
const { ensureDataset } = require('./build-set');
const { cardTable } = require('./cards');

const COLORS = 'WUBRG'.split('');
const POD = 8;

function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

async function main() {
  const set = (process.argv[2] ?? 'HOB').toUpperCase();
  const ti = process.argv.indexOf('--table');
  const tablePath = ti > 0 ? process.argv[ti + 1] : path.join(__dirname, '..', '..', 'data', 'sets', `${set}.json`);
  const cache = path.join(os.tmpdir(), 'arena-overlay-datasets');
  const table = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
  const { cards, list } = await cardTable(set, cache);
  const draft = await ensureDataset('draft_data', set, 'PremierDraft', cache);

  // Per card index: colors, quality z, ATA.
  const gihs = Object.values(table.cards).map((c) => c.gih).filter((x) => x != null);
  const mean = gihs.reduce((a, b) => a + b, 0) / gihs.length;
  const std = Math.sqrt(gihs.reduce((a, b) => a + (b - mean) ** 2, 0) / gihs.length);
  const info = list.map((m) => {
    const t = table.cards[m.mtgaId];
    return { colors: String(m.color ?? '').replace(/[^WUBRG]/g, ''), z: t?.gih != null ? (t.gih - mean) / std : null, ata: t?.ata ?? null };
  });
  const lateness = (c, pickNo) => {
    const k = info[c];
    if (!k || k.ata == null || k.z == null || k.z < -0.5) return 0;
    const late = pickNo + 1 - k.ata;
    return late > 0 ? Math.min(late, 8) * (0.5 + normCdf(k.z)) : 0;
  };
  const quality = (c) => (info[c]?.z != null ? normCdf(info[c].z) : 0.3);

  const rowsOut = [];
  let cols = null, cur = null;
  const flush = () => {
    if (!cur) return;
    const byKey = new Map(cur.rows.map((r) => [r.packNo * 100 + r.pickNo, r]));
    const vec = () => Object.fromEntries(COLORS.map((c) => [c, 0]));
    const left = vec(), right = vec(), out = vec();
    let wheels = 0;
    for (let i = 0; i <= 5; i++) {
      const a = byKey.get(i), b = byKey.get(i + POD);
      if (!a || !b) continue;
      wheels++;
      const remaining = new Map();
      for (const c of b.pack) remaining.set(c, (remaining.get(c) ?? 0) + 1);
      let mine = a.taken;
      for (const c of a.pack) {
        if (c === mine) { mine = null; continue; }
        const k = remaining.get(c) ?? 0;
        if (k > 0) { remaining.set(c, k - 1); continue; }
        const cs = info[c]?.colors ?? '';
        for (const ch of cs) left[ch] += quality(c) / cs.length;
      }
    }
    const signal = (packNo, dst) => {
      let n = 0;
      for (let i = 1; i <= POD; i++) {
        const r = byKey.get(packNo * 100 + i);
        if (!r) continue;
        n++;
        for (const c of r.pack) {
          const l = lateness(c, i);
          const cs = info[c]?.colors ?? '';
          for (const ch of cs) dst[ch] += l / cs.length;
        }
      }
      return n;
    };
    const n1 = signal(0, right), n2 = signal(1, out);
    if (wheels >= 4 && n1 >= 6 && n2 >= 6) rowsOut.push({ left, right, out });
    cur = null;
  };
  for await (const { header, row } of readCsvGz(draft.file)) {
    if (!cols) {
      cols = { id: header.indexOf('draft_id'), packNo: header.indexOf('pack_number'), pickNo: header.indexOf('pick_number'), pick: header.indexOf('pick'), pack: [] };
      header.forEach((h, i) => { if (h.startsWith('pack_card_')) { const c = cards.get(normCardName(h.slice(10))); if (c) cols.pack.push([i, c.idx]); } });
    }
    const id = row[cols.id];
    if (!cur || cur.id !== id) { flush(); cur = { id, rows: [] }; }
    const packNo = Number(row[cols.packNo]);
    if (packNo > 1) continue;
    const pack = [];
    for (const [i, c] of cols.pack) { const k = Number(row[i]); for (let j = 0; j < k; j++) pack.push(c); }
    cur.rows.push({ packNo, pickNo: Number(row[cols.pickNo]), pack, taken: cards.get(normCardName(row[cols.pick]))?.idx ?? null });
  }
  flush();

  // Within-draft (demeaned over colors) correlations and a joint fit.
  const demean = (v) => { const m = COLORS.reduce((s, c) => s + v[c], 0) / 5; return COLORS.map((c) => v[c] - m); };
  const X = [], Y = [];
  for (const r of rowsOut) {
    const L = demean(r.left), R = demean(r.right), O = demean(r.out);
    for (let j = 0; j < 5; j++) { X.push([L[j], R[j]]); Y.push(O[j]); }
  }
  const corr = (a, b) => {
    const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
    let sab = 0, sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
    return sab / Math.sqrt(sa * sb);
  };
  const L = X.map((x) => x[0]), R = X.map((x) => x[1]);
  // OLS with two regressors (no intercept: all demeaned).
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < Y.length; i++) { a11 += L[i] * L[i]; a12 += L[i] * R[i]; a22 += R[i] * R[i]; b1 += L[i] * Y[i]; b2 += R[i] * Y[i]; }
  const det = a11 * a22 - a12 * a12;
  const bl = (a22 * b1 - a12 * b2) / det, br = (a11 * b2 - a12 * b1) / det;
  let rss = 0, tss = 0;
  for (let i = 0; i < Y.length; i++) { rss += (Y[i] - bl * L[i] - br * R[i]) ** 2; tss += Y[i] ** 2; }
  const sdL = Math.sqrt(a11 / Y.length), sdR = Math.sqrt(a22 / Y.length);
  console.log(`${set}: ${rowsOut.length} drafts`);
  console.log(`  corr(pack-2 flow, left side took in pack 1)   ${corr(L, Y).toFixed(3)}`);
  console.log(`  corr(pack-2 flow, pack-1 signal from right)   ${corr(R, Y).toFixed(3)}`);
  console.log(`  joint fit: left ${bl.toFixed(3)} (${(bl * sdL).toFixed(3)} per SD), right ${br.toFixed(3)} (${(br * sdR).toFixed(3)} per SD); R² ${(1 - rss / tss).toFixed(3)}`);
  console.log(`  scale: SD of left ${sdL.toFixed(3)}, right ${sdR.toFixed(3)}, pack-2 flow ${Math.sqrt(tss / Y.length).toFixed(3)}`);
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });
