import React, { useState, useEffect, useRef } from 'react';
import DraftOverlay from './components/DraftOverlay';
import OverlayHeader from './components/OverlayHeader';
import TestModeBanner from './components/TestModeBanner';
import { useDraftState } from './hooks/useDraftState';
import { useSettings } from './hooks/useSettings';
import { useAssistantState } from './hooks/useAssistantState';
import { useGameState } from './hooks/useGameState';
import GamePanel from './components/GamePanel';

export default function App() {
  const { settings, loading: settingsLoading } = useSettings();
  const { draftState } = useDraftState();
  const assistantState = useAssistantState();
  const game = useGameState();
  // A game in progress takes over the overlay unless a draft is running.
  const showGame = !!game && !draftState.inDraft && settings?.assistant?.gameAssistant !== false;

  const [status, setStatus] = useState('watching');
  // Unpinned (default): the top bar and corner take the mouse. Pinned: nothing does.
  const [isInteractable, setIsInteractable] = useState(true);
  // 'none' | 'body' (cursor over the click-through part) | 'hit' (over a hot spot)
  const [hover, setHover] = useState('none');
  const [isMinimized, setIsMinimized] = useState(false);
  const [lastLogUpdate, setLastLogUpdate] = useState(null);

  // A short banner after pinning says what changed.
  const [pinBanner, setPinBanner] = useState(false);
  const prevInteractable = useRef(isInteractable);
  useEffect(() => {
    if (prevInteractable.current === isInteractable) return;
    prevInteractable.current = isInteractable;
    setPinBanner(!isInteractable);
    const id = setTimeout(() => setPinBanner(false), 3000);
    return () => clearTimeout(id);
  }, [isInteractable]);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.getOverlayLocked?.().then((pinned) => {
      prevInteractable.current = !pinned; // no banner for the initial state
      setIsInteractable(!pinned);
    });
    window.electronAPI.getOverlayHover?.().then((h) => setHover(typeof h === 'string' ? h : 'none'));
    const unsubs = [
      window.electronAPI.onStatusUpdate(setStatus),
      window.electronAPI.onInteractableChanged(setIsInteractable),
      window.electronAPI.onOverlayHover?.(setHover),
      window.electronAPI.onLogUpdated(setLastLogUpdate),
    ];
    return () => unsubs.forEach((fn) => fn && fn());
  }, []);

  useHitRegions();

  if (settingsLoading) return null;

  // The opacity setting fades the background only; text stays crisp. While
  // the cursor passes over the card list (which is click-through), the whole
  // overlay fades so you can see and click the Arena card underneath.
  const opacity = settings?.overlay?.opacity ?? 0.85;
  const active = isInteractable && hover === 'hit';
  const ghost = hover === 'body';

  return (
    <div style={{
      width: '100%',
      height: isMinimized ? 'auto' : '100%',
      display: 'flex',
      flexDirection: 'column',
      background: `rgba(10,10,22,${opacity})`,
      border: active ? '1px solid rgba(92,200,255,0.55)' : '1px solid transparent',
      borderRadius: 8,
      color: '#e0e0e0',
      overflow: 'hidden',
      userSelect: 'none',
      pointerEvents: isInteractable ? 'auto' : 'none',
      opacity: ghost ? GHOST_OPACITY : 1,
      transition: 'opacity 0.12s, border-color 0.15s',
      position: 'relative',
    }}>
      <TestModeBanner />
      {pinBanner && (
        <div style={{
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.08)',
          borderBottom: '1px solid rgba(92,200,255,0.3)',
          color: '#ccc',
          fontSize: 11,
          fontWeight: 600,
          textAlign: 'center',
          flexShrink: 0,
          letterSpacing: '0.02em',
        }}>
          PINNED — even the top bar lets clicks through. Unpin from the tray icon or the control window.
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
        isInteractable={isInteractable}
        hovered={active}
        onDragStart={startWindowDrag}
        isMinimized={isMinimized}
        onToggleMinimize={() => setIsMinimized((m) => !m)}
        landsStatus={draftState.landsStatus}
        idleLabel={showGame ? 'In game' : undefined}
        lastLogUpdate={lastLogUpdate}
        packCardCount={draftState.enrichedPack?.length ?? 0}
        packCardCountMismatch={
          draftState.inDraft &&
          (draftState.enrichedPack?.length ?? 0) > Math.max(1, (draftState.packSize ?? 14) - (draftState.pickNumber ?? 0))
        }
      />

      {!isMinimized && showGame && <GamePanel game={game} />}
      {!isMinimized && !showGame && (
        <DraftOverlay
          draftState={draftState}
          settings={settings}
          recommendation={draftState.recommendation}
          assistantState={assistantState}
        />
      )}
      {isInteractable && !isMinimized && <ResizeGrip lit={active} />}
    </div>
  );
}

// How visible the overlay stays while the cursor passes over its card list.
const GHOST_OPACITY = 0.2;
const HIT_REGION_POLL_MS = 250;

/**
 * Report the rectangles of every [data-hit] element (top bar, resize corner,
 * collapse buttons) to the main process: those are the only places the
 * overlay takes the mouse. Polled because layout shifts with pack contents,
 * banners and collapsing; sent only when something moved.
 */
function useHitRegions() {
  useEffect(() => {
    let last = '';
    const send = () => {
      const rects = [...document.querySelectorAll('[data-hit]')]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }));
      const key = JSON.stringify(rects);
      if (key === last) return;
      last = key;
      window.electronAPI?.setHitRegions?.(rects);
    };
    send();
    const id = setInterval(send, HIT_REGION_POLL_MS);
    return () => clearInterval(id);
  }, []);
}

/**
 * Pointer-capture drag:`apply(dx, dy)` runs at most once per frame while the
 * pointer is down. The main process is told a drag is in progress so the
 * overlay keeps the mouse even if the cursor outruns the window.
 */
function trackPointer(e, apply) {
  e.preventDefault();
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  window.electronAPI?.setOverlayBusy?.(true);
  const start = { x: e.screenX, y: e.screenY };
  let frame = null;
  const onMove = (ev) => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      apply(ev.screenX - start.x, ev.screenY - start.y);
    });
  };
  const onUp = () => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    window.electronAPI?.setOverlayBusy?.(false);
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

// Move the window by dragging the top bar. Done in JS rather than with
// -webkit-app-region: the overlay never takes focus, and Windows only moves
// a window via its caption when it may activate.
function startWindowDrag(e) {
  if (e.button !== 0 || e.target.closest('button')) return;
  const origin = { x: window.screenX, y: window.screenY };
  trackPointer(e, (dx, dy) => window.electronAPI?.moveOverlay?.(origin.x + dx, origin.y + dy));
}

// Bottom-right resize handle. Transparent windows can't be edge-resized on
// Windows, so the overlay resizes itself through the main process.
function ResizeGrip({ lit }) {
  const onPointerDown = (e) => {
    const start = { w: window.outerWidth, h: window.outerHeight };
    trackPointer(e, (dx, dy) => window.electronAPI?.resizeOverlay(start.w + dx, start.h + dy));
  };
  return (
    <div
      data-hit
      onPointerDown={onPointerDown}
      title="Drag to resize"
      style={{
        position: 'absolute', right: 0, bottom: 0, width: 20, height: 20,
        cursor: 'nwse-resize', zIndex: 10,
        background: `linear-gradient(135deg, transparent 50%, rgba(92,200,255,${lit ? 0.8 : 0.25}) 50%)`,
        borderBottomRightRadius: 6,
      }}
    />
  );
}
