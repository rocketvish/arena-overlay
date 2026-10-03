#!/usr/bin/env node
/**
 * test-draft.js — CLI pipeline test for the last draft in Player.log.
 *
 * Runs without Electron. Parses the log, fetches 17Lands data, runs the
 * full assistant analysis pipeline, and prints a detailed report.
 *
 * Usage:  node scripts/test-draft.js [path/to/Player.log]
 *   or:   npm run test:draft
 */

'use strict';

// Make main-process modules loadable outside Electron. This dev tool reads and
// writes the real app cache (the same files the app uses) unless
// ARENA_OVERLAY_USERDATA points elsewhere.
process.env.ARENA_OVERLAY_USERDATA = process.env.ARENA_OVERLAY_USERDATA
  ?? require('path').join(require('os').homedir(), 'AppData', 'Roaming', 'arena-overlay');
require('./lib/electronShim');

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// After the shim, require app modules
const logParser      = require('../src/main/logParser');
const landsData      = require('../src/main/17landsData');
const signalAnalyzer = require('../src/main/signalAnalyzer');
const draftTracker   = require('../src/main/draftTracker');
const { splitLogChunk } = require('../src/main/logWatcher');

// ── Color helpers ─────────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE   = '\x1b[34m';
const MAGENTA= '\x1b[35m';
const CYAN   = '\x1b[36m';
const WHITE  = '\x1b[37m';
const ORANGE = '\x1b[38;5;208m';

function color(c, s) { return `${c}${s}${RESET}`; }
function bold(s)  { return `${BOLD}${s}${RESET}`; }
function dim(s)   { return `${DIM}${s}${RESET}`; }
function hr(char = '─', len = 70) { return char.repeat(len); }

const GRADE_COLOR = {
  'A+': GREEN, 'A': GREEN, 'A-': GREEN,
  'B+': CYAN,  'B': CYAN,  'B-': CYAN,
  'C+': YELLOW,'C': YELLOW,'C-': YELLOW,
  'D+': ORANGE,'D': ORANGE,'D-': ORANGE,
  'F':  RED,
};
function gradeStr(g) {
  if (!g) return dim('  —');
  return color(GRADE_COLOR[g] ?? WHITE, g.padStart(2));
}

const COLOR_SYMBOL = { W: color(YELLOW,'W'), U: color(BLUE,'U'), B: color(MAGENTA,'B'), R: color(RED,'R'), G: color(GREEN,'G') };
function colorStr(c) {
  return (c ?? '').replace(/[^WUBRG]/g,'').split('').map(ch => COLOR_SYMBOL[ch] ?? ch).join('') || dim('—');
}

const SIGNAL_COLORS = {
  'Wide Open': GREEN, 'Open': GREEN,
  'Contested': YELLOW,
  'Cut Off': RED, 'Hard Cut': RED,
};
function signalStr(label, score) {
  const c = SIGNAL_COLORS[label] ?? WHITE;
  return `${color(c, label.padEnd(11))} ${dim(`(${score})`)}`;
}

// ── Log path detection ────────────────────────────────────────────────────────
function defaultLogPath() {
  const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(path.dirname(appdata), 'LocalLow', 'Wizards Of The Coast', 'MTGA', 'Player.log');
}

function getLogPath() {
  const arg = process.argv[2];
  if (arg) return arg;
  // Try to read from settings
  try {
    const settingsPath = path.join(os.homedir(), 'AppData', 'Roaming', 'arena-overlay', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const raw = s?.general?.arenaLogPath;
      if (raw) {
        return raw
          .replace('%APPDATA%', process.env.APPDATA ?? '')
          .replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA ?? '')
          .replace(/\//g, path.sep);
      }
    }
  } catch {}
  return defaultLogPath();
}

// ── Log parsing ───────────────────────────────────────────────────────────────
function extractDraftEvents(logContent) {
  // Same line splitting as the live watcher (Player.log is CRLF).
  const { lines, carry } = splitLogChunk('', logContent);
  if (carry) lines.push(carry);
  const events = [];
  const collector = (ch, data) => events.push({ channel: ch, data: JSON.parse(JSON.stringify(data)) });

  logParser.reset();
  logParser.setBroadcast(collector);
  for (const line of lines) {
    if (line.trim()) logParser.parseLine(line, collector);
  }
  logParser.reset();
  return events;
}

