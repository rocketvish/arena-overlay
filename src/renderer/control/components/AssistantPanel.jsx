import React from 'react';

// ── Color helpers ─────────────────────────────────────────────────────────────
const COLORS = ['W', 'U', 'B', 'R', 'G'];
const COLOR_HEX = { W: '#f5e664', U: '#50a0ff', B: '#b090e0', R: '#f06464', G: '#50b95a' };
const COLOR_LABELS = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const GRADE_COLORS = {
  'A+':'#32c850','A':'#32c850','A-':'#50d264',
  'B+':'#28aadc','B':'#28aadc','B-':'#3cb4c8',
  'C+':'#dcc832','C':'#d2b928','C-':'#c8a51e',
  'D+':'#e6823c','D':'#dc6e32','D-':'#d25a28','F':'#c83232',
};

function signalTrafficColor(score) {
  if (score >= 60) return '#50c87a';
  if (score >= 40) return '#c8c830';
  return '#d05050';
}

function SectionHead({ title }) {
  return (
    <div style={{ fontSize: 9, fontWeight: 700, color: '#555', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8, paddingBottom: 3, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
      {title}
    </div>
  );
}

// ── Color Signals ─────────────────────────────────────────────────────────────
function ColorSignalsPanel({ colorSignals, hasColorData }) {
  if (!colorSignals) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <SectionHead title="Color Signals" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {COLORS.map(color => {
          const sig = colorSignals[color];
          if (!sig) return null;
          const bar = sig.hasData ? sig.score : 50;
          const col = sig.hasData ? signalTrafficColor(sig.score) : '#444';
          return (
            <div key={color}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <span style={{ color: COLOR_HEX[color], fontWeight: 700, fontSize: 11, width: 14 }}>{color}</span>
                <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.07)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${bar}%`, height: '100%', background: col, borderRadius: 3, transition: 'width 0.4s' }} />
                </div>
                <span style={{ fontSize: 10, color: col, minWidth: 72, textAlign: 'right' }}>
                  {sig.hasData ? `${sig.label} (${sig.score})` : 'No data yet'}
                </span>
              </div>
              <div style={{ fontSize: 9, color: '#555', paddingLeft: 20, marginBottom: 2 }}>{sig.evidence}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Archetype standings: which two-color decks the field wins with ───────────
function ArchetypeStandingsPanel({ standings, commitment }) {
  if (!standings || standings.length === 0) return null;
  const yours = commitment?.colors?.length === 2 ? [...commitment.colors].sort().join('') : null;
  const cohort = standings[0]?.cohort === 'top' ? "17Lands' top players" : 'all 17Lands players';
  const maxWr = Math.max(...standings.map(s => s.wr));
  const minWr = Math.min(...standings.map(s => s.wr));
  return (
    <div style={{ marginBottom: 16 }}>
      <SectionHead title={`What's winning — 2-color win rate (${cohort})`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {standings.map(s => {
          const mine = yours && [...s.pair].sort().join('') === yours;
          const width = maxWr > minWr ? 15 + 85 * (s.wr - minWr) / (maxWr - minWr) : 50;
          return (
            <div key={s.pair} style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                 title={`${s.pair}: ${(s.wr * 100).toFixed(1)}% (${s.cohort === 'top' ? 'top players' : 'all players'}); all players ${(s.overallWr * 100).toFixed(1)}%; ${(s.share * 100).toFixed(0)}% of decks`}>
              <span style={{ width: 26, fontSize: 10, fontWeight: 700, fontFamily: 'monospace' }}>
                {[...s.pair].map(c => <span key={c} style={{ color: COLOR_HEX[c] }}>{c}</span>)}
              </span>
              <div style={{ flex: 1, height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${width}%`, height: '100%', background: mine ? '#7ec8ff' : 'rgba(150,170,200,0.45)' }} />
              </div>
              <span style={{ fontSize: 10, color: mine ? '#7ec8ff' : '#999', fontFamily: 'monospace', minWidth: 40, textAlign: 'right' }}>
                {(s.wr * 100).toFixed(1)}%
              </span>
              <span style={{ fontSize: 9, color: '#555', minWidth: 28, textAlign: 'right' }}>{(s.share * 100).toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 9, color: '#555', marginTop: 4 }}>Right column: share of decks drafted. Source: 17Lands.</div>
    </div>
  );
}

// ── Mana Curve ────────────────────────────────────────────────────────────────
function ManaCurve({ curve }) {
  if (!curve) return null;
  const entries = [1,2,3,4,5,6].map(k => ({ cmc: k === 6 ? '6+' : String(k), count: curve[k] ?? 0 }));
  const max = Math.max(1, ...entries.map(e => e.count));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 36 }}>
        {entries.map(({ cmc, count }) => (
          <div key={cmc} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
            <div style={{ fontSize: 8, color: '#777', fontFamily: 'monospace' }}>{count > 0 ? count : ''}</div>
            <div style={{
              width: '100%',
              height: count > 0 ? `${Math.round((count / max) * 24)}px` : 2,
              background: count > 0 ? 'rgba(80,140,220,0.55)' : 'rgba(255,255,255,0.05)',
              borderRadius: '2px 2px 0 0',
              transition: 'height 0.3s',
            }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 3, marginTop: 1 }}>
        {entries.map(({ cmc }) => (
          <div key={cmc} style={{ flex: 1, textAlign: 'center', fontSize: 8, color: '#555' }}>{cmc}</div>
        ))}
      </div>
    </div>
  );
}

// ── Deck Overview ─────────────────────────────────────────────────────────────
function DeckOverviewPanel({ composition, manaAnalysis }) {
  if (!composition) return null;
  const { creatures, nonCreatures, removalCount, cardAdvantageCount, fixingCount, colorCounts, curve, totalPicked } = composition;
  const totalNonLand = creatures + nonCreatures;
  const top2 = Object.entries(colorCounts ?? {}).sort(([,a],[,b])=>b-a).filter(([,v])=>v>0).slice(0,2);
  const mana = manaAnalysis ?? {};

  return (
    <div style={{ marginBottom: 16 }}>
      <SectionHead title="Deck Overview" />

      {/* Primary colors */}
      {top2.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
          {top2.map(([c, v]) => (
            <span key={c} style={{ padding: '2px 8px', borderRadius: 4, background: `${COLOR_HEX[c]}22`, border: `1px solid ${COLOR_HEX[c]}55`, fontSize: 10, color: COLOR_HEX[c], fontWeight: 700 }}>
              {COLOR_LABELS[c]} ({v})
            </span>
          ))}
        </div>
      )}

      {/* Mana base */}
      <div style={{ fontSize: 10, color: mana.assessment === 'ok' ? '#6a9' : mana.assessment === 'warning' ? '#cc8' : '#e06', marginBottom: 8 }}>
        {mana.message}
      </div>

      {/* Mana curve */}
      {totalNonLand > 0 && <ManaCurve curve={curve} />}

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {[
          ['Creatures', creatures],
          ['Spells', nonCreatures],
          ['Removal', `${removalCount}/3`, removalCount < 2 && totalNonLand >= 8 ? '#e07050' : '#6a9'],
          ['Card Adv.', cardAdvantageCount],
          ['Fixing', fixingCount],
        ].map(([label, val, col]) => (
          <div key={label} style={{ textAlign: 'center', minWidth: 44 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: col ?? '#c8c8c8', fontFamily: 'monospace' }}>{val}</div>
            <div style={{ fontSize: 9, color: '#555' }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Strengths & Weaknesses ────────────────────────────────────────────────────
function AssessmentPanel({ strengths, weaknesses, deckNeeds }) {
  const hasAny = strengths?.length || weaknesses?.length || deckNeeds?.length;
  if (!hasAny) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <SectionHead title="Deck Assessment" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {(strengths ?? []).map((s, i) => (
          <div key={i} style={{ fontSize: 10, color: '#6baa6b' }}>✓ {s}</div>
        ))}
        {(deckNeeds ?? []).map(n => n.priority === 'high' ? (
          <div key={n.id} style={{ fontSize: 10, color: '#e07050' }}>⚠ {n.label} — {n.detail}</div>
        ) : null)}
        {(weaknesses ?? []).map((w, i) => (
          <div key={i} style={{ fontSize: 10, color: '#888' }}>△ {w}</div>
        ))}
        {(deckNeeds ?? []).filter(n => n.priority !== 'high').map(n => (
          <div key={n.id} style={{ fontSize: 10, color: '#786838' }}>○ {n.label} — {n.detail}</div>
        ))}
      </div>
    </div>
  );
}

// ── Pick History ──────────────────────────────────────────────────────────────
function PickHistoryPanel({ pickHistory }) {
  if (!pickHistory || pickHistory.length === 0) return null;
  const shown = pickHistory.slice().reverse().slice(0, 20);
  return (
    <div style={{ marginBottom: 8 }}>
      <SectionHead title="Pick History" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {shown.map((pick) => {
          const gradeColor = GRADE_COLORS[pick.grade] ?? '#666';
          const diffRec = !pick.alignedWithRec && pick.recommendation;
          return (
            <div key={pick.seqNum} style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '2px 4px',
              background: diffRec ? 'rgba(255,160,60,0.05)' : 'transparent',
              borderRadius: 3,
            }}>
              <span style={{ fontSize: 9, color: '#444', width: 22, textAlign: 'right', flexShrink: 0, fontFamily: 'monospace' }}>
                P{(pick.packNumber ?? 0) + 1}.{(pick.pickNumber ?? 0) + 1}
              </span>
              {pick.grade && (
                <span style={{ fontSize: 9, color: gradeColor, width: 18, textAlign: 'center', flexShrink: 0, fontWeight: 700 }}>
                  {pick.grade}
                </span>
              )}
              <span style={{ flex: 1, fontSize: 10, color: '#c8c8c8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {pick.name}
              </span>
              {diffRec && (
                <span title={`Rec: ${pick.recommendation}`} style={{ fontSize: 9, color: '#c87830', flexShrink: 0 }}>≠</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────
export default function AssistantPanel({ assistantState, draftState }) {
  const inDraft = draftState?.inDraft ?? false;

  if (!inDraft) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 40, opacity: 0.1 }}>🧭</div>
        <div style={{ fontSize: 13, color: '#444' }}>
          No draft active
          <br />
          <span style={{ fontSize: 11, color: '#333' }}>Assistant activates when you join a draft.</span>
        </div>
      </div>
    );
  }

  if (!assistantState) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, fontSize: 11, color: '#444' }}>
        Loading assistant data…
      </div>
    );
  }

  const {
    colorSignals, hasColorData, deckComposition, deckNeeds, strengths, weaknesses,
    manaAnalysis, pickHistory, archetype, winConditions, deckGrade,
    archetypeStandings, commitment,
  } = assistantState;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
      <ColorSignalsPanel colorSignals={colorSignals} hasColorData={hasColorData} />
      <ArchetypeStandingsPanel standings={archetypeStandings} commitment={commitment} />
      <ArchetypeWinPanel archetype={archetype} winConditions={winConditions} deckGrade={deckGrade} />
      <DeckOverviewPanel composition={deckComposition} manaAnalysis={manaAnalysis} />
      <AssessmentPanel strengths={strengths} weaknesses={weaknesses} deckNeeds={deckNeeds} />
      <PickHistoryPanel pickHistory={pickHistory} />
    </div>
  );
}

// ── Tier 3 archetype + win condition (Section 6) ──────────────────────────────
function ArchetypeWinPanel({ archetype, winConditions, deckGrade }) {
  const hasArchetype = archetype?.primary;
  const hasWincon = winConditions?.message;
  if (!hasArchetype && !hasWincon && !deckGrade) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <SectionHead title="Deck Identity" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {hasArchetype && (
          <div style={{ fontSize: 11, color: '#cfcfcf' }}>
            <span style={{ color: '#666' }}>Archetype: </span>
            <span style={{ color: '#7ec8ff', fontWeight: 700 }}>{archetype.label ?? archetype.primary}</span>
            {archetype.confidence > 0 && (
              <span style={{ color: '#555', marginLeft: 6 }}>
                ({Math.round(archetype.confidence * 100)}% confident)
              </span>
            )}
          </div>
        )}
        {deckGrade && (
          <div style={{ fontSize: 11, color: '#cfcfcf' }}>
            <span style={{ color: '#666' }}>Deck grade: </span>
            <span style={{ color: '#7ec8a0', fontWeight: 700 }}>{deckGrade.grade}</span>
            <span style={{ color: '#555', marginLeft: 6, fontFamily: 'monospace' }}>
              avg {(deckGrade.avgGihwr * 100).toFixed(1)}%
            </span>
          </div>
        )}
        {hasWincon && (
          <div style={{ fontSize: 11, color: winConditions.hasBomb ? '#e0c878' : '#888', lineHeight: 1.4 }}>
            <span style={{ color: '#666' }}>{winConditions.hasBomb ? '★ ' : '▸ '}</span>
            {winConditions.message}
          </div>
        )}
      </div>
    </div>
  );
}
