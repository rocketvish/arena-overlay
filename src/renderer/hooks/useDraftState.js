import { useState, useEffect, useRef, useCallback } from 'react';
import {
  loadSetData,
  matchCards,
  getMissingIds,
  cacheArenaIds,
  clearSetData,
} from '../utils/cardMatcher';

const DEFAULT_PACK_SIZE = 14; // current Arena boosters; replaced by the size seen in the log

// Remove ONE copy of a card — a pack can contain duplicates, and picking one
// copy must leave the other on screen.
function withoutOne(cards, grpId) {
  const i = cards.findIndex((c) => c.grpId === grpId);
  return i < 0 ? cards : [...cards.slice(0, i), ...cards.slice(i + 1)];
}

const INITIAL_STATE = {
  inDraft: false,
  setCode: null,
  setName: null,
  format: 'PremierDraft',
  packNumber: 0,
  pickNumber: 0,
  packSize: DEFAULT_PACK_SIZE,
  totalPicks: DEFAULT_PACK_SIZE * 3,
  currentPack: [],   // raw cards waiting for enrichment
  enrichedPack: [],  // cards with 17Lands stats
  pickedCards: [],   // accumulated picks with stats
  landsStatus: null, // 'fetching' | 'loaded' | 'no-data' | 'error'
  landsError: null,
  landsFetchedAt: null,  // when the 17Lands snapshot in use was downloaded
  landsStale: false,     // true when showing an older snapshot (offline / set no longer live)
  landsStaleReason: null,
  recommendation: null,
  packId: 0,         // incremented each pack; forces React key reset
  packEventId: null, // unique id from the parser per pack-opened event
};

