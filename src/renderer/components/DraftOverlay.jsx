import React, { useMemo } from 'react';
import CardRow from './CardRow';
import ColorFilter from './ColorFilter';
import PickedCards from './PickedCards';

// ── Sorting ───────────────────────────────────────────────────────────────────
const GRADE_ORDER = ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F'];
const COLOR_ORDER = { W: 0, U: 1, B: 2, R: 3, G: 4 };

function colorSortKey(color) {
  if (!color) return 9;
  if (color.length > 1) return 8; // multicolor
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

// ── Column header row ─────────────────────────────────────────────────────────
function ColHeaders({ columns, compact }) {
  const s = { fontSize: 9, color: '#555', textAlign: 'right', minWidth: 34, textTransform: 'uppercase', fontFamily: 'monospace', flexShrink: 0 };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: compact ? '2px 8px' : '3px 8px', borderBottom: '1px solid rgba(255,255,255,0.055)' }}>
      {/* pip placeholder */}
      <div style={{ width: 8, flexShrink: 0 }} />
      {columns.grade && <span style={{ ...s, minWidth: 26, textAlign: 'center' }}>Grade</span>}
      <span style={{ flex: 1, fontSize: 9, color: '#555' }}>Card</span>
      <div style={{ width: 5, flexShrink: 0 }} />
      {columns.gihwr && <span style={s}>GIH%</span>}
      {columns.ohwr  && <span style={{ ...s, color: '#444' }}>OH%</span>}
      {columns.gpwr  && <span style={s}>GP%</span>}
      {columns.alsa  && <span style={s}>ALSA</span>}
      {columns.iwd   && <span style={s}>IWD</span>}
    </div>
  );
}

// ── Loading / error state ─────────────────────────────────────────────────────
function LoadingBanner({ landsStatus, landsError }) {
  if (!landsStatus || landsStatus === 'loaded') return null;
  const isFetching = landsStatus === 'fetching';
  return (
    <div style={{
      padding: '5px 10px', fontSize: 10,
      background: isFetching ? 'rgba(40,80,40,0.3)' : 'rgba(80,30,30,0.35)',
      color: isFetching ? '#7ec8a0' : '#e08080',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      {isFetching ? (
        <><span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span> Loading 17Lands data…</>
      ) : (
        <><span>⚠</span> 17Lands unavailable{landsError ? ` — ${landsError}` : ''}. Showing names only.</>
      )}
    </div>
  );
}

// ── Idle / no-draft state ─────────────────────────────────────────────────────
function IdleView({ landsStatus }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 32, opacity: 0.2 }}>🃏</div>
      <div style={{ fontSize: 12, color: '#555', lineHeight: 1.6 }}>
        Waiting for a draft to start…
        <br />
        <span style={{ fontSize: 10, color: '#3a3a3a' }}>Open MTG Arena and join a draft event.</span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function DraftOverlay({ draftState, settings, onColorFilterChange }) {
  if (!settings) return null;

  const { columns = {}, display = {} } = settings;
  const compact = display.compactMode ?? false;
  const sortBy = display.sortBy ?? 'grade';
  const colorFilter = display.colorFilter ?? 'all';

  const { inDraft, enrichedPack, pickedCards, setCode, landsStatus, landsError } = draftState;

  const sortedCards = useMemo(
    () => sortCards(enrichedPack ?? [], sortBy),
    [enrichedPack, sortBy]
  );

  if (!inDraft) return <IdleView landsStatus={landsStatus} />;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Loading / error banner */}
      <LoadingBanner landsStatus={landsStatus} landsError={landsError} />

      {/* Color filter chips */}
      <ColorFilter value={colorFilter} onChange={onColorFilterChange} />

      {/* Column headers */}
      {sortedCards.length > 0 && <ColHeaders columns={columns} compact={compact} />}

      {/* Card rows */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {sortedCards.length === 0 ? (
          <div style={{ padding: '20px 12px', fontSize: 11, color: '#444', textAlign: 'center' }}>
            {enrichedPack?.length === 0 ? 'Waiting for pack…' : 'No cards match the color filter.'}
          </div>
        ) : (
          sortedCards.map((card, i) => (
            <CardRow
              key={card.grpId ?? i}
              card={card}
              columns={columns}
              compact={compact}
              isTopPick={i === 0}
            />
          ))
        )}
      </div>

      {/* Picked cards section */}
      <PickedCards picks={pickedCards} />
    </div>
  );
}
