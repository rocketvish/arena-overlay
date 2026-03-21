import React, { useState, useEffect } from 'react';
import DraftOverlay from './components/DraftOverlay';
import OverlayHeader from './components/OverlayHeader';
import { useDraftState } from './hooks/useDraftState';
import { useSettings } from './hooks/useSettings';

export default function App() {
  const { settings, loading: settingsLoading } = useSettings();
  const { draftState } = useDraftState(settings);

  const [status, setStatus] = useState('watching');
  const [isInteractable, setIsInteractable] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [lastLogUpdate, setLastLogUpdate] = useState(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubs = [
      window.electronAPI.onStatusUpdate(setStatus),
      window.electronAPI.onInteractableChanged(setIsInteractable),
      window.electronAPI.onLogUpdated(setLastLogUpdate),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, []);

  if (settingsLoading) return null;

  const opacity = settings?.overlay?.opacity ?? 0.85;

  return (
    <div style={{
      width: '100%',
      height: isMinimized ? 'auto' : '100%',
      display: 'flex',
      flexDirection: 'column',
      background: `rgba(10,10,22,${opacity})`,
      border: isInteractable ? '1px solid rgba(100,140,255,0.5)' : '1px solid transparent',
      borderRadius: 8,
      color: '#e0e0e0',
      overflow: 'hidden',
      userSelect: isInteractable ? 'auto' : 'none',
      pointerEvents: isInteractable ? 'auto' : 'none',
    }}>
      <OverlayHeader
        setCode={draftState.setCode}
        format={draftState.format ?? settings?.general?.draftFormat}
        inDraft={draftState.inDraft}
        packNumber={draftState.packNumber}
        pickNumber={draftState.pickNumber}
        totalPicks={draftState.totalPicks}
        isInteractable={isInteractable}
        isMinimized={isMinimized}
        onToggleMinimize={() => setIsMinimized((m) => !m)}
        onToggleInteract={() => window.electronAPI?.toggleInteract()}
        landsStatus={draftState.landsStatus}
        lastLogUpdate={lastLogUpdate}
      />

      {!isMinimized && (
        <DraftOverlay
          draftState={draftState}
          settings={settings}
          recommendation={draftState.recommendation}
        />
      )}
    </div>
  );
}
