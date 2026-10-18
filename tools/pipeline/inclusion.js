/**
 * inclusion.js — how often drafters maindeck a card they drafted, when it's
 * castable in their deck's colors.
 *
 * 17Lands' "Learning from the Best" found situational cards (Goldhound) win
 * more because skilled players only maindeck them where they fit — a card's
 * win rate is measured on a filtered set of decks. A card that's often benched
 * even when on color is one whose value depends on the deck. Training drafts
 * only (hash % 10 ≠ 0) unless `all`, first game of each draft. Research runs
 * cache the result in the dataset cache.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readCsvGz, normCardName } = require('./csv');
const { hashId } = require('./winModel');

const colorsOf = (c) => String(c ?? '').replace(/[^WUBRG]/g, '');

/**
 * Map mtgaId → { r: maindeck share of on-color copies, n: copies }. `cards`:
 * normalized name → { mtgaId, color, land }. `cache` null = don't cache.
 */
async function playRates(set, gameFile, cards, cache, { all = false } = {}) {
  const file = cache && path.join(cache, `inclusion.${set}${all ? '.all' : ''}.json`);
  if (file && fs.existsSync(file)) return new Map(JSON.parse(fs.readFileSync(file, 'utf8')));
  let cols = null;
  const seen = new Set();
  const acc = new Map();
  for await (const { header, row } of readCsvGz(gameFile)) {
    if (!cols) {
      cols = { draft: header.indexOf('draft_id'), main: header.indexOf('main_colors'), splash: header.indexOf('splash_colors'), cards: [] };
      const byName = new Map();
      header.forEach((h, i) => {
        const m = /^(deck|sideboard)_(.*)$/.exec(h);
        if (!m) return;
        const c = cards.get(normCardName(m[2]));
        if (!c || c.land) return;
        const e = byName.get(c.mtgaId) ?? { id: c.mtgaId, colors: colorsOf(c.color) };
        e[m[1]] = i;
        byName.set(c.mtgaId, e);
      });
      cols.cards = [...byName.values()].filter((e) => e.deck != null && e.sideboard != null);
    }
    const id = row[cols.draft];
    if (seen.has(id) || (!all && hashId(id) % 10 === 0)) continue;
    seen.add(id);
    const main = colorsOf(row[cols.main]) + colorsOf(row[cols.splash]);
    for (const e of cols.cards) {
      const d = Number(row[e.deck]) || 0, s = Number(row[e.sideboard]) || 0;
      if (!d && !s) continue;
      if (![...e.colors].every((ch) => main.includes(ch))) continue;
      const a = acc.get(e.id) ?? [0, 0];
      a[0] += d; a[1] += d + s;
      acc.set(e.id, a);
    }
  }
  const out = [...acc].map(([id, [d, n]]) => [id, { r: d / n, n }]);
  if (file) fs.writeFileSync(file, JSON.stringify(out));
  return new Map(out);
}

/**
 * Per card with ≥ minN on-color copies: its maindeck rate and the rate of
 * cards of similar deck value (running mean over cards sorted by value).
 * Map mtgaId → { r, expected, n, i } (i = index in value.ids).
 */
function inclusionStats(value, rates, { minN = 200 } = {}) {
  const pts = value.ids.map((id, i) => ({ id, i, w: value.w[i], rate: rates.get(id) })).filter((p) => p.rate && p.rate.n >= minN);
  pts.sort((a, b) => a.w - b.w);
  const k = Math.max(5, Math.round(pts.length / 10));
  const out = new Map();
  pts.forEach((p, j) => {
    const lo = Math.max(0, j - k), hi = Math.min(pts.length, j + k + 1);
    let s = 0;
    for (let q = lo; q < hi; q++) s += pts[q].rate.r;
    out.set(p.id, { r: p.rate.r, expected: s / (hi - lo), n: p.rate.n, i: p.i });
  });
  return out;
}

/**
 * Deck values with selective inclusion priced in: a card benched more often
 * than cards of its value (on color) keeps only part of its value above
 * filler — w' = filler + (w − filler)·min(1, r / r̂(w))^κ. r̂ is a running
 * mean of play rate over cards sorted by value (local, robust to shape).
 */
function discountValues(value, rates, { kappa = 1, minN = 200 } = {}) {
  const w = value.w.slice();
  const changes = [];
  for (const [id, st] of inclusionStats(value, rates, { minN })) {
    const ratio = Math.min(1, st.r / st.expected);
    const w0 = value.w[st.i];
    if (w0 > value.filler && ratio < 1) {
      w[st.i] = value.filler + (w0 - value.filler) * ratio ** kappa;
      changes.push({ id, w: w0, w2: w[st.i], r: st.r, expected: st.expected });
    }
  }
  return { w, changes };
}

module.exports = { playRates, inclusionStats, discountValues };
