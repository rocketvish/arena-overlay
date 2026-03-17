import React, { useState, useEffect } from 'react';
import DraftOverlay from './components/DraftOverlay';
import SettingsPanel from './components/SettingsPanel';
import OverlayHeader from './components/OverlayHeader';
import { useDraftState } from './hooks/useDraftState';
import { useSettings } from './hooks/useSettings';

const STATUS_LABELS = {
  watching: 'Watching for Arena...',
  'arena-detected': 'Arena detected',
  'log-not-found': 'Log file not found',
  error: 'Watcher error',
  'draft-active': 'Draft in progress',
};

export default function App() {
  const { settings, setSetting, loading: settingsLoading } = useSettings();
  const { draftState } = useDraftState();

  const [status, setStatus] = useState('watching');
  const [isInteractable, setIsInteractable] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const unsubs = [
      window.electronAPI.onStatusUpdate(setStatus),
      window.electronAPI.onInteractableChanged(setIsInteractable),
      window.electronAPI.onOpenSettings(() => setShowSettings(true)),
    ];
    return () => unsubs.forEach(fn => fn());
  }, []);

  if (settingsLoading) return null;

  const statusLabel = draftState.inDraft
    ? `Pack ${draftState.packNumber + 1} · Pick ${draftState.pickNumber + 1}`
    : (STATUS_LABELS[status] || status);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: isInteractable
          ? 'rgba(10, 10, 20, 0.92)'
          : 'rgba(10, 10, 20, 0.85)',
        border: isInteractable ? '1px solid rgba(120, 160, 255, 0.6)' : '1px solid transparent',
        borderRadius: 8,
        color: '#e8e8e8',
        overflow: 'hidden',
        userSelect: isInteractable ? 'auto' : 'none',
        pointerEvents: isInteractable ? 'auto' : 'none',
      }}
    >
      <OverlayHeader
        status={statusLabel}
        isInteractable={isInteractable}
        onToggleInteract={() => window.electronAPI.toggleInteract()}
        onOpenSettings={() => setShowSettings(true)}
        packNumber={draftState.packNumber}
        pickNumber={draftState.pickNumber}
        inDraft={draftState.inDraft}
      />

      {showSettings ? (
        <SettingsPanel
          settings={settings}
          onSet={setSetting}
          onClose={() => setShowSettings(false)}
        />
      ) : (
        <DraftOverlay
          draftState={draftState}
          settings={settings}
        />
      )}
    </div>
  );
}