function findLastCompleteDraft(events) {
  const starts = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].channel === 'draft-started') starts.push(i);
  }
  if (starts.length === 0) return null;

  for (let si = starts.length - 1; si >= 0; si--) {
    const start = starts[si];
    const end   = si + 1 < starts.length ? starts[si + 1] : events.length;
    const slice = events.slice(start, end);
    if (slice.filter(e => e.channel === 'pack-opened').length >= 15) return slice;
  }
  // Fall back to most recent with any packs
  const last = events.slice(starts[starts.length - 1]);
  return last.filter(e => e.channel === 'pack-opened').length > 0 ? last : null;
}

// ── Enrichment ────────────────────────────────────────────────────────────────
async function buildLandsMap(setCode, format) {
  process.stdout.write(`  Fetching 17Lands data for ${setCode} ${format}... `);
  try {
    const result = await landsData.fetchSetData(setCode, format);
    if (result?.data) {
      const map = new Map();
      for (const card of result.data) {
        if (card.mtgaId != null) map.set(card.mtgaId, card);
      }
      console.log(color(GREEN, `${result.data.length} cards (${result.fromCache ? 'cached' : 'fetched'})`));
      return { map, data: result.data };
    }
  } catch (e) {
    console.log(color(RED, `Error: ${e.message}`));
  }
  console.log(color(YELLOW, 'No data'));
  return { map: new Map(), data: [] };
}

function enrichCard(rawCard, landsMap) {
  const lands = landsMap.get(rawCard.grpId) ?? null;
  const scry  = landsData.getScryfallCardData(rawCard.grpId) ?? {};
  return {
    grpId:      rawCard.grpId,
    name:       lands?.name ?? scry.name ?? rawCard.name ?? null,
    color:      lands?.color ?? scry.colorIdentity ?? '',
    rarity:     lands?.rarity ?? scry.rarity ?? 'common',
    cmc:        lands?.cmc ?? scry.cmc ?? null,
    typeLine:   lands?.typeLine || scry.typeLine || '',
    oracleText: lands?.oracleText || scry.oracleText || '',
    stats:      lands?.stats ?? null,
    _matched:   lands != null,
    _hasStats:  lands?.stats?.gihwr != null || lands?.stats?.grade != null,
    _estimated: !!lands?.stats?.gradeEstimated,
  };
}

