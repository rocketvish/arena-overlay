import { useState, useEffect, useCallback } from 'react';

export function useSettings() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!window.electronAPI) {
      setLoading(false);
      return;
    }
    window.electronAPI.getSettings().then(s => {
      setSettings(s);
      setLoading(false);
    });

    // Keep settings in sync when changed from any window
    const unsub = window.electronAPI.onSettingsChanged?.((s) => setSettings(s));
    return () => unsub?.();
  }, []);

  const setSetting = useCallback(async (keyPath, value) => {
    if (!window.electronAPI) return;
    const updated = await window.electronAPI.setSetting(keyPath, value);
    setSettings(updated);
  }, []);

  return { settings, setSetting, loading };
}
