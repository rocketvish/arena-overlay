import React, { useEffect, useMemo, useRef, useState } from 'react';
import CardRow from './CardRow';
import AssistantBar from './AssistantBar';

// ── Arena visual sort ─────────────────────────────────────────────────────────
// The log lists a pack in booster order (commons first), not the order Arena
// shows it. Arena's card database carries its own sort keys
// (Order_MythicToCommon, Order_LandLast, Order_ColorOrder, Order_CMCWithXLast,
// Order_Title); the pack is shown by rarity, then color — W, U, B, R, G, then
// two-color pairs in guild order — with lands last. Collector number is NOT
// the key: sets with a bonus sheet (FRA's cards numbered 197+) put those
// cards among their own color, not after the main set.
const RARITY_ORDER = { mythic: 0, rare: 1, uncommon: 2, common: 3 };
const MONO_ORDER = { W: 0, U: 1, B: 2, R: 3, G: 4 };
// Order_ColorOrder for two-color cards (Arena DB: WU 5, UR 8, BR 9, WG 13).
const PAIR_ORDER = { WU: 5, WB: 6, UB: 7, UR: 8, BR: 9, BG: 10, RG: 11, WR: 12, WG: 13, UG: 14 };

function colorOrder(card) {
  const cs = (card.color ?? '').replace(/[^WUBRG]/g, '');
  if (cs.length === 1) return MONO_ORDER[cs];
  if (cs.length === 2) return PAIR_ORDER[['W', 'U', 'B', 'R', 'G'].filter((c) => cs.includes(c)).join('')] ?? 15;
  if (cs.length > 2) return 15;
  return 16; // colorless
}

const BASIC_NAMES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']);
const isBasic = (card) => BASIC_NAMES.has(card.name);
const isLand = (card) => isBasic(card) || (/\bLand\b/.test(card.typeLine ?? '') && !/\bCreature\b/.test(card.typeLine ?? ''));
// Arena sorts X spells after everything else of their color.
const cmcKey = (card) => (card.cmc ?? 99) + (/\{X\}/.test(card.manaCost ?? '') ? 100 : 0);

function arenaVisualSort(cards) {
  const key = (c) => [
    c.name ? 0 : 1,                     // unknown cards (no data) last, in log order
    isBasic(c) ? 4 : RARITY_ORDER[c.rarity] ?? 3, // basics after commons
    isLand(c) ? 1 : 0,
    isLand(c) ? 1 : 0,
    colorOrder(c),
    cmcKey(c),
  ];
  return cards.map((c, i) => ({ card: c, i, k: key(c) })).sort((a, b) => {
    for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j];
    const byName = (a.card.name ?? '').localeCompare(b.card.name ?? '');
    return byName || a.i - b.i;
  }).map(({ card }) => card);
}

// ── Basic land name resolution ────────────────────────────────────────────────
// Basic lands are not in the 17Lands card pool (they're not drafted normally)
// so they arrive with no name. Hardcode the standard basic land names so the
// overlay shows "Forest" instead of "#100652".
const BASIC_LAND_NAMES = {
  // TMT (TMNT) set basic land Arena IDs — inferred from gap in 17Lands data
  100648: 'Plains', 100649: 'Island', 100650: 'Swamp',
  100651: 'Mountain', 100652: 'Forest',
  // FDN (Foundations) basic land Arena IDs — 4 art variants each
  95181: 'Plains',  95182: 'Plains',  95191: 'Plains',  95192: 'Plains',
  95183: 'Island',  95184: 'Island',  95193: 'Island',  95194: 'Island',
  95185: 'Swamp',   95186: 'Swamp',   95195: 'Swamp',   95196: 'Swamp',
  95187: 'Mountain', 95188: 'Mountain', 95197: 'Mountain', 95198: 'Mountain',
  95189: 'Forest',  95190: 'Forest',  95199: 'Forest',  95200: 'Forest',
};

function resolveBasicLandName(card) {
  if (card.name) return card.name;
  return BASIC_LAND_NAMES[card.grpId] ?? null;
}

// ── Column header row ─────────────────────────────────────────────────────────
function ColHeaders({ columns, compact }) {
  const s = { fontSize: 10, color: '#888', textAlign: 'right', minWidth: 40, textTransform: 'uppercase', fontFamily: 'monospace', fontWeight: 600, flexShrink: 0 };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: compact ? '3px 10px' : '4px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
      <div style={{ width: 10, flexShrink: 0 }} />
      {columns.grade && <span style={{ ...s, minWidth: 32, textAlign: 'center' }}>Grade</span>}
      <span style={{ flex: 1, fontSize: 10, color: '#888', fontWeight: 600, textTransform: 'uppercase' }}>Card</span>
      <div style={{ width: 6, flexShrink: 0 }} />
      {columns.win && <span style={{ ...s, color: '#7ec8a0' }} title="Deck win value: percentage points this card adds to your projected deck's win rate (deck model fit on 17Lands game results, controlling for player skill; counts creatures, two-drops, removal and curve)">Win</span>}
      {columns.gihwr && <span style={s}>GIH%</span>}
      {columns.ohwr  && <span style={{ ...s, color: '#666' }}>OH%</span>}
      {columns.gpwr  && <span style={s}>GP%</span>}
      {columns.ata   && <span style={s} title="Average pick at which 17Lands drafters take this card">ATA</span>}
      {columns.alsa  && <span style={s}>ALSA</span>}
      {columns.iwd   && <span style={s}>IWD</span>}
    </div>
  );
}

