import React, { useState } from 'react';

export default function PickedCards({ picks }) {
  const [expanded, setExpanded] = useState(false);

  if (!picks || picks.length === 0) return null;

  const displayed = expanded ? picks : picks.slice(0, 5);

  return (
    <div style={{
      borderTop: '1px solid rgba(255,255,255,0.08)',
      background: 'rgba(0,0,0,0.2)',
    }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%',
          padding: '5px 8px',
          textAlign: 'left',
          background: 'none',
          border: 'none',
          color: '#888',
          fontSize: 11,
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>Picked ({picks.length})</span>
        <span style={{ fontSize: 10 }}>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div style={{ padding: '0 8px 6px' }}>
          {picks.map((card, i) => (
            <div
              key={i}
              style={{
                fontSize: 11,
                color: '#b0b0b0',
                padding: '2px 0',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span>{card.name || `#${card.grpId}`}</span>
              <span style={{ color: '#666', fontSize: 10 }}>P{i + 1}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
