/**
 * cards.js — a set's card list for the pipeline: 17Lands names and Arena
 * ids, plus mana value and rules text from Scryfall, reduced to the traits
 * the deck win model uses (creature, two-drop, removal, 6+ drop).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { normCardName } = require('./csv');

const HEADERS = { 'User-Agent': 'ArenaOverlay-pipeline', Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Dataset columns are card names; the app keys by Arena grpId. 17Lands' card
 * list (legacy endpoint — still lists every card with its mtga_id even after
 * the stats window has passed) bridges the two.
 */
async function loadCardList(set) {
  const list = await fetchJSON(`https://www.17lands.com/card_ratings/data?expansion=${set}&format=PremierDraft`);
  const byName = new Map();
  list.forEach((c, order) => {
    if (c.mtga_id == null) return;
    const key = normCardName(c.name);
    if (!byName.has(key)) byName.set(key, { mtgaId: c.mtga_id, name: c.name, color: c.color ?? '', rarity: c.rarity, types: c.types ?? [], order });
  });
  return byName;
}

// ─── Scryfall text ────────────────────────────────────────────────────────────

const scryfallEntry = (c) => ({
  cmc: c.cmc ?? null,
  oracle: c.oracle_text ?? (c.card_faces ?? []).map((f) => f.oracle_text ?? '').join('\n'),
});

/** Mana value and rules text for a set, keyed by normalized name (front face). */
async function scryfallSet(set) {
  const out = {};
  let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`e:${set.toLowerCase()}`)}&unique=cards`;
  while (url) {
    const page = await fetchJSON(url);
    for (const c of page.data ?? []) out[normCardName(c.name)] = scryfallEntry(c);
    url = page.has_more ? page.next_page : null;
    if (url) await sleep(120); // Scryfall asks for ≤ 10 requests/second
  }
  return out;
}

/** Cards printed under another set code (bonus sheets, special guests): look up by name. */
async function scryfallByName(names) {
  const out = {};
  for (let i = 0; i < names.length; i += 75) {
    const res = await fetchJSON('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: names.slice(i, i + 75).map((name) => ({ name: name.split(' // ')[0] })) }),
    });
    for (const c of res.data ?? []) out[normCardName(c.name)] = scryfallEntry(c);
    await sleep(120);
  }
  return out;
}

// ─── Traits ───────────────────────────────────────────────────────────────────

const TRAIT = { creature: 1, twoDrop: 2, removal: 4, topEnd: 8 };
const TRAIT_LIST = [TRAIT.creature, TRAIT.twoDrop, TRAIT.removal, TRAIT.topEnd];
// Same idea as deckBuilder.js's REMOVAL_RE.
const REMOVAL_RE = /\b(destroy target|exile target|deal[s]? \d+ damage to (any target|target)|deals damage equal to .* to (any target|target)|gets? [-−]\d+\/[-−]\d+|[-−]\d+\/[-−]\d+ until|[-−]x\/[-−]x|fights? (another |up to one )?target|target creature .* fights|return[s]? target (creature|nonland permanent) to its owner's hand)/i;

const isLandType = (types) => types.some((t) => /\bLand\b/.test(t)) && !types.some((t) => /\bCreature\b/.test(t));

/** Trait bits for a card: { types, cmc, oracle } (Scryfall text may be missing). */
function cardTraits({ types = [], cmc = null, oracle = '' }) {
  if (isLandType(types)) return 0;
  let t = 0;
  const creature = types.some((x) => /\bCreature\b/.test(x));
  if (creature) t |= TRAIT.creature;
  if (creature && cmc != null && cmc <= 2) t |= TRAIT.twoDrop;
  if (REMOVAL_RE.test(oracle ?? '')) t |= TRAIT.removal;
  if (cmc != null && cmc >= 6) t |= TRAIT.topEnd;
  return t;
}

/**
 * The set's cards with traits, cached in `cache`. Returns { list, cards }:
 * `list` in a stable order (its index is the model's card index), `cards`
 * keyed by normalized name.
 */
async function cardTable(set, cache) {
  const file = path.join(cache, `cards2.${set}.json`);
  let list;
  if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    list = [...(await loadCardList(set)).values()];
    let text = {};
    try {
      text = await scryfallSet(set);
      const missing = list.filter((m) => !text[normCardName(m.name)]).map((m) => m.name);
      if (missing.length) Object.assign(text, await scryfallByName(missing));
    } catch (e) { console.warn(`  (no Scryfall text: ${e.message})`); }
    for (const m of list) Object.assign(m, text[normCardName(m.name)] ?? {});
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list));
  }
  const cards = new Map();
  list.forEach((m, idx) => cards.set(normCardName(m.name), {
    idx, mtgaId: m.mtgaId, name: m.name, color: m.color, types: m.types,
    land: isLandType(m.types),
    traits: cardTraits({ types: m.types, cmc: m.cmc ?? null, oracle: m.oracle ?? '' }),
  }));
  const withText = list.filter((m) => m.oracle != null).length;
  if (withText < list.length * 0.9) console.warn(`  only ${withText}/${list.length} cards have Scryfall text`);
  return { cards, list };
}

module.exports = { loadCardList, cardTable, cardTraits, TRAIT, TRAIT_LIST, REMOVAL_RE };
