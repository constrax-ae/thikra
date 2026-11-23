import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox } from './src/outbox.ts';
import { createSender } from './src/sender.ts';

// The sender moves messages from the outbox to the server. A fake transport stands in for the socket and for HTTP, and a fake clock for time.
function rig() {
  const data = new Map<string, string>();
  const box = createOutbox({ getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } }, 1);
  const t = { now: 1_000_000 };
  const socket: string[] = [];                         // client ids handed to the socket, in order
  const http: Array<{ cid: string; ok: () => void; fail: (code: string) => void }> = [];
  const net = { socketUp: true };
  const sender = createSender(box, {
    connected: () => net.socketUp,
    socketSend: i => { if (!net.socketUp) return false; socket.push(i.cid); return true; },
    httpSend: i => new Promise<void>((ok, fail) => { http.push({ cid: i.cid, ok, fail: code => fail({ code }) }); }),
  }, () => t.now);
  const add = (cid: string, circle = 1) => { box.add({ cid, circle, body: cid, replyTo: null, at: t.now++ }); sender.kick(); };
  const tick = () => new Promise<void>(r => setImmediate(r));
  return { box, sender, socket, http, net, t, add, tick };
}

test('one at a time per chat, in the order written: the second goes only when the first is confirmed', () => {
  const { sender, socket, add, box } = rig();
  add('a'); add('b'); add('c');
  assert.deepEqual(socket, ['a']);
  sender.kick(); sender.kick();
  assert.deepEqual(socket, ['a'], 'asking again does not send again');
  sender.acked('a');
  assert.deepEqual(socket, ['a', 'b']);
  sender.acked('b'); sender.acked('c');
  assert.deepEqual(socket, ['a', 'b', 'c']);
  assert.deepEqual(box.list(1), []);
});

test('chats do not wait for each other, and a chat that is not open is sent all the same', () => {
  const { sender, socket, add } = rig();
  add('a1', 1); add('b1', 2); add('a2', 1);
  assert.deepEqual(socket, ['a1', 'b1']);
  sender.acked('b1');
  assert.deepEqual(socket, ['a1', 'b1'], 'chat 1 still waits for its own first message');
});

test('the connection drops while a message is in flight: it goes out again with the same id on the next connection', () => {
  const { sender, socket, add, net } = rig();
  add('a'); add('b');
  net.socketUp = false; sender.socketClosed();
  net.socketUp = true; sender.kick();
  assert.deepEqual(socket, ['a', 'a'], 'the same id: the server keeps one copy');
  sender.acked('a');
  assert.deepEqual(socket, ['a', 'a', 'b']);
});

test('no answer at all for 15 seconds on a live connection: sent again', () => {
  const { sender, socket, add, t } = rig();
  add('a');
  t.now += 14_000; sender.kick();
  assert.deepEqual(socket, ['a']);
  t.now += 2_000; sender.kick();
  assert.deepEqual(socket, ['a', 'a']);
});

test('socket down: it goes over HTTP; with no network it stays pending, is tried again later, and is never marked failed', async () => {
  const { sender, http, add, net, t, box, tick } = rig();
  net.socketUp = false;
  add('a'); add('b');
  assert.deepEqual(http.map(h => h.cid), ['a']);
  for (let i = 0; i < 12; i++) {
    http.at(-1)!.fail('network'); await tick();
    sender.kick();
    assert.equal(http.length, i + 1, 'not retried at once');
    t.now += 61_000; sender.kick();
    assert.equal(http.length, i + 2);
  }
  assert.deepEqual(box.list(1).map(i => [i.cid, i.failed]), [['a', undefined], ['b', undefined]], 'hours offline lose nothing and fail nothing');
  http.at(-1)!.ok(); await tick();
  assert.equal(http.at(-1)!.cid, 'b', 'then the next one follows');
});

test('the server refuses a message: it is marked failed for the person, and the ones after it still go', () => {
  const { sender, socket, add, box } = rig();
  const seen: string[] = [];
  sender.subscribe(e => seen.push(`${e.type}:${e.cid ?? ''}`));
  add('a'); add('b');
  sender.errored('a', 'blocked');
  assert.deepEqual(box.list(1).map(i => [i.cid, i.failed]), [['a', 'blocked'], ['b', undefined]]);
  assert.deepEqual(socket, ['a', 'b']);
  assert.ok(seen.includes('failed:a'));
  sender.retry('a');
  assert.deepEqual(box.pending(1).map(i => i.cid), ['a', 'b']);
});

test('"too fast" or a server error: tried again with growing pauses, the chat\'s later messages wait behind it (order is kept), and after 5 tries it is marked failed', () => {
  const { sender, socket, add, t, box } = rig();
  add('a'); add('b');
  const gaps: number[] = [];
  for (let n = 1; n <= 4; n++) {
    sender.errored('a', 'rate_limited');
    sender.kick();
    assert.equal(socket.length, n, 'not at once');
    assert.ok(!socket.includes('b'), 'b never overtakes a');
    const before = t.now;
    while (socket.length === n) { t.now += 500; sender.kick(); }
    gaps.push(t.now - before);
  }
  assert.deepEqual(gaps, [2000, 4000, 8000, 16000]);
  sender.errored('a', 'server');
  assert.equal(box.list(1)[0].failed, 'server', 'the fifth refusal: over to the person');
  assert.equal(socket.at(-1), 'b', 'and the chat moves on');
});

test('discarding a message takes it out wherever it is, and an answer that arrives for it later is ignored', () => {
  const { sender, socket, add, box } = rig();
  add('a'); add('b');
  sender.discard('a');
  assert.deepEqual(box.list(1).map(i => i.cid), ['b']);
  assert.deepEqual(socket, ['a', 'b']);
  sender.acked('a'); sender.errored('a', 'blocked');
  assert.deepEqual(box.list(1).map(i => [i.cid, i.failed]), [['b', undefined]]);
});

test('listeners hear when something was sent, and how (a message sent over HTTP is not pushed back to this device)', async () => {
  const { sender, http, add, net, tick } = rig();
  const seen: string[] = [];
  const off = sender.subscribe(e => seen.push(`${e.type}:${e.cid ?? ''}:${e.via ?? ''}`));
  add('a'); sender.acked('a');
  net.socketUp = false; add('b'); http[0].ok(); await tick();
  assert.ok(seen.includes('sent:a:socket') && seen.includes('sent:b:http'), seen.join());
  off(); add('c');
  const n = seen.length; http.at(-1)!.ok(); await tick();
  assert.equal(seen.length, n, 'unsubscribed');
});
