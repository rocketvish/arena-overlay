import React from 'react';

// Single colors
const MONO = [
  { id: 'W', bg: 'rgba(245,230,100,0.22)', border: 'rgba(245,230,100,0.65)', text: '#f5e664' },
  { id: 'U', bg: 'rgba( 80,160,255,0.22)', border: 'rgba( 80,160,255,0.65)', text: '#50a0ff' },
  { id: 'B', bg: 'rgba(155,110,210,0.22)', border: 'rgba(155,110,210,0.65)', text: '#9b6ed2' },
  { id: 'R', bg: 'rgba(240,100,100,0.22)', border: 'rgba(240,100,100,0.65)', text: '#f06464' },
  { id: 'G', bg: 'rgba( 80,185, 90,0.22)', border: 'rgba( 80,185, 90,0.65)', text: '#50b95a' },
];

const PAIRS = ['WU','WB','WR','WG','UB','UR','UG','BR','BG','RG'];

export default function ColorFilter({ value, onChange }) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 3,
      padding: '4px 8px 5px',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
    }}>
      <Chip id="all" label="All" active={value === 'all'} onClick={() => onChange('all')}
        activeBg="rgba(180,180,255,0.18)" activeBorder="rgba(180,180,255,0.55)" activeText="#c0c0ff" />

      {MONO.map((c) => (
        <Chip key={c.id} id={c.id} label={c.id} active={value === c.id} onClick={() => onChange(c.id)}
          activeBg={c.bg} activeBorder={c.border} activeText={c.text} />
      ))}

      {PAIRS.map((p) => (
        <Chip key={p} id={p} label={p} active={value === p} onClick={() => onChange(p)}
          activeBg="rgba(210,175, 60,0.2)" activeBorder="rgba(210,175,60,0.6)" activeText="#d2af3c" />
      ))}
    </div>
  );
}

function Chip({ id, label, active, onClick, activeBg, activeBorder, activeText }) {
  return (
    <button onClick={onClick} style={{
      padding: '2px 6px', fontSize: 10, borderRadius: 3,
      border: `1px solid ${active ? activeBorder : 'rgba(255,255,255,0.1)'}`,
      background: active ? activeBg : 'rgba(255,255,255,0.03)',
      color: active ? activeText : '#777',
      cursor: 'pointer', fontWeight: active ? 700 : 400,
      fontFamily: 'monospace', letterSpacing: '0.02em',
      transition: 'all 0.12s',
    }}>
      {label}
    </button>
  );
}
