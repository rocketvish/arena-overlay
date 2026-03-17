import React, { useState, useMemo } from 'react';

const COLOR_STYLES = {
  W: { bg: 'rgba(245,230,100,0.25)', text: '#f5e664', border: 'rgba(245,230,100,0.4)' },
  U: { bg: 'rgba( 80,160,255,0.25)', text: '#50a0ff', border: 'rgba( 80,160,255,0.4)' },
  B: { bg: 'rgba(155,110,210,0.25)', text: '#9b6ed2', border: 'rgba(155,110,210,0.4)' },
  R: { bg: 'rgba(240,100,100,0.25)', text: '#f06464', border: 'rgba(240,100,100,0.4)' },
  G: { bg: 'rgba( 80,185, 90,0.25)', text: '#50b95a', border: 'rgba( 80,185, 90,0.4)' },
  M: { bg: 'rgba(210,175, 60,0.25)', text: '#d2af3c', border: 'rgba(210,175,60,0.4)' },
  C: { bg: 'rgba(140,140,140,0.20)', text: '#909090', border: 'rgba(140,140,140,0.35)' },
};

function getColorKey(card) {
  const c = card.color ?? '';
  const chars = c.replace(/[^WUBRG]/g, '');
  if (chars.length === 0) return 'C';
  if (chars.length > 1) return 'M';
  return chars[0];
}

// Tiny bar chart for mana curve (CMC 1-6+)
function ManaCurve({ picks }) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, '6+': 0 };
  for (const p of picks) {
    const c = p.cmc ?? null;
    if (c == null) continue;
    if (c <= 1) counts[1]++;
    else if (c === 2) counts[2]++;
    else if (c === 3) counts[3]++;
    else if (c === 4) counts[4]++;
    else if (c === 5) counts[5]++;
    else counts['6+']++;
  }
  const max = Math.max(1, ...Object.values(counts));
  const keys = [1, 2, 3, 4, 5, '6+'];

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 20, padding: '0 2px' }}>
      {keys.map((k) => {
        const h = Math.round((counts[k] / max) * 18);
        return (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
            <div style={{
              width: 8, height: h || 2, borderRadius: 1,
              background: h > 0 ? 'rgba(80,160,220,0.6)' : 'rgba(80,80,80,0.3)',
              transition: 'height 0.2s',
            }} />
            <span style={{ fontSize: 7, color: '#555', lineHeight: 1 }}>{k}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function PickedCards({ picks }) {
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo(() => {
    if (!picks || picks.length === 0) return null;

    // Color counts
    const colorCounts = {};
    for (const p of picks) {
      const key = getColorKey(p);
      colorCounts[key] = (colorCounts[key] ?? 0) + 1;
    }

    // Average GIH WR for picks that have stats
    const withStats = picks.filter((p) => p.stats?.gihwr != null);
    const avgGihwr = withStats.length > 0
      ? withStats.reduce((s, p) => s + p.stats.gihwr, 0) / withStats.length
      : null;

    return { colorCounts, avgGihwr };
  }, [picks]);

  if (!picks || picks.length === 0) return null;

  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', background: 'rgba(0,0,0,0.25)', flexShrink: 0 }}>
      {/* Header / toggle */}
      <button
        onClick={() => setExpanded((e) => !e)}
        style={{
          width: '100%', padding: '5px 8px',
          background: 'none', border: 'none', color: '#777',
          fontSize: 11, cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          gap: 8,
        }}
      >
        {/* Left: pick count + color pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ color: '#555' }}>Picked {picks.length}</span>
          {stats && Object.entries(stats.colorCounts)
            .sort(([a], [b]) => 'WUBRGMC'.indexOf(a) - 'WUBRGMC'.indexOf(b))
            .map(([color, count]) => {
              const s = COLOR_STYLES[color] ?? COLOR_STYLES.C;
              return (
                <span key={color} style={{
                  fontSize: 10, fontWeight: 700, fontFamily: 'monospace',
                  padding: '0px 4px', borderRadius: 3,
                  background: s.bg, color: s.text, border: `1px solid ${s.border}`,
                }}>
                  {color}:{count}
                </span>
              );
            })}
        </div>

        {/* Right: avg GIH% + mana curve + expand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {stats?.avgGihwr != null && (
            <span style={{ fontSize: 10, color: '#7a9a7a', fontFamily: 'monospace' }}>
              avg {(stats.avgGihwr * 100).toFixed(1)}%
            </span>
          )}
          <ManaCurve picks={picks} />
          <span style={{ fontSize: 9, color: '#444' }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {/* Expanded card list */}
      {expanded && (
        <div style={{ padding: '0 8px 6px', maxHeight: 160, overflowY: 'auto' }}>
          {picks.map((card, i) => {
            const cs = COLOR_STYLES[getColorKey(card)] ?? COLOR_STYLES.C;
            return (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.04)',
                fontSize: 11,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden' }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: cs.text, flexShrink: 0 }} />
                  <span style={{ color: '#c0c0c0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {card.name ?? `#${card.grpId}`}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  {card.stats?.gihwr != null && (
                    <span style={{ fontSize: 10, color: '#6a8a6a', fontFamily: 'monospace' }}>
                      {(card.stats.gihwr * 100).toFixed(1)}%
                    </span>
                  )}
                  <span style={{ color: '#444', fontSize: 10 }}>P{i + 1}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
