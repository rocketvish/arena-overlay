import React from 'react';

const COLOR_PAIRS = [
  { id: 'all', label: 'All' },
  { id: 'WU', label: 'WU' },
  { id: 'WB', label: 'WB' },
  { id: 'WR', label: 'WR' },
  { id: 'WG', label: 'WG' },
  { id: 'UB', label: 'UB' },
  { id: 'UR', label: 'UR' },
  { id: 'UG', label: 'UG' },
  { id: 'BR', label: 'BR' },
  { id: 'BG', label: 'BG' },
  { id: 'RG', label: 'RG' },
];

const COLOR_SYMBOLS = { W: '☀', U: '💧', B: '💀', R: '🔥', G: '🌲' };

export default function ColorFilter({ value, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '6px 8px' }}>
      {COLOR_PAIRS.map(pair => (
        <button
          key={pair.id}
          onClick={() => onChange(pair.id)}
          style={{
            padding: '2px 6px',
            fontSize: 10,
            borderRadius: 3,
            border: '1px solid',
            borderColor: value === pair.id ? 'rgba(120,160,255,0.8)' : 'rgba(255,255,255,0.15)',
            background: value === pair.id ? 'rgba(80,120,220,0.35)' : 'rgba(255,255,255,0.05)',
            color: value === pair.id ? '#a8c4ff' : '#aaa',
            cursor: 'pointer',
            fontWeight: value === pair.id ? 600 : 400,
            transition: 'all 0.1s',
          }}
        >
          {pair.label}
        </button>
      ))}
    </div>
  );
}
