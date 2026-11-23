import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf, safetyCode, gradeQuality, readQuality, clock, endKey } from './src/calls.ts';

const fp = (h: string) => `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 ${h}\r\na=setup:actpass\r\n`;

test('the DTLS fingerprint is read from an SDP; none gives null', () => {
  assert.equal(fingerprintOf(fp('aa:bb:cc')), 'AA:BB:CC');
  assert.equal(fingerprintOf('v=0\r\n'), null);
  assert.equal(fingerprintOf(`${fp('aa:bb')}a=fingerprint:sha-256 aa:bb\r\n`), 'AA:BB', 'the same one twice is fine');
  assert.equal(fingerprintOf(`a=fingerprint:sha-256 11:22\r\n${fp('aa:bb')}`), null, 'two different ones: refused');
});

test('the safety code is the same on both phones whichever side asks, 15 digits in three groups, and changes if one key changes', async () => {
  const mine = fp('AA:11:22:33'), theirs = fp('BB:44:55:66');
  const x = await safetyCode(mine, theirs), y = await safetyCode(theirs, mine);
  assert.equal(x, y);
  assert.match(x!, /^\d{5} \d{5} \d{5}$/);
  assert.notEqual(await safetyCode(mine, fp('BB:44:55:67')), x);
  assert.equal(await safetyCode(mine, 'v=0'), null, 'no fingerprint, no code');
});

test('quality: good / weak / bad from round trip and packet loss; nothing known gives null', () => {
  assert.equal(gradeQuality({ rttMs: 80, lossPct: 0 }), 'good');
  assert.equal(gradeQuality({ rttMs: 250, lossPct: 0 }), 'weak');
  assert.equal(gradeQuality({ rttMs: 80, lossPct: 5 }), 'weak');
  assert.equal(gradeQuality({ rttMs: 500, lossPct: 0 }), 'bad');
  assert.equal(gradeQuality({ rttMs: 80, lossPct: 15 }), 'bad');
  assert.equal(gradeQuality({ rttMs: null, lossPct: null }), null);
  assert.equal(gradeQuality({ rttMs: null, lossPct: 12 }), 'bad');
});

test('stats: round trip from the selected pair, loss from what arrived since the last look', () => {
  const rep = (lost: number, got: number) => [
    { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.12 },
    { type: 'inbound-rtp', kind: 'audio', packetsLost: lost, packetsReceived: got },
  ];
  const first = readQuality(rep(2, 98), null);
  assert.equal(first.rttMs, 120); assert.equal(first.lossPct, 2);
  const second = readQuality(rep(12, 188), first.next);   // 10 lost of 100 more
  assert.equal(second.lossPct, 10);
  assert.deepEqual(readQuality([], null).rttMs, null);
  assert.equal(readQuality([{ type: 'remote-inbound-rtp', kind: 'audio', roundTripTime: 0.3 }], null).rttMs, 300, 'falls back to the remote report');
});

test('time and end reasons', () => {
  assert.equal(clock(5), '0:05'); assert.equal(clock(65), '1:05'); assert.equal(clock(3725), '1:02:05');
  assert.equal(endKey('declined'), 'declined'); assert.equal(endKey('timeout'), 'noAnswer'); assert.equal(endKey('weird'), 'ended');
  assert.equal(endKey('lost'), 'lost'); assert.equal(endKey('offline'), 'offline'); assert.equal(endKey('cancelled'), 'ended');
});
