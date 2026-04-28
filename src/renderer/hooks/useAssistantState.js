import { useState, useEffect } from 'react';

/**
 * Subscribe to assistant-update events from the main process.
 * Returns the latest assistant state, or null if not yet received.
 */
export function useAssistantState() {
  const [assistantState, setAssistantState] = useState(null);

  useEffect(() => {
    if (!window.electronAPI) return;

    // Seed with whatever the main process already has
    window.electronAPI.getAssistantState?.().then((s) => {
      if (s) setAssistantState(s);
    });

    const unsub = window.electronAPI.onAssistantUpdate?.((s) => {
      setAssistantState(s);
    });

    return () => unsub?.();
  }, []);

  return assistantState;
}
