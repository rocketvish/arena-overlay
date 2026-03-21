import React, { useState, useEffect } from 'react';

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

export default function OverlayHeader({
  setCode, format, inDraft, packNumber, pickNumber, totalPicks,
  isInteractable, isMinimized, onToggleMinimize, onToggleInteract,
  landsStatus, lastLogUpdate,
}) {
  const setName = setCode ? (SET_NAMES[setCode] ?? setCode) : null;
  const formatShort = FORMAT_SHORT[format] ?? format ?? 'Premier';
  const ago = useAgo(lastLogUpdate);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'rgba(0,0,0,0.55)',
      borderBottom: isMinimized ? 'none' : '1px solid rgba(255,255,255,0.07)',
      flexShrink: 0,
      WebkitAppRegion: isInteractable ? 'drag' : 'no-drag',
    }}>
      {/* ── Top row ── */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '5px 10px', gap: 6, minHeight: 28 }}>
        {/* Left: set name or idle */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {inDraft && setName ? (
            <span style={{ fontSize: 11, color: '#c8c8c8', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
              {setName}
              <span style={{ color: '#555', fontWeight: 400, marginLeft: 5 }}>— {formatShort}</span>
            </span>
          ) : (
            <span style={{ fontSize: 10, color: landsStatus === 'fetching' ? '#7ec8a0' : '#444' }}>
              {landsStatus === 'fetching' ? '⟳ Loading…' : 'Waiting for draft…'}
            </span>
          )}
        </div>

        {/* Last log update */}
        {ago && (
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.15)', flexShrink: 0, WebkitAppRegion: 'no-drag' }}
                title="Last log activity">
            ● {ago}
          </span>
        )}

        {/* Controls (drag-exempt) */}
        <div style={{ display: 'flex', gap: 3, WebkitAppRegion: 'no-drag', flexShrink: 0 }}>
          {isInteractable && (
            <>
              <IconBtn onClick={onToggleInteract} title="Lock overlay (Alt+D)">🔒</IconBtn>
              <IconBtn onClick={onToggleMinimize} title={isMinimized ? 'Expand' : 'Collapse'}>
                {isMinimized ? '▼' : '▲'}
              </IconBtn>
            </>
          )}
          {!isInteractable && (
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.12)' }}>Alt+D</span>
          )}
        </div>
      </div>

      {/* ── Pack / pick row ── */}
      {inDraft && !isMinimized && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px 5px', gap: 5 }}>
          <PackPip active={packNumber === 0} done={packNumber > 0} n={1} />
          <PackPip active={packNumber === 1} done={packNumber > 1} n={2} />
          <PackPip active={packNumber === 2} done={packNumber > 2} n={3} />
          <span style={{ fontSize: 11, color: '#7ec8a0', fontWeight: 600, marginLeft: 2 }}>
            Pack {packNumber + 1} · Pick {pickNumber + 1}
          </span>
          {totalPicks > 0 && (
            <span style={{ fontSize: 10, color: '#555', marginLeft: 'auto' }}>
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
      lineHeight: 1, padding: '2px 5px', transition: 'background 0.1s',
    }}
    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.16)')}
    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
    >{children}</button>
  );
}
