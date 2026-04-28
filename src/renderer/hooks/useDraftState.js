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
  packId: 0,         // incremented each pack; forces React key reset
  packEventId: null, // Section 6C: unique id from the parser per pack-opened event
};

export function useDraftState(settings) {
  const [draftState, setDraftState] = useState(INITIAL_STATE);
  // Keep a ref to current pack so we can re-enrich when 17Lands data arrives
  const pendingPack = useRef(null);
  const currentSetCode = useRef(null);
  const currentFormat = useRef('PremierDraft');
  // Track landsStatus synchronously so onPackOpened can see it without stale closure
  const landsStatusRef = useRef(null);
  // Version counter: incremented on every new pack; async callbacks capture and check it to
  // discard results that belong to a previous pack (prevents phantom cards from stale callbacks)
  const packVersion = useRef(0);
  // Section 6C: track the last successfully-displayed pack event ID. Any
  // pack-opened event with a matching ID is a duplicate from the parser
  // (e.g. log re-read on stale-detection) and is silently dropped.
  const lastPackEventId = useRef(null);

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
        // Always re-enrich pendingPack.current — it's always the latest pack.
        // No version guard here: the version guard is only for Scryfall callbacks
        // where the data is pack-specific. 17Lands data is set-wide and always
        // correct to apply to whatever pack is current.
        setDraftState((prev) => ({
          ...prev,
          landsStatus: 'loaded',
          enrichedPack: pendingPack.current
            ? [...enrich(pendingPack.current, setCode, format, prev.display?.colorFilter ?? 'all')]
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
      window.electronAPI.onDraftStarted(({ setCode, format: detectedFormat }) => {
        // Prefer format detected from the Arena log EventName (e.g. QuickDraft for FDN)
        // over the user's settings default, since the log tells us exactly which event is running.
        const fmt = detectedFormat ?? format;
        currentSetCode.current = setCode;
        currentFormat.current = fmt;
        pendingPack.current = null;
        landsStatusRef.current = null;
        clearSetData(setCode);

        console.log(`[useDraftState] draft-started setCode=${setCode} format=${fmt} (detected=${detectedFormat ?? 'none'} setting=${format})`);

        setDraftState({
          ...INITIAL_STATE,
          inDraft: true,
          setCode,
          format: fmt,
        });

        // Kick off 17Lands fetch using the correct format
        if (setCode) fetchLandsData(setCode, fmt);
      }),

      window.electronAPI.onPackOpened(async ({ packEventId, packNumber, pickNumber, cards, setCode, format: detectedFormat }) => {
        // ── Section 6C, step 2: dedupe by packEventId ─────────────────────────
        // Reject any pack-opened event whose ID matches the currently displayed
        // pack. The parser produces a fresh ID per emit (timestamped), so any
        // collision means we're seeing the same event a second time.
        if (packEventId && packEventId === lastPackEventId.current) {
          console.log(`[useDraftState] Duplicate packEventId rejected: ${packEventId}`);
          return;
        }

        const sc = setCode || currentSetCode.current;
        // Use format detected from the log if available (more reliable than user setting)
        const fmt = detectedFormat ?? currentFormat.current;
        if (detectedFormat && detectedFormat !== currentFormat.current) {
          currentFormat.current = detectedFormat;
        }
        const colorPair = settings?.display?.colorFilter ?? 'all';

        // ── Section 6C, step 3: REPLACE — never append. Freeze the new array
        // so any later code that tries to mutate it throws (in strict mode)
        // or silently no-ops (in sloppy mode), making accidental appends loud.
        const frozenIncoming = Object.freeze(cards.map(c => Object.freeze({ ...c })));

        // ── PACK REPLACED logging ────────────────────────────────────────────
        const oldNames = (pendingPack.current ?? []).map((c) => c.name ?? `#${c.grpId}`);
        const newNames = frozenIncoming.map((c) => c.name ?? `#${c.grpId}`);
        console.log(`[PACK REPLACED] eventId=${packEventId} old=[${oldNames.join(', ')}] new=[${newNames.join(', ')}]`);

        // ── Bump version — stale async callbacks will see a mismatch and bail ─
        packVersion.current += 1;
        const myVersion = packVersion.current;
        lastPackEventId.current = packEventId ?? null;

        // ── Nuclear clear then set ────────────────────────────────────────────
        pendingPack.current = null;           // clear before assigning new pack
        pendingPack.current = frozenIncoming;  // frozen, replace-only
        if (sc) currentSetCode.current = sc;

        // ── Validate new pack ─────────────────────────────────────────────────
        const expectedCount = 15 - pickNumber;
        if (cards.length !== expectedCount) {
          console.warn(`[useDraftState] Pack size unexpected: got ${cards.length}, expected ${expectedCount} (pack ${packNumber + 1}, pick ${pickNumber})`);
        }
        const idSet = new Set(cards.map((c) => c.grpId));
        if (idSet.size !== cards.length) {
          console.warn(`[useDraftState] Duplicate card IDs in new pack:`, cards.map((c) => c.grpId));
        }

        // ── Scryfall fallback (version-guarded) ───────────────────────────────
        // Only call Scryfall when 17Lands won't resolve the names itself.
        // If 17Lands is fetching, skip — re-enrichment runs when it loads.
        // If 17Lands has no data or errored, try Scryfall as a fallback.
        const ls = landsStatusRef.current;
        const missingIds = (ls === 'no-data' || ls === 'error' || ls === null)
          ? getMissingIds(cards, sc, fmt)
          : [];
        if (missingIds.length > 0 && window.electronAPI) {
          window.electronAPI.resolveArenaIds(missingIds).then((idMap) => {
            if (packVersion.current !== myVersion) {
              console.log(`[useDraftState] Scryfall result discarded — stale pack (v${myVersion}, current v${packVersion.current})`);
              return;
            }
            if (idMap && Object.keys(idMap).length > 0) {
              cacheArenaIds(idMap);
              // Re-enrich with the now-resolved names
              setDraftState((prev) => ({
                ...prev,
                enrichedPack: [...enrich(pendingPack.current, sc, fmt, colorPair)],
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

        setDraftState((prev) => {
          // Validate: check for IDs from the old pack leaking into the new one
          const oldIds = new Set((prev.currentPack ?? []).map((c) => c.grpId));
          const leaked = cards.filter((c) => oldIds.has(c.grpId) && (prev.currentPack ?? []).length > 0);
          if (leaked.length > 0 && leaked.length < cards.length) {
            // Some overlap is expected between packs (foils/reprints), only warn if unusual
            console.warn(`[useDraftState] ${leaked.length} card IDs appear in both old and new pack:`, leaked.map((c) => c.name ?? `#${c.grpId}`));
          }
          return {
            ...prev,
            inDraft: true,
            setCode: sc || prev.setCode,
            packNumber,
            pickNumber,
            packId: (prev.packId ?? 0) + 1,  // force React key reset
            packEventId,                       // Section 6C: track event ID
            // Frozen, brand-new arrays — never mutated downstream.
            currentPack: Object.freeze([...cards]),
            enrichedPack: Object.freeze([...enriched]),
            recommendation: null,
          };
        });
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

          // Remove only the picked card from the visible pack — don't blank the
          // entire overlay.  The remaining cards stay visible while we wait for
          // the next pack-opened event, preventing a distracting blank flash.
          const enrichedPack = prev.enrichedPack.filter((c) => c.grpId !== grpId);

          return {
            ...prev,
            currentPack: prev.currentPack.filter((c) => c.grpId !== grpId),
            enrichedPack,
            pickedCards,
          };
        });
        // Update pendingPack ref to match (remove picked card)
        if (pendingPack.current) {
          pendingPack.current = pendingPack.current.filter((c) => c.grpId !== grpId);
        }
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
