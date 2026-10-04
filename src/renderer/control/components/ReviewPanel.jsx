import React, { useEffect, useState } from 'react';

// Post-draft review: every pick next to what the assistant recommended at the time.

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
}

const KIND_COLOR = { safe: '#7ec8ff', clear: '#7ec8a0', upside: '#ffce5c', need: '#e88c64', wheel: '#c89cff' };

export default function ReviewPanel() {
  const [list, setList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    window.electronAPI?.listDrafts?.().then((l) => {
      setList(l ?? []);
      if (l?.length) setSelected(l[0].file);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    window.electronAPI?.getDraft?.(selected).then(setDraft);
  }, [selected]);

  if (list.length === 0) {
    return <div style={{ flex: 1, padding: 32, textAlign: 'center', color: '#555', fontSize: 12 }}>Finished drafts appear here for review.</div>;
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: 200, borderRight: '1px solid rgba(255,255,255,0.07)', overflowY: 'auto' }}>
        {list.map((d) => (
          <div key={d.file} onClick={() => setSelected(d.file)} style={{
            padding: '8px 12px', cursor: 'pointer', fontSize: 12,
            background: selected === d.file ? 'rgba(80,128,220,0.15)' : 'transparent',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
          }}>
            <div style={{ color: '#ddd', fontWeight: 600 }}>{d.setCode} · {d.deckColors ?? '—'}</div>
            <div style={{ color: '#777', fontSize: 11 }}>{fmtDate(d.endedAt)} · {d.picks} picks{d.agreed != null ? ` · ${Math.round(d.agreed * 100)}% with rec` : ''}</div>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
        {draft && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#777', textAlign: 'left', fontSize: 10, textTransform: 'uppercase' }}>
                <th style={{ padding: '4px 6px' }}>Pick</th><th>You took</th><th>Recommended</th><th>Other options</th>
              </tr>
            </thead>
            <tbody>
              {draft.picks.map((p) => {
                const same = p.recommendedGrpId == null || p.alignedWithRec;
                return (
                  <tr key={p.seqNum} style={{ borderTop: '1px solid rgba(255,255,255,0.05)', background: same ? 'transparent' : 'rgba(255,160,60,0.05)' }}>
                    <td style={{ padding: '4px 6px', color: '#666', fontFamily: 'monospace' }}>P{p.packNumber + 1}p{p.pickNumber + 1}</td>
                    <td style={{ color: '#eee' }}>{p.name}{p.grade ? <span style={{ color: '#888' }}> ({p.grade})</span> : null}</td>
                    <td style={{ color: same ? '#6a9' : '#e0a050' }}>{same ? '✓' : p.recommendation}</td>
                    <td style={{ color: '#888', fontSize: 11 }}>
                      {(p.options ?? []).filter((o) => o.grpId !== p.grpId && o.grpId !== p.recommendedGrpId).map((o, i) => (
                        <span key={i} title={o.reason} style={{ marginRight: 8 }}>
                          <span style={{ color: KIND_COLOR[o.kind] ?? '#888' }}>{o.kind}</span> {o.name}
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
