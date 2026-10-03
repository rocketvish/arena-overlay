#!/usr/bin/env node
/**
 * test-parser.js — regression tests for the log watcher + parser.
 *
 * Feeds scripts/fixtures/sos-quickdraft.log (a CRLF Player.log rebuilt from a
 * real 14-card-pack SOS Quick Draft) through the same line splitting the live
 * watcher uses, at many different chunk boundaries.
 *
 * Usage: node scripts/test-parser.js
 */
'use strict';

require('./lib/electronShim');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const logParser = require('../src/main/logParser');
const { splitLogChunk } = require('../src/main/logWatcher');

const FIXTURE = path.join(__dirname, 'fixtures', 'sos-quickdraft.log');
const fixture = fs.readFileSync(FIXTURE, 'utf-8');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

/** Run text through the watcher's splitter in fixed-size chunks; return events. */
function runChunked(text, chunkSize) {
  const events = [];
  const collect = (channel, data) => events.push({ channel, data });
  const { log, warn } = console;
  console.log = console.warn = () => {}; // the parser is chatty
  try {
    logParser.reset();
    logParser.setBroadcast(collect);
    let carry = '';
    for (let i = 0; i < text.length; i += chunkSize) {
      const out = splitLogChunk(carry, text.slice(i, i + chunkSize));
      carry = out.carry;
      for (const line of out.lines) if (line.trim()) logParser.parseLine(line, collect);
    }
    if (carry.trim()) logParser.parseLine(carry, collect);
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return events;
}

const byChannel = (events, ch) => events.filter(e => e.channel === ch);

console.log('\nParser / watcher regression tests');

const events = runChunked(fixture, 1 << 20);

test('fixture really uses CRLF line endings', () => {
  assert.ok(fixture.includes('\r\n'), 'expected CRLF in fixture');
});

test('one draft-started with set + format from EventName', () => {
  const starts = byChannel(events, 'draft-started');
  assert.strictEqual(starts.length, 1);
  assert.deepStrictEqual(starts[0].data, { setCode: 'SOS', format: 'QuickDraft' });
});

test('42 packs opened (3 × 14-card packs), in order', () => {
  const packs = byChannel(events, 'pack-opened');
  assert.strictEqual(packs.length, 42);
  packs.forEach((p, i) => {
    assert.strictEqual(p.data.packNumber, Math.floor(i / 14), `pack # at ${i}`);
    assert.strictEqual(p.data.pickNumber, i % 14, `pick # at ${i}`);
    assert.strictEqual(p.data.cards.length, 14 - (i % 14), `card count at ${i}`);
  });
});

test('pack size is learned as 14 (not assumed 15)', () => {
  for (const p of byChannel(events, 'pack-opened')) assert.strictEqual(p.data.packSize, 14);
});

test('every pick is detected (CRLF request lines parse)', () => {
  const picks = byChannel(events, 'card-picked');
  assert.strictEqual(picks.length, 42);
  picks.forEach((p, i) => {
    assert.strictEqual(p.data.packNumber, Math.floor(i / 14));
    assert.strictEqual(p.data.pickNumber, i % 14);
  });
  assert.strictEqual(picks[41].data.pickedCards.length, 42);
});

test('each picked card was in the pack it was picked from', () => {
  const packs = byChannel(events, 'pack-opened');
  const picks = byChannel(events, 'card-picked');
  picks.forEach((p, i) => {
    assert.ok(packs[i].data.cards.some(c => c.grpId === p.data.grpId), `pick ${i} grpId ${p.data.grpId}`);
  });
});

test('DraftStatus=Completed ends the draft', () => {
  const ends = byChannel(events, 'draft-ended');
  assert.strictEqual(ends.length, 1);
  assert.strictEqual(events[events.length - 1].channel, 'draft-ended');
});

test('identical events regardless of read-chunk boundaries', () => {
  const baseline = JSON.stringify(events.map(e => [e.channel, e.data.grpId ?? e.data.packEventId?.split('-t')[0]]));
  for (const size of [1, 7, 64, 333, 4096]) {
    const got = JSON.stringify(runChunked(fixture, size).map(e => [e.channel, e.data.grpId ?? e.data.packEventId?.split('-t')[0]]));
    assert.strictEqual(got, baseline, `chunk size ${size}`);
  }
});

test('a second draft in the same session is not suppressed as stale', () => {
  const twice = runChunked(fixture + fixture, 4096);
  assert.strictEqual(byChannel(twice, 'draft-started').length, 2);
  assert.strictEqual(byChannel(twice, 'pack-opened').length, 84);
  assert.strictEqual(byChannel(twice, 'card-picked').length, 84);
});

test('abandoned draft followed by a new P1p1 restarts cleanly', () => {
  const lines = fixture.split('\r\n');
  // Cut the first draft off before it completes (drop the last ~20 lines).
  const abandoned = lines.slice(0, lines.length - 20).join('\r\n') + '\r\n';
  const evs = runChunked(abandoned + fixture, 4096);
  assert.strictEqual(byChannel(evs, 'draft-started').length, 2);
  assert.strictEqual(byChannel(evs, 'draft-ended').length, 2);
});

test('replayed pick lines are not double-counted', () => {
  const lines = fixture.split('\r\n');
  const pickLine = lines.find(l => l.includes('==> BotDraftDraftPick'));
  const evs = runChunked(fixture.replace(pickLine, `${pickLine}\r\n${pickLine}`), 4096);
  assert.strictEqual(byChannel(evs, 'card-picked').length, 42);
});

test('Premier Draft.Notify + EventPlayerDraftMakePick are understood', () => {
  const notify = (pack, pick, ids) =>
    `[UnityCrossThreadLogger]Draft.Notify {"draftId":"d1","SelfPick":${pick},"SelfPack":${pack},"PackCards":"${ids.join(',')}"}`;
  const makePick = (pack, pick, id) =>
    `[UnityCrossThreadLogger]==> EventPlayerDraftMakePick {"id":"x","request":"{\\"DraftId\\":\\"d1\\",\\"GrpIds\\":[${id}],\\"Pack\\":${pack},\\"Pick\\":${pick}}"}`;
  const join = `[UnityCrossThreadLogger]==> EventJoin {"id":"j","request":"{\\"EventName\\":\\"PremierDraft_FRA_20260929\\",\\"EntryCurrencyType\\":\\"Gem\\"}"}`;
  const text = [
    join,
    notify(1, 1, [1, 2, 3]), makePick(1, 1, 2),
    notify(1, 2, [4, 5]), makePick(1, 2, 5),
  ].join('\r\n') + '\r\n';
  const evs = runChunked(text, 4096);
  const packs = byChannel(evs, 'pack-opened');
  const picks = byChannel(evs, 'card-picked');
  // Draft.Notify has no EventName — the set must come from EventJoin.
  assert.deepStrictEqual(byChannel(evs, 'draft-started')[0].data, { setCode: 'FRA', format: 'PremierDraft' });
  assert.strictEqual(packs.length, 2);
  assert.deepStrictEqual([packs[0].data.packNumber, packs[0].data.pickNumber], [0, 0]);
  assert.deepStrictEqual(picks.map(p => [p.data.grpId, p.data.packNumber, p.data.pickNumber]), [[2, 0, 0], [5, 0, 1]]);
});

test('a human draft with no EventJoin recognises its set from the cards', () => {
  logParser.setSetCodeResolver((ids) => (ids.includes(106256) ? 'FRA' : null));
  try {
    const evs = runChunked('[UnityCrossThreadLogger]Draft.Notify {"draftId":"d","SelfPick":4,"SelfPack":1,"PackCards":"106256,5,6"}\r\n', 4096);
    assert.strictEqual(byChannel(evs, 'draft-started')[0].data.setCode, 'FRA');
  } finally {
    logParser.setSetCodeResolver(null);
  }
});

// ── Integration: the real watcher's startup scan, mid-Premier-draft ──────────
async function watcherStartupScan() {
  const os = require('os');
  const { userData } = require('./lib/electronShim');
  const logWatcher = require('../src/main/logWatcher');
  const tmpLog = path.join(os.tmpdir(), `arena-overlay-test-${process.pid}.log`);
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ general: { arenaLogPath: tmpLog } }));
  const join = `[UnityCrossThreadLogger]==> EventJoin {"id":"j","request":"{\\"EventName\\":\\"PremierDraft_FRA_20260929\\"}"}`;
  const notify = (pick, ids) => `[UnityCrossThreadLogger]Draft.Notify {"draftId":"d","SelfPick":${pick},"SelfPack":1,"PackCards":"${ids}"}`;
  // Earlier noise, the join, a few picks — and an unterminated final line (Arena mid-write).
  fs.writeFileSync(tmpLog, ['noise', join, 'more noise', notify(1, '1,2,3'), notify(2, '4,5')].join('\r\n') + '\r\n[UnityCrossThreadLogger]partial li');

  const events = [];
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    logWatcher.startWatching((channel, data) => events.push({ channel, data }));
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    logWatcher.stopWatching();
    console.log = log; console.warn = warn;
    fs.rmSync(tmpLog, { force: true });
  }
  return events;
}

(async () => {
  const events = await watcherStartupScan();
  test('startup scan finds an in-progress Premier draft and its set', () => {
    const start = byChannel(events, 'draft-started')[0];
    assert.ok(start, 'no draft-started from the startup scan');
    assert.deepStrictEqual(start.data, { setCode: 'FRA', format: 'PremierDraft' });
    const packs = byChannel(events, 'pack-opened');
    assert.strictEqual(packs[packs.length - 1].data.pickNumber, 1);
  });

  console.log(failures ? `\n${failures} test(s) failed\n` : '\nAll parser tests passed\n');
  process.exit(failures ? 1 : 0);
})();
