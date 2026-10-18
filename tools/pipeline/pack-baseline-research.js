#!/usr/bin/env node
/**
 * pack-baseline-research.js — should "seen later than usual" use a per-pack
 * baseline?
 *
 *   node --max-old-space-size=12000 tools/pipeline/pack-baseline-research.js HOB
 *
 * The openness read compares when a card reaches you with its average taken
 * at (ATA). Sierkovitz found Arena drafters' priorities shift by pack
 * (fixing wheels far more in pack 1, gold cards more in pack 3), so one ATA
 * per card may misread. Baselines come from training drafts (hash % 10 ≠ 0):
 *   global   one ATA per card (what the app uses)
 *   pack     ATA per card and pack number
 * On held-out drafts, within each pack, the read after pick i (summed
 * lateness by color so far) predicts how good the cards in that color will be
 * over the next 3 picks (summed GIH z of playables, a baseline-free outcome),
 * compared across colors within the draft.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCsvGz, normCardName } = require('./csv');
const { ensureDataset } = require('./build-set');
const { cardTable } = require('./cards');
const { hashId } = require('./winModel');

const COLORS = 'WUBRG'.split('');
const AHEAD = 3;

function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

async function* draftRows(file, cardOf) {
  let cols = null;
  for await (const { header, row } of readCsvGz(file)) {
    if (!cols) {
      cols = { id: header.indexOf('draft_id'), pack: header.indexOf('pack_number'), pick: header.indexOf('pick_number'), taken: header.indexOf('pick'), cards: [] };
      header.forEach((h, i) => { if (h.startsWith('pack_card_')) { const k = cardOf(h.slice(10)); if (k) cols.cards.push([i, k]); } });
    }
    yield { row, cols };
  }
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
  const meta = new Map();
  let idx = 0;
  for (const [name, c] of cards) {
    const t = table.cards[c.mtgaId];
    meta.set(name, { i: idx++, colors: String(c.color ?? '').replace(/[^WUBRG]/g, ''), z: t?.gih != null ? (t.gih - m) / sd : null });
  }
  const cardOf = (nm) => meta.get(normCardName(nm)) ?? null;

  // Pass 1: ATA overall and per pack, training drafts.
  const n = meta.size;
  const sum = [0, 1, 2, 3].map(() => new Float64Array(n)), cnt = [0, 1, 2, 3].map(() => new Float64Array(n));
  for await (const { row, cols } of draftRows(draft.file, cardOf)) {
    if (hashId(row[cols.id]) % 10 === 0) continue;
    const k = cardOf(row[cols.taken]);
    if (!k) continue;
    const p = Number(row[cols.pack]), i = Number(row[cols.pick]) + 1;
    sum[p][k.i] += i; cnt[p][k.i]++;
    sum[3][k.i] += i; cnt[3][k.i]++;
  }
  const ata = (b, k) => (cnt[b][k.i] >= 30 ? sum[b][k.i] / cnt[b][k.i] : cnt[3][k.i] >= 30 ? sum[3][k.i] / cnt[3][k.i] : null);
  // How much per-pack ATA differs from the global one.
  let diff = 0, nd = 0;
  for (const k of meta.values()) for (const p of [0, 1, 2]) { const a = ata(p, k), g = ata(3, k); if (a != null && g != null && cnt[p][k.i] >= 30) { diff += Math.abs(a - g); nd++; } }
  console.log(`${set}: per-pack ATA differs from global by ${(diff / nd).toFixed(2)} picks on average`);

  const late = (k, i, base) => {
    const a = ata(base, k);
    if (a == null || k.z == null || k.z < -0.5) return 0;
    const l = i + 1 - a;
    return l > 0 ? Math.min(l, 8) * (0.5 + normCdf(k.z)) : 0;
  };
  const quality = (k) => (k.z != null && k.z >= -0.5 ? k.z + 0.5 : 0);

  // Pass 2: held-out drafts.
  const acc = { global: new Map(), pack: new Map() }; // `${pack}:${pick}` → moments
  let cur = null, drafts = 0;
  const flush = () => {
    if (!cur) return;
    drafts++;
    for (const [pack, byPick] of cur) {
      const Q = [], LG = [], LP = [];
      for (let i = 0; i < 15; i++) {
        const list = byPick.get(i);
        if (!list) { Q.push(null); LG.push(null); LP.push(null); continue; }
        const q = Object.fromEntries(COLORS.map((c) => [c, 0])), lg = { ...q }, lp = { ...q };
        for (const k of list) for (const ch of k.colors) {
          q[ch] += quality(k) / k.colors.length;
          lg[ch] += late(k, i, 3) / k.colors.length;
          lp[ch] += late(k, i, pack) / k.colors.length;
        }
        Q.push(q); LG.push(lg); LP.push(lp);
      }
      for (let i = 2; i + AHEAD < 15; i++) {
        if (!Q[i] || Q.slice(i + 1, i + 1 + AHEAD).some((x) => !x)) continue;
        const y = COLORS.map((c) => Q.slice(i + 1, i + 1 + AHEAD).reduce((s, v) => s + v[c], 0));
        for (const [name, Lx] of [['global', LG], ['pack', LP]]) {
          const x = COLORS.map((c) => { let s = 0; for (let j = 1; j <= i; j++) if (Lx[j]) s += Lx[j][c]; return s; });
          const xm = x.reduce((a, b) => a + b, 0) / 5, ym = y.reduce((a, b) => a + b, 0) / 5;
          const key = `${pack}`;
          const a = acc[name].get(key) ?? { sxy: 0, sxx: 0, syy: 0 };
          for (let c = 0; c < 5; c++) { const dx = x[c] - xm, dy = y[c] - ym; a.sxy += dx * dy; a.sxx += dx * dx; a.syy += dy * dy; }
          acc[name].set(key, a);
        }
      }
    }
    cur = null;
  };
  for await (const { row, cols } of draftRows(draft.file, cardOf)) {
    const id = row[cols.id];
    if (hashId(id) % 10 !== 0) continue;
    if (!cur || cur.id !== id) { flush(); cur = new Map(); cur.id = id; }
    const p = Number(row[cols.pack]), i = Number(row[cols.pick]);
    const list = [];
    for (const [ci, k] of cols.cards) { const c = Number(row[ci]); for (let j = 0; j < c; j++) list.push(k); }
    if (!cur.has(p)) cur.set(p, new Map());
    cur.get(p).set(i, list);
  }
  flush();
  console.log(`  ${drafts} held-out drafts; correlation of the read with color quality over the next ${AHEAD} picks`);
  const r = (a) => a.sxy / Math.sqrt(a.sxx * a.syy);
  for (const pack of ['0', '1', '2']) {
    const g = acc.global.get(pack), p = acc.pack.get(pack);
    if (g && p) console.log(`  pack ${Number(pack) + 1}: global ATA r=${r(g).toFixed(4)}   per-pack ATA r=${r(p).toFixed(4)}`);
  }
  const tot = (name) => [...acc[name].values()].reduce((s, a) => ({ sxy: s.sxy + a.sxy, sxx: s.sxx + a.sxx, syy: s.syy + a.syy }), { sxy: 0, sxx: 0, syy: 0 });
  console.log(`  all:    global ATA r=${r(tot('global')).toFixed(4)}   per-pack ATA r=${r(tot('pack')).toFixed(4)}`);
}

if (require.main === module) main().catch((e) => { console.error(e.stack); process.exit(1); });
