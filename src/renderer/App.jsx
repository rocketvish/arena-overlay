import React, { useState, useEffect, useRef } from 'react';
import DraftOverlay from './components/DraftOverlay';
import OverlayHeader from './components/OverlayHeader';
import TestModeBanner from './components/TestModeBanner';
import { useDraftState } from './hooks/useDraftState';
import { useSettings } from './hooks/useSettings';
import { useAssistantState } from './hooks/useAssistantState';

export default function App() {
  const { settings, loading: settingsLoading } = useSettings();
  const { draftState } = useDraftState();
  const assistantState = useAssistantState();

  const [status, setStatus] = useState('watching');
  const [isInteractable, setIsInteractable] = useState(false);
  const [hotkeys, setHotkeys] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [lastLogUpdate, setLastLogUpdate] = useState(null);

  // Banner shows for 3 seconds after the user toggles into interactive mode.
  const [showInteractiveBanner, setShowInteractiveBanner] = useState(false);
  const prevInteractable = useRef(isInteractable);
  useEffect(() => {
    if (!prevInteractable.current && isInteractable) {
      setShowInteractiveBanner(true);
      const id = setTimeout(() => setShowInteractiveBanner(false), 3000);
      prevInteractable.current = isInteractable;
      return () => clearTimeout(id);
    }
    if (prevInteractable.current && !isInteractable) {
      setShowInteractiveBanner(false);
    }
    prevInteractable.current = isInteractable;
  }, [isInteractable]);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.getOverlayLocked?.().then((locked) => setIsInteractable(!locked));
    window.electronAPI.getHotkeyStatus?.().then(setHotkeys);
    const unsubs = [
      window.electronAPI.onStatusUpdate(setStatus),
      window.electronAPI.onInteractableChanged(setIsInteractable),
      window.electronAPI.onHotkeysStatus?.(setHotkeys),
      window.electronAPI.onLogUpdated(setLastLogUpdate),
    ];
    return () => unsubs.forEach((fn) => fn && fn());
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
      // Bright blue border when interactive — 2px so it pops on a transparent overlay.
      border: isInteractable ? '2px solid #5cc8ff' : '1px solid transparent',
      boxShadow: isInteractable ? '0 0 12px rgba(92,200,255,0.45)' : 'none',
      borderRadius: 8,
      color: '#e0e0e0',
      overflow: 'hidden',
      userSelect: isInteractable ? 'auto' : 'none',
      pointerEvents: isInteractable ? 'auto' : 'none',
      transition: 'border-color 0.2s, box-shadow 0.2s',
      position: 'relative',
    }}>
      <TestModeBanner />
      {showInteractiveBanner && (
        <div style={{
          padding: '6px 10px',
          background: 'rgba(92,200,255,0.18)',
          borderBottom: '1px solid rgba(92,200,255,0.4)',
          color: '#9fdcff',
          fontSize: 11,
          fontWeight: 600,
          textAlign: 'center',
          flexShrink: 0,
          letterSpacing: '0.02em',
          // Part of the drag handle — it sits where people grab right after unlocking.
          WebkitAppRegion: 'drag',
          cursor: 'move',
        }}>
          UNLOCKED — drag the top bar to move, corner to resize{hotkeys?.interact?.ok ? `, ${hotkeys.interact.key} to lock` : ''}
        </div>
      )}
      <OverlayHeader
        setCode={draftState.setCode}
        format={draftState.format ?? settings?.general?.draftFormat}
        inDraft={draftState.inDraft}
        packNumber={draftState.packNumber}
        pickNumber={draftState.pickNumber}
        totalPicks={draftState.totalPicks}
        packSize={draftState.packSize}
        interactHotkey={hotkeys?.interact}
        isInteractable={isInteractable}
        isMinimized={isMinimized}
        onToggleMinimize={() => setIsMinimized((m) => !m)}
        onToggleInteract={() => window.electronAPI?.toggleInteract()}
        landsStatus={draftState.landsStatus}
        lastLogUpdate={lastLogUpdate}
        packCardCount={draftState.enrichedPack?.length ?? 0}
        packCardCountMismatch={
          draftState.inDraft &&
          (draftState.enrichedPack?.length ?? 0) > Math.max(1, (draftState.packSize ?? 14) - (draftState.pickNumber ?? 0))
        }
      />

      {!isMinimized && (
        <DraftOverlay
          draftState={draftState}
          settings={settings}
          recommendation={draftState.recommendation}
          assistantState={assistantState}
        />
      )}
      {isInteractable && !isMinimized && <ResizeGrip />}
    </div>
  );
}

// Bottom-right resize handle. Transparent windows can't be edge-resized on
// Windows, so the overlay resizes itself through the main process.
function ResizeGrip() {
  const onPointerDown = (e) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.screenX, y: e.screenY, w: window.outerWidth, h: window.outerHeight };
    let frame = null;
    const onMove = (ev) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        window.electronAPI?.resizeOverlay(start.w + ev.screenX - start.x, start.h + ev.screenY - start.y);
      });
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };
  return (
    <div
      onPointerDown={onPointerDown}
      title="Drag to resize"
      style={{
        position: 'absolute', right: 0, bottom: 0, width: 18, height: 18,
        cursor: 'nwse-resize', WebkitAppRegion: 'no-drag', zIndex: 10,
        background: 'linear-gradient(135deg, transparent 50%, rgba(92,200,255,0.75) 50%)',
        borderBottomRightRadius: 6,
      }}
    />
  );
}
