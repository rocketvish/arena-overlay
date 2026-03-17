import React from 'react';

const GRADE_COLORS = {
  'A+': '#f5c842', 'A': '#f5c842', 'A-': '#f0d060',
  'B+': '#7ed87e', 'B': '#7ed87e', 'B-': '#9ecc9e',
  'C+': '#6cb8e8', 'C': '#6cb8e8', 'C-': '#8abcd4',
  'D+': '#e87e6c', 'D': '#e87e6c', 'D-': '#d4a08a',
  'F': '#c06060',
};

const RARITY_COLORS = {
  common: '#c0c0c0',
  uncommon: '#a8d0b0',
  rare: '#e0c060',
  mythic: '#e08040',
};

function StatCell({ value, show, format }) {
  if (!show) return null;
  const display = value != null ? (format ? format(value) : value) : '—';
  return (
    <span style={{ fontSize: 10, color: '#aaa', minWidth: 36, textAlign: 'right' }}>
      {display}
    </span>
  );
}

function pct(v) {
  if (v == null) return null;
  return `${(v * 100).toFixed(1)}%`;
}

export default function CardRow({ card, columns, compact, isTopPick }) {
  const grade = card.stats?.grade;
  const gradeColor = grade ? (GRADE_COLORS[grade] || '#888') : '#555';
  const rarityColor = RARITY_COLORS[card.rarity] || '#c0c0c0';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: compact ? '3px 8px' : '5px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        background: isTopPick ? 'rgba(120,200,140,0.08)' : 'transparent',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
      onMouseLeave={e => e.currentTarget.style.background = isTopPick ? 'rgba(120,200,140,0.08)' : 'transparent'}
    >
      {/* Grade badge */}
      {columns.grade && (
        <span style={{
          minWidth: 28,
          fontSize: compact ? 11 : 12,
          fontWeight: 700,
          color: gradeColor,
          textAlign: 'center',
        }}>
          {grade || '?'}
        </span>
      )}

      {/* Card name */}
      <span style={{
        flex: 1,
        fontSize: compact ? 11 : 12,
        color: '#e0e0e0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {card.name || `#${card.grpId}`}
      </span>

      {/* Rarity dot */}
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: rarityColor,
        flexShrink: 0,
      }} />

      {/* Stats */}
      <StatCell value={card.stats?.gihwr} show={columns.gihwr} format={pct} />
      <StatCell value={card.stats?.ohwr}  show={columns.ohwr}  format={pct} />
      <StatCell value={card.stats?.gpwr}  show={columns.gpwr}  format={pct} />
      <StatCell value={card.stats?.alsa}  show={columns.alsa}  format={v => v?.toFixed(1)} />
      <StatCell value={card.stats?.iwd}   show={columns.iwd}   format={v => v > 0 ? `+${v.toFixed(1)}` : v?.toFixed(1)} />
    </div>
  );
}
