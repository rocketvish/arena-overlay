/**
 * gameAssistant.js — information for the game in progress (pure functions).
 *
 * Deliberately *information*, not "make this play" advice:
 *   - mulligan: keep-vs-mulligan win rates from 17Lands' public game data
 *   - opponent read: instant-speed cards their colors can cast with the mana
 *     they have open, ranked by how often 17Lands decks in that pair run them
 *   - draw odds: what's left in your library
 *
 * Inputs: a gameTracker snapshot, a card lookup (grpId → normalized 17Lands
 * card with cmc / typeLine / oracleText / color), and the set table from
 * setData (mulligan stats, per-pair play counts) when one exists.
 */

'use strict';

const COLORS = 'WUBRG';
const REMOVAL_RE = /\b(destroy target|exile target|deals? \d+ damage to (any target|target)|deals damage equal to .* to (any target|target)|gets? [-−]\d+\/[-−]\d+|fights? (another )?target|return target (creature|nonland permanent) to its owner's hand)/i;
const COUNTER_RE = /\bcounter target\b/i;
const TRICK_RE = /\btarget creature (you control )?gets \+\d+\/\+\d+|\bgains? (indestructible|hexproof|protection)|\buntil end of turn\b.*\+\d+\/\+\d+/i;

// When the set table has fewer games than this for a cell, blend it with the
// cross-set prior below.
const MIN_CELL_GAMES = 400;
// Cross-set prior: games-weighted average over ECL, EOE, HOB, MSH, SOS, TLA
// and TMT Premier Draft public game data (~2.6M kept hands). Win rate keeping
// 7 with N lands, and after a mulligan to 6. Cells with < 200 games are null.
const PRIOR = {
  keep7: {
    play: [null, 0.413, 0.568, 0.624, 0.586, 0.502, null, null],
    draw: [null, 0.403, 0.534, 0.559, 0.52, 0.449, null, null],
  },
  mull6: { play: 0.439, draw: 0.407 },
};

// Pooled over the same seven sets: overall win rate on the play vs the draw.
const PRIOR_PLAY_DRAW = { play: 0.584, draw: 0.529 };

// ─── Play or draw ────────────────────────────────────────────────────────────

/**
 * You won the die roll: play or draw? The standard Limited answer (LR and
 * most pros) is "play" unless the format is unusually slow — so check this
 * format's actual numbers rather than assume.
 */
function playDrawAdvice(snapshot, table) {
  if (!snapshot?.choosingStart) return null;
  const m = table?.mulligan;
  const sideWr = (side) => {
    if (!m) return null;
    let w = 0, n = 0;
    for (const c of m.keep7?.[side] ?? []) if (c && c[0] != null) { w += c[0] * c[1]; n += c[1]; }
    for (const k of ['mull6', 'mull5']) { const c = m[k]?.[side]; if (c && c[0] != null) { w += c[0] * c[1]; n += c[1]; } }
    return n > 1000 ? w / n : null;
  };
  const play = sideWr('play') ?? PRIOR_PLAY_DRAW.play;
  const draw = sideWr('draw') ?? PRIOR_PLAY_DRAW.draw;
  return { verdict: play >= draw ? 'play' : 'draw', play, draw, source: m ? 'set' : 'prior' };
}

// ─── Mulligan ────────────────────────────────────────────────────────────────

function blend(cell, prior) {
  if (!cell || cell[0] == null) return prior;
  const [wr, n] = cell;
  if (prior == null) return wr;
  if (n >= MIN_CELL_GAMES) return wr;
  const k = n / MIN_CELL_GAMES;
  return wr * k + prior * (1 - k);
}

/**
 * Keep or mulligan a 7-card hand? Compares 17Lands' win rate for kept 7s with
 * this many lands (play/draw) against the win rate after mulliganing to 6.
 * Only offered for 7-card hands; below that the data is too thin to be useful.
 */
function mulliganAdvice(snapshot, table) {
  if (!snapshot?.mulligan) return null;
  const hand = snapshot.me.hand;
  const lands = hand.filter((c) => c.isLand).length;
  const side = snapshot.onPlay === false ? 'draw' : 'play';
  const sideKnown = snapshot.onPlay != null;
  if (snapshot.mulligan.handSize !== 7 || hand.length !== 7) {
    const bottom = Math.max(0, hand.length - snapshot.mulligan.handSize);
    return {
      handSize: snapshot.mulligan.handSize, lands, side, sideKnown, verdict: null,
      // London mulligan: you see 7 and bottom the extras.
      note: bottom > 0
        ? `You'll bottom ${bottom}. Rule of thumb: keep 3 lands in a 6-card hand (2 with a low curve) and bottom your most expensive spells first.`
        : 'Mulligan data covers 7-card hands only',
    };
  }
  const t = table?.mulligan;
  const keepWr = blend(t?.keep7?.[side]?.[lands], PRIOR.keep7[side][lands]);
  const mullWr = blend(t?.mull6?.[side], PRIOR.mull6[side]);
  if (keepWr == null || mullWr == null) {
    return { handSize: 7, lands, side, sideKnown, verdict: lands <= 1 || lands >= 6 ? 'mulligan' : 'keep', keepWr: null, mullWr: null, note: 'No data for this land count' };
  }
  const edge = keepWr - mullWr;
  // A small edge either way is within noise — call it close.
  const verdict = edge > 0.02 ? 'keep' : edge < -0.02 ? 'mulligan' : 'close';
  return {
    handSize: 7, lands, side, sideKnown, verdict, keepWr, mullWr, edge,
    games: t?.keep7?.[side]?.[lands]?.[1] ?? 0,
    source: t?.keep7 ? 'set' : 'prior',
  };
}

// ─── Opponent read ───────────────────────────────────────────────────────────

const cardColors = (c) => (c?.color ?? '').replace(/[^WUBRG]/g, '');

/** Colors the opponent has shown: their lands' basic types plus their spells' colors. */
function opponentColors(snapshot, cardsById) {
  const seen = new Set(snapshot.opp.landColors);
  for (const g of snapshot.opp.seen) for (const ch of cardColors(cardsById.get(g))) seen.add(ch);
  return COLORS.split('').filter((c) => seen.has(c));
}

function category(card) {
  const ot = card.oracleText ?? '';
  if (COUNTER_RE.test(ot)) return 'counter';
  if (REMOVAL_RE.test(ot)) return 'removal';
  if (TRICK_RE.test(ot)) return 'trick';
  return 'other';
}

/**
 * Instant-speed cards (instants and flash) the opponent could cast right now:
 * castable in the colors they've shown, mana value ≤ their untapped lands.
 * Ranked by how often 17Lands decks of that color pair actually play them,
 * so the list reflects what people really have, not every card that exists.
 */
function opponentThreats(snapshot, cardsById, table, { limit = 6 } = {}) {
  const colors = opponentColors(snapshot, cardsById);
  const open = snapshot.opp.untappedLands;
  if (!colors.length || open === 0) return { colors, open, threats: [] };
  const pairKeys = colors.length >= 2
    ? [COLORS.split('').filter((c) => colors.slice(0, 2).includes(c)).join('')]
    : COLORS.split('').filter((c) => c !== colors[0]).map((c) => COLORS.split('').filter((x) => x === c || x === colors[0]).join(''));
  const threats = [];
  for (const card of cardsById.values()) {
    const tl = card.typeLine ?? '';
    const instantSpeed = /\bInstant\b/.test(tl) || /\bFlash\b/.test(card.oracleText ?? '');
    if (!instantSpeed || card.cmc == null || card.cmc > open) continue;
    const cc = cardColors(card);
    if (![...cc].every((c) => colors.includes(c))) continue;
    const t = table?.cards?.[card.mtgaId];
    // Popularity: drawn-games in the opponent's likely pair(s); falls back to overall play count.
    const pop = t ? Math.max(...pairKeys.map((p) => t.pairs?.[p]?.[1] ?? 0), 0) || (t.gpN ?? 0) * 0.1 : (card.stats?.gameCount ?? 0) * 0.1;
    if (pop <= 0) continue;
    threats.push({ grpId: card.mtgaId, name: card.name, cmc: card.cmc, kind: category(card), popularity: pop, seen: snapshot.opp.seen.includes(card.mtgaId) });
  }
  threats.sort((a, b) => b.popularity - a.popularity);
  const total = threats.reduce((s, t) => s + t.popularity, 0) || 1;
  return {
    colors, open,
    threats: threats.slice(0, limit).map((t) => ({ ...t, share: t.popularity / total })),
  };
}

// ─── Draw odds ───────────────────────────────────────────────────────────────

/**
 * What's left in your library: deck list minus every card of yours seen in
 * another zone. Cards that weren't in your deck (tokens, created copies) are
 * ignored. If Arena hid something (face-down exile), the counts are scaled to
 * the library size Arena reports.
 */
function drawOdds(snapshot, cardsById) {
  const remaining = new Map();
  for (const g of snapshot.deckCards) remaining.set(g, (remaining.get(g) ?? 0) + 1);
  for (const g of snapshot.me.known) {
    const n = remaining.get(g);
    if (n) remaining.set(g, n - 1);
  }
  // Lands: seen as a land this game, typed as one by 17Lands/Scryfall, or —
  // for deck cards 17Lands doesn't list at all — basic lands, which are the
  // only cards in a Limited deck missing from a set's 17Lands card list.
  const seenLands = new Set(snapshot.landGrpIds ?? []);
  let total = 0, lands = 0, removal = 0, creatures = 0;
  for (const [g, n] of remaining) {
    if (n <= 0) continue;
    const c = cardsById.get(g);
    total += n;
    const tl = c?.typeLine ?? '';
    const isLand = seenLands.has(g) || (c ? /\bLand\b/.test(tl) && !/\bCreature\b/.test(tl) : cardsById.size > 0);
    if (isLand) lands += n;
    else if (c && REMOVAL_RE.test(c.oracleText ?? '')) removal += n;
    if (/\bCreature\b/.test(tl)) creatures += n;
  }
  const library = snapshot.me.libraryCount || total;
  const scale = total > 0 ? library / total : 1;
  return {
    library,
    tracked: total, // cards our accounting says are left (before scaling to Arena's count)
    lands: Math.round(lands * scale),
    removal: Math.round(removal * scale),
    creatures: Math.round(creatures * scale),
    pLand: total ? lands / total : null,
    pRemoval: total ? removal / total : null,
  };
}

// ─── Race ────────────────────────────────────────────────────────────────────

/**
 * "Who's the beatdown?" (Mike Flores; a Limited Resources staple): how many
 * turns each side needs to win if every creature attacked unblocked. Crude by
 * design — no blocks, no tricks — but it tells you which side should race.
 */
function raceMath(snapshot) {
  const power = (list) => list.filter((c) => c.isCreature && (c.power ?? 0) > 0).reduce((s, c) => s + c.power, 0);
  const mine = power(snapshot.me.battlefield);
  const theirs = power(snapshot.opp.battlefield);
  const clock = (life, p) => (p > 0 && life != null ? Math.ceil(Math.max(0, life) / p) : null);
  const myClock = clock(snapshot.opp.life, mine);
  const oppClock = clock(snapshot.me.life, theirs);
  let beatdown = null;
  if (myClock != null && oppClock != null) beatdown = myClock < oppClock ? 'you' : myClock > oppClock ? 'them' : 'even';
  else if (myClock != null) beatdown = 'you';
  else if (oppClock != null) beatdown = 'them';
  return { myPower: mine, oppPower: theirs, myClock, oppClock, beatdown };
}

/** Everything the overlay shows for the current game state. */
function analyzeGame(snapshot, cardsById, table) {
  if (!snapshot) return null;
  return {
    turn: snapshot.turn,
    myTurn: snapshot.myTurn,
    onPlay: snapshot.onPlay,
    life: { me: snapshot.me.life, opp: snapshot.opp.life },
    result: snapshot.result,
    playDraw: playDrawAdvice(snapshot, table),
    mulligan: mulliganAdvice(snapshot, table),
    race: raceMath(snapshot),
    opponent: { ...opponentThreats(snapshot, cardsById, table), handCount: snapshot.opp.handCount },
    draws: drawOdds(snapshot, cardsById),
  };
}

module.exports = { analyzeGame, mulliganAdvice, playDrawAdvice, raceMath, opponentThreats, drawOdds, opponentColors, PRIOR };
