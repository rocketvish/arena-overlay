import React, { useState, useEffect, useCallback } from 'react';
import DraftOverlay from './components/DraftOverlay';
import SettingsPanel from './components/SettingsPanel';
import OverlayHeader from './components/OverlayHeader';
import { useDraftState } from './hooks/useDraftState';
import { useSettings } from './hooks/useSettings';

export default function App() {
  const { settings, setSetting, loading: settingsLoading } = useSettings();
  const { draftState, reEnrichWithColorPair } = useDraftState(settings);

  const [status, setStatus] = useState('watching');
  const [isInteractable, setIsInteractable] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [sortBy, setSortBy] = useState('grade');
  const [lastLogUpdate, setLastLogUpdate] = useState(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubs = [
      window.electronAPI.onStatusUpdate(setStatus),
      window.electronAPI.onInteractableChanged(setIsInteractable),
      window.electronAPI.onOpenSettings(() => setShowSettings(true)),
      window.electronAPI.onLogUpdated(setLastLogUpdate),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, []);

  // Sync sort preference from settings on load
  useEffect(() => {
    if (settings?.display?.sortBy) setSortBy(settings.display.sortBy);
  }, [settings?.display?.sortBy]);

  const handleSortChange = useCallback((val) => {
    setSortBy(val);
    setSetting('display.sortBy', val);
  }, [setSetting]);

  const handleColorFilterChange = useCallback((val) => {
    setSetting('display.colorFilter', val);
    reEnrichWithColorPair(val);
  }, [setSetting, reEnrichWithColorPair]);

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
        sortBy={sortBy}
        onSortChange={handleSortChange}
        status={status}
        isInteractable={isInteractable}
        isMinimized={isMinimized}
        onToggleMinimize={() => setIsMinimized((m) => !m)}
        onToggleInteract={() => window.electronAPI?.toggleInteract()}
        onOpenSettings={() => setShowSettings(true)}
        landsStatus={draftState.landsStatus}
        lastLogUpdate={lastLogUpdate}
      />

      {!isMinimized && (
        showSettings ? (
          <SettingsPanel
            settings={settings}
            onSet={setSetting}
            onClose={() => setShowSettings(false)}
          />
        ) : (
          <DraftOverlay
            draftState={draftState}
            settings={{ ...settings, display: { ...settings?.display, sortBy } }}
            onColorFilterChange={handleColorFilterChange}
          />
        )
      )}
    </div>
  );
}
