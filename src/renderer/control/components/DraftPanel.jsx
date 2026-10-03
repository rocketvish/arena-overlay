import React, { useMemo } from 'react';
import CardRow from '../../components/CardRow';
import ColorFilter from '../../components/ColorFilter';

// ── Sorting ───────────────────────────────────────────────────────────────────
const GRADE_ORDER = ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F'];
const COLOR_ORDER = { W: 0, U: 1, B: 2, R: 3, G: 4 };

function colorSortKey(color) {
  if (!color) return 9;
  if (color.length > 1) return 8;
  return COLOR_ORDER[color[0]] ?? 9;
}

function sortCards(cards, sortBy) {
  return [...cards].sort((a, b) => {
    switch (sortBy) {
      case 'grade': {
        const ai = GRADE_ORDER.indexOf(a.stats?.grade ?? '');
        const bi = GRADE_ORDER.indexOf(b.stats?.grade ?? '');
        return (ai === -1 ? GRADE_ORDER.length : ai) - (bi === -1 ? GRADE_ORDER.length : bi);
      }
      case 'gihwr': return (b.stats?.gihwr ?? -1) - (a.stats?.gihwr ?? -1);
      case 'ohwr':  return (b.stats?.ohwr  ?? -1) - (a.stats?.ohwr  ?? -1);
      case 'color': return colorSortKey(a.color) - colorSortKey(b.color);
      case 'name':  return (a.name ?? '').localeCompare(b.name ?? '');
      default: return 0;
    }
  });
}

const COLOR_CHARS = new Set(['W','U','B','R','G']);

function cardMatchesFilter(card, colorFilter) {
  if (!colorFilter || colorFilter === 'all') return true;
  const cardColor = (card.color ?? '').replace(/[^WUBRG]/g, '');
  if (cardColor.length === 0) return true; // colorless — always shown
  return [...colorFilter].some((c) => COLOR_CHARS.has(c) && cardColor.includes(c));
}

// ── Grade colors ──────────────────────────────────────────────────────────────
const GRADE_COLORS = {
  'A+': '#32c850', 'A': '#32c850', 'A-': '#50d264',
  'B+': '#28aadc', 'B': '#28aadc', 'B-': '#3cb4c8',
  'C+': '#dcc832', 'C': '#d2b928', 'C-': '#c8a51e',
  'D+': '#e6823c', 'D': '#dc6e32', 'D-': '#d25a28',
  'F': '#c83232',
};

function pct(v) { return v != null ? `${(v * 100).toFixed(1)}%` : '—'; }

