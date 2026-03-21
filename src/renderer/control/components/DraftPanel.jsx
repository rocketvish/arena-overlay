import React from 'react';

const GRADE_COLORS = {
  'A+': '#32c850', 'A': '#32c850', 'A-': '#50d264',
  'B+': '#28aadc', 'B': '#28aadc', 'B-': '#3cb4c8',
  'C+': '#dcc832', 'C': '#d2b928', 'C-': '#c8a51e',
  'D+': '#e6823c', 'D': '#dc6e32', 'D-': '#d25a28',
  'F': '#c83232',
};

function pct(v) {
  return v != null ? `${(v * 100).toFixed(1)}%` : '—';
}

function RecommendedCard({ card, label, primary }) {
  if (!card) return null;
  const grade = card.stats?.grade;
  const gradeColor = grade ? (GRADE_COLORS[grade] ?? '#888') : '#888';

  return (
    <div style={{
      background: primary ? 'rgba(80,200,120,0.10)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${primary ? 'rgba(80,200,120,0.3)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 6,
      padding: '10px 14px',
    }}>
      <div style={{ fontSize: 10, color: '#555', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {grade && (
          <span style={{
            fontSize: 20, fontWeight: 700, color: gradeColor,
            minWidth: 36, textAlign: 'center',
          }}>
            {grade}
          </span>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e8e8e8' }}>
            {card.name ?? `#${card.grpId}`}
          </div>
          <div style={{ fontSize: 11, color: '#666', marginTop: 2, fontFamily: 'monospace' }}>
            GIH {pct(card.stats?.gihwr)}
            {card.stats?.ohwr != null && <span style={{ marginLeft: 8, color: '#555' }}>OH {pct(card.stats.ohwr)}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DraftPanel({ draftState }) {
  const { inDraft, enrichedPack, pickedCards, recommendation } = draftState;

  if (!inDraft) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 12, padding: 32, textAlign: 'center',
      }}>
        <div style={{ fontSize: 40, opacity: 0.15 }}>🃏</div>
        <div style={{ fontSize: 13, color: '#444' }}>
          No draft active
          <br />
          <span style={{ fontSize: 11, color: '#333' }}>Open MTG Arena and join a draft event.</span>
        </div>
      </div>
    );
  }

  const packSize = enrichedPack?.length ?? 0;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Recommendation */}
      {recommendation && (
        <div>
          <div style={{ fontSize: 11, color: '#555', marginBottom: 8 }}>Recommendation</div>
          <RecommendedCard card={recommendation.primary} label="Best Pick" primary />
          {recommendation.secondary && recommendation.secondary.grpId !== recommendation.primary?.grpId && (
            <div style={{ marginTop: 8 }}>
              <RecommendedCard card={recommendation.secondary} label="Runner-Up" primary={false} />
            </div>
          )}
          {recommendation.explanation && (
            <div style={{
              marginTop: 8, padding: '6px 10px',
              background: 'rgba(255,255,255,0.03)',
              borderRadius: 4, fontSize: 11, color: '#777', fontStyle: 'italic',
            }}>
              {recommendation.explanation}
            </div>
          )}
        </div>
      )}

      {/* Pack summary */}
      {packSize > 0 && (
        <div>
          <div style={{ fontSize: 11, color: '#555', marginBottom: 8 }}>
            Current Pack ({packSize} cards)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {[...(enrichedPack ?? [])].slice(0, 15).map((card, i) => {
              const isRec = recommendation?.primary?.grpId === card.grpId;
              return (
                <div key={card.grpId ?? i} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '3px 8px', borderRadius: 3,
                  background: isRec ? 'rgba(80,200,120,0.07)' : 'transparent',
                  border: `1px solid ${isRec ? 'rgba(80,200,120,0.2)' : 'transparent'}`,
                }}>
                  {isRec && <span style={{ fontSize: 10, color: '#7ec8a0' }}>★</span>}
                  {!isRec && <div style={{ width: 14 }} />}
                  <span style={{ flex: 1, fontSize: 12, color: '#c8c8c8' }}>
                    {card.name ?? `#${card.grpId}`}
                  </span>
                  {card.stats?.grade && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: GRADE_COLORS[card.stats.grade] ?? '#888', minWidth: 24, textAlign: 'right' }}>
                      {card.stats.grade}
                    </span>
                  )}
                  {card.stats?.gihwr != null && (
                    <span style={{ fontSize: 10, color: '#666', minWidth: 40, textAlign: 'right', fontFamily: 'monospace' }}>
                      {pct(card.stats.gihwr)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Picked cards summary */}
      {pickedCards?.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>
            Picked ({pickedCards.length})
          </div>
          <div style={{ fontSize: 11, color: '#444' }}>
            {pickedCards.slice(-5).map((c, i) => c.name ?? `#${c.grpId}`).join(', ')}
            {pickedCards.length > 5 && ` ... +${pickedCards.length - 5} more`}
          </div>
        </div>
      )}
    </div>
  );
}
