import { useState, useEffect } from 'react';
import { matchCards } from '../utils/cardMatcher';

const INITIAL_STATE = {
  inDraft: false,
  setCode: null,
  packNumber: 0,
  pickNumber: 0,
  currentPack: [],
  pickedCards: [],
};

export function useDraftState() {
  const [draftState, setDraftState] = useState(INITIAL_STATE);

  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubs = [
      window.electronAPI.onDraftStarted(({ setCode }) => {
        setDraftState({
          ...INITIAL_STATE,
          inDraft: true,
          setCode,
        });
      }),

      window.electronAPI.onPackOpened(({ packNumber, pickNumber, cards, setCode }) => {
        // Enrich cards with any cached 17Lands data
        const enriched = matchCards(cards, setCode);
        setDraftState(prev => ({
          ...prev,
          inDraft: true,
          setCode: setCode || prev.setCode,
          packNumber,
          pickNumber,
          currentPack: enriched,
        }));
      }),

      window.electronAPI.onCardPicked(({ grpId, pickedCards }) => {
        setDraftState(prev => ({
          ...prev,
          currentPack: [],
          pickedCards: pickedCards || [...prev.pickedCards, { grpId }],
        }));
      }),

      window.electronAPI.onDraftEnded(() => {
        setDraftState(prev => ({ ...prev, inDraft: false, currentPack: [] }));
      }),
    ];

    return () => unsubs.forEach(fn => fn && fn());
  }, []);

  return { draftState };
}
