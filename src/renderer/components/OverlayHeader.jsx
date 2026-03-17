import React from 'react';

const SET_NAMES = {
  DSK: 'Duskmourn', BLB: 'Bloomburrow', MH3: 'Modern Horizons 3',
  OTJ: 'Outlaws of Thunder Junction', MKM: 'Murders at Karlov Manor',
  LCI: 'Lost Caverns of Ixalan', WOE: 'Wilds of Eldraine',
  MOM: 'March of the Machine', ONE: 'Phyrexia: All Will Be One',
  BRO: 'The Brothers War', DMU: 'Dominaria United',
  FDN: 'Foundations', TDM: 'Tarkir: Dragonstorm',
  FIN: 'Final Fantasy',
};

const FORMAT_SHORT = {
  PremierDraft: 'Premier', QuickDraft: 'Quick',
  TradDraft: 'Traditional', Sealed: 'Sealed',
};

const SORT_OPTIONS = [
  { value: 'grade',  label: 'Grade' },
  { value: 'gihwr', label: 'GIH%' },
  { value: 'ohwr',  label: 'OH%' },
  { value: 'color', label: 'Color' },
  { value: 'name',  label: 'Name' },
];

const STATUS_LABELS = {
  watching: 'Watching for Arena…',
  'arena-detected': 'Arena detected',
  'log-not-found': 'Log file not found — check settings',
  error: 'Watcher error',
};

export default function OverlayHeader({
  setCode, format, inDraft, packNumber, pickNumber, totalPicks,
  sortBy, onSortChange, status, isInteractable, isMinimized,
  onToggleMinimize, onToggleInteract, onOpenSettings, landsStatus,
}) {
  const setName = setCode ? (SET_NAMES[setCode] ?? setCode) : null;
  const formatShort = FORMAT_SHORT[format] ?? format ?? 'Premier';
  const statusLabel = STATUS_LABELS[status] ?? status ?? 'Watching…';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'rgba(0,0,0,0.55)',
      borderBottom: isMinimized ? 'none' : '1px solid rgba(255,255,255,0.07)',
      flexShrink: 0,
      WebkitAppRegion: isInteractable ? 'drag' : 'no-drag',
    }}>
      {/* ── Top row ── */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '5px 10px', gap: 6, minHeight: 34 }}>
        {/* Left: set name or status */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {inDraft && setName ? (
            <span style={{ fontSize: 11, color: '#c8c8c8', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
              {setName}
              <span style={{ color: '#555', fontWeight: 400, marginLeft: 5 }}>— {formatShort}</span>
            </span>
          ) : (
            <span style={{ fontSize: 11, color: landsStatus === 'error' ? '#f08080' : '#666' }}>
              {landsStatus === 'fetching' ? '⟳ Loading 17Lands…' :
               landsStatus === 'error'    ? '⚠ 17Lands unavailable' :
               statusLabel}
            </span>
          )}
        </div>

        {/* Right: controls (drag-exempt) */}
        {isInteractable && (
          <div style={{ display: 'flex', gap: 4, WebkitAppRegion: 'no-drag', flexShrink: 0 }}>
            {inDraft && (
              <select
                value={sortBy}
                onChange={(e) => onSortChange(e.target.value)}
                title="Sort cards by"
                style={{
                  background: 'rgba(30,30,50,0.95)', border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 3, color: '#bbb', fontSize: 10, padding: '2px 4px', cursor: 'pointer',
                }}
              >
                {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
            <IconBtn title="Settings (⚙)" onClick={onOpenSettings}>⚙</IconBtn>
            <IconBtn title="Lock overlay — Alt+D" onClick={onToggleInteract}>🔓</IconBtn>
            <IconBtn title={isMinimized ? 'Expand' : 'Collapse'} onClick={onToggleMinimize}>
              {isMinimized ? '▼' : '▲'}
            </IconBtn>
          </div>
        )}
        {!isInteractable && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.13)', flexShrink: 0 }}>Alt+D</span>
        )}
      </div>

      {/* ── Pack / pick row ── */}
      {inDraft && !isMinimized && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px 6px', gap: 6 }}>
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
      borderRadius: 3, color: '#bbb', cursor: 'pointer', fontSize: 12,
      lineHeight: 1, padding: '3px 6px', transition: 'background 0.1s',
    }}
    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.16)')}
    onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
    >{children}</button>
  );
}