// ── Report sections ───────────────────────────────────────────────────────────
function printPackReport(packEvents, landsMap, trackerState, assistantSettings, pickEvents) {
  // Build a lookup of grpId → pick event for this draft
  const pickByPack = new Map();
  for (const pe of pickEvents) {
    const key = `${pe.data.packNumber}:${pe.data.pickNumber}`;
    pickByPack.set(key, pe.data);
  }

  let globalPickSeq = 0;
  for (const packEvent of packEvents) {
    const { packNumber, pickNumber, cards } = packEvent.data;
    globalPickSeq++;

    const enriched = cards.map(c => enrichCard(c, landsMap));
    const pickKey  = `${packNumber}:${pickNumber}`;
    const pickData = pickByPack.get(pickKey);
    const pickedId = pickData?.grpId ?? null;

    console.log(`\n${bold(`Pack ${packNumber + 1} · Pick ${pickNumber + 1}`)}  ${dim(`(seq #${globalPickSeq})`)}`);
    console.log(hr('─', 60));

    // Record in tracker for analysis
    draftTracker.recordPackSeen({ packNumber, pickNumber, cards: enriched });

    // Compute recommendation at this pick
    const ts    = draftTracker.getState();
    const anal  = signalAnalyzer.analyze(ts, enriched, { packNumber, pickNumber, packSize: packEvent.data.packSize }, assistantSettings);
    const rec   = anal.recommendation;

    // Print card table
    const noMatch   = [];
    const noStats   = [];
    const duplicateIds = new Set();
    const seenIds   = new Set();

    console.log(`  ${'GRD'.padEnd(4)} ${'GIH%'.padEnd(7)} ${'COLOR'.padEnd(6)} ${'RARITY'.padEnd(9)} CARD`);
    console.log(`  ${dim(hr('·', 55))}`);

    for (const card of enriched) {
      const isRec     = rec?.primary?.grpId === card.grpId;
      const isPicked  = pickedId === card.grpId;
      const grade     = card.stats?.grade ?? null;
      const gihwr     = card.stats?.gihwr;
      const gihStr    = gihwr != null ? `${(gihwr * 100).toFixed(1)}%`
        : card._estimated ? dim(`~${(card.stats.gihwrEst ?? card.stats.gpwr) * 100 | 0}%e`)
        : (card._hasStats ? dim('  —  ') : dim('N/A  '));
      const nameStr   = card.name ?? color(RED, `#${card.grpId}`);
      const prefix    = isRec ? color(GREEN, '★') : (isPicked ? color(CYAN, '→') : ' ');
      const suffix    = isPicked ? color(CYAN, ' ← PICKED') : (isRec ? color(GREEN, ' ← REC') : '');

      console.log(`  ${prefix} ${gradeStr(grade).padEnd(4)} ${gihStr.padEnd(7)} ${colorStr(card.color).padEnd(6)} ${(card.rarity ?? '').padEnd(9)} ${nameStr}${suffix}`);

      if (!card._matched) noMatch.push(card.grpId);
      else if (!card._hasStats) noStats.push(card.name ?? `#${card.grpId}`);
      if (seenIds.has(card.grpId)) duplicateIds.add(card.grpId);
      else seenIds.add(card.grpId);
    }

    // Warnings
    if (noMatch.length > 0) {
      console.log(`  ${color(RED, `⚠ ${noMatch.length} card(s) not found in 17Lands:`)} ${noMatch.join(', ')}`);
    }
    if (noStats.length > 0) {
      const shown = noStats.slice(0, 5);
      console.log(`  ${color(YELLOW, `○ ${noStats.length} card(s) matched but no GIH% data:`)} ${shown.join(', ')}${noStats.length > 5 ? ` +${noStats.length - 5} more` : ''}`);
    }
    if (duplicateIds.size > 0) {
      console.log(`  ${color(RED, `⚠ Duplicate card IDs in pack:`)} ${[...duplicateIds].join(', ')}`);
    }

    // Recommendation — show multi-option picks if available (Section 3)
    if (rec?.picks && rec.picks.length > 0) {
      const ICONS = { safe: color(BLUE, '★ SAFE  '), upside: color(YELLOW, '⚡ UPSIDE'), need: color(ORANGE, '🔧 NEED  '), clear: color(GREEN, '★ CLEAR '), wheel: color(MAGENTA, '⟲ WHEEL ') };
      for (const p of rec.picks) {
        const tag = ICONS[p.kind] ?? '  ';
        const name = p.card?.name ?? `#${p.card?.grpId}`;
        console.log(`  ${tag}: ${bold(name)} — ${p.reason}`);
      }
    } else if (rec?.primary) {
      console.log(`  ${color(GREEN,'Rec:')} ${bold(rec.primary.name ?? `#${rec.primary.grpId}`)} — ${rec.explanation}`);
      if (rec.secondary) console.log(`  ${color(CYAN,'Alt:')} ${rec.secondary.name ?? `#${rec.secondary.grpId}`}`);
    }

    // Late-pack signal insights (Section 4)
    if (anal.signalInsights && anal.signalInsights.length > 0) {
      for (const ins of anal.signalInsights.slice(0, 2)) {
        const c = ins.tone === 'flowing' ? GREEN : ins.tone === 'cut' ? RED : WHITE;
        console.log(`  ${color(c, '◈')} ${color(c, ins.short)}`);
      }
    }

    // Record the pick — look up by ID in landsMap so it works even when the
    // picked card isn't in the current pack snapshot (off-by-one pickNumber).
    if (pickedId != null) {
      const pickedCard = enriched.find(c => c.grpId === pickedId)
        ?? enrichCard({ grpId: pickedId }, landsMap);
      draftTracker.recordPick({
        packNumber, pickNumber, grpId: pickedId,
        enrichedCard: pickedCard,
        recommendation: rec,
      });
    }
  }
}

function printColorSignals(colorSignals) {
  console.log(`\n${bold('COLOR SIGNALS')}`);
  console.log(hr());
  for (const [color_key, sig] of Object.entries(colorSignals)) {
    const bar = '█'.repeat(Math.round(sig.score / 5)).padEnd(20, '░');
    const col = COLOR_SYMBOL[color_key] ?? color_key;
    console.log(`  ${col}  ${signalStr(sig.label, sig.score)}  ${dim(bar)}  ${dim(sig.evidence)}`);
  }
}

function printDeckAnalysis(composition, manaAnalysis, deckNeeds, strengths, weaknesses) {
  console.log(`\n${bold('DECK COMPOSITION')}`);
  console.log(hr());
  const { creatures, nonCreatures, removalCount, cardAdvantageCount, fixingCount, curve, colorCounts, totalPicked } = composition;
  console.log(`  Total picked:    ${totalPicked}`);
  console.log(`  Creatures:       ${creatures}  (target ~${Math.round((creatures + nonCreatures) * 0.65)})`);
  console.log(`  Non-creatures:   ${nonCreatures}`);
  console.log(`  Removal:         ${removalCount >= 3 ? color(GREEN, removalCount) : color(YELLOW, removalCount)} / 3 recommended`);
  console.log(`  Card advantage:  ${cardAdvantageCount}`);
  console.log(`  Fixing:          ${fixingCount}`);
  console.log(`  Colors: ${Object.entries(colorCounts).filter(([,v])=>v>0).map(([c,v])=>`${colorStr(c)}:${v}`).join('  ')}`);

  // Curve
  const curveStr = [1,2,3,4,5,6].map(k => {
    const v = curve[k] ?? 0;
    const label = k === 6 ? '6+' : String(k);
    return `${label}:${v}`;
  }).join('  ');
  console.log(`  Curve:  ${curveStr}`);

  console.log(`\n  Mana: ${manaAnalysis.assessment === 'ok' ? color(GREEN, manaAnalysis.message) : manaAnalysis.assessment === 'warning' ? color(YELLOW, manaAnalysis.message) : color(RED, manaAnalysis.message)}`);

  if (strengths.length > 0) {
    console.log(`\n${bold('STRENGTHS')}`);
    strengths.forEach(s => console.log(`  ${color(GREEN,'✓')} ${s}`));
  }
  if (weaknesses.length > 0) {
    console.log(`\n${bold('WEAKNESSES')}`);
    weaknesses.forEach(w => console.log(`  ${color(YELLOW,'△')} ${w}`));
  }
  if (deckNeeds.length > 0) {
    console.log(`\n${bold('DECK NEEDS')}`);
    deckNeeds.forEach(n => {
      const c = n.priority === 'high' ? RED : YELLOW;
      console.log(`  ${color(c, n.priority.toUpperCase().padEnd(7))} ${n.label} — ${n.detail}`);
    });
  }
}

// ── Tier 3 summary (Section 6) ────────────────────────────────────────────────
function printTier3(state) {
  console.log(`\n${bold('TIER 3 — SYNERGY / ARCHETYPE / WIN CONDITION')}`);
  console.log(hr());

  // Archetype
  const arc = state.archetype;
  if (arc?.primary) {
    console.log(`  ${bold('Archetype:')} ${color(CYAN, arc.label ?? arc.primary)}  ${dim(`(confidence ${(arc.confidence * 100).toFixed(0)}%)`)}`);
    if (arc.fits) {
      const fits = Object.entries(arc.fits).sort(([,a],[,b]) => b - a)
        .map(([k, v]) => `${k}:${(v * 100).toFixed(0)}`).join('  ');
      console.log(`  ${dim('Fits:')} ${fits}`);
    }
  } else {
    console.log(`  ${dim('Archetype: not enough data')}`);
  }

  // Deck grade
  if (state.deckGrade) {
    console.log(`  ${bold('Deck grade:')} ${color(GREEN, state.deckGrade.grade)}  ${dim(`(avg ${(state.deckGrade.avgGihwr * 100).toFixed(1)}% from ${state.deckGrade.sampleSize} cards)`)}`);
  }

  // Win conditions
  const wc = state.winConditions;
  if (wc) {
    console.log(`  ${bold('Win plan:')} ${wc.message}`);
    if (wc.bombs && wc.bombs.length > 0) {
      const bombList = wc.bombs.map(b => `${b.name} (${b.grade})`).join(', ');
      console.log(`  ${dim('Bombs:')} ${color(YELLOW, bombList)}`);
    }
    if (wc.types && wc.types.length > 0) {
      console.log(`  ${dim('Types:')} ${wc.types.join(', ')}`);
    }
  }

  // Synergy themes
  const themes = state.synergyThemes;
  if (themes) {
    const tribes = Object.entries(themes.tribes ?? {}).filter(([, v]) => v >= 2)
      .sort(([,a],[,b]) => b - a).map(([k, v]) => `${k}(${v})`);
    const mechs  = Object.entries(themes.mechanics ?? {}).filter(([, v]) => v >= 2)
      .sort(([,a],[,b]) => b - a).map(([k, v]) => `${k}(${v})`);
    if (tribes.length > 0) console.log(`  ${dim('Tribes (≥2):')} ${color(MAGENTA, tribes.join(', '))}`);
    if (mechs.length > 0)  console.log(`  ${dim('Mechanics (≥2):')} ${color(CYAN, mechs.join(', '))}`);
    if (tribes.length === 0 && mechs.length === 0) console.log(`  ${dim('Synergies: no repeated themes detected yet')}`);
  }
}

function printPickHistory(pickHistory) {
  console.log(`\n${bold('PICK HISTORY')}`);
  console.log(hr());
  console.log(`  ${'#'.padEnd(4)} ${'PACK·PICK'.padEnd(10)} ${'GRD'.padEnd(4)} ${'COLOR'.padEnd(6)} ${'REC?'.padEnd(5)} CARD`);
  console.log(`  ${dim(hr('·', 60))}`);
  for (const p of pickHistory) {
    const pickPos  = `P${p.packNumber + 1}·${p.pickNumber + 1}`;
    const aligned  = p.alignedWithRec ? color(GREEN, 'yes') : (p.recommendation ? color(YELLOW, 'no ') : dim(' — '));
    const diffNote = (!p.alignedWithRec && p.recommendation) ? dim(` (rec: ${p.recommendation})`) : '';
    console.log(`  ${String(p.seqNum).padEnd(4)} ${pickPos.padEnd(10)} ${gradeStr(p.grade).padEnd(4)} ${colorStr(p.color).padEnd(6)} ${aligned.padEnd(5)} ${p.name}${diffNote}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${bold('Arena Overlay — Draft Pipeline Test')}`);
  console.log(hr('═'));

  const logPath = getLogPath();
  console.log(`Log: ${logPath}`);

  if (!fs.existsSync(logPath)) {
    console.error(color(RED, `\nError: Log file not found at ${logPath}`));
    console.error('Pass the path as an argument: node scripts/test-draft.js /path/to/Player.log');
    process.exit(1);
  }

  const stat = fs.statSync(logPath);
  console.log(`Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB  Modified: ${stat.mtime.toLocaleString()}`);

  // Parse log
  process.stdout.write('Parsing log... ');
  const logContent = fs.readFileSync(logPath, 'utf-8');
  const allEvents  = extractDraftEvents(logContent);
  const draftEvents = findLastCompleteDraft(allEvents);

  const draftCount = allEvents.filter(e => e.channel === 'draft-started').length;
  console.log(color(GREEN, `${allEvents.length} events from ${draftCount} draft(s)`));

  if (!draftEvents) {
    console.error(color(RED, '\nNo complete draft found in log.'));
    process.exit(1);
  }

  const startEv   = draftEvents[0];
  const packEvents = draftEvents.filter(e => e.channel === 'pack-opened');
  const pickEvents = draftEvents.filter(e => e.channel === 'card-picked');
  const { setCode, format } = startEv.data;

  console.log(`\nDraft: ${bold(setCode)} ${format} · ${packEvents.length} packs · ${pickEvents.length} picks`);
  console.log(hr('═'));

  // Fetch 17Lands
  const { map: landsMap, data: landsCards } = await buildLandsMap(setCode, format);

  // Compute set metrics for signal baseline
  const ratings = await landsData.fetchColorRatings(setCode).catch(() => null);
  const setMetrics = signalAnalyzer.computeSetMetrics(landsCards, ratings);
  if (setMetrics.pairs) {
    const top = Object.entries(setMetrics.pairs).sort((a, b) => b[1].wr - a[1].wr).slice(0, 3)
      .map(([p, v]) => `${p} ${(v.wr * 100).toFixed(1)}% (${v.cohort})`).join(', ');
    console.log(`  Best archetypes: ${top}`);
  }
  console.log(`  Set avg GIH%: ${setMetrics.meanGihwr > 0 ? `${(setMetrics.meanGihwr*100).toFixed(1)}%` : 'N/A'}  Total cards: ${setMetrics.totalCards}`);

  // Init tracker
  draftTracker.reset();
  draftTracker.setInfo(setCode, format);
  draftTracker.setSetMetrics(setMetrics);

  const assistantSettings = {
    confidenceThreshold: 4,
    draftStyle: 'balanced',
  };

  // ── Pack-by-pack report ────────────────────────────────────────────────────
  console.log(`\n${bold('PACK-BY-PACK REPORT')}`);
  console.log(hr('═'));
  printPackReport(packEvents, landsMap, draftTracker.getState(), assistantSettings, pickEvents);

  // ── Final analysis ─────────────────────────────────────────────────────────
  const lastPack = packEvents[packEvents.length - 1]?.data ?? {};
  const finalState = signalAnalyzer.analyze(draftTracker.getState(), null,
    { packNumber: lastPack.packNumber ?? 0, pickNumber: lastPack.pickNumber ?? 0, packSize: lastPack.packSize },
    assistantSettings);

  printColorSignals(finalState.colorSignals);
  printDeckAnalysis(
    finalState.deckComposition,
    finalState.manaAnalysis,
    finalState.deckNeeds,
    finalState.strengths,
    finalState.weaknesses,
  );
  printTier3(finalState);
  printPickHistory(finalState.pickHistory);

  // ── Summary stats ──────────────────────────────────────────────────────────
  const allEnriched  = packEvents.flatMap(pe => pe.data.cards.map(c => enrichCard(c, landsMap)));
  const uniqIds      = new Set(allEnriched.map(c => c.grpId));
  const matched      = [...uniqIds].filter(id => landsMap.has(id)).length;
  const unmatched    = [...uniqIds].filter(id => !landsMap.has(id)).length;
  const withStats    = [...uniqIds].filter(id => {
    const c = landsMap.get(id);
    return c?.stats?.gihwr != null || c?.stats?.grade != null;
  }).length;
  const diffFromRec  = finalState.pickHistory.filter(p => !p.alignedWithRec && p.recommendation).length;

  console.log(`\n${bold('SUMMARY')}`);
  console.log(hr('═'));
  console.log(`  Unique card IDs seen:  ${uniqIds.size}`);
  console.log(`  Matched in 17Lands:    ${color(matched === uniqIds.size ? GREEN : YELLOW, matched)} / ${uniqIds.size}`);
  console.log(`  Cards with GIH% data:  ${withStats}`);
  console.log(`  Unresolved IDs:        ${unmatched > 0 ? color(RED, unmatched) : color(GREEN, unmatched)}`);
  console.log(`  Picks off recommendation: ${diffFromRec} / ${pickEvents.length}`);
  console.log();
}

main().catch(err => {
  console.error(color(RED, `\nFatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
