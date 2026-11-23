import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages, oldestOf } from './src/history.ts';

const m = (seq: number, rev = seq, extra: Record<string, unknown> = {}) => ({ id: seq * 10, seq, rev, ...extra });
const seqs = (list: Array<{ seq?: number }>) => list.map(x => x.seq);

test('new messages slot in by seq, and a newer revision of a held message replaces it', () => {
  const held = [m(98), m(99), m(100)];
  const out = mergeMessages(held, [m(101), m(99, 500, { body: 'edited' })], 98);
  assert.deepEqual(seqs(out), [98, 99, 100, 101]);
  assert.equal((out[1] as any).body, 'edited');
  assert.equal((mergeMessages(out, [m(99, 3, { body: 'stale' })], 98)[1] as any).body, 'edited', 'an older revision never wins');
});

test('a change to a message OLDER than what is loaded is not put on screen (it would sit out of place and break scrolling back)', () => {
  const window = Array.from({ length: 50 }, (_, i) => m(9951 + i));
  const out = mergeMessages(window, [m(5, 20_000, { reactions: ['x'] })], 9951);   // someone reacted to message 5 of a 10,000-message chat
  assert.deepEqual(seqs(out), seqs(window));
  assert.equal(oldestOf(out), 9951, 'so the next page asked for is still the one just before 9951');
});

test('an older page being added IS accepted: the caller lowers the limit to the page\'s first message', () => {
  const window = [m(9951), m(9952)];
  const page = [m(9901), m(9950)];
  assert.deepEqual(seqs(mergeMessages(window, page, 9901)), [9901, 9950, 9951, 9952]);
});

test('when the whole chat is loaded (limit 0), anything is accepted', () => {
  assert.deepEqual(seqs(mergeMessages([m(3), m(4)], [m(1)], 0)), [1, 3, 4]);
});

test('a held message keeps being updated even if the limit moved above it meanwhile', () => {
  const out = mergeMessages([m(5), m(6)], [m(5, 99, { body: 'edited' })], 6);
  assert.equal((out[0] as any).body, 'edited');
});

test('oldestOf ignores anything without a seq, and an empty list has none', () => {
  const unsent: { id: number; seq?: number } = { id: -1 };
  assert.equal(oldestOf([unsent, m(7), m(9)]), 7);
  assert.equal(oldestOf([]), null);
  assert.equal(oldestOf([unsent]), null);
});
