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
// Saturated colors for high-impact visual scanning at a glance.
const GRADE_BADGE = {
  'A+': { bg: 'rgba( 60,230, 90,0.40)', border: 'rgba( 60,230, 90,0.80)', text: '#7cff8c' },
  'A':  { bg: 'rgba( 60,230, 90,0.35)', border: 'rgba( 60,230, 90,0.70)', text: '#7cff8c' },
  'A-': { bg: 'rgba( 90,230,110,0.30)', border: 'rgba( 90,230,110,0.60)', text: '#90ff9c' },
  'B+': { bg: 'rgba( 50,190,240,0.35)', border: 'rgba( 50,190,240,0.70)', text: '#5cc8ff' },
  'B':  { bg: 'rgba( 50,190,240,0.28)', border: 'rgba( 50,190,240,0.60)', text: '#5cc8ff' },
  'B-': { bg: 'rgba( 70,200,220,0.25)', border: 'rgba( 70,200,220,0.55)', text: '#6ad4e0' },
  'C+': { bg: 'rgba(240,215, 60,0.32)', border: 'rgba(240,215, 60,0.65)', text: '#ffd844' },
  'C':  { bg: 'rgba(230,200, 50,0.28)', border: 'rgba(230,200, 50,0.55)', text: '#f0c838' },
  'C-': { bg: 'rgba(220,180, 40,0.22)', border: 'rgba(220,180, 40,0.45)', text: '#e0b428' },
  'D+': { bg: 'rgba(245,140, 70,0.32)', border: 'rgba(245,140, 70,0.65)', text: '#ff944c' },
  'D':  { bg: 'rgba(235,120, 60,0.28)', border: 'rgba(235,120, 60,0.55)', text: '#ee7c40' },
  'D-': { bg: 'rgba(225,100, 50,0.22)', border: 'rgba(225,100, 50,0.45)', text: '#dc6432' },
  'F':  { bg: 'rgba(220, 60, 60,0.36)', border: 'rgba(220, 60, 60,0.75)', text: '#ff5c5c' },
};
const GRADE_UNKNOWN = { bg: 'rgba(100,100,100,0.15)', border: 'rgba(100,100,100,0.3)', text: '#888' };

// grade=string → show badge; grade=null hasData=true → "N/A" (found but no data yet);
// grade=null hasData=false → "?" (not found in 17Lands at all).
// Estimated grades (17Lands withholds GIH% under 500 games) get a "~" and a
// dashed border so they're never mistaken for measured ones.
function GradeBadge({ grade, hasLandsData, estimated }) {
  const s = GRADE_BADGE[grade] ?? GRADE_UNKNOWN;
  const label = grade ? (estimated ? `~${grade}` : grade) : (hasLandsData ? 'N/A' : '?');
  return (
    <div style={{
      minWidth: 32, padding: '2px 4px',
      background: s.bg, border: `1.5px ${estimated ? 'dashed' : 'solid'} ${s.border}`,
      borderRadius: 4, textAlign: 'center',
      fontSize: grade ? (estimated ? 11 : 13) : 10, fontWeight: grade ? 800 : 500,
      color: grade ? s.text : '#888',
      letterSpacing: grade ? '-0.02em' : 0,
      flexShrink: 0,
      textShadow: grade ? '0 1px 2px rgba(0,0,0,0.5)' : 'none',
    }}>
      {label}
    </div>
  );
}

// ── Rarity colors ─────────────────────────────────────────────────────────────
const RARITY_COLOR = {
  common: '#a0a0a0', uncommon: '#a8d8b0', rare: '#e0c060', mythic: '#e08040',
};

// ── Stat cell ─────────────────────────────────────────────────────────────────
function Stat({ value, show, format, secondary, primary }) {
  if (!show) return null;
  const disp = value != null ? (format ? format(value) : String(value)) : '—';
  return (
    <span style={{
      fontSize: secondary ? 11 : 12,
      color: secondary ? '#888' : (primary ? '#fff' : '#cfcfcf'),
      fontWeight: primary ? 700 : 500,
      minWidth: 40, textAlign: 'right', fontFamily: 'monospace', flexShrink: 0,
    }}>
      {disp}
    </span>
  );
}

