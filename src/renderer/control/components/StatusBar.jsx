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
  FIN: 'Final Fantasy', ECL: 'Edge of Eternities',
  TMT: 'Teenage Mutant Ninja Turtles',
};

export default function StatusBar({ status, draftState, watcherRunning }) {
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