export function useDraftState() {
  const [draftState, setDraftState] = useState(INITIAL_STATE);
  // Latest pack, kept so we can re-enrich when 17Lands data arrives
  const pendingPack = useRef(null);
  const currentSetCode = useRef(null);
  // Track landsStatus synchronously so onPackOpened can see it without stale closure
  const landsStatusRef = useRef(null);
  const landsFetchedAtRef = useRef(null);
  // Incremented on every new pack; async callbacks compare against it so a
  // late Scryfall answer can't paint names onto a newer pack.
  const packVersion = useRef(0);
  // Last displayed pack event ID — a repeat is a duplicate broadcast.
  const lastPackEventId = useRef(null);

  const enrich = useCallback((cards, setCode) => {
    if (!cards || cards.length === 0) return [];
    return matchCards(cards, setCode);
  }, []);

  // Name any pack cards 17Lands doesn't list (basic lands, bonus cards) via
  // Scryfall. Skipped while 17Lands is still loading — it will name most cards.
  const resolveMissingNames = useCallback((setCode) => {
    const cards = pendingPack.current;
    if (!cards || !window.electronAPI || landsStatusRef.current === 'fetching') return;
    const missingIds = getMissingIds(cards, setCode);
    if (missingIds.length === 0) return;
    const myVersion = packVersion.current;
    window.electronAPI.resolveArenaIds(missingIds).then((idMap) => {
      if (packVersion.current !== myVersion) return; // a newer pack is showing
      if (idMap && Object.keys(idMap).length > 0) {
        cacheArenaIds(idMap);
        setDraftState((prev) => ({ ...prev, enrichedPack: Object.freeze(enrich(pendingPack.current, setCode)) }));
      }
    });
  }, [enrich]);

  // Fetch 17Lands data for a set (main process serves it from cache when fresh)
  // quiet: reload without flashing the "Loading…" banner (data is already cached in main).
  const fetchLandsData = useCallback(async (setCode, { quiet = false } = {}) => {
    if (!window.electronAPI || !setCode) return;

    if (!quiet) {
      landsStatusRef.current = 'fetching';
      setDraftState((prev) => ({ ...prev, landsStatus: 'fetching', landsError: null }));
    }

    try {
      const result = await window.electronAPI.fetchSetData(setCode, 'PremierDraft');
      if (currentSetCode.current && currentSetCode.current !== setCode) return; // a newer draft took over
      if (result?.data) {
        loadSetData(setCode, result.data);
        landsStatusRef.current = 'loaded';
        landsFetchedAtRef.current = result.fetchedAt ?? null;
        // 17Lands data is set-wide, so it's always right to apply it to the
        // current pack, whichever one that is.
        setDraftState((prev) => ({
          ...prev,
          landsStatus: 'loaded',
          landsError: null,
          landsFetchedAt: result.fetchedAt ?? null,
          landsStale: !!result.stale,
          landsStaleReason: result.staleReason ?? null,
          enrichedPack: pendingPack.current
            ? Object.freeze(enrich(pendingPack.current, setCode))
            : prev.enrichedPack,
        }));
        resolveMissingNames(setCode);
      } else if (result?.noData) {
        landsStatusRef.current = 'no-data';
        setDraftState((prev) => ({ ...prev, landsStatus: 'no-data', landsError: null }));
        resolveMissingNames(setCode);
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
      setDraftState((prev) => ({ ...prev, landsStatus: 'error', landsError: err.message }));
    }
    if (landsStatusRef.current === 'error') resolveMissingNames(setCode);
  }, [enrich, resolveMissingNames]);

  // ── IPC event listeners ────────────────────────────────────────────────────
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubs = [
      window.electronAPI.onDraftStarted(({ setCode, format }) => {
        currentSetCode.current = setCode;
        pendingPack.current = null;
        landsStatusRef.current = null;
        landsFetchedAtRef.current = null;
        lastPackEventId.current = null;
        clearSetData(setCode);

        console.log(`[useDraftState] draft-started setCode=${setCode} format=${format ?? 'unknown'}`);

        setDraftState({
          ...INITIAL_STATE,
          inDraft: true,
          setCode,
          format: format ?? 'PremierDraft',
        });

        if (setCode) fetchLandsData(setCode);
      }),

      window.electronAPI.onPackOpened(({ packEventId, packNumber, pickNumber, packSize, cards, setCode, format }) => {
        if (packEventId && packEventId === lastPackEventId.current) {
          console.log(`[useDraftState] Duplicate packEventId rejected: ${packEventId}`);
          return;
        }

        const sc = setCode || currentSetCode.current;
        // If we never saw draft-started (overlay opened mid-draft), load data
        // now; and retry after an earlier failure (main rate-limits retries).
        if (sc && sc !== currentSetCode.current) {
          currentSetCode.current = sc;
          fetchLandsData(sc);
        } else if (sc && (landsStatusRef.current === 'error' || landsStatusRef.current === 'no-data')) {
          fetchLandsData(sc, { quiet: true });
        }

        // Replace — never append — the pack. Frozen so accidental mutation is loud.
        const frozenIncoming = Object.freeze(cards.map(c => Object.freeze({ ...c })));

        packVersion.current += 1;
        lastPackEventId.current = packEventId ?? null;
        pendingPack.current = frozenIncoming;

        const size = packSize ?? DEFAULT_PACK_SIZE;
        if (cards.length !== size - pickNumber) {
          console.warn(`[useDraftState] Pack size unexpected: got ${cards.length}, expected ${size - pickNumber} (pack ${packNumber + 1}, pick ${pickNumber + 1})`);
        }

        resolveMissingNames(sc);

        const enriched = enrich(cards, sc);

        setDraftState((prev) => ({
          ...prev,
          inDraft: true,
          setCode: sc || prev.setCode,
          format: format ?? prev.format,
          packNumber,
          pickNumber,
          packSize: size,
          totalPicks: size * 3,
          packId: (prev.packId ?? 0) + 1,  // force React key reset
          packEventId,
          currentPack: Object.freeze([...cards]),
          enrichedPack: Object.freeze([...enriched]),
          recommendation: null,
        }));
      }),

      window.electronAPI.onCardPicked(({ grpId, pickedCards: rawPicked }) => {
        setDraftState((prev) => {
          // Find the picked card in enrichedPack to preserve its stats
          const pickedCard = prev.enrichedPack.find((c) => c.grpId === grpId) ?? { grpId };

          const pickedCards = rawPicked
            ? rawPicked.map((p) => {
                const existing = prev.pickedCards.find((x) => x.grpId === p.grpId);
                return existing ?? (p.grpId === grpId ? pickedCard : { grpId: p.grpId });
              })
            : [...prev.pickedCards, pickedCard];

          // Remove only the picked card — the rest stay visible until the
          // next pack arrives, avoiding a blank flash.
          return {
            ...prev,
            currentPack: withoutOne(prev.currentPack, grpId),
            enrichedPack: withoutOne(prev.enrichedPack, grpId),
            pickedCards,
          };
        });
        if (pendingPack.current) {
          pendingPack.current = withoutOne(pendingPack.current, grpId);
        }
      }),

      window.electronAPI.onDraftEnded(() => {
        setDraftState((prev) => ({ ...prev, inDraft: false, currentPack: [], enrichedPack: [] }));
        pendingPack.current = null;
      }),

      // Newer data downloaded (manual refresh, or another window's fetch):
      // reload it from the main-process cache and re-apply.
      window.electronAPI.on17landsStatus((s) => {
        if (s?.status !== 'loaded' || !s.setCode || s.setCode !== currentSetCode.current) return;
        if (s.fetchedAt && s.fetchedAt === landsFetchedAtRef.current) return;
        fetchLandsData(s.setCode, { quiet: true });
      }),
    ];

    return () => unsubs.forEach((fn) => fn && fn());
  }, [fetchLandsData, enrich, resolveMissingNames]);

  const refreshLandsData = useCallback(async () => {
    const sc = currentSetCode.current;
    if (!sc || !window.electronAPI?.refreshSetData) return;
    setDraftState((prev) => ({ ...prev, landsStatus: 'fetching' }));
    await window.electronAPI.refreshSetData(sc);
    await fetchLandsData(sc);
  }, [fetchLandsData]);

  return { draftState, refreshLandsData };
}
