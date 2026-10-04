import React from 'react';

// ── Primitives ────────────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: '#666', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  );
}

function Toggle({ label, value, onChange, description }) {
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', gap: 8 }}>
      <div>
        <span style={{ fontSize: 12, color: '#c8c8c8' }}>{label}</span>
        {description && <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>{description}</div>}
      </div>
      <div onClick={() => onChange(!value)} style={{
        width: 36, height: 20, borderRadius: 10, flexShrink: 0,
        background: value ? 'rgba(70,160,90,0.7)' : 'rgba(70,70,70,0.5)',
        border: '1px solid rgba(255,255,255,0.1)',
        position: 'relative', transition: 'background 0.2s', cursor: 'pointer',
      }}>
        <div style={{
          position: 'absolute', top: 2, left: value ? 16 : 2,
          width: 14, height: 14, borderRadius: '50%',
          background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
        }} />
      </div>
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange, format }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#c8c8c8' }}>
        <span>{label}</span>
        <span style={{ color: '#777', fontSize: 11, fontFamily: 'monospace' }}>
          {format ? format(value) : value}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#5080dc' }}
      />
    </div>
  );
}

function Select({ label, value, options, onChange }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, color: '#c8c8c8' }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{
        background: 'rgba(30,30,50,0.9)', border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 4, color: '#c8c8c8', fontSize: 11, padding: '3px 6px', cursor: 'pointer',
      }}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function TextInput({ label, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: '#c8c8c8' }}>{label}</span>
      <input type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} style={{
        background: 'rgba(30,30,50,0.9)', border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 4, color: '#b0b0b0', fontSize: 10, padding: '4px 7px',
        fontFamily: 'monospace',
      }} />
    </div>
  );
}

