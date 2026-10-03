import React, { useMemo } from 'react';
import CardRow from './CardRow';
import AssistantBar from './AssistantBar';

// ── Arena visual sort ─────────────────────────────────────────────────────────
// Arena displays pack cards sorted by: rarity (mythic→rare→uncommon→common),
// then by collector number ascending within each rarity tier.
//
// The collectorNumber field on each enriched card is the card's 0-based index
// in the 17Lands data array, which empirically matches collector number − 1.
// Cards not in 17Lands (basic lands, very new cards) have no collectorNumber
// and sort to the end of the list.
//
// Verified against a TMT pack where Shredder's Armor (uncommon, coll#75)
// appeared before all commons; and within commons, cards followed collector
// number order (W#9 → U#53 → R#111 → G#118 → G#129 → WB#147 → ...).
const RARITY_ORDER = { mythic: 0, rare: 1, uncommon: 2, common: 3 };

function arenaVisualSort(cards) {
  return cards.map((c, i) => ({ card: c, i })).sort((a, b) => {
    const ca = a.card, cb = b.card;

    // Cards with no 17Lands data have no collectorNumber — sort them last, preserving log order
    const hasA = ca.collectorNumber != null;
    const hasB = cb.collectorNumber != null;
    if (!hasA && !hasB) return a.i - b.i;
    if (!hasA) return 1;
    if (!hasB) return -1;

    // Primary: rarity (mythic/rare before uncommon before common)
    const rA = RARITY_ORDER[ca.rarity] ?? 3;
    const rB = RARITY_ORDER[cb.rarity] ?? 3;
    if (rA !== rB) return rA - rB;

    // Secondary: collector number ascending
    return ca.collectorNumber - cb.collectorNumber;
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

// ── Main component ────────────────────────────────────────────────────────────
export default function DraftOverlay({ draftState, settings, recommendation, assistantState }) {
  if (!settings) return null;

  const { columns = {}, display = {} } = settings;
  const compact = display.compactMode ?? false;

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
      {cards.length > 0 && <ColHeaders columns={columns} compact={compact} />}

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
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
              compact={compact}
              isTopPick={false}
              isRecommended={false}
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
