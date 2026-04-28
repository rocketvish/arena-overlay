import React, { useState } from 'react';

// ── Color signal pills ─────────────────────────────────────────────────────────
const COLOR_NAMES = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G' };
const COLOR_HEX   = { W: '#f5e664', U: '#50a0ff', B: '#b090e0', R: '#f06464', G: '#50b95a' };

function signalColor(score) {
  if (score >= 70) return '#50c87a'; // green — open
  if (score >= 45) return '#c8b830'; // yellow — contested
  return '#d05050';                  // red — cut
}

function SignalPills({ colorSignals, hasData }) {
  if (!colorSignals) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
      {Object.entries(colorSignals).map(([color, sig]) => {
        const text = !hasData ? '?' : sig.label === 'Wide Open' ? 'Open' : sig.label === 'Hard Cut' ? 'Cut' : sig.label;
        const fg = !sig.hasData ? '#666' : signalColor(sig.score);
        return (
          <span key={color} title={`${sig.label} (${sig.score}/100) — ${sig.evidence}`} style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '2px 6px', borderRadius: 4,
            border: `1px solid ${fg}55`,
            background: `${fg}20`,
            fontSize: 10, fontFamily: 'monospace', flexShrink: 0,
          }}>
            <span style={{ color: COLOR_HEX[color], fontWeight: 700 }}>{COLOR_NAMES[color]}</span>
            <span style={{ color: fg, fontWeight: 600 }}>{text}</span>
          </span>
        );
      })}
    </div>
  );
}

// ── Recommendation line (single-pick fallback) ────────────────────────────────
function RecLine({ recommendation }) {
  if (!recommendation?.primary) return null;
  const { primary, secondary, explanation } = recommendation;
  const name = primary.name ?? `#${primary.grpId}`;
  const secName = secondary?.name ?? null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, lineHeight: 1.3,
    }}>
      <span style={{ color: '#7ec8a0', flexShrink: 0 }}>★</span>
      <span style={{ color: '#fff', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
        {secName ? `${name} or ${secName}` : name}
      </span>
      {explanation && (
        <span style={{ color: '#888', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          — {explanation}
        </span>
      )}
    </div>
  );
}

// ── Deck needs line ────────────────────────────────────────────────────────────
function NeedsLine({ deckNeeds }) {
  if (!deckNeeds || deckNeeds.length === 0) return null;
  const top = deckNeeds.slice(0, 3);
  return (
    <div style={{ fontSize: 10, color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      <span style={{ color: '#888', fontWeight: 600 }}>Needs: </span>
      {top.map((n, i) => (
        <span key={n.id}>
          {i > 0 && <span style={{ color: '#555' }}>, </span>}
          <span style={{ color: n.priority === 'high' ? '#ff8060' : '#d8a868', fontWeight: 600 }}>{n.label}</span>
          <span style={{ color: '#888' }}> {n.detail}</span>
        </span>
      ))}
    </div>
  );
}

// ── Multi-pick recommendation list (Section 3) ────────────────────────────────
const PICK_KIND_STYLE = {
  safe:   { icon: '★', color: '#7ec8ff', label: 'SAFE' },
  upside: { icon: '⚡', color: '#ffce5c', label: 'UPSIDE' },
  need:   { icon: '🔧', color: '#e88c64', label: 'NEED' },
  clear:  { icon: '★', color: '#7ec8a0', label: 'CLEAR' },
};

function PicksList({ picks }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {picks.map((p, i) => {
        const s = PICK_KIND_STYLE[p.kind] ?? PICK_KIND_STYLE.safe;
        const cardName = p.card?.name ?? `#${p.card?.grpId ?? '?'}`;
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: 1.3,
          }}>
            <span style={{ color: s.color, flexShrink: 0, fontSize: 12 }}>{s.icon}</span>
            <span style={{ color: s.color, fontWeight: 700, flexShrink: 0, fontSize: 9, letterSpacing: '0.04em', minWidth: 42 }}>
              {s.label}:
            </span>
            <span style={{ color: '#fff', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
              {cardName}
            </span>
            {p.reason && (
              <span style={{ color: '#9a9a9a', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                — {p.reason}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Late-pack insight (Section 4) ─────────────────────────────────────────────
function InsightLine({ insight }) {
  if (!insight) return null;
  const colorMap = { flowing: '#7ec8a0', cut: '#e08080', neutral: '#a8a8a8' };
  const color = colorMap[insight.tone] ?? '#a8a8a8';
  return (
    <div style={{ fontSize: 10, color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: 'italic' }}>
      ◈ {insight.short}
    </div>
  );
}

// ── Assistant section (bottom of overlay) ─────────────────────────────────────
// Section 6B: visually distinct from the card list above, with a header,
// a divider, and a collapse toggle.
export default function AssistantBar({ assistantState, settings, inDraft }) {
  const [collapsed, setCollapsed] = useState(false);

  if (!inDraft) return null;
  const assistantSettings = settings?.assistant ?? {};
  if (assistantSettings.enabled === false) return null;

  const showSignals = assistantSettings.showSignalsInOverlay !== false;
  const showRec     = assistantSettings.showRecommendationInOverlay !== false;

  const colorSignals  = assistantState?.colorSignals ?? null;
  const hasColorData  = assistantState?.hasColorData ?? false;
  const deckNeeds     = assistantState?.deckNeeds ?? [];
  const recommendation = assistantState?.recommendation ?? null;
  const insights      = assistantState?.signalInsights ?? [];
  const picks         = recommendation?.picks ?? null;

  const hasAnything = showSignals || (showRec && (picks?.length || recommendation));
  if (!hasAnything) return null;

  return (
    <div style={{ flexShrink: 0 }}>
      {/* ─── Section divider + header bar ─── */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '4px 10px',
        background: 'rgba(60,90,150,0.22)',
        borderTop: '2px solid rgba(80,140,255,0.45)',
        borderBottom: collapsed ? 'none' : '1px solid rgba(80,140,255,0.18)',
        cursor: 'pointer',
      }}
      onClick={() => setCollapsed(c => !c)}
      title={collapsed ? 'Expand assistant' : 'Collapse assistant'}
      >
        <span style={{
          fontSize: 10, fontWeight: 800, color: '#9fc8ff',
          letterSpacing: '0.10em', textTransform: 'uppercase',
        }}>
          Assistant
        </span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 11, color: '#9fc8ff', fontWeight: 700,
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
          display: 'inline-block', lineHeight: 1,
        }}>
          ▾
        </span>
      </div>

      {/* ─── Body — only render when expanded ─── */}
      {!collapsed && (
        <div style={{
          padding: '8px 10px',
          background: 'linear-gradient(180deg, rgba(20,28,48,0.85) 0%, rgba(10,14,28,0.92) 100%)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {showSignals && colorSignals && (
            <SignalPills colorSignals={colorSignals} hasData={hasColorData} />
          )}
          {showRec && picks && picks.length > 0
            ? <PicksList picks={picks} />
            : (showRec && recommendation && <RecLine recommendation={recommendation} />)}
          {insights.length > 0 && <InsightLine insight={insights[0]} />}
          {deckNeeds.length > 0 && <NeedsLine deckNeeds={deckNeeds} />}
        </div>
      )}
    </div>
  );
}