function ActionBtn({ label, onClick, danger }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', padding: '6px 0',
      background: danger ? 'rgba(120,30,30,0.35)' : 'rgba(60,60,100,0.35)',
      border: `1px solid ${danger ? 'rgba(180,60,60,0.4)' : 'rgba(100,100,180,0.3)'}`,
      borderRadius: 4, color: danger ? '#e08080' : '#9090c0',
      fontSize: 11, cursor: 'pointer', transition: 'background 0.1s',
    }}
    onMouseEnter={(e) => (e.currentTarget.style.background = danger ? 'rgba(150,40,40,0.5)' : 'rgba(80,80,130,0.5)')}
    onMouseLeave={(e) => (e.currentTarget.style.background = danger ? 'rgba(120,30,30,0.35)' : 'rgba(60,60,100,0.35)')}
    >{label}</button>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function SettingsPanel({ settings, onSet, onClose }) {
  if (!settings) return null;
  const { overlay = {}, columns = {}, display = {}, general = {}, assistant = {} } = settings;

  async function handleClearCache() {
    await window.electronAPI?.clearCache();
    alert('Cache cleared. Re-fetch will happen on next draft start.');
  }

  async function handleReset() {
    if (!confirm('Reset all settings to defaults?')) return;
    const fresh = await window.electronAPI?.resetSettings();
    if (fresh) window.location.reload();
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0' }}>Settings</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#666', fontSize: 16, cursor: 'pointer', padding: '0 4px' }}>✕</button>
      </div>

      {/* Overlay */}
      <Section title="Overlay">
        <Slider label="Opacity" value={overlay.opacity ?? 0.85} min={0.1} max={1} step={0.05}
          onChange={(v) => onSet('overlay.opacity', v)} format={(v) => `${Math.round(v * 100)}%`} />
      </Section>

      {/* Stat columns */}
      <Section title="Stat columns">
        {[
          ['grade', 'Grade', 'Letter grade (A+–F) based on σ from mean'],
          ['gihwr', 'GIH Win Rate', 'Win rate when card is in opening hand or drawn'],
          ['ohwr',  'Opening Hand Win Rate', 'Win rate when card is in opening hand'],
          ['gpwr',  'Game in Pack Win Rate', 'Overall win rate when in deck'],
          ['ata',   'Avg Taken At (ATA)', 'How early 17Lands drafters take the card'],
          ['alsa',  'Avg Last Seen At (ALSA)', 'Average pick position when last seen'],
          ['iwd',   'Improvement When Drawn', 'Win rate boost when drawn vs not'],
        ].map(([key, label, desc]) => (
          <Toggle key={key} label={label} description={desc}
            value={columns[key] ?? false} onChange={(v) => onSet(`columns.${key}`, v)} />
        ))}
      </Section>

      {/* Draft Assistant */}
      <Section title="Draft Assistant">
        <Toggle label="Enable Draft Assistant"
          description="Analyze color signals, deck needs, and recommend picks"
          value={assistant.enabled !== false}
          onChange={(v) => onSet('assistant.enabled', v)} />
        <Toggle label="Show signals in overlay"
          description="Color openness pills in the overlay"
          value={assistant.showSignalsInOverlay !== false}
          onChange={(v) => onSet('assistant.showSignalsInOverlay', v)} />
        <Toggle label="Show pick recommendation in overlay"
          description="★ recommended pick line in the overlay"
          value={assistant.showRecommendationInOverlay !== false}
          onChange={(v) => onSet('assistant.showRecommendationInOverlay', v)} />
        <Toggle label="In-game assistant"
          description="During games: mulligan data, opponent's likely instant-speed cards, draw odds (needs Arena's Detailed Logs)"
          value={assistant.gameAssistant !== false}
          onChange={(v) => onSet('assistant.gameAssistant', v)} />
        <Slider label="Signal confidence threshold"
          description="Minimum late packs seen before showing openness labels"
          value={assistant.confidenceThreshold ?? 4}
          min={1} max={10} step={1}
          onChange={(v) => onSet('assistant.confidenceThreshold', v)} />
        <Select label="Draft style preference"
          value={assistant.draftStyle ?? 'balanced'}
          options={[
            { value: 'best-card', label: 'Best card available' },
            { value: 'balanced',  label: 'Balanced' },
            { value: 'signals',   label: 'Prioritize signals' },
          ]}
          onChange={(v) => onSet('assistant.draftStyle', v)} />
      </Section>

      {/* Display */}
      <Section title="Display">
        <Toggle label="Show recommendation bar" description="Highlight the best pick in the overlay"
          value={display.showRecommendation ?? true} onChange={(v) => onSet('display.showRecommendation', v)} />
        <Toggle label="Compact mode" value={display.compactMode ?? false} onChange={(v) => onSet('display.compactMode', v)} />
      </Section>

      {/* General */}
      <Section title="General">
        <Select label="Draft format" value={general.draftFormat ?? 'PremierDraft'}
          options={[
            { value: 'PremierDraft', label: 'Premier Draft' },
            { value: 'QuickDraft',   label: 'Quick Draft' },
            { value: 'TradDraft',    label: 'Traditional Draft' },
            { value: 'Sealed',       label: 'Sealed' },
          ]}
          onChange={(v) => onSet('general.draftFormat', v)} />
        <TextInput label="Arena log path"
          value={general.arenaLogPath}
          onChange={(v) => onSet('general.arenaLogPath', v)} />
        <TextInput label="Toggle visibility hotkey"
          value={general.hotkey_toggle}
          onChange={(v) => onSet('general.hotkey_toggle', v)} />
        <TextInput label="Toggle interact hotkey"
          value={general.hotkey_interact}
          onChange={(v) => onSet('general.hotkey_interact', v)} />
        <Toggle label="Launch on system startup"
          value={general.autoLaunch ?? false}
          onChange={(v) => onSet('general.autoLaunch', v)} />
      </Section>

      {/* Actions */}
      <Section title="Actions">
        <ActionBtn label="Restart Log Watcher" onClick={() => window.electronAPI?.restartLogWatcher()} />
        <ActionBtn label="Clear 17Lands cache and re-fetch" onClick={handleClearCache} />
        <ActionBtn label="Check for Updates" onClick={() => window.electronAPI?.checkForUpdates?.()} />
        <ActionBtn label="Reset all settings to defaults" onClick={handleReset} danger />
      </Section>
    </div>
  );
}
