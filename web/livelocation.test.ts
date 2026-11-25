import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_GAP_MS, MIN_GAP_MS, addShare, dropShare, isSharing, metres, prune, shares, shouldSend } from './src/livelocation.ts';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, raw: m }; };

test('distance between two points is in metres', () => {
  assert.equal(Math.round(metres(24.7136, 46.6753, 24.7136, 46.6753)), 0);
  assert.ok(Math.abs(metres(24.7136, 46.6753, 24.7146, 46.6753) - 111) < 3, 'a ten-thousandth of a degree north is about 111 m');
});

test('a point is sent when it is the first, when the person has moved, or when it has been quiet too long', () => {
  assert.ok(shouldSend(null, 1000, 24.7, 46.6), 'the first reading always goes');
  const last = { at: 100_000, lat: 24.7, lng: 46.6 };
  assert.ok(!shouldSend(last, 100_000 + MIN_GAP_MS - 1, 25, 47), 'never faster than the minimum gap, however far it jumped');
  assert.ok(!shouldSend(last, 100_000 + MIN_GAP_MS + 1, 24.700_05, 46.6), 'a few metres is the device being imprecise, not news');
  assert.ok(shouldSend(last, 100_000 + MIN_GAP_MS + 1, 24.7005, 46.6), 'fifty metres is news');
  assert.ok(shouldSend(last, 100_000 + MAX_GAP_MS, 24.7, 46.6), 'and standing still still says so now and then, so the pin is seen to be alive');
});

test('a share that has run out is forgotten, and the rest are kept', () => {
  const now = 1_000_000;
  assert.deepEqual(prune([{ mid: 1, circleId: 2, until: now - 1 }, { mid: 3, circleId: 2, until: now + 1 }], now).map(s => s.mid), [3]);
});

test('shares are remembered on this device so a refresh carries on, and stopping one forgets it', () => {
  const s = mem(), now = 1_000_000;
  addShare({ mid: 7, circleId: 2, until: now + 60_000 }, s, now);
  addShare({ mid: 8, circleId: 3, until: now + 60_000 }, s, now);
  assert.deepEqual(shares(s, now).map(x => x.mid), [7, 8]);
  assert.ok(isSharing(7, s, now));

  addShare({ mid: 7, circleId: 2, until: now + 120_000 }, s, now);
  assert.equal(shares(s, now).length, 2, 'sharing the same message again moves it, it does not double it');

  dropShare(7, s, now);
  assert.deepEqual(shares(s, now).map(x => x.mid), [8]);
  assert.equal(shares(s, now + 10 * 60_000).length, 0, 'and later they have all run out');

  dropShare(8, s, now);
  assert.equal(s.raw.size, 0, 'nothing is left behind once nothing is shared');
});

test('damaged storage is read as nothing shared, never as a crash', () => {
  const s = mem();
  s.setItem('tamtim_live', '{not json');
  assert.deepEqual(shares(s, 1), []);
  s.setItem('tamtim_live', '[{"mid":"x"}]');
  assert.deepEqual(shares(s, 1), []);
});