function RecommendedCard({ card, label, primary }) {
  if (!card) return null;
  const grade = card.stats?.grade;
  const gradeColor = grade ? (GRADE_COLORS[grade] ?? '#888') : '#888';
  return (
    <div style={{
      background: primary ? 'rgba(80,200,120,0.10)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${primary ? 'rgba(80,200,120,0.3)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 6, padding: '10px 14px',
    }}>
      <div style={{ fontSize: 10, color: '#555', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {grade && (
          <span style={{ fontSize: 20, fontWeight: 700, color: gradeColor, minWidth: 36, textAlign: 'center' }}>
            {grade}
          </span>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e8e8e8' }}>
            {card.name ?? `#${card.grpId}`}
          </div>
          <div style={{ fontSize: 11, color: '#666', marginTop: 2, fontFamily: 'monospace' }}>
            GIH {pct(card.stats?.gihwr)}
            {card.stats?.ohwr != null && <span style={{ marginLeft: 8, color: '#555' }}>OH {pct(card.stats.ohwr)}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Multi-pick recommendations (Section 3) ────────────────────────────────────
const PICK_KIND_META = {
  safe:   { icon: '★', color: '#7ec8ff', label: 'Safe',   bg: 'rgba(92,200,255,0.10)', border: 'rgba(92,200,255,0.32)' },
  upside: { icon: '⚡', color: '#ffce5c', label: 'Upside', bg: 'rgba(255,206,92,0.10)', border: 'rgba(255,206,92,0.32)' },
  need:   { icon: '🔧', color: '#e88c64', label: 'Need',   bg: 'rgba(232,140,100,0.10)', border: 'rgba(232,140,100,0.32)' },
  clear:  { icon: '★', color: '#7ec8a0', label: 'Clear pick', bg: 'rgba(126,200,160,0.12)', border: 'rgba(126,200,160,0.34)' },
  wheel:  { icon: '⟲', color: '#c89cff', label: 'Wheel play', bg: 'rgba(200,156,255,0.10)', border: 'rgba(200,156,255,0.32)' },
};

function PickOptionCard({ pick }) {
  const meta = PICK_KIND_META[pick.kind] ?? PICK_KIND_META.safe;
  const card = pick.card;
  const grade = card?.stats?.grade;
  const gradeColor = grade ? (GRADE_COLORS[grade] ?? '#888') : '#888';
  return (
    <div style={{
      background: meta.bg,
      border: `1px solid ${meta.border}`,
      borderRadius: 6, padding: '8px 12px',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span style={{ fontSize: 16, color: meta.color, flexShrink: 0, width: 18, textAlign: 'center' }}>
        {meta.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 10, color: meta.color, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {meta.label}
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {card?.name ?? `#${card?.grpId ?? '?'}`}
          </span>
          {grade && (
            <span style={{ fontSize: 11, fontWeight: 700, color: gradeColor, marginLeft: 'auto', flexShrink: 0 }}
                  title={card?.stats?.gradeEstimated ? 'Estimated: 17Lands withholds GIH% under 500 games' : undefined}>
              {card?.stats?.gradeEstimated ? `~${grade}` : grade}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#aaa', marginTop: 2, lineHeight: 1.35 }}>
          {pick.reasonLong ?? pick.reason}
        </div>
      </div>
    </div>
  );
}

function PicksPanel({ picks }) {
  if (!picks || picks.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {picks.map((p, i) => <PickOptionCard key={i} pick={p} />)}
    </div>
  );
}

// ── Deck Stats panel (Section 5) ──────────────────────────────────────────────
const COLOR_HEX_DECK   = { W: '#f5e664', U: '#50a0ff', B: '#b090e0', R: '#f06464', G: '#50b95a' };
const COLOR_LABEL_DECK = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

function ProgressBar({ value, target, color, height = 6 }) {
  const pct = Math.min(100, Math.round((value / target) * 100));
  return (
    <div style={{ height, background: 'rgba(255,255,255,0.08)', borderRadius: height / 2, overflow: 'hidden' }}>
      <div style={{
        width: `${pct}%`, height: '100%',
        background: color, borderRadius: height / 2,
        transition: 'width 0.4s ease',
      }} />
    </div>
  );
}

function ManaCurveChartLarge({ curve }) {
  if (!curve) return null;
  const entries = [1, 2, 3, 4, 5, 6].map(k => ({ cmc: k === 6 ? '6+' : String(k), count: curve[k] ?? 0 }));
  const max = Math.max(1, ...entries.map(e => e.count));
  const HEIGHT = 150;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: HEIGHT }}>
        {entries.map(({ cmc, count }) => {
          const barH = count > 0 ? Math.max(8, Math.round((count / max) * (HEIGHT - 24))) : 4;
          return (
            <div key={cmc} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
              <div style={{ fontSize: 12, color: '#fff', fontFamily: 'monospace', fontWeight: 700, height: 16 }}>
                {count > 0 ? count : ''}
              </div>
              <div style={{
                width: '100%',
                height: barH,
                background: count > 0
                  ? 'linear-gradient(180deg, rgba(120,170,240,0.85) 0%, rgba(80,140,220,0.6) 100%)'
                  : 'rgba(255,255,255,0.05)',
                borderRadius: '3px 3px 0 0',
                borderTop: count > 0 ? '1px solid rgba(160,200,255,0.6)' : 'none',
                transition: 'height 0.3s',
              }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 4 }}>
        {entries.map(({ cmc }) => (
          <div key={cmc} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: '#888', fontWeight: 600 }}>{cmc}</div>
        ))}
      </div>
    </div>
  );
}

const GRADE_LETTER_COLOR = {
  'A+':'#7cff8c','A':'#7cff8c','A-':'#90ff9c',
  'B+':'#5cc8ff','B':'#5cc8ff','B-':'#6ad4e0',
  'C+':'#ffd844','C':'#f0c838','C-':'#e0b428',
  'D+':'#ff944c','D':'#ee7c40','D-':'#dc6432','F':'#ff5c5c',
};

function DeckStatsPanel({ composition, manaAnalysis, deckGrade, archetype }) {
  if (!composition) return null;
  const { creatures, nonCreatures, removalCount, cardAdvantageCount, fixingCount, colorCounts, curve, totalPicked } = composition;
  const totalNonLand = creatures + nonCreatures;
  const significantColors = Object.entries(colorCounts ?? {}).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a);

  // Heuristic: a color with <3 cards is treated as a splash, not a main color.
  function colorRoleLabel(count, isMain) {
    if (count === 0) return null;
    if (isMain) return null; // implied
    if (count <= 2) return 'splash';
    return null;
  }

  const REMOVAL_TARGET = 3;
  const CREATURE_LO = 15;
  const CREATURE_HI = 17;
  const removalColor = removalCount >= REMOVAL_TARGET ? '#7cff8c' : removalCount >= 1 ? '#ffce5c' : '#ff7c5c';
  const creatureColor = creatures >= CREATURE_LO ? '#7cff8c' : creatures >= CREATURE_LO - 4 ? '#ffce5c' : '#ff7c5c';

  const archetypeLabel = archetype?.label
    ?? (archetype?.primary ? archetype.primary[0].toUpperCase() + archetype.primary.slice(1) : 'Unknown');

  const deckGradeLetter = deckGrade?.grade ?? '—';
  const deckGradeColor  = GRADE_LETTER_COLOR[deckGradeLetter] ?? '#888';

  return (
    <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, background: 'rgba(0,0,0,0.18)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#888', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Deck — {totalPicked} picks
        </span>
        {deckGrade && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Grade</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: deckGradeColor, lineHeight: 1, textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
              {deckGradeLetter}
            </span>
            <span style={{ fontSize: 10, color: '#666', fontFamily: 'monospace' }}>
              {(deckGrade.avgGihwr * 100).toFixed(1)}%
            </span>
          </span>
        )}
      </div>

      {archetype?.primary && (
        <div style={{ fontSize: 11, color: '#cfcfcf', marginBottom: 10 }}>
          <span style={{ color: '#888' }}>Archetype: </span>
          <span style={{ fontWeight: 700, color: '#7ec8ff' }}>{archetypeLabel}</span>
          {archetype.confidence > 0 && (
            <span style={{ color: '#666', marginLeft: 6 }}>({Math.round(archetype.confidence * 100)}% confidence)</span>
          )}
        </div>
      )}

      {/* Color commitment */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Colors
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {significantColors.length === 0 && (
            <div style={{ fontSize: 11, color: '#555' }}>No colored cards yet</div>
          )}
          {significantColors.map(([c, count], i) => {
            const isMain = i < 2 && count >= 3;
            const isSplash = !isMain && count <= 2;
            return (
              <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ width: 50, color: COLOR_HEX_DECK[c], fontWeight: 700 }}>{COLOR_LABEL_DECK[c]}:</span>
                <span style={{ color: '#fff', fontWeight: 600, minWidth: 50 }}>
                  {count} card{count !== 1 ? 's' : ''}
                </span>
                {isSplash && <span style={{ fontSize: 10, color: '#c8a040', fontStyle: 'italic' }}>splash</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Removal tracker */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
          <span style={{ fontSize: 11, color: '#cfcfcf', fontWeight: 600 }}>
            Removal: <span style={{ color: removalColor, fontWeight: 700 }}>{removalCount}</span> of {REMOVAL_TARGET}+ recommended
          </span>
        </div>
        <ProgressBar value={Math.min(removalCount, REMOVAL_TARGET)} target={REMOVAL_TARGET} color={removalColor} />
      </div>

      {/* Creature tracker */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
          <span style={{ fontSize: 11, color: '#cfcfcf', fontWeight: 600 }}>
            Creatures: <span style={{ color: creatureColor, fontWeight: 700 }}>{creatures}</span> of {CREATURE_LO}-{CREATURE_HI} recommended
          </span>
        </div>
        <ProgressBar value={Math.min(creatures, CREATURE_HI)} target={CREATURE_HI} color={creatureColor} />
      </div>

      {/* Mana curve */}
      {totalNonLand > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10, color: '#666', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Mana Curve
          </div>
          <ManaCurveChartLarge curve={curve} />
        </div>
      )}

      {/* Mana base assessment */}
      {manaAnalysis?.message && (
        <div style={{
          marginTop: 8, padding: '5px 8px', borderRadius: 4, fontSize: 11,
          background: manaAnalysis.assessment === 'ok' ? 'rgba(80,200,120,0.10)'
                    : manaAnalysis.assessment === 'splash' ? 'rgba(200,160,60,0.10)'
                    : manaAnalysis.assessment === 'warning' ? 'rgba(200,160,60,0.15)'
                    : 'rgba(200,80,80,0.15)',
          color: manaAnalysis.assessment === 'ok' ? '#7ec8a0'
               : manaAnalysis.assessment === 'splash' ? '#c8a868'
               : manaAnalysis.assessment === 'warning' ? '#e0b878'
               : '#e08080',
        }}>
          {manaAnalysis.message} {fixingCount > 0 && <span style={{ opacity: 0.7 }}>· {fixingCount} fixing</span>} {cardAdvantageCount > 0 && <span style={{ opacity: 0.7 }}>· {cardAdvantageCount} card advantage</span>}
        </div>
      )}
    </div>
  );
}

// ── Late-pack signal insights (Section 4) ─────────────────────────────────────
const INSIGHT_TONE_META = {
  flowing: { color: '#7ec8a0', icon: '◆' },
  cut:     { color: '#e08080', icon: '◇' },
  neutral: { color: '#a8a8a8', icon: '◈' },
};

function SignalInsightsPanel({ insights }) {
  if (!insights || insights.length === 0) return null;
  return (
    <div style={{
      marginTop: 8, padding: '8px 12px',
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 6,
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: '#666', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 5 }}>
        Late-pack signals
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {insights.map((ins, i) => {
          const meta = INSIGHT_TONE_META[ins.tone] ?? INSIGHT_TONE_META.neutral;
          return (
            <div key={i}>
              <div style={{ fontSize: 11, color: meta.color, fontWeight: 600, lineHeight: 1.35 }}>
                {meta.icon} {ins.short}
              </div>
              {ins.detail && (
                <div style={{ fontSize: 10, color: '#888', paddingLeft: 14, marginTop: 1 }}>
                  {ins.detail}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SORT_OPTIONS = [
  { value: 'grade',  label: 'Grade' },
  { value: 'gihwr', label: 'GIH%' },
  { value: 'ohwr',  label: 'OH%' },
  { value: 'color', label: 'Color' },
  { value: 'name',  label: 'Name' },
];

export default function DraftPanel({ draftState, assistantState, settings, onSet, onRefreshData }) {
  const { inDraft, enrichedPack, pickedCards, packId, landsFetchedAt, landsStale, landsStatus } = draftState;
  // Recommendation comes from the assistant pipeline (signalAnalyzer) — not draftState.
  const recommendation = assistantState?.recommendation ?? draftState.recommendation ?? null;
  const signalInsights = assistantState?.signalInsights ?? [];
  const columns  = settings?.columns  ?? {};
  const display  = settings?.display  ?? {};
  const sortBy      = display.sortBy      ?? 'grade';
  const colorFilter = display.colorFilter ?? 'all';
  const compact     = display.compactMode ?? false;

  const sortedFiltered = useMemo(() => {
    const filtered = (enrichedPack ?? []).filter((c) => cardMatchesFilter(c, colorFilter));
    return sortCards(filtered, sortBy);
  }, [enrichedPack, sortBy, colorFilter]);

  const recommendedGrpId = recommendation?.primary?.grpId ?? null;

  function handleColorChange(val) {
    // Filters the list only. (17Lands' public card endpoint has no per-color-pair stats.)
    onSet('display.colorFilter', val);
  }

  function handleSortChange(val) {
    onSet('display.sortBy', val);
  }

  if (!inDraft) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 40, opacity: 0.15 }}>🃏</div>
        <div style={{ fontSize: 13, color: '#444' }}>
          No draft active
          <br />
          <span style={{ fontSize: 11, color: '#333' }}>Open MTG Arena and join a draft event.</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Multi-option recommendations (Section 3) + signal insights (Section 4) */}
      {recommendation && (
        <div style={{ padding: '12px 16px 8px', flexShrink: 0 }}>
          {recommendation.picks && recommendation.picks.length > 0 ? (
            <>
              <PicksPanel picks={recommendation.picks} />
              <SignalInsightsPanel insights={signalInsights} />
            </>
          ) : (
            <>
              <RecommendedCard card={recommendation.primary} label="Best Pick" primary />
              {recommendation.secondary && recommendation.secondary.grpId !== recommendation.primary?.grpId && (
                <div style={{ marginTop: 6 }}>
                  <RecommendedCard card={recommendation.secondary} label="Runner-Up" primary={false} />
                </div>
              )}
              {recommendation.explanation && (
                <div style={{ marginTop: 6, padding: '5px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 4, fontSize: 11, color: '#777', fontStyle: 'italic' }}>
                  {recommendation.explanation}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Sort + pack info bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ fontSize: 11, color: '#555', flex: 1 }}>
          Pack ({(enrichedPack ?? []).length} cards) — sorted by
        </span>
        <span style={{ fontSize: 10, color: landsStale ? '#d8c070' : '#556' }}
              title={landsFetchedAt ? `17Lands data downloaded ${new Date(landsFetchedAt).toLocaleString()}` : undefined}>
          17Lands{landsFetchedAt ? ` · ${new Date(landsFetchedAt).toLocaleDateString()} ${new Date(landsFetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}{landsStale ? ' (old snapshot)' : ''}
        </span>
        <button onClick={() => onRefreshData?.()} disabled={landsStatus === 'fetching'}
          title="Download the latest 17Lands numbers now (normally refreshed every 12 hours)"
          style={{
            background: 'rgba(30,30,50,0.9)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4,
            color: '#c8c8c8', fontSize: 11, padding: '3px 8px', cursor: landsStatus === 'fetching' ? 'wait' : 'pointer',
          }}>
          {landsStatus === 'fetching' ? 'Refreshing…' : '↻ Refresh'}
        </button>
        <select
          value={sortBy}
          onChange={(e) => handleSortChange(e.target.value)}
          style={{
            background: 'rgba(30,30,50,0.9)', border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 4, color: '#c8c8c8', fontSize: 11, padding: '3px 6px', cursor: 'pointer',
          }}
        >
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* Color filter */}
      <div style={{ flexShrink: 0 }}>
        <ColorFilter value={colorFilter} onChange={handleColorChange} />
      </div>

      {/* Sorted card list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sortedFiltered.length === 0 ? (
          <div style={{ padding: '20px 16px', fontSize: 11, color: '#444', textAlign: 'center' }}>
            No cards match the color filter.
          </div>
        ) : (
          sortedFiltered.map((card, i) => (
            <CardRow
              key={`${packId ?? 0}-${i}-${card.grpId}`}
              card={card}
              columns={columns}
              compact={compact}
              isTopPick={i === 0}
              isRecommended={recommendedGrpId != null && card.grpId === recommendedGrpId}
            />
          ))
        )}
      </div>

      {/* Deck stats — prominent in the Draft tab (Section 5) */}
      {assistantState?.deckComposition && assistantState.deckComposition.totalPicked > 0 && (
        <DeckStatsPanel
          composition={assistantState.deckComposition}
          manaAnalysis={assistantState.manaAnalysis}
          deckGrade={assistantState.deckGrade}
          archetype={assistantState.archetype}
        />
      )}
    </div>
  );
}
