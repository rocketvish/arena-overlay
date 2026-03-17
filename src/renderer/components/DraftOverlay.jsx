import React, { useMemo } from 'react';
import CardRow from './CardRow';
import ColorFilter from './ColorFilter';
import PickedCards from './PickedCards';

function sortCards(cards, sortBy) {
  return [...cards].sort((a, b) => {
    if (sortBy === 'grade') {
      const gradeOrder = ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F'];
      const ai = gradeOrder.indexOf(a.stats?.grade ?? 'F');
      const bi = gradeOrder.indexOf(b.stats?.grade ?? 'F');
      const aIdx = ai === -1 ? gradeOrder.length : ai;
      const bIdx = bi === -1 ? gradeOrder.length : bi;
      return aIdx - bIdx;
    }
    if (sortBy === 'gihwr') return (b.stats?.gihwr ?? 0) - (a.stats?.gihwr ?? 0);
    if (sortBy === 'ohwr')  return (b.stats?.ohwr  ?? 0) - (a.stats?.ohwr  ?? 0);
    if (sortBy === 'alsa')  return (a.stats?.alsa  ?? 99) - (b.stats?.alsa  ?? 99);
    return 0;
  });
}

function filterByColor(cards, colorFilter) {
  if (!colorFilter || colorFilter === 'all') return cards;
  return cards.filter(card => {
    const colors = card.colorIdentity || card.colors || '';
    return [...colorFilter].every(c => colors.includes(c));
  });
}

// Column header row
function ColumnHeaders({ columns, compact }) {
  const style = { fontSize: 9, color: '#666', textAlign: 'right', minWidth: 36, textTransform: 'uppercase' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: compact ? '2px 8px' : '3px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      {columns.grade && <span style={{ ...style, minWidth: 28, textAlign: 'center' }}>Grade</span>}
      <span style={{ flex: 1, fontSize: 9, color: '#666' }}>Card</span>
      <span style={{ width: 6 }} />
      {columns.gihwr && <span style={style}>GIH%</span>}
      {columns.ohwr  && <span style={style}>OH%</span>}
      {columns.gpwr  && <span style={style}>GP%</span>}
      {columns.alsa  && <span style={style}>ALSA</span>}
      {columns.iwd   && <span style={style}>IWD</span>}
    </div>
  );
}

// Idle / waiting state
function IdleView() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, padding: 24 }}>
      <div style={{ fontSize: 28, opacity: 0.3 }}>🃏</div>
      <div style={{ fontSize: 12, color: '#555', textAlign: 'center', lineHeight: 1.5 }}>
        Waiting for a draft to start…
        <br />
        <span style={{ fontSize: 10, color: '#444' }}>Open MTG Arena and join a draft event.</span>
      </div>
    </div>
  );
}

export default function DraftOverlay({ draftState, settings }) {
  if (!settings) return null;

  const { columns = {}, display = {} } = settings;
  const compact = display.compactMode || false;
  const sortBy = display.sortBy || 'grade';
  const colorFilter = display.colorFilter || 'all';

  const { inDraft, currentPack, pickedCards, setCode } = draftState;

  const processedCards = useMemo(() => {
    if (!currentPack?.length) return [];
    const filtered = filterByColor(currentPack, colorFilter);
    return sortCards(filtered, sortBy);
  }, [currentPack, colorFilter, sortBy]);

  if (!inDraft || !currentPack?.length) {
    return <IdleView />;
  }

  const topCard = processedCards[0];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Set code badge */}
      {setCode && (
        <div style={{ padding: '3px 8px', fontSize: 10, color: '#666', letterSpacing: '0.05em' }}>
          {setCode}
        </div>
      )}

      <ColorFilter
        value={colorFilter}
        onChange={val => window.electronAPI?.setSetting('display.colorFilter', val)}
      />

      <ColumnHeaders columns={columns} compact={compact} />

      {/* Card list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {processedCards.map((card, i) => (
          <CardRow
            key={card.grpId ?? i}
            card={card}
            columns={columns}
            compact={compact}
            isTopPick={i === 0}
          />
        ))}
        {processedCards.length === 0 && (
          <div style={{ padding: 16, fontSize: 11, color: '#555', textAlign: 'center' }}>
            No cards match the color filter.
          </div>
        )}
      </div>

      <PickedCards picks={pickedCards} />
    </div>
  );
}
