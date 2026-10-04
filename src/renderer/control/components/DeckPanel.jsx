import React, { useState } from 'react';

// Suggested 40-card builds from the current draft pool (or a Sealed pool).
// Built in the main process by deckBuilder.js from 17Lands numbers.

const COLOR_HEX = { W: '#f5e664', U: '#50a0ff', B: '#b090e0', R: '#f06464', G: '#50b95a' };
const LAND_NAME = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

function Pips({ colors }) {
  return (
    <span style={{ fontFamily: 'monospace', fontWeight: 800 }}>
      {[...(colors ?? '')].map((c, i) => <span key={i} style={{ color: COLOR_HEX[c] ?? '#aaa' }}>{c}</span>)}
    </span>
  );
}

function CurveColumns({ main }) {
  const buckets = [1, 2, 3, 4, 5, 6].map((k) => main.filter((c) => {
    const v = Math.max(1, Math.min(6, Math.round(c.cmc ?? 0) || 1));
    return v === k;
  }));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 8 }}>
      {buckets.map((cards, i) => (
        <div key={i}>
          <div style={{ fontSize: 10, color: '#777', fontWeight: 700, marginBottom: 4 }}>{i === 5 ? '6+' : i + 1} · {cards.length}</div>
          {cards.map((c, j) => (
            <div key={j} title={`${c.name}${c.grade ? ` (${c.grade})` : ''}`} style={{
              fontSize: 11, color: /\bCreature\b/i.test(c.typeLine ?? '') ? '#ddd' : '#9fc8ff',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.5,
            }}>
              {c.name}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function DeckCard({ deck, rank }) {
  const s = deck.stats ?? {};
  const basics = Object.entries(deck.lands?.basics ?? {}).filter(([, n]) => n > 0);
  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: 14, marginBottom: 12, background: rank === 0 ? 'rgba(80,140,255,0.06)' : 'transparent' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16 }}><Pips colors={deck.colors} /></span>
        {deck.splash && <span style={{ fontSize: 12, color: '#ccc' }}>+ splash <Pips colors={deck.splash.color} /> ({deck.splash.cards.map((c) => c.name).join(', ')}; {deck.splash.sources} sources, {Math.round(deck.splash.castOdds * 100)}% by turn 6)</span>}
        {deck.variant && deck.variant !== 'standard' && <span style={{ fontSize: 10, color: '#ffce5c', fontWeight: 700, textTransform: 'uppercase' }}>{deck.variant}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#888' }}>
          {s.creatures} creatures · {s.removal} removal · {s.twoDrops} two-drops · avg {s.avgCmc?.toFixed?.(2) ?? '—'}
        </span>
      </div>
      <CurveColumns main={deck.main} />
      <div style={{ marginTop: 10, fontSize: 12, color: '#bbb' }}>
        <b>{deck.lands?.total} lands:</b>{' '}
        {basics.map(([c, n]) => `${n} ${LAND_NAME[c]}`).join(', ')}
        {deck.nonbasicLands?.length ? `, ${deck.nonbasicLands.map((c) => c.name).join(', ')}` : ''}
      </div>
      {(deck.reasons?.length > 0 || deck.warnings?.length > 0) && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {deck.reasons?.map((r, i) => <div key={`r${i}`} style={{ fontSize: 11, color: '#6baa6b' }}>✓ {r}</div>)}
          {deck.warnings?.map((w, i) => <div key={`w${i}`} style={{ fontSize: 11, color: '#d8a868' }}>△ {w}</div>)}
        </div>
      )}
    </div>
  );
}

export default function DeckPanel({ assistantState, draftState }) {
  const [showSealed, setShowSealed] = useState(true);
  const sealed = assistantState?.sealed ?? null;
  const draftDecks = assistantState?.deckSuggestions ?? [];
  const useSealed = sealed && showSealed && (!draftState?.inDraft || draftDecks.length === 0);
  const decks = useSealed ? sealed.decks : draftDecks;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#888', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {useSealed ? `Sealed pool — ${sealed.eventName} (${sealed.poolSize} cards)` : 'Suggested builds from your draft pool'}
        </span>
        {!useSealed && draftState?.inDraft && (
          <span style={{ fontSize: 11, color: '#777' }}>
            projected from {(draftState.packNumber ?? 0) * (draftState.packSize ?? 14) + (draftState.pickNumber ?? 0)} picks — shortfalls fill in as you draft
          </span>
        )}
        {sealed && draftDecks.length > 0 && (
          <button onClick={() => setShowSealed((v) => !v)} style={{ marginLeft: 'auto', fontSize: 11, background: 'rgba(30,30,50,0.9)', color: '#ccc', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}>
            {useSealed ? 'Show draft' : 'Show sealed'}
          </button>
        )}
      </div>
      {decks.length === 0 ? (
        <div style={{ fontSize: 12, color: '#555', padding: 24, textAlign: 'center' }}>
          Builds appear once you've drafted ~15 cards, or when you open a Sealed pool.
        </div>
      ) : decks.map((d, i) => <DeckCard key={`${d.colors}-${d.variant ?? ''}-${i}`} deck={d} rank={i} />)}
      <div style={{ fontSize: 10, color: '#444', marginTop: 4 }}>
        Card values from 17Lands (archetype-specific win rates where available). Land count follows Bo1 data: 16 for low curves, 17 otherwise.
      </div>
    </div>
  );
}