function pct(v) { return v != null ? `${(v * 100).toFixed(1)}%` : null; }
function estPct(v) { return v != null ? `~${(v * 100).toFixed(1)}` : null; }
function ata(v) { return v != null ? v.toFixed(1) : null; }
function iwd(v) { return v != null ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}` : null; }

function cardTooltip(card) {
  const s = card.stats;
  if (!card.hasLandsData || !s) return `${card.name ?? '#' + card.grpId} — not in 17Lands data`;
  const n = (v) => (v ?? 0).toLocaleString();
  const lines = [card.name];
  if (s.gihwr != null) {
    lines.push(`GIH WR ${pct(s.gihwr)} over ${n(s.sampleSize)} drawn games`);
  } else if (s.gradeEstimated && s.gihwrEst != null) {
    lines.push(`GIH WR withheld by 17Lands (${n(s.sampleSize)} drawn games, needs 500).`);
    lines.push(`Estimated ${pct(s.gihwrEst)} from GP WR ${pct(s.gpwr)} over ${n(s.gameCount)} games.`);
  } else if (s.gradeEstimated) {
    lines.push(`17Lands has no GIH WR for this set yet; graded from GP WR ${pct(s.gpwr)} over ${n(s.gameCount)} games.`);
  } else {
    lines.push(`Not enough games for a grade yet (${n(s.gameCount)} played).`);
  }
  if (s.ata != null) lines.push(`17Lands drafters take it ~pick ${s.ata.toFixed(1)} (ATA); last seen ~pick ${s.alsa?.toFixed(1) ?? '—'} (ALSA)`);
  lines.push('Right-click: open on 17Lands');
  return lines.join('\n');
}

// ── Main component ────────────────────────────────────────────────────────────
export default function CardRow({ card, columns, compact, isTopPick, isRecommended }) {
  const { name, color, rarity, stats, hasLandsData } = card;
  const grade = stats?.grade ?? null;
  const estimated = !!stats?.gradeEstimated;
  const lowSample = stats?.lowSample ?? false;
  const tooltip = cardTooltip(card);
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
      title={tooltip}
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: compact ? '4px 10px' : '8px 10px',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        background: baseBg,
        border: isRecommended ? '1px solid rgba(80,200,120,0.25)' : '1px solid transparent',
        transition: 'background 0.12s',
        opacity: lowSample && !grade ? 0.65 : 1,
        cursor: 'context-menu',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = baseBg)}
    >
      {/* Recommended star or color pip */}
      {isRecommended
        ? <span style={{ fontSize: 10, color: '#7ec8a0', flexShrink: 0, width: 10, textAlign: 'center' }}>★</span>
        : <ColorPip color={color} />
      }

      {/* Grade badge */}
      {columns.grade && <GradeBadge grade={grade} hasLandsData={hasLandsData} estimated={estimated} />}

      {/* Card name */}
      <span style={{
        flex: 1, fontSize: compact ? 13 : 14, color: '#ffffff', fontWeight: 500,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        textShadow: '0 1px 2px rgba(0,0,0,0.6)',
      }}>
        {name ?? `#${card.grpId}`}
        {lowSample && !grade && hasLandsData && <span style={{ marginLeft: 4, fontSize: 10, color: '#c8a040' }}>⚠</span>}
      </span>

      {/* Rarity dot */}
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: rarityColor, flexShrink: 0 }} />

      {/* Stats — GIHWR is the primary scanning column, render bold/white */}
      {/* GIH% — 17Lands' measured value, or a dimmed "~" estimate when it's withheld */}
      {stats?.gihwr == null && stats?.gihwrEst != null
        ? <Stat value={stats.gihwrEst} show={columns.gihwr} format={estPct} secondary />
        : <Stat value={stats?.gihwr} show={columns.gihwr} format={pct} primary />}
      <Stat value={stats?.ohwr}  show={columns.ohwr}  format={pct}  secondary />
      <Stat value={stats?.gpwr}  show={columns.gpwr}  format={pct} />
      <Stat value={stats?.ata}   show={columns.ata}   format={ata} />
      <Stat value={stats?.alsa}  show={columns.alsa}  format={ata} />
      <Stat value={stats?.iwd}   show={columns.iwd}   format={iwd} />
    </div>
  );
}
