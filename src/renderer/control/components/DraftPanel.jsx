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

const SORT_OPTIONS = [
  { value: 'grade',  label: 'Grade' },
  { value: 'gihwr', label: 'GIH%' },
  { value: 'ohwr',  label: 'OH%' },
  { value: 'color', label: 'Color' },
  { value: 'name',  label: 'Name' },
];

export default function DraftPanel({ draftState, settings, onSet, reEnrichWithColorPair }) {
  const { inDraft, enrichedPack, pickedCards, recommendation } = draftState;
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
    onSet('display.colorFilter', val);
    reEnrichWithColorPair?.(val);
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
      {/* Recommendation */}
      {recommendation && (
        <div style={{ padding: '12px 16px 8px', flexShrink: 0 }}>
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
        </div>
      )}

      {/* Sort + pack info bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ fontSize: 11, color: '#555', flex: 1 }}>
          Pack ({(enrichedPack ?? []).length} cards) — sorted by
        </span>
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
              key={card.grpId ?? i}
              card={card}
              columns={columns}
              compact={compact}
              isTopPick={i === 0}
              isRecommended={recommendedGrpId != null && card.grpId === recommendedGrpId}
            />
          ))
        )}
      </div>

      {/* Picked cards */}
      {pickedCards?.length > 0 && (
        <div style={{ padding: '6px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: '#555', marginBottom: 3 }}>Picked ({pickedCards.length})</div>
          <div style={{ fontSize: 11, color: '#444', lineHeight: 1.5 }}>
            {pickedCards.slice(-6).map((c) => c.name ?? `#${c.grpId}`).join(', ')}
            {pickedCards.length > 6 && ` … +${pickedCards.length - 6} more`}
          </div>
        </div>
      )}
    </div>
  );
}
