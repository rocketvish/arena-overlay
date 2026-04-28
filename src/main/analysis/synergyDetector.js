/**
 * synergyDetector.js — heuristic Tier 3 synergy detector.
 *
 * Scans the picked pile for repeated themes (creature types, keywords,
 * mechanics) and rewards pack cards that reinforce those themes.
 *
 * Pure function: no I/O, no module-level state. Output is a list of
 * per-card synergy scores plus a deck-wide theme map.
 */

'use strict';

// ── Theme detectors ──────────────────────────────────────────────────────────
// Each theme is a (name, predicate) where predicate(card) returns truthy if
// the card "cares about" the theme (typically by oracle text or type line).

const TRIBES = [
  'Goblin','Elf','Zombie','Vampire','Wizard','Soldier','Knight','Spirit','Merfolk',
  'Cat','Dog','Dragon','Angel','Demon','Bird','Beast','Human','Warrior','Rogue',
  'Cleric','Pirate','Dinosaur','Faerie','Treefolk','Rat','Ninja','Sliver','Construct',
];

const KEYWORDS = [
  'flying','deathtouch','lifelink','vigilance','trample','first strike','double strike',
  'haste','reach','menace','hexproof','indestructible','flash','prowess','ward',
];

const MECHANIC_THEMES = [
  { id: 'tokens',      cares: /\b(create[s]?|sacrifice).*\btoken\b|\btoken[s]?\b.*you control|\bamass\b/i,
                       has:   /\bcreate[s]? .* token\b|\bamass\b/i },
  { id: 'sacrifice',   cares: /\bwhenever .* (sacrificed|dies)|sacrifice (a|another)|sacrifice a creature\b/i,
                       has:   /\bsacrifice (a|another)\b/i },
  { id: 'artifacts',   cares: /\bartifact (you control|spell|enters)|\bmetalcraft\b|\baffinity for artifacts\b/i,
                       has:   /\bArtifact\b/i, typeMatch: true },
  { id: 'graveyard',   cares: /\bfrom (your )?graveyard\b|\bdelve\b|\bescape\b|\bunearth\b|\bflashback\b|\bdisturb\b/i,
                       has:   /\bgraveyard\b|\bmill\b|\bdiscard\b/i },
  { id: 'lifegain',    cares: /\bwhenever you gain life\b|\blifegain\b/i,
                       has:   /\bgain \d+ life\b|\blifelink\b/i },
  { id: 'plus_counters', cares: /\b\+1\/\+1 counter\b/i,
                         has:   /\+1\/\+1 counter/i },
  { id: 'spells_matter', cares: /\bwhenever you cast (an instant|a sorcery|a noncreature)\b|\bprowess\b|\bmagecraft\b/i,
                         has:   /\bInstant\b|\bSorcery\b/i, typeMatch: true },
  { id: 'mutate',      cares: /\bmutate\b/i,                  has: /\bmutate\b/i },
  { id: 'adventure',   cares: /\bAdventure\b/i,               has: /\bAdventure\b/i, typeMatch: true },
  { id: 'party',       cares: /\bparty\b/i,                   has: /\b(Cleric|Rogue|Warrior|Wizard)\b/i, typeMatch: true },
  { id: 'value_engine', cares: /\b(draw a card|investigate|surveil \d|scry \d|create .* clue|create .* food)\b/i,
                         has:   /\b(when .* enters the battlefield|enters the battlefield)\b.*(draw|create|investigate|surveil)/i },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function cardOracle(card) {
  return (card.oracleText ?? '').toString();
}
function cardTypeLine(card) {
  return (card.typeLine ?? '').toString();
}

function creatureTypesOf(card) {
  const tl = cardTypeLine(card);
  if (!/\bCreature\b/i.test(tl)) return [];
  // The post-em-dash portion of "Creature — Goblin Warrior"
  const dashIdx = tl.indexOf('—');
  const subtypes = dashIdx >= 0 ? tl.slice(dashIdx + 1).trim().split(/\s+/) : [];
  return TRIBES.filter(t => subtypes.includes(t));
}

function keywordsOf(card) {
  const ot = cardOracle(card).toLowerCase();
  return KEYWORDS.filter(k => ot.includes(k));
}

function mechanicsOf(card) {
  const ot = cardOracle(card);
  const tl = cardTypeLine(card);
  return MECHANIC_THEMES.filter(m => {
    if (m.cares.test(ot)) return true;
    if (m.has?.test(m.typeMatch ? tl : ot)) return true;
    return false;
  }).map(m => m.id);
}

// ── Theme aggregation ────────────────────────────────────────────────────────
function buildDeckThemes(pickedCards) {
  const tribes = {};      // 'Goblin' → count
  const keywords = {};    // 'flying' → count
  const mechanics = {};   // 'sacrifice' → count

  for (const card of pickedCards) {
    for (const t of creatureTypesOf(card)) tribes[t] = (tribes[t] ?? 0) + 1;
    for (const k of keywordsOf(card))      keywords[k] = (keywords[k] ?? 0) + 1;
    for (const m of mechanicsOf(card))     mechanics[m] = (mechanics[m] ?? 0) + 1;
  }

  return { tribes, keywords, mechanics };
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Score each pack card's synergy with the picked pile.
 *
 * @param {object[]} pickedCards
 * @param {object[]} packCards
 * @returns {{ synergies: Array<{grpId, score, reason, themes}>, themes: object }}
 */
function analyzeSynergies(pickedCards, packCards) {
  if (!pickedCards || !packCards) return { synergies: [], themes: { tribes: {}, keywords: {}, mechanics: {} } };

  const themes = buildDeckThemes(pickedCards);
  const synergies = [];

  for (const card of packCards) {
    const cardTribes = creatureTypesOf(card);
    const cardKeywords = keywordsOf(card);
    const cardMechanics = mechanicsOf(card);

    let score = 0;
    const reasons = [];
    const matchedThemes = [];

    // Tribal: 3+ creatures of the same type → boost other creatures of that type.
    for (const t of cardTribes) {
      const tribeCount = themes.tribes[t] ?? 0;
      if (tribeCount >= 3) {
        score += 0.4;
        reasons.push(`works with your ${tribeCount} other ${t}${tribeCount !== 1 ? 's' : ''}`);
        matchedThemes.push(`tribe:${t}`);
      } else if (tribeCount >= 1) {
        score += 0.15;
        matchedThemes.push(`tribe:${t}`);
      }
    }

    // Keyword stacking: 2+ cards sharing a keyword boosts cards with that keyword.
    for (const k of cardKeywords) {
      const count = themes.keywords[k] ?? 0;
      if (count >= 2) {
        score += 0.25;
        reasons.push(`stacks ${k} with ${count} other card${count !== 1 ? 's' : ''}`);
        matchedThemes.push(`kw:${k}`);
      }
    }

    // Mechanic synergies: detect strong combos.
    const mechSet = new Set(Object.keys(themes.mechanics).filter(m => themes.mechanics[m] >= 2));
    for (const m of cardMechanics) {
      const count = themes.mechanics[m] ?? 0;
      if (count >= 2) {
        score += 0.30;
        reasons.push(`reinforces ${m.replace('_', ' ')} theme (${count} cards)`);
        matchedThemes.push(`mech:${m}`);
      }
    }
    // Specific combo detection: tokens × sacrifice, value-engine × ETB
    if (mechSet.has('tokens') && cardMechanics.includes('sacrifice')) {
      score += 0.25;
      reasons.push('sacrifice outlet for your token theme');
      matchedThemes.push('combo:tokens+sacrifice');
    }
    if (mechSet.has('sacrifice') && cardMechanics.includes('tokens')) {
      score += 0.25;
      reasons.push('token generator for your sacrifice theme');
      matchedThemes.push('combo:tokens+sacrifice');
    }
    if (mechSet.has('value_engine') && /enters the battlefield/i.test(cardOracle(card))) {
      score += 0.15;
      reasons.push('extends your ETB value engine');
      matchedThemes.push('combo:value_etb');
    }

    // Cap raw score at 1.0
    score = Math.min(1.0, score);

    if (score > 0) {
      synergies.push({
        grpId: card.grpId,
        score,
        reason: reasons[0] ?? null, // surface the strongest single reason
        allReasons: reasons,
        themes: matchedThemes,
      });
    }
  }

  return { synergies, themes };
}

module.exports = { analyzeSynergies, buildDeckThemes };