// ── Loading / error / no-data banner ─────────────────────────────────────────
function LoadingBanner({ landsStatus, landsError, landsStale, landsStaleReason, landsFetchedAt }) {
  if (landsStatus === 'loaded' && landsStale) {
    return (
      <div style={{ padding: '5px 10px', fontSize: 10, background: 'rgba(80,70,20,0.4)', color: '#d8c070', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
           title={landsStaleReason ?? undefined}>
        ⏱ Showing 17Lands data from {formatAge(landsFetchedAt)} — {landsStaleReason ?? 'could not refresh'}
      </div>
    );
  }
  if (!landsStatus || landsStatus === 'loaded') return null;
  const isFetching = landsStatus === 'fetching';
  const isNoData   = landsStatus === 'no-data';
  const bg    = isFetching ? 'rgba(40,80,40,0.3)' : isNoData ? 'rgba(60,60,20,0.4)' : 'rgba(80,30,30,0.35)';
  const color = isFetching ? '#7ec8a0' : isNoData ? '#c8c060' : '#e08080';
  return (
    <div style={{ padding: '5px 10px', fontSize: 10, background: bg, color, borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', gap: 6 }}>
      {isFetching ? (
        <><span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span> Loading 17Lands data…</>
      ) : isNoData ? (
        <><span>ℹ</span> 17Lands data not yet available. Showing card names only.</>
      ) : (
        <><span>⚠</span> 17Lands unavailable{landsError ? ` — ${landsError}` : ''}. Showing names only.</>
      )}
    </div>
  );
}

function formatAge(ts) {
  if (!ts) return 'an earlier session';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// 17Lands asks tools built on its data to credit it visibly, with a link.
function DataCredit({ setCode, fetchedAt }) {
  const url = `https://www.17lands.com/card_data?expansion=${encodeURIComponent(setCode ?? '')}&format=PremierDraft`;
  return (
    <span
      data-hit
      onClick={() => window.electronAPI?.openUrl(url)}
      title={`Card stats from 17Lands (Premier Draft), downloaded ${fetchedAt ? new Date(fetchedAt).toLocaleString() : '—'}. Click to open 17lands.com`}
      style={{ fontSize: 9, color: '#7a8a9a', cursor: 'pointer', marginLeft: 8, whiteSpace: 'nowrap' }}>
      data: 17Lands{fetchedAt ? ` · ${formatAge(fetchedAt)}` : ''}
    </span>
  );
}

// ── "Pack" section header + card count (Section 6B / 6C) ──────────────────────
function PackSectionHeader({ cardCount, expectedCount, mismatch, setCode, fetchedAt }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '4px 10px',
      background: 'rgba(255,255,255,0.04)',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      flexShrink: 0,
    }}>
      <span style={{
        fontSize: 10, fontWeight: 800, color: '#a8a8a8',
        letterSpacing: '0.10em', textTransform: 'uppercase',
      }}>
        Pack
      </span>
      <DataCredit setCode={setCode} fetchedAt={fetchedAt} />
      <span style={{ flex: 1 }} />
      <span title={mismatch ? `Expected ${expectedCount} cards for this pick — got ${cardCount}` : undefined}
            style={{
        fontSize: 10, fontWeight: 700,
        color: mismatch ? '#ff8060' : '#888',
        fontFamily: 'monospace',
      }}>
        {cardCount} card{cardCount !== 1 ? 's' : ''}
        {mismatch && <span style={{ marginLeft: 4 }}>⚠ exp {expectedCount}</span>}
      </span>
    </div>
  );
}

// ── Idle state ────────────────────────────────────────────────────────────────
function IdleView() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 28, opacity: 0.15 }}>🃏</div>
      <div style={{ fontSize: 11, color: '#444', lineHeight: 1.6 }}>
        Waiting for a draft to start…
        <br />
        <span style={{ fontSize: 10, color: '#333' }}>Open MTG Arena and join a draft event.</span>
      </div>
    </div>
  );
}

// Height of a full-size card row (8px padding top and bottom + text + border).
const FULL_ROW_PX = 38;

