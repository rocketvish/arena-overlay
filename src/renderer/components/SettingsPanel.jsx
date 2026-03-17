import React from 'react';

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        color: '#888',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        marginBottom: 8,
        paddingBottom: 4,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

function Toggle({ label, value, onChange }) {
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', fontSize: 12, color: '#ccc' }}>
      <span>{label}</span>
      <div
        onClick={() => onChange(!value)}
        style={{
          width: 36,
          height: 20,
          borderRadius: 10,
          background: value ? 'rgba(80,160,100,0.7)' : 'rgba(80,80,80,0.5)',
          border: '1px solid rgba(255,255,255,0.1)',
          position: 'relative',
          transition: 'background 0.2s',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <div style={{
          position: 'absolute',
          top: 2,
          left: value ? 16 : 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.15s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        }} />
      </div>
    </label>
  );
}

function SliderRow({ label, value, min, max, step, onChange, format }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#ccc' }}>
        <span>{label}</span>
        <span style={{ color: '#888', fontSize: 11 }}>{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#5080dc' }}
      />
    </div>
  );
}

function SelectRow({ label, value, options, onChange }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, color: '#ccc' }}>{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          background: 'rgba(40,40,60,0.9)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 4,
          color: '#ccc',
          fontSize: 11,
          padding: '3px 6px',
          cursor: 'pointer',
        }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function TextRow({ label, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: '#ccc' }}>{label}</span>
      <input
        type="text"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        style={{
          background: 'rgba(40,40,60,0.9)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 4,
          color: '#ccc',
          fontSize: 10,
          padding: '4px 6px',
          fontFamily: 'monospace',
        }}
      />
    </div>
  );
}

export default function SettingsPanel({ settings, onSet, onClose }) {
  if (!settings) return null;
  const { overlay = {}, columns = {}, display = {}, general = {} } = settings;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0' }}>Settings</span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#888', fontSize: 16, cursor: 'pointer', padding: '0 4px' }}
        >✕</button>
      </div>

      {/* Overlay */}
      <Section title="Overlay">
        <SliderRow
          label="Opacity"
          value={overlay.opacity ?? 0.85}
          min={0.1} max={1.0} step={0.05}
          onChange={v => onSet('overlay.opacity', v)}
          format={v => `${Math.round(v * 100)}%`}
        />
        <Toggle
          label="Visible on start"
          value={overlay.visible ?? true}
          onChange={v => onSet('overlay.visible', v)}
        />
      </Section>

      {/* Columns */}
      <Section title="Stat columns">
        {[
          ['grade', 'Grade'],
          ['gihwr', 'GIH Win Rate'],
          ['ohwr', 'Opening Hand Win Rate'],
          ['gpwr', 'Game in Pack Win Rate'],
          ['alsa', 'Avg Last Seen At'],
          ['iwd', 'Improvement When Drawn'],
        ].map(([key, label]) => (
          <Toggle
            key={key}
            label={label}
            value={columns[key] ?? false}
            onChange={v => onSet(`columns.${key}`, v)}
          />
        ))}
      </Section>

      {/* Display */}
      <Section title="Display">
        <SelectRow
          label="Sort by"
          value={display.sortBy || 'grade'}
          options={[
            { value: 'grade', label: 'Grade' },
            { value: 'gihwr', label: 'GIH Win Rate' },
            { value: 'ohwr', label: 'OH Win Rate' },
            { value: 'alsa', label: 'Avg Last Seen At' },
          ]}
          onChange={v => onSet('display.sortBy', v)}
        />
        <SelectRow
          label="Font size"
          value={display.fontSize || 'medium'}
          options={[
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ]}
          onChange={v => onSet('display.fontSize', v)}
        />
        <Toggle
          label="Compact mode"
          value={display.compactMode ?? false}
          onChange={v => onSet('display.compactMode', v)}
        />
      </Section>

      {/* General */}
      <Section title="General">
        <TextRow
          label="Arena log path"
          value={general.arenaLogPath}
          onChange={v => onSet('general.arenaLogPath', v)}
        />
        <TextRow
          label="Toggle visibility hotkey"
          value={general.hotkey_toggle}
          onChange={v => onSet('general.hotkey_toggle', v)}
        />
        <TextRow
          label="Toggle interact hotkey"
          value={general.hotkey_interact}
          onChange={v => onSet('general.hotkey_interact', v)}
        />
        <Toggle
          label="Launch on startup"
          value={general.autoLaunch ?? false}
          onChange={v => onSet('general.autoLaunch', v)}
        />
        <div style={{ marginTop: 4 }}>
          <button
            onClick={() => window.electronAPI?.restartLogWatcher()}
            style={{
              width: '100%',
              padding: '6px 0',
              background: 'rgba(80,80,120,0.4)',
              border: '1px solid rgba(120,120,200,0.3)',
              borderRadius: 4,
              color: '#aaa',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            Restart Log Watcher
          </button>
        </div>
      </Section>
    </div>
  );
}
