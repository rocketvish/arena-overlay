import React, { useState } from 'react';

// "What's open" over the draft: one small chart per color (small multiples —
// five crossing lines in mana colors would be unreadable, and red/green
// can't carry identity alone). Each row is labeled; the mana color is only an
// accent on the current point. The line is the color's openness read (0–100,
// 50 = typical) after every pack you were passed; reads from too early in a
// pack are drawn faint. Hover a chart for the value at each pick.

const COLORS = ['W', 'U', 'B', 'R', 'G'];
const NAME = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const MANA = { W: '#f5e664', U: '#50a0ff', B: '#b090e0', R: '#f06464', G: '#50b95a' };
const INK = { primary: '#e0e0e0', secondary: '#aaa', muted: '#666', line: '#9aa0b4', grid: 'rgba(255,255,255,0.08)', faint: 'rgba(255,255,255,0.04)' };
const CONF = {
  'too early': { color: '#777', text: 'Too early to tell', tip: 'A pack\'s first picks say almost nothing about what\'s open.' },
  low:         { color: '#c8a050', text: 'Low confidence', tip: 'Picks 4–5 of a pack: the read is starting to mean something.' },
  medium:      { color: '#8fb8ff', text: 'Medium confidence', tip: 'Picks 6–8: a usable read.' },
  high:        { color: '#7ec8a0', text: 'High confidence', tip: 'Pick 9 on: as good as this read gets.' },
};
const W = 42 * 6; // viewBox width: one slot per pick of a 3 × 14 draft
const H = 22;

function xOf(p, packSize) {
  return ((p.packNumber * packSize + p.pickNumber) / (3 * packSize - 1)) * W;
}
const yOf = (score) => H - 2 - (score / 100) * (H - 4);

function Spark({ color, points, packSize, current, onHover }) {
  const pts = points.map((p) => [xOf(p, packSize), yOf(p.scores[color]), p]);
  // Faint segments where the read was too early to trust, solid elsewhere.
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a[2].packNumber !== b[2].packNumber) continue; // break the line between packs
    segs.push({ d: `M${a[0]},${a[1]}L${b[0]},${b[1]}`, faint: b[2].confidence === 'too early' || !b[2].hasData });
  }
  const last = pts[pts.length - 1];
  return (
    <div style={{ position: 'relative', flex: 1, height: H, minWidth: 80 }}
         onMouseMove={(e) => {
           const r = e.currentTarget.getBoundingClientRect();
           const x = ((e.clientX - r.left) / r.width) * W;
           let best = null;
           for (const p of pts) if (!best || Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p;
           onHover(best ? best[2] : null);
         }}
         onMouseLeave={() => onHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H} style={{ display: 'block' }}>
        {/* pack dividers and the "typical" (50) line */}
        {[1, 2].map((k) => {
          const x = (k * packSize - 0.5) / (3 * packSize - 1) * W;
          return <line key={k} x1={x} x2={x} y1={0} y2={H} stroke={INK.grid} strokeWidth="1" vectorEffect="non-scaling-stroke" />;
        })}
        <line x1={0} x2={W} y1={yOf(50)} y2={yOf(50)} stroke={INK.grid} strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        {segs.map((s, i) => (
          <path key={i} d={s.d} fill="none" stroke={INK.line} strokeOpacity={s.faint ? 0.3 : 1}
                strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {last && (
        // HTML dot so it stays round when the chart stretches.
        <div style={{
          position: 'absolute', width: 8, height: 8, borderRadius: '50%',
          left: `calc(${(last[0] / W) * 100}% - 4px)`, top: last[1] - 4,
          background: MANA[color], boxShadow: '0 0 0 2px #0d0d1a',
          opacity: current?.hasData ? 1 : 0.4,
        }} />
      )}
    </div>
  );
}

function scoreLabel(sig) {
  if (!sig?.hasData) return 'No read yet';
  return `${sig.label} · ${sig.score}`;
}

export default function ColorTrack({ track, colorSignals, confidence, packSize = 14, compact = false }) {
  const [hover, setHover] = useState(null);
  if (!colorSignals) return null;
  const points = track ?? [];
  const conf = CONF[confidence?.level] ?? CONF['too early'];
  const ranked = COLORS.slice().sort((a, b) => (colorSignals[b]?.score ?? 0) - (colorSignals[a]?.score ?? 0));
  return (
    <div style={{ marginBottom: compact ? 8 : 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, paddingBottom: 3, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: '#555', letterSpacing: '0.08em', textTransform: 'uppercase' }}>What's open</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: conf.color }}
              title={`${conf.tip} Measured on 17Lands drafts: how well a color's read predicts what reaches you over the next few picks.`}>
          {conf.text}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: INK.muted, fontFamily: 'monospace' }}>
          {hover ? `P${hover.packNumber + 1}p${hover.pickNumber + 1} · ${COLORS.map((c) => `${c} ${hover.scores[c]}`).join(' ')} · ${hover.confidence}` : '50 = typical'}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 2 : 6 }}>
        {ranked.map((c) => {
          const sig = colorSignals[c];
          return (
            <div key={c}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, width: compact ? 56 : 64, flexShrink: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: MANA[c] }} />
                  <span style={{ fontSize: 11, color: INK.primary }}>{NAME[c]}</span>
                </span>
                <Spark color={c} points={points} packSize={packSize} current={sig} onHover={setHover} />
                <span style={{ fontSize: 10, color: sig?.hasData ? INK.secondary : INK.muted, width: compact ? 92 : 104, textAlign: 'right', flexShrink: 0 }}>
                  {scoreLabel(sig)}
                </span>
              </div>
              {!compact && sig?.evidence && (
                <div style={{ fontSize: 9, color: '#555', paddingLeft: 72, marginTop: 1 }}>{sig.evidence}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