// ── Main component ────────────────────────────────────────────────────────────
export default function DraftOverlay({ draftState, settings, recommendation, assistantState }) {
  if (!settings) return null;

  const { display = {} } = settings;
  const compact = display.compactMode ?? false;
  // Deck win value per card, once the set's deck win model is available.
  const winByCard = assistantState?.recommendation?.win?.byCard ?? null;
  const columns = { ...(settings.columns ?? {}), win: settings.columns?.win !== false && !!winByCard };
  const winBestValue = winByCard ? Math.max(...Object.values(winByCard)) : null;

  const { inDraft, enrichedPack, pickedCards, landsStatus, landsError, packId,
          packEventId, pickNumber, packNumber, packSize, setCode,
          landsStale, landsStaleReason, landsFetchedAt } = draftState;

  // Enforce the expected card count for this pick: pack size (learned from the
  // log — 14 for current boosters) minus picks already made from this pack.
  // More cards than that means a ghost card; truncate and log.
  const expectedCount = Math.max(1, (packSize ?? 14) - (pickNumber ?? 0));
  const rawCards = enrichedPack ?? [];
  const overflow = rawCards.length > expectedCount;
  if (overflow) {
    console.warn(
      `[overlay] Card count exceeds expected for P${(packNumber ?? 0) + 1}.${(pickNumber ?? 0) + 1} — `+
      `got ${rawCards.length}, expected ${expectedCount}. Truncating to expected count. `+
      `packEventId=${packEventId ?? 'none'}`,
      rawCards.map(c => c.name ?? `#${c.grpId}`)
    );
  }

  // Resolve basic land names, then sort to match Arena's visual pack layout.
  // Apply the count truncation BEFORE sorting so we don't display ghosts.
  const cards = useMemo(() => {
    const truncated = overflow ? rawCards.slice(0, expectedCount) : rawCards;
    const resolved = truncated.map((c) => {
      const name = resolveBasicLandName(c);
      return name !== c.name ? { ...c, name } : c;
    });
    const sorted = arenaVisualSort(resolved);
    if (sorted.length > 0) {
      console.log(
        `[overlay] Pack order (eventId=${packEventId ?? 'n/a'}, ${sorted.length} cards):`,
        sorted.map((c, i) =>
          `${i + 1}. ${c.name ?? `#${c.grpId}`} (${c.rarity?.[0]?.toUpperCase() ?? '?'} coll#${c.collectorNumber ?? '?'})`
        ).join('\n')
      );
    }
    return sorted;
  }, [enrichedPack, packEventId, expectedCount, overflow, rawCards]);

  // The card list is click-through (so it never blocks Arena) and therefore
  // can't be scrolled: switch to compact rows when the full pack wouldn't fit.
  const listRef = useRef(null);
  const [listHeight, setListHeight] = useState(0);
  const hasList = inDraft && cards.length > 0;
  useEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setListHeight(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasList]);
  const rowCompact = compact || (listHeight > 0 && cards.length * FULL_ROW_PX > listHeight);

  if (!inDraft) return <IdleView />;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <LoadingBanner landsStatus={landsStatus} landsError={landsError} landsStale={landsStale}
                     landsStaleReason={landsStaleReason} landsFetchedAt={landsFetchedAt} />

      {/* ── TOP SECTION — "Pack": pure data view, no recommendations here ── */}
      {cards.length > 0 && (
        <PackSectionHeader
          cardCount={cards.length}
          expectedCount={expectedCount}
          mismatch={overflow}
          setCode={setCode}
          fetchedAt={landsFetchedAt}
        />
      )}
      {cards.length > 0 && <ColHeaders columns={columns} compact={rowCompact} />}

      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {cards.length === 0 ? (
          <div style={{ padding: '20px 12px', fontSize: 11, color: '#444', textAlign: 'center' }}>
            Waiting for pack…
          </div>
        ) : (
          cards.map((card, i) => (
            <CardRow
              // Position is part of the key: packs can hold two copies of a
              // card, and duplicate keys made React leave ghost rows behind.
              key={`${packEventId ?? packId ?? 0}-${i}-${card.grpId}`}
              card={card}
              columns={columns}
              compact={rowCompact}
              isTopPick={false}
              isRecommended={false}
              winPct={winByCard?.[card.grpId] ?? null}
              winBest={winByCard?.[card.grpId] != null && winByCard[card.grpId] === winBestValue && winBestValue > 0}
            />
          ))
        )}
      </div>

      {pickedCards?.length > 0 && (
        <div style={{
          padding: '4px 10px', fontSize: 10, color: '#888', fontWeight: 600,
          borderTop: '1px solid rgba(255,255,255,0.05)',
          background: 'rgba(255,255,255,0.02)',
          flexShrink: 0,
        }}>
          {pickedCards.length} picked
        </div>
      )}

      {/* ── BOTTOM SECTION — "Assistant": picks, signals, needs (collapsible) ── */}
      <AssistantBar
        assistantState={assistantState}
        settings={settings}
        inDraft={inDraft}
      />
    </div>
  );
}
