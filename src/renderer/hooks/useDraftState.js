import { useState, useEffect, useRef, useCallback } from 'react';
import {
  loadSetData,
  loadColorPairData,
  matchCards,
  getMissingIds,
  cacheArenaIds,
  clearSetData,
} from '../utils/cardMatcher';

const INITIAL_STATE = {
  inDraft: false,
  setCode: null,
  setName: null,
  format: 'PremierDraft',
  packNumber: 0,
  pickNumber: 0,
  totalPicks: 45, // 3 packs × 15 cards
  currentPack: [],   // raw cards waiting for enrichment
  enrichedPack: [],  // cards with 17Lands stats
  pickedCards: [],   // accumulated picks with stats
  landsStatus: null, // 'fetching' | 'loaded' | 'error'
  landsError: null,
  recommendation: null, // { primary, secondary, explanation, colors }
};

export function useDraftState(settings) {
  const [draftState, setDraftState] = useState(INITIAL_STATE);
  // Keep a ref to current pack so we can re-enrich when 17Lands data arrives
  const pendingPack = useRef(null);
  const currentSetCode = useRef(null);
  const currentFormat = useRef('PremierDraft');
  // Track landsStatus synchronously so onPackOpened can see it without stale closure
  const landsStatusRef = useRef(null);

  // ── Enrichment helper ──────────────────────────────────────────────────────
  const enrich = useCallback(
    (cards, setCode, format, colorPair) => {
      if (!cards || cards.length === 0) return [];
      return matchCards(cards, setCode, format, colorPair);
    },
    []
  );

  // Fetch 17Lands data for a set and load it into the matcher
  const fetchLandsData = useCallback(async (setCode, format) => {
    if (!window.electronAPI || !setCode) return;

    landsStatusRef.current = 'fetching';
    setDraftState((prev) => ({ ...prev, landsStatus: 'fetching', landsError: null }));

    try {
      const result = await window.electronAPI.fetchSetData(setCode, format);
      if (result?.data) {
        loadSetData(setCode, format, result.data);
        landsStatusRef.current = 'loaded';
        setDraftState((prev) => ({
          ...prev,
          landsStatus: 'loaded',
          enrichedPack: pendingPack.current
            ? enrich(pendingPack.current, setCode, format, prev.display?.colorFilter ?? 'all')
            : prev.enrichedPack,
        }));
      } else if (result?.noData) {
        landsStatusRef.current = 'no-data';
        setDraftState((prev) => ({ ...prev, landsStatus: 'no-data', landsError: null }));
      } else {
        landsStatusRef.current = 'error';
        setDraftState((prev) => ({
          ...prev,
          landsStatus: 'error',
          landsError: result?.error ?? 'Unknown error',
        }));
      }
    } catch (err) {
      landsStatusRef.current = 'error';
      setDraftState((prev) => ({
        ...prev,
        landsStatus: 'error',
        landsError: err.message,
      }));
    }
  }, [enrich]);

  // Re-enrich current pack when color filter changes
  const reEnrichWithColorPair = useCallback(
    async (colorPair) => {
      const setCode = currentSetCode.current;
      const format = currentFormat.current;
      if (!setCode || !pendingPack.current) return;

      // Try to load color pair data if not already loaded (fire-and-forget, cached)
      if (colorPair && colorPair !== 'all' && window.electronAPI) {
        window.electronAPI.fetchColorPairData(setCode, format, colorPair).then((result) => {
          if (result?.data) {
            loadColorPairData(setCode, format, colorPair, result.data);
            setDraftState((prev) => ({
              ...prev,
              enrichedPack: enrich(pendingPack.current, setCode, format, colorPair),
            }));
          }
        });
      }

      setDraftState((prev) => ({
        ...prev,
        enrichedPack: enrich(pendingPack.current, setCode, format, colorPair),
      }));
    },
    [enrich]
  );

  // ── IPC event listeners ────────────────────────────────────────────────────
  useEffect(() => {
    if (!window.electronAPI) return;

    const format = settings?.general?.draftFormat ?? 'PremierDraft';

    const unsubs = [
      window.electronAPI.onDraftStarted(({ setCode }) => {
        currentSetCode.current = setCode;
        currentFormat.current = format;
        pendingPack.current = null;
        landsStatusRef.current = null;
        clearSetData(setCode);

        setDraftState({
          ...INITIAL_STATE,
          inDraft: true,
          setCode,
          format,
        });

        // Kick off 17Lands fetch
        if (setCode) fetchLandsData(setCode, format);
      }),

      window.electronAPI.onPackOpened(async ({ packNumber, pickNumber, cards, setCode }) => {
        const sc = setCode || currentSetCode.current;
        const fmt = currentFormat.current;
        const colorPair = settings?.display?.colorFilter ?? 'all';

        pendingPack.current = cards;
        if (sc) currentSetCode.current = sc;

        // Only call Scryfall when 17Lands won't resolve the names itself.
        // If 17Lands is fetching, skip — re-enrichment runs when it loads.
        // If 17Lands has no data or errored, try Scryfall as a fallback.
        const ls = landsStatusRef.current;
        const missingIds = (ls === 'no-data' || ls === 'error' || ls === null)
          ? getMissingIds(cards, sc, fmt)
          : [];
        if (missingIds.length > 0 && window.electronAPI) {
          window.electronAPI.resolveArenaIds(missingIds).then((idMap) => {
            if (idMap && Object.keys(idMap).length > 0) {
              cacheArenaIds(idMap);
              // Re-enrich with the now-resolved names
              setDraftState((prev) => ({
                ...prev,
                enrichedPack: enrich(pendingPack.current, sc, fmt, colorPair),
              }));
            }
          });
        }

        const enriched = enrich(cards, sc, fmt, colorPair);

        // Sanity check: enriched pack must match the raw pack 1-to-1
        if (enriched.length !== cards.length) {
          console.warn(
            `[useDraftState] enrichedPack length mismatch: raw=${cards.length} enriched=${enriched.length}`,
            'raw:', cards.map(c => c.grpId),
            'enriched:', enriched.map(c => c.grpId),
          );
        }

        setDraftState((prev) => ({
          ...prev,
          inDraft: true,
          setCode: sc || prev.setCode,
          packNumber,
          pickNumber,
          currentPack: cards,
          enrichedPack: enriched,
          recommendation: null, // Will be set after enrichment if data available
        }));
      }),

      window.electronAPI.onCardPicked(({ grpId, pickedCards: rawPicked }) => {
        setDraftState((prev) => {
          // Find the picked card in enrichedPack to preserve its stats
          const pickedCard =
            prev.enrichedPack.find((c) => c.grpId === grpId) ?? { grpId };

          const pickedCards = rawPicked
            ? rawPicked.map((p) => {
                const existing = prev.pickedCards.find((x) => x.grpId === p.grpId);
                return existing ?? (p.grpId === grpId ? pickedCard : { grpId: p.grpId });
              })
            : [...prev.pickedCards, pickedCard];

          return {
            ...prev,
            currentPack: [],
            enrichedPack: [],
            pickedCards,
          };
        });
        pendingPack.current = null;
      }),

      window.electronAPI.onDraftEnded(() => {
        setDraftState((prev) => ({ ...prev, inDraft: false, currentPack: [], enrichedPack: [] }));
        pendingPack.current = null;
      }),
    ];

    return () => unsubs.forEach((fn) => fn && fn());
  }, [settings, fetchLandsData, enrich]);

  return { draftState, reEnrichWithColorPair };
}
