import React from 'react';

export default function OverlayHeader({
  status,
  isInteractable,
  onToggleInteract,
  onOpenSettings,
  inDraft,
  packNumber,
  pickNumber,
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 10px',
        background: 'rgba(0,0,0,0.4)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        WebkitAppRegion: isInteractable ? 'drag' : 'no-drag',
        flexShrink: 0,
        minHeight: 36,
      }}
    >
      {/* Status / pack-pick info */}
      <span style={{ fontSize: 12, color: inDraft ? '#7ec8a0' : '#999', fontWeight: 500, letterSpacing: '0.02em' }}>
        {status}
      </span>

      {/* Controls — only visible when interactable */}
      {isInteractable && (
        <div style={{ display: 'flex', gap: 6, WebkitAppRegion: 'no-drag' }}>
          <HeaderBtn title="Settings" onClick={onOpenSettings}>⚙</HeaderBtn>
          <HeaderBtn title="Lock overlay (Alt+D)" onClick={onToggleInteract}>🔓</HeaderBtn>
        </div>
      )}

      {/* Lock indicator when non-interactable */}
      {!isInteractable && (
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>Alt+D</span>
      )}
    </div>
  );
}

function HeaderBtn({ children, onClick, title }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 4,
        color: '#ccc',
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: 1,
        padding: '3px 7px',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.18)'}
      onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
    >
      {children}
    </button>
  );
}
