import { useEffect, useState } from 'react';

/** Latest in-game analysis from the main process (null when no game is running). */
export function useGameState() {
  const [game, setGame] = useState(null);
  useEffect(() => {
    if (!window.electronAPI?.onGameUpdate) return;
    window.electronAPI.getGameState?.().then((g) => g && setGame(g));
    return window.electronAPI.onGameUpdate(setGame);
  }, []);
  return game;
}
