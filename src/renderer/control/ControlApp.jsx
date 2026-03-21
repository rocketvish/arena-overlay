import React, { useState, useEffect, useCallback } from 'react';
import StatusBar from './components/StatusBar';
import DraftPanel from './components/DraftPanel';
import SettingsPanel from '../components/SettingsPanel';
import { useDraftState } from '../hooks/useDraftState';
import { useSettings } from '../hooks/useSettings';

const NAV_TABS = [
  { id: 'draft', label: 'Draft' },
  { id: 'settings', label: 'Settings' },
];

export default function ControlApp() {
  const { settings, setSetting, loading: settingsLoading } = useSettings();
  const { draftState, reEnrichWithColorPair } = useDraftState(settings);

  const [activeTab, setActiveTab] = useState('draft');
  const [status, setStatus] = useState('watching');
  const [watcherRunning, setWatcherRunning] = useState(true);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubs = [
      window.electronAPI.onStatusUpdate(setStatus),
      window.electronAPI.onUpdateAvailable?.(() => setUpdateAvailable(true)),
      window.electronAPI.onOverlayVisibilityChanged?.((v) => setOverlayVisible(v)),
    ].filter(Boolean);

    window.electronAPI.getWatcherStatus?.().then((s) => {
      if (s) setWatcherRunning(s.running);
    });
    window.electronAPI.getOverlayVisible?.().then((v) => setOverlayVisible(v));

    return () => unsubs.forEach((fn) => fn());
  }, []);

  const handleToggleOverlay = useCallback(async () => {
    const newVisible = !overlayVisible;
    await window.electronAPI?.setOverlayVisible?.(newVisible);
    setOverlayVisible(newVisible);
  }, [overlayVisible]);

  const handleToggleWatcher = useCallback(async () => {
    if (!window.electronAPI) return;
    if (watcherRunning) {
      await window.electronAPI.stopWatcher?.();
      setWatcherRunning(false);
    } else {
      await window.electronAPI.startWatcher?.();
      setWatcherRunning(true);
    }
  }, [watcherRunning]);

  const version = window.electronAPI?.appVersion ?? '0.3.0';

  if (settingsLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#444' }}>
        Loading...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0d0d1a', color: '#e0e0e0' }}>
      <StatusBar status={status} draftState={draftState} watcherRunning={watcherRunning} />

      {updateAvailable && (
        <div style={{ padding: '6px 16px', background: 'rgba(80,160,80,0.2)', borderBottom: '1px solid rgba(80,160,80,0.3)', fontSize: 12, color: '#7ec8a0' }}>
          Update available! Restart the app to install.
        </div>
      )}

      {/* Navigation tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
        {NAV_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '8px 20px', fontSize: 12,
              background: activeTab === tab.id ? 'rgba(255,255,255,0.07)' : 'transparent',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid #5080dc' : '2px solid transparent',
              color: activeTab === tab.id ? '#e0e0e0' : '#666',
              cursor: 'pointer', transition: 'all 0.12s',
            }}
          >
            {tab.label}
          </button>
        ))}

        <div style={{ flex: 1 }} />

        {/* Show / Hide overlay — primary action */}
        <button
          onClick={handleToggleOverlay}
          style={{
            margin: '4px 4px 4px 0', padding: '4px 14px', fontSize: 11, fontWeight: 600,
            background: overlayVisible ? 'rgba(200,60,60,0.25)' : 'rgba(60,200,100,0.25)',
            border: `1px solid ${overlayVisible ? 'rgba(200,60,60,0.5)' : 'rgba(60,200,100,0.5)'}`,
            borderRadius: 4,
            color: overlayVisible ? '#e07070' : '#60d888',
            cursor: 'pointer',
          }}
          title={overlayVisible ? 'Hide the overlay window' : 'Show the overlay window'}
        >
          {overlayVisible ? 'Hide Overlay' : 'Show Overlay'}
        </button>

        <button
          onClick={handleToggleWatcher}
          style={{
            margin: '4px 8px 4px 0', padding: '4px 12px', fontSize: 11,
            background: watcherRunning ? 'rgba(200,80,80,0.2)' : 'rgba(80,200,120,0.2)',
            border: `1px solid ${watcherRunning ? 'rgba(200,80,80,0.4)' : 'rgba(80,200,120,0.4)'}`,
            borderRadius: 4,
            color: watcherRunning ? '#e08080' : '#7ec8a0',
            cursor: 'pointer',
          }}
          title={watcherRunning ? 'Stop log watcher' : 'Start log watcher'}
        >
          {watcherRunning ? 'Stop Watcher' : 'Start Watcher'}
        </button>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'draft' && (
          <DraftPanel
            draftState={draftState}
            settings={settings}
            onSet={setSetting}
            reEnrichWithColorPair={reEnrichWithColorPair}
          />
        )}
        {activeTab === 'settings' && (
          <div style={{ flex: 1, overflowY: 'auto', background: '#0d0d1a' }}>
            <SettingsPanel
              settings={settings}
              onSet={setSetting}
              onClose={() => setActiveTab('draft')}
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '6px 16px', flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: '#333' }}>Arena Overlay v{version}</span>
        <span style={{ fontSize: 10, color: '#333' }}>
          {draftState.inDraft ? `${draftState.setCode ?? '?'} · Pack ${draftState.packNumber + 1}` : 'Idle'}
        </span>
      </div>
    </div>
  );
}
