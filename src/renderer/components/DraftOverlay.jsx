import React, { useMemo } from 'react';
import CardRow from './CardRow';

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
};

function resolveBasicLandName(card) {
  if (card.name) return card.name;
  return BASIC_LAND_NAMES[card.grpId] ?? null;
}

// ── Column header row ─────────────────────────────────────────────────────────
function ColHeaders({ columns, compact }) {
  const s = { fontSize: 9, color: '#555', textAlign: 'right', minWidth: 34, textTransform: 'uppercase', fontFamily: 'monospace', flexShrink: 0 };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: compact ? '2px 8px' : '3px 8px', borderBottom: '1px solid rgba(255,255,255,0.055)' }}>
      <div style={{ width: 8, flexShrink: 0 }} />
      {columns.grade && <span style={{ ...s, minWidth: 26, textAlign: 'center' }}>Grade</span>}
      <span style={{ flex: 1, fontSize: 9, color: '#555' }}>Card</span>
      <div style={{ width: 5, flexShrink: 0 }} />
      {columns.gihwr && <span style={s}>GIH%</span>}
      {columns.ohwr  && <span style={{ ...s, color: '#444' }}>OH%</span>}
      {columns.gpwr  && <span style={s}>GP%</span>}
      {columns.alsa  && <span style={s}>ALSA</span>}
      {columns.iwd   && <span style={s}>IWD</span>}
    </div>
  );
}

// ── Loading / error / no-data banner ─────────────────────────────────────────
function LoadingBanner({ landsStatus, landsError }) {
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

// ── Recommended pick bar ──────────────────────────────────────────────────────
function RecommendationBar({ recommendation }) {
  if (!recommendation?.primary) return null;
  const card  = recommendation.primary;
  const grade = card.stats?.grade;
  return (
    <div style={{
      padding: '4px 8px', background: 'rgba(80,200,120,0.08)',
      borderBottom: '1px solid rgba(80,200,120,0.15)',
      display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
    }}>
      <span style={{ fontSize: 10, color: '#7ec8a0' }}>★</span>
      <span style={{ fontSize: 11, color: '#7ec8a0', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {card.name ?? `#${card.grpId}`}
        {grade && <span style={{ marginLeft: 5, opacity: 0.8 }}>({grade})</span>}
      </span>
      {recommendation.explanation && (
        <span style={{ fontSize: 9, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
          {recommendation.explanation}
        </span>
      )}
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
export default function DraftOverlay({ draftState, settings, recommendation }) {
  if (!settings) return null;

  const { columns = {}, display = {} } = settings;
  const compact = display.compactMode ?? false;
  const showRecommendation = display.showRecommendation ?? true;

  const { inDraft, enrichedPack, pickedCards, landsStatus, landsError } = draftState;

  // Resolve basic land names, then sort to match Arena's visual pack layout
  const cards = useMemo(() => {
    const resolved = (enrichedPack ?? []).map((c) => {
      const name = resolveBasicLandName(c);
      return name !== c.name ? { ...c, name } : c;
    });
    const sorted = arenaVisualSort(resolved);
    if (sorted.length > 0) {
      console.log('[overlay] Pack order:', sorted.map((c, i) =>
        `${i + 1}. ${c.name ?? `#${c.grpId}`} (${c.rarity?.[0]?.toUpperCase() ?? '?'} coll#${c.collectorNumber ?? '?'})`
      ).join('\n'));
    }
    return sorted;
  }, [enrichedPack]);

  const recommendedGrpId = recommendation?.primary?.grpId ?? null;

  if (!inDraft) return <IdleView />;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <LoadingBanner landsStatus={landsStatus} landsError={landsError} />

      {showRecommendation && recommendation && <RecommendationBar recommendation={recommendation} />}

      {cards.length > 0 && <ColHeaders columns={columns} compact={compact} />}

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {cards.length === 0 ? (
          <div style={{ padding: '20px 12px', fontSize: 11, color: '#444', textAlign: 'center' }}>
            Waiting for pack…
          </div>
        ) : (
          cards.map((card, i) => (
            <CardRow
              key={card.grpId ?? i}
              card={card}
              columns={columns}
              compact={compact}
              isTopPick={false}
              isRecommended={recommendedGrpId != null && card.grpId === recommendedGrpId}
            />
          ))
        )}
      </div>

      {/* Picked cards tally */}
      {pickedCards?.length > 0 && (
        <div style={{
          padding: '4px 10px', fontSize: 10, color: '#555',
          borderTop: '1px solid rgba(255,255,255,0.05)', flexShrink: 0,
        }}>
          {pickedCards.length} picked
        </div>
      )}
    </div>
  );
}
