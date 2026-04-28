import React, { useState, useEffect } from 'react';

export default function TestModeBanner() {
  const [replayInfo, setReplayInfo] = useState(null); // null = not active

  useEffect(() => {
    if (!window.electronAPI) return;

    // Seed: check if already active when component mounts
    window.electronAPI.isReplayActive?.().then((r) => {
      if (r?.active) setReplayInfo({ active: true });
    });

    const unsubStart = window.electronAPI.onReplayStarted?.((info) => setReplayInfo(info));
    const unsubEnd   = window.electronAPI.onReplayEnded?.(() => setReplayInfo(null));

    return () => { unsubStart?.(); unsubEnd?.(); };
  }, []);

  if (!replayInfo) return null;

  const { setCode, format, packCount, pickCount } = replayInfo;
  return (
    <div style={{
      padding: '3px 8px',
      background: 'rgba(200,120,30,0.35)',
      borderBottom: '1px solid rgba(200,120,30,0.5)',
      display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
    }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: '#e8a040', letterSpacing: '0.12em' }}>
        TEST MODE
      </span>
      {setCode && (
        <span style={{ fontSize: 9, color: '#aa7030' }}>
          — replaying {setCode} {format} ({packCount ?? '?'} packs / {pickCount ?? '?'} picks)
        </span>
      )}
    </div>
  );
}
