import React, { useState, useEffect, useRef } from 'react';

const SET_NAMES = {
  DSK: 'Duskmourn', BLB: 'Bloomburrow', MH3: 'Modern Horizons 3',
  OTJ: 'Outlaws of Thunder Junction', MKM: 'Murders at Karlov Manor',
  LCI: 'Lost Caverns of Ixalan', WOE: 'Wilds of Eldraine',
  MOM: 'March of the Machine', ONE: 'Phyrexia: All Will Be One',
  BRO: 'The Brothers War', DMU: 'Dominaria United',
  FDN: 'Foundations', TDM: 'Tarkir: Dragonstorm',
  FIN: 'Final Fantasy', ECL: 'Edge of Eternities',
};

const FORMAT_SHORT = {
  PremierDraft: 'Premier', QuickDraft: 'Quick',
  TradDraft: 'Traditional', Sealed: 'Sealed',
};

function useAgo(timestamp) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!timestamp) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [timestamp]);

  if (!timestamp) return null;
  const secs = Math.floor((Date.now() - timestamp) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

// ── Lock icon (SVG, scales cleanly) ──────────────────────────────────────────
function LockIcon({ open, color, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
      {open ? (
        <>
          <path d="M7 11V7a5 5 0 019.9-1" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
          <rect x="4" y="11" width="16" height="10" rx="2" stroke={color} strokeWidth="2.2" fill="none" />
          <circle cx="12" cy="16" r="1.5" fill={color} />
        </>
      ) : (
        <>
          <path d="M7 11V7a5 5 0 0110 0v4" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
          <rect x="4" y="11" width="16" height="10" rx="2" stroke={color} strokeWidth="2.2" fill="none" />
          <circle cx="12" cy="16" r="1.5" fill={color} />
        </>
      )}
    </svg>
  );
}

export default function OverlayHeader({
  setCode, format, inDraft, packNumber, pickNumber, totalPicks,
  isInteractable, isMinimized, onToggleMinimize, onToggleInteract,
  landsStatus, lastLogUpdate, packCardCount, packCardCountMismatch,
}) {
  const setName = setCode ? (SET_NAMES[setCode] ?? setCode) : null;
  const formatShort = FORMAT_SHORT[format] ?? format ?? 'Premier';
  const ago = useAgo(lastLogUpdate);

  // Pulse the lock icon for 2s after a state toggle so the user notices.
  const [pulsing, setPulsing] = useState(false);
  const prevInteractable = useRef(isInteractable);
  useEffect(() => {
    if (prevInteractable.current !== isInteractable) {
      setPulsing(true);
      const id = setTimeout(() => setPulsing(false), 2000);
      prevInteractable.current = isInteractable;
      return () => clearTimeout(id);
    }
  }, [isInteractable]);

  const lockColor = isInteractable ? '#5cc8ff' : '#888';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'rgba(0,0,0,0.55)',
      borderBottom: isMinimized ? 'none' : '1px solid rgba(255,255,255,0.07)',
      flexShrink: 0,
      WebkitAppRegion: isInteractable ? 'drag' : 'no-drag',
    }}>
      {/* Pulse keyframes — declared once at the top so styled inline animation works */}
      <style>{`
        @keyframes lockPulse {
          0%, 100% { transform: scale(1); filter: drop-shadow(0 0 0 transparent); }
          50%      { transform: scale(1.35); filter: drop-shadow(0 0 6px ${lockColor}); }
        }
      `}</style>

      {/* ── Top row ── */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '5px 10px', gap: 6, minHeight: 28 }}>
        {/* Lock state indicator (always visible, top-left corner) */}
        <div style={{
          flexShrink: 0,
          WebkitAppRegion: 'no-drag',
          animation: pulsing ? 'lockPulse 0.5s ease-in-out 4' : 'none',
        }}
        title={isInteractable ? 'Unlocked — click to drag/resize' : 'Locked (click-through)'}>
          <LockIcon open={isInteractable} color={lockColor} size={14} />
        </div>

        {/* Left: set name or idle */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {inDraft && setName ? (
            <span style={{ fontSize: 12, color: '#dcdcdc', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
              {setName}
              <span style={{ color: '#666', fontWeight: 400, marginLeft: 5 }}>— {formatShort}</span>
            </span>
          ) : (
            <span style={{ fontSize: 11, color: landsStatus === 'fetching' ? '#7ec8a0' : '#666' }}>
              {landsStatus === 'fetching' ? '⟳ Loading…' : 'Waiting for draft…'}
            </span>
          )}
        </div>

        {/* Last log update */}
        {ago && (
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.18)', flexShrink: 0, WebkitAppRegion: 'no-drag' }}
                title="Last log activity">
            ● {ago}
          </span>
        )}

        {/* Controls (drag-exempt) */}
        <div style={{ display: 'flex', gap: 3, WebkitAppRegion: 'no-drag', flexShrink: 0 }}>
          {isInteractable && (
            <>
              <IconBtn onClick={onToggleInteract} title="Lock overlay (Alt+D)">Lock</IconBtn>
              <IconBtn onClick={onToggleMinimize} title={isMinimized ? 'Expand' : 'Collapse'}>
                {isMinimized ? '▼' : '▲'}
              </IconBtn>
            </>
          )}
          {!isInteractable && (
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.18)' }}>Alt+D</span>
          )}
        </div>
      </div>

      {/* ── Pack / pick row ── */}
      {inDraft && !isMinimized && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px 5px', gap: 5 }}>
          <PackPip active={packNumber === 0} done={packNumber > 0} n={1} />
          <PackPip active={packNumber === 1} done={packNumber > 1} n={2} />
          <PackPip active={packNumber === 2} done={packNumber > 2} n={3} />
          <span style={{ fontSize: 12, color: '#7ec8a0', fontWeight: 700, marginLeft: 2 }}>
            Pack {packNumber + 1} · Pick {pickNumber + 1}
          </span>
          {/* Section 6C: card count, highlighted red when it doesn't match expected */}
          {packCardCount != null && (
            <span title={packCardCountMismatch ? 'Card count exceeds expected — possible ghost card' : undefined}
                  style={{
              fontSize: 10,
              color: packCardCountMismatch ? '#ff8060' : '#888',
              fontWeight: 600,
              marginLeft: 6,
              fontFamily: 'monospace',
            }}>
              {packCardCount} card{packCardCount !== 1 ? 's' : ''}{packCardCountMismatch ? ' ⚠' : ''}
            </span>
          )}
          {totalPicks > 0 && (
            <span style={{ fontSize: 11, color: '#666', marginLeft: 'auto' }}>
              {Math.min(packNumber * 15 + pickNumber + 1, totalPicks)}/{totalPicks}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function PackPip({ active, done, n }) {
  const color = done ? '#3a6a4a' : active ? '#7ec8a0' : '#333';
  const border = done ? '#3a6a4a' : active ? '#7ec8a0' : '#444';
  return (
    <div style={{
      width: 14, height: 14, borderRadius: '50%',
      border: `1.5px solid ${border}`, background: done ? '#1a3a2a' : active ? 'rgba(126,200,160,0.2)' : 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 8, color, fontWeight: 700, flexShrink: 0,
    }}>{n}</div>
  );
}

function IconBtn({ children, onClick, title }) {
  return (
    <button onClick={onClick} title={title} style={{
      background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 3, color: '#bbb', cursor: 'pointer', fontSize: 11,
      lineHeight: 1, padding: '2px 6px', transition: 'background 0.1s',
    }}
    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.16)')}
    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
    >{children}</button>
  );
}
