import React from 'react';

// ── Color pip styling ────────────────────────────────────────────────────────
const COLOR_STYLES = {
  W: { bg: '#f5e664', shadow: 'rgba(245,230,100,0.6)' },
  U: { bg: '#50a0ff', shadow: 'rgba( 80,160,255,0.6)' },
  B: { bg: '#9b6ed2', shadow: 'rgba(155,110,210,0.6)' },
  R: { bg: '#f06464', shadow: 'rgba(240,100,100,0.6)' },
  G: { bg: '#50b95a', shadow: 'rgba( 80,185, 90,0.6)' },
};
const MULTI_STYLE = { bg: 'linear-gradient(135deg,#f5e664,#f06464)', shadow: 'rgba(210,170,60,0.6)' };
const COLORLESS_STYLE = { bg: '#909090', shadow: 'rgba(144,144,144,0.4)' };

function ColorPip({ color }) {
  const chars = (color ?? '').replace(/[^WUBRG]/g, '');
  let style;
  if (chars.length === 0) style = COLORLESS_STYLE;
  else if (chars.length === 1) style = COLOR_STYLES[chars] ?? COLORLESS_STYLE;
  else style = MULTI_STYLE;

  return (
    <div style={{
      width: 8, height: 8, borderRadius: '50%',
      background: style.bg,
      boxShadow: `0 0 4px ${style.shadow}`,
      flexShrink: 0,
    }} />
  );
}

// ── Grade badge ───────────────────────────────────────────────────────────────
const GRADE_BADGE = {
  'A+': { bg: 'rgba( 50,200, 80,0.25)', border: 'rgba( 50,200, 80,0.5)', text: '#32c850' },
  'A':  { bg: 'rgba( 50,200, 80,0.20)', border: 'rgba( 50,200, 80,0.4)', text: '#32c850' },
  'A-': { bg: 'rgba( 80,210,100,0.18)', border: 'rgba( 80,210,100,0.35)', text: '#50d264' },
  'B+': { bg: 'rgba( 40,170,220,0.20)', border: 'rgba( 40,170,220,0.4)', text: '#28aadc' },
  'B':  { bg: 'rgba( 40,170,220,0.15)', border: 'rgba( 40,170,220,0.35)', text: '#28aadc' },
  'B-': { bg: 'rgba( 60,180,200,0.15)', border: 'rgba( 60,180,200,0.3)', text: '#3cb4c8' },
  'C+': { bg: 'rgba(220,200, 50,0.18)', border: 'rgba(220,200, 50,0.35)', text: '#dcc832' },
  'C':  { bg: 'rgba(210,185, 40,0.15)', border: 'rgba(210,185, 40,0.3)', text: '#d2b928' },
  'C-': { bg: 'rgba(200,165, 30,0.12)', border: 'rgba(200,165, 30,0.25)', text: '#c8a51e' },
  'D+': { bg: 'rgba(230,130, 60,0.18)', border: 'rgba(230,130, 60,0.35)', text: '#e6823c' },
  'D':  { bg: 'rgba(220,110, 50,0.15)', border: 'rgba(220,110, 50,0.3)', text: '#dc6e32' },
  'D-': { bg: 'rgba(210, 90, 40,0.12)', border: 'rgba(210, 90, 40,0.25)', text: '#d25a28' },
  'F':  { bg: 'rgba(200, 50, 50,0.20)', border: 'rgba(200, 50, 50,0.4)', text: '#c83232' },
};
const GRADE_UNKNOWN = { bg: 'rgba(100,100,100,0.15)', border: 'rgba(100,100,100,0.3)', text: '#666' };

function GradeBadge({ grade }) {
  const s = GRADE_BADGE[grade] ?? GRADE_UNKNOWN;
  return (
    <div style={{
      minWidth: 26, padding: '1px 0',
      background: s.bg, border: `1px solid ${s.border}`,
      borderRadius: 3, textAlign: 'center',
      fontSize: 11, fontWeight: 700, color: s.text,
      flexShrink: 0,
    }}>
      {grade ?? '?'}
    </div>
  );
}

// ── Rarity colors ─────────────────────────────────────────────────────────────
const RARITY_COLOR = {
  common: '#a0a0a0', uncommon: '#a8d8b0', rare: '#e0c060', mythic: '#e08040',
};

// ── Stat cell ─────────────────────────────────────────────────────────────────
function Stat({ value, show, format, secondary }) {
  if (!show) return null;
  const disp = value != null ? (format ? format(value) : String(value)) : '—';
  return (
    <span style={{
      fontSize: secondary ? 9 : 10, color: secondary ? '#666' : '#aaa',
      minWidth: 34, textAlign: 'right', fontFamily: 'monospace', flexShrink: 0,
    }}>
      {disp}
    </span>
  );
}

function pct(v) { return v != null ? `${(v * 100).toFixed(1)}%` : null; }
function ata(v) { return v != null ? v.toFixed(1) : null; }
function iwd(v) { return v != null ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}` : null; }

// ── Main component ────────────────────────────────────────────────────────────
export default function CardRow({ card, columns, compact, isTopPick, isRecommended }) {
  const { name, color, rarity, stats } = card;
  const grade = stats?.grade ?? null;
  const lowSample = stats?.lowSample ?? false;
  const rarityColor = RARITY_COLOR[rarity] ?? '#a0a0a0';
  const highlighted = isRecommended || isTopPick;
  const baseBg = isRecommended
    ? 'rgba(80,200,120,0.10)'
    : isTopPick ? 'rgba(80,200,120,0.06)' : 'transparent';

  function handleContextMenu(e) {
    e.preventDefault();
    if (name && window.electronAPI) {
      const slug = encodeURIComponent(name);
      window.electronAPI.openUrl(`https://www.17lands.com/card_data_detail/${slug}`);
    }
  }

  return (
    <div
      onContextMenu={handleContextMenu}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: compact ? '2px 8px' : '4px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        background: baseBg,
        border: isRecommended ? '1px solid rgba(80,200,120,0.25)' : '1px solid transparent',
        transition: 'background 0.12s',
        opacity: lowSample ? 0.65 : 1,
        cursor: 'context-menu',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = baseBg)}
    >
      {/* Recommended star or color pip */}
      {isRecommended
        ? <span style={{ fontSize: 8, color: '#7ec8a0', flexShrink: 0, width: 8, textAlign: 'center' }}>★</span>
        : <ColorPip color={color} />
      }

      {/* Grade badge */}
      {columns.grade && <GradeBadge grade={grade} />}

      {/* Card name */}
      <span style={{
        flex: 1, fontSize: compact ? 11 : 12, color: '#e0e0e0',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {name ?? `#${card.grpId}`}
        {lowSample && <span title="Low sample size (<200 games)" style={{ marginLeft: 4, fontSize: 9, color: '#886a30' }}>⚠</span>}
      </span>

      {/* Rarity dot */}
      <div style={{ width: 5, height: 5, borderRadius: '50%', background: rarityColor, flexShrink: 0 }} />

      {/* Stats */}
      <Stat value={stats?.gihwr} show={columns.gihwr} format={pct} />
      <Stat value={stats?.ohwr}  show={columns.ohwr}  format={pct}  secondary />
      <Stat value={stats?.gpwr}  show={columns.gpwr}  format={pct} />
      <Stat value={stats?.alsa}  show={columns.alsa}  format={ata} />
      <Stat value={stats?.iwd}   show={columns.iwd}   format={iwd} />
    </div>
  );
}
