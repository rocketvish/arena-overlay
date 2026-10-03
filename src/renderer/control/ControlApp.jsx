import React, { useState, useEffect, useCallback } from 'react';
import StatusBar from './components/StatusBar';
import DraftPanel from './components/DraftPanel';
import AssistantPanel from './components/AssistantPanel';
import SettingsPanel from '../components/SettingsPanel';
import { useDraftState } from '../hooks/useDraftState';
import { useSettings } from '../hooks/useSettings';
import { useAssistantState } from '../hooks/useAssistantState';

const NAV_TABS = [
  { id: 'draft',     label: 'Draft' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'settings',  label: 'Settings' },
];

export default function ControlApp() {
  const { settings, setSetting, loading: settingsLoading } = useSettings();
  const { draftState, refreshLandsData } = useDraftState();
  const assistantState = useAssistantState();

  const [activeTab, setActiveTab] = useState('draft');
  const [status, setStatus] = useState('watching');
  const [watcherRunning, setWatcherRunning] = useState(true);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [overlayInteractable, setOverlayInteractable] = useState(false);
  const [hotkeys, setHotkeys] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);  // { version, downloaded }
  const [version, setVersion] = useState('0.5.0');
  const [replayActive, setReplayActive] = useState(false);
  const [replayInfo, setReplayInfo] = useState(null);
  const [replayError, setReplayError] = useState(null);

  useEffect(() => {
    if (!window.electronAPI) return;

    window.electronAPI.getAppVersion?.().then((v) => { if (v) setVersion(v); });
    window.electronAPI.getWatcherStatus?.().then((s) => { if (s) setWatcherRunning(s.running); });
    window.electronAPI.getOverlayVisible?.().then((v) => setOverlayVisible(v));
    window.electronAPI.getOverlayLocked?.().then((locked) => setOverlayInteractable(!locked));
    window.electronAPI.getHotkeyStatus?.().then(setHotkeys);

    const unsubs = [
      window.electronAPI.onStatusUpdate((s) => {
        setStatus(s);
        // The watcher can start after this window first asked for its status.
        if (s === 'stopped') setWatcherRunning(false);
        else if (s === 'watching' || s === 'arena-detected' || s === 'log-stale') setWatcherRunning(true);
      }),
      window.electronAPI.onUpdateAvailable?.((d) => setUpdateInfo((prev) => ({ ...prev, version: d?.version, downloaded: false }))),
      window.electronAPI.onUpdateDownloaded?.((d) => setUpdateInfo((prev) => ({ ...prev, version: d?.version, downloaded: true }))),
      window.electronAPI.onOverlayVisibilityChanged?.((v) => setOverlayVisible(v)),
      window.electronAPI.onInteractableChanged?.(setOverlayInteractable),
      window.electronAPI.onHotkeysStatus?.(setHotkeys),
    ].filter(Boolean);

    return () => unsubs.forEach((fn) => fn());
  }, []);

  // Replay event listeners
  useEffect(() => {
    if (!window.electronAPI) return;
    // Seed current replay state
    window.electronAPI.isReplayActive?.().then((r) => {
      if (r?.active) setReplayActive(true);
    });
    const unsubStart = window.electronAPI.onReplayStarted?.((info) => {
      setReplayActive(true);
      setReplayInfo(info);
      setReplayError(null);
    });
    const unsubEnd = window.electronAPI.onReplayEnded?.(() => {
      setReplayActive(false);
    });
    return () => { unsubStart?.(); unsubEnd?.(); };
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

  const handleToggleReplay = useCallback(async () => {
    if (!window.electronAPI) return;
    setReplayError(null);
    if (replayActive) {
      await window.electronAPI.stopReplay?.();
      setReplayActive(false);
      setWatcherRunning(true); // watcher restarted by main process
    } else {
      const result = await window.electronAPI.startReplay?.({ pickDelayMs: 2000 });
      if (result?.ok) {
        setReplayActive(true);
        setReplayInfo(result.draftInfo ?? null);
        setWatcherRunning(false); // watcher paused during replay
      } else {
        setReplayError(result?.error ?? 'Failed to start replay');
      }
    }
  }, [replayActive]);

  if (settingsLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#444' }}>
        Loading...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0d0d1a', color: '#e0e0e0' }}>
      <StatusBar status={status} draftState={draftState} watcherRunning={watcherRunning} isInteractable={overlayInteractable} interactHotkey={hotkeys?.interact} />

      {updateInfo && (
        <div style={{ padding: '6px 16px', background: 'rgba(80,160,80,0.18)', borderBottom: '1px solid rgba(80,160,80,0.3)', fontSize: 12, color: '#7ec8a0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1 }}>
            {updateInfo.downloaded
              ? `v${updateInfo.version} ready — restart to install`
              : `v${updateInfo.version} available`}
          </span>
          {!updateInfo.downloaded && (
            <button
              onClick={() => window.electronAPI?.downloadUpdate?.()}
              style={{ padding: '2px 10px', fontSize: 11, background: 'rgba(80,140,220,0.22)', border: '1px solid rgba(80,140,220,0.45)', borderRadius: 3, color: '#8fb8ff', cursor: 'pointer' }}
            >
              Download
            </button>
          )}
          {updateInfo.downloaded && (
            <button
              onClick={() => window.electronAPI?.quitAndInstall?.()}
              style={{ padding: '2px 10px', fontSize: 11, background: 'rgba(80,200,120,0.25)', border: '1px solid rgba(80,200,120,0.5)', borderRadius: 3, color: '#7ec8a0', cursor: 'pointer' }}
            >
              Restart &amp; Install
            </button>
          )}
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
            margin: '4px 4px 4px 0', padding: '4px 12px', fontSize: 11,
            background: watcherRunning ? 'rgba(200,80,80,0.2)' : 'rgba(80,200,120,0.2)',
            border: `1px solid ${watcherRunning ? 'rgba(200,80,80,0.4)' : 'rgba(80,200,120,0.4)'}`,
            borderRadius: 4,
            color: watcherRunning ? '#e08080' : '#7ec8a0',
            cursor: 'pointer',
          }}
          title={watcherRunning ? 'Stop log watcher' : 'Start log watcher'}
        >
          {watcherRunning ? 'Stop' : 'Start'} Watcher
        </button>

        <button
          onClick={handleToggleReplay}
          style={{
            margin: '4px 8px 4px 0', padding: '4px 12px', fontSize: 11,
            background: replayActive ? 'rgba(200,120,30,0.35)' : 'rgba(100,100,100,0.2)',
            border: `1px solid ${replayActive ? 'rgba(200,120,30,0.6)' : 'rgba(100,100,100,0.35)'}`,
            borderRadius: 4,
            color: replayActive ? '#e8a040' : '#888',
            cursor: 'pointer',
            fontWeight: replayActive ? 600 : 400,
          }}
          title={replayActive ? 'Stop test replay' : 'Replay last draft from Player.log (2s between picks)'}
        >
          {replayActive ? '■ Stop Test' : '▶ Test Mode'}
        </button>
      </div>

      {/* Replay active banner */}
      {replayActive && replayInfo && (
        <div style={{ padding: '4px 16px', background: 'rgba(200,120,30,0.2)', borderBottom: '1px solid rgba(200,120,30,0.35)', fontSize: 11, color: '#c89040', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700 }}>TEST MODE</span>
          <span style={{ color: '#906830' }}>—</span>
          <span>Replaying {replayInfo.setCode} {replayInfo.format} · {replayInfo.packCount ?? '?'} packs · {replayInfo.pickCount ?? '?'} picks · 2s between events</span>
        </div>
      )}
      {/* Replay error */}
      {replayError && (
        <div style={{ padding: '4px 16px', background: 'rgba(200,60,60,0.2)', borderBottom: '1px solid rgba(200,60,60,0.35)', fontSize: 11, color: '#e08080', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Replay error: {replayError}</span>
          <button onClick={() => setReplayError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#e08080', cursor: 'pointer', fontSize: 12 }}>✕</button>
        </div>
      )}

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'draft' && (
          <DraftPanel
            draftState={draftState}
            assistantState={assistantState}
            settings={settings}
            onSet={setSetting}
            onRefreshData={refreshLandsData}
          />
        )}
        {activeTab === 'assistant' && (
          <AssistantPanel
            assistantState={assistantState}
            draftState={draftState}
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
