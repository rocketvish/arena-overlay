import React from 'react';

// In-game information: mulligan data, the opponent's likely instant-speed
// cards, and draw odds. Information only — it never tells you which play to make.

const COLOR_HEX = { W: '#f5e664', U: '#50a0ff', B: '#b090e0', R: '#f06464', G: '#50b95a' };
const KIND = {
  removal: { label: 'removal', color: '#ff8a7a' },
  counter: { label: 'counter', color: '#7ab8ff' },
  trick:   { label: 'trick',   color: '#ffce5c' },
  other:   { label: 'instant', color: '#aaa' },
};
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

function Section({ title, children, right }) {
  return (
    <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 5 }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: '#9fc8ff', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{title}</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#777' }}>{right}</span>
      </div>
      {children}
    </div>
  );
}

function Mulligan({ m }) {
  const side = m.sideKnown ? `on the ${m.side}` : '';
  if (!m.verdict || m.keepWr == null) {
    return <div style={{ fontSize: 12, color: '#aaa' }}>{m.lands} lands {side}. {m.note}</div>;
  }
  const color = m.verdict === 'keep' ? '#7ec8a0' : m.verdict === 'mulligan' ? '#ff8a7a' : '#ffce5c';
  const word = m.verdict === 'close' ? 'CLOSE CALL' : m.verdict.toUpperCase();
  return (
    <div title={`17Lands public game data${m.source === 'set' ? ` for this set (${m.games.toLocaleString()} games with this land count)` : ' across recent sets'}. Win rate of players who kept a 7 like this, vs. those who mulliganed to 6. Doesn't see which spells you hold.`}>
      <div style={{ fontSize: 16, fontWeight: 800, color }}>{word}</div>
      <div style={{ fontSize: 12, color: '#ccc', marginTop: 2 }}>
        {m.lands} lands {side}: keeping wins <b>{pct(m.keepWr)}</b> vs <b>{pct(m.mullWr)}</b> after a mulligan to 6
      </div>
    </div>
  );
}

function Opponent({ o }) {
  return (
    <>
      <div style={{ fontSize: 12, color: '#ccc', marginBottom: 4 }}>
        {o.colors.length ? o.colors.map((c) => <span key={c} style={{ color: COLOR_HEX[c], fontWeight: 800 }}>{c}</span>) : 'Colors unknown'}
        {' · '}<b>{o.open}</b> open mana · {o.handCount} cards in hand
      </div>
      {o.threats.length === 0 ? (
        <div style={{ fontSize: 11, color: '#777' }}>{o.open === 0 ? 'Tapped out — no instant-speed cards possible' : 'No common instant-speed cards for these colors at this mana'}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {o.threats.map((t) => {
            const k = KIND[t.kind] ?? KIND.other;
            return (
              <div key={t.grpId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                   title={`Share of instant-speed plays at this mana among 17Lands decks in these colors: ${Math.round(t.share * 100)}%`}>
                <span style={{ fontSize: 9, color: k.color, minWidth: 46, textTransform: 'uppercase', fontWeight: 700 }}>{k.label}</span>
                <span style={{ color: '#eee', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}{t.seen ? ' ·seen' : ''}</span>
                <span style={{ color: '#888', fontFamily: 'monospace', fontSize: 11 }}>{t.cmc}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function PlayDraw({ p }) {
  return (
    <div title="Overall win rate when going first vs second in this format (17Lands public game data). Most Limited formats favor playing first.">
      <div style={{ fontSize: 16, fontWeight: 800, color: '#7ec8a0' }}>{p.verdict === 'play' ? 'PLAY FIRST' : 'DRAW FIRST'}</div>
      <div style={{ fontSize: 12, color: '#ccc', marginTop: 2 }}>
        On the play wins <b>{pct(p.play)}</b> vs <b>{pct(p.draw)}</b> on the draw{p.source === 'set' ? ' in this format' : ' (recent formats)'}
      </div>
    </div>
  );
}

function Race({ r }) {
  if (r.myClock == null && r.oppClock == null) return null;
  const turns = (n) => (n == null ? 'no clock' : `${n} turn${n === 1 ? '' : 's'}`);
  const who = r.beatdown === 'you' ? "you're the beatdown — keep attacking"
    : r.beatdown === 'them' ? "they're the beatdown — prioritize blocking and trading"
    : 'even race';
  return (
    <div style={{ fontSize: 12, color: '#ccc' }}
         title="Who's the beatdown? Turns each side needs if every creature attacked unblocked (ignores blocks and tricks).">
      You win in <b>{turns(r.myClock)}</b> ({r.myPower} power) · they win in <b>{turns(r.oppClock)}</b> ({r.oppPower} power)
      <div style={{ fontSize: 11, color: r.beatdown === 'them' ? '#ffb070' : '#8fd0a8', marginTop: 2 }}>{who}</div>
    </div>
  );
}

function Draws({ d }) {
  return (
    <div style={{ fontSize: 12, color: '#ccc' }}>
      Next draw: <b>{pct(d.pLand)}</b> land · {d.removal} removal · {d.creatures} creatures left in {d.library} cards
    </div>
  );
}

export default function GamePanel({ game }) {
  if (!game) return null;
  const life = game.life ?? {};
  const header = game.result
    ? `Game over — ${game.result === 'win' ? 'you won' : game.result === 'loss' ? 'you lost' : 'draw'}`
    : game.turn ? `Turn ${game.turn} · ${game.myTurn ? 'your turn' : "opponent's turn"}` : 'Game starting';
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px', background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ fontSize: 12, color: '#ddd', fontWeight: 700 }}>{header}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#aaa', fontFamily: 'monospace' }}>
          {life.me ?? '—'} <span style={{ color: '#555' }}>vs</span> {life.opp ?? '—'}
        </span>
      </div>
      {game.playDraw && <Section title="You choose" right="17Lands data"><PlayDraw p={game.playDraw} /></Section>}
      {game.mulligan && <Section title="Mulligan" right="17Lands data"><Mulligan m={game.mulligan} /></Section>}
      {!game.mulligan && game.race && game.turn > 0 && <Section title="Race (unblocked)"><Race r={game.race} /></Section>}
      {!game.mulligan && game.opponent && <Section title="Opponent could have" right="17Lands decks in their colors"><Opponent o={game.opponent} /></Section>}
      {!game.mulligan && game.draws && <Section title="Your library"><Draws d={game.draws} /></Section>}
      {!game.setCode && (
        <div style={{ padding: '6px 10px', fontSize: 10, color: '#666' }}>Card details unavailable for this deck (works for Limited decks of a known set).</div>
      )}
    </div>
  );
}
