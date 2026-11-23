import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox } from './src/outbox.ts';

/** What a browser's localStorage looks like to the outbox. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
}
const item = (cid: string, at: number, circle = 1) => ({ cid, circle, body: `text ${cid}`, replyTo: null, at });
const ME = 7;

test('messages wait in the order they were written, per chat', () => {
  const box = createOutbox(fakeStorage(), ME);
  box.add(item('b', 200)); box.add(item('a', 100)); box.add(item('c', 200)); box.add(item('x', 50, 2));
  assert.deepEqual(box.list(1).map(i => i.cid), ['a', 'b', 'c'], 'by time written, then by the order they were added');
  assert.deepEqual(box.list(2).map(i => i.cid), ['x']);
  assert.deepEqual(box.list(3), []);
  assert.deepEqual(box.circles().sort(), [1, 2]);
});

test('a sent message leaves the outbox; the others keep their places', () => {
  const box = createOutbox(fakeStorage(), ME);
  box.add(item('a', 1)); box.add(item('b', 2)); box.add(item('c', 3));
  box.done('b');
  assert.deepEqual(box.list(1).map(i => i.cid), ['a', 'c']);
  box.done('nope');   // an ack for something we no longer hold is harmless
  assert.equal(box.list(1).length, 2);
});

test('closing the tab loses nothing: a new outbox on the same storage holds the same messages, with their quotes', () => {
  const storage = fakeStorage();
  const first = createOutbox(storage, ME);
  const quote = { id: 7, author: 'Sara', kind: 'text', text: 'hello' };
  first.add({ cid: 'a', circle: 1, body: 'مرحبا', replyTo: 7, at: 1, quote });
  first.add(item('b', 2));
  first.fail('b', 'blocked');
  const second = createOutbox(storage, ME);   // the app was closed and opened again
  assert.deepEqual(second.list(1), [{ cid: 'a', circle: 1, body: 'مرحبا', replyTo: 7, at: 1, quote }, { ...item('b', 2), failed: 'blocked' }]);
});

test('a refused message is marked failed and waits for the person; retry clears the mark and keeps its place and its id', () => {
  const box = createOutbox(fakeStorage(), ME);
  box.add(item('a', 1)); box.add(item('b', 2));
  box.fail('a', 'circle_frozen');
  assert.deepEqual(box.list(1).map(i => [i.cid, i.failed]), [['a', 'circle_frozen'], ['b', undefined]]);
  assert.deepEqual(box.pending(1).map(i => i.cid), ['b'], 'a failed message is not resent by itself');
  assert.deepEqual(box.circles(), [1]);
  box.retry('a');
  assert.deepEqual(box.pending(1).map(i => i.cid), ['a', 'b'], 'same id, same place: the server will not store it twice');
});

test('adding the same id twice keeps one copy', () => {
  const box = createOutbox(fakeStorage(), ME);
  box.add(item('a', 1)); box.add(item('a', 5));
  assert.equal(box.list(1).length, 1);
});

test('each person has their own outbox on a shared browser: one never sees or sends the other\'s unsent words', () => {
  const storage = fakeStorage();
  const nasser = createOutbox(storage, 1), sara = createOutbox(storage, 2);
  nasser.add(item('n1', 1));
  assert.deepEqual(sara.list(1), []);
  sara.add(item('s1', 2));
  assert.deepEqual(nasser.list(1).map(i => i.cid), ['n1']);
  nasser.clear();   // signing out wipes what was not sent
  assert.deepEqual(createOutbox(storage, 1).list(1), []);
  assert.deepEqual(createOutbox(storage, 2).list(1).map(i => i.cid), ['s1'], 'and leaves the other person\'s alone');
});

test('two tabs of the same person do not overwrite each other', () => {
  const storage = fakeStorage();
  const tabA = createOutbox(storage, ME), tabB = createOutbox(storage, ME);   // both opened while the outbox was empty
  tabA.add(item('x', 1));
  tabB.add(item('y', 2));
  assert.deepEqual(tabA.list(1).map(i => i.cid), ['x', 'y']);
  assert.deepEqual(tabB.list(1).map(i => i.cid), ['x', 'y']);
  tabB.done('x');   // sent from the other tab
  assert.deepEqual(tabA.list(1).map(i => i.cid), ['y'], 'what another tab sent is not sent again from here');
  assert.deepEqual(createOutbox(storage, ME).list(1).map(i => i.cid), ['y']);
});

test('storage that is full or forbidden: the outbox still works for this visit', () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('denied'); } };
  const box = createOutbox(broken, ME);
  box.add(item('a', 1)); box.add(item('b', 2));
  assert.deepEqual(box.list(1).map(i => i.cid), ['a', 'b']);
  box.done('a');
  assert.deepEqual(box.list(1).map(i => i.cid), ['b']);
  assert.deepEqual(createOutbox(null, ME).list(1), [], 'no storage at all (private mode) is the same');
});

test('a damaged or foreign stored value is treated as empty, and bad entries inside a good list are dropped', () => {
  const key = `thikra_outbox_v2_${ME}`;
  assert.deepEqual(createOutbox(fakeStorage({ [key]: '{not json' }), ME).list(1), []);
  assert.deepEqual(createOutbox(fakeStorage({ [key]: '"a string"' }), ME).list(1), []);
  const mixed = JSON.stringify([item('ok', 1), { cid: 5, circle: 1 }, null, { cid: 'nobody', circle: 1, body: '', at: 2, replyTo: null }]);
  assert.deepEqual(createOutbox(fakeStorage({ [key]: mixed }), ME).list(1).map(i => i.cid), ['ok'], 'an entry without text or with a wrong shape cannot be sent');
});
