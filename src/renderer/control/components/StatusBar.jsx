import React from 'react';

const STATUS_LABELS = {
  watching: 'Watching for Arena...',
  'arena-detected': 'Arena detected',
  'log-not-found': 'Log file not found — check settings',
  error: 'Watcher error',
  stopped: 'Log watcher stopped',
  'log-stale': 'Log appears stale — Arena may have closed',
};

const STATUS_COLORS = {
  watching: '#888',
  'arena-detected': '#7ec8a0',
  'log-not-found': '#e08080',
  error: '#e08080',
  stopped: '#e0a030',
  'log-stale': '#e0a030',
};

const FORMAT_SHORT = {
  PremierDraft: 'Premier Draft',
  QuickDraft: 'Quick Draft',
  TradDraft: 'Traditional Draft',
  Sealed: 'Sealed',
};

const SET_NAMES = {
  DSK: 'Duskmourn', BLB: 'Bloomburrow', MH3: 'Modern Horizons 3',
  OTJ: 'Outlaws of Thunder Junction', MKM: 'Murders at Karlov Manor',
  LCI: 'Lost Caverns of Ixalan', WOE: 'Wilds of Eldraine',
  MOM: 'March of the Machine', ONE: 'Phyrexia: All Will Be One',
  BRO: 'The Brothers War', DMU: 'Dominaria United',
  FDN: 'Foundations', TDM: 'Tarkir: Dragonstorm',
  FIN: 'Final Fantasy', EOE: 'Edge of Eternities', ECL: 'Lorwyn Eclipsed',
  TLA: 'Avatar: The Last Airbender', TMT: 'Teenage Mutant Ninja Turtles',
};

// Click to lock/unlock — works even when the hotkey is taken by another app.
function OverlayLockChip({ isInteractable, hotkey }) {
  const color = isInteractable ? '#5cc8ff' : '#7a7a7a';
  const bg = isInteractable ? 'rgba(92,200,255,0.18)' : 'rgba(255,255,255,0.04)';
  const border = isInteractable ? 'rgba(92,200,255,0.55)' : 'rgba(255,255,255,0.12)';
  const label = isInteractable ? 'OVERLAY: UNLOCKED — click to lock' : 'OVERLAY: LOCKED — click to unlock';
  const hotkeyNote = !hotkey?.key ? ''
    : hotkey.ok ? ` (or press ${hotkey.key})`
    : `. The ${hotkey.key} hotkey could not be registered — another app is using it; change it in Settings.`;
  return (
    <button
      onClick={() => window.electronAPI?.setOverlayLocked?.(isInteractable)}
      title={(isInteractable
        ? 'Overlay can be dragged and resized. Click to lock it (click-through, fixed in place)'
        : 'Overlay is click-through and fixed in place. Click to unlock it for moving/resizing') + hotkeyNote}
      style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', borderRadius: 4,
      background: bg, border: `1px solid ${border}`,
      fontSize: 10, fontWeight: 700, color, letterSpacing: '0.04em',
      flexShrink: 0, cursor: 'pointer', fontFamily: 'inherit',
    }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
        {isInteractable ? (
          <path d="M7 11V7a5 5 0 019.9-1M4 11h16v10H4z" stroke={color} strokeWidth="2.5" fill="none" strokeLinecap="round" />
        ) : (
          <path d="M7 11V7a5 5 0 0110 0v4M4 11h16v10H4z" stroke={color} strokeWidth="2.5" fill="none" strokeLinecap="round" />
        )}
      </svg>
      {label}
      {hotkey && !hotkey.ok && <span style={{ color: '#e0a030' }} title={`${hotkey.key} is in use by another app`}>⚠</span>}
    </button>
  );
}

export default function StatusBar({ status, draftState, watcherRunning, isInteractable, interactHotkey }) {
  const { inDraft, setCode, packNumber, pickNumber, format } = draftState;
  const statusLabel = STATUS_LABELS[status] ?? status ?? 'Watching...';
  const statusColor = STATUS_COLORS[status] ?? '#888';
  const setName = setCode ? (SET_NAMES[setCode] ?? setCode) : null;
  const formatName = FORMAT_SHORT[format] ?? format ?? '';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 16px',
      background: 'rgba(255,255,255,0.04)',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      flexShrink: 0,
    }}>
      {/* Watcher status dot */}
      <div style={{
        width: 8, height: 8, borderRadius: '50%',
        background: watcherRunning ? '#7ec8a0' : '#e08080',
        boxShadow: watcherRunning ? '0 0 6px rgba(126,200,160,0.6)' : '0 0 6px rgba(224,128,128,0.5)',
        flexShrink: 0,
      }} title={watcherRunning ? 'Watcher running' : 'Watcher stopped'} />

      {/* Status text */}
      <span style={{ fontSize: 12, color: statusColor, flex: 1 }}>
        {inDraft && setName
          ? `Draft active: ${setName} — ${formatName}`
          : statusLabel}
      </span>

      {/* Overlay lock state — visible regardless of draft state */}
      <OverlayLockChip isInteractable={!!isInteractable} hotkey={interactHotkey} />

      {/* Pack/pick info when in draft */}
      {inDraft && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: '#7ec8a0', fontWeight: 600 }}>
            Pack {packNumber + 1} · Pick {pickNumber + 1}
          </span>
          <span style={{ fontSize: 10, color: '#555' }}>
            ({setCode})
          </span>
        </div>
      )}
    </div>
  );
}
