import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRateLimiter, MemoryKeyValue, LocalBus, createBusNetwork, type RateLimiter, type KeyValue } from './state.ts';
import { createLive } from './live.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- contract tests: written against the interfaces, so a Redis implementation has to pass exactly the same ones ----
async function rateLimiterContract(make: () => RateLimiter) {
  const l = make();
  for (let i = 0; i < 3; i++) assert.equal(await l.hit('a', 3, 1000), false, `hit ${i + 1} of 3 is allowed`);
  assert.equal(await l.hit('a', 3, 1000), true, 'the 4th within the window is over the limit');
  assert.equal(await l.hit('b', 3, 1000), false, 'another key is counted separately');
  const short = make();
  await short.hit('x', 1, 30); assert.equal(await short.hit('x', 1, 30), true);
  await sleep(45);
  assert.equal(await short.hit('x', 1, 30), false, 'the window forgets old hits');
}
async function keyValueContract(make: () => KeyValue) {
  const kv = make();
  assert.equal(await kv.get('k'), undefined);
  await kv.set('k', 42, 1000);
  assert.equal(await kv.get('k'), 42);
  await kv.del('k');
  assert.equal(await kv.get('k'), undefined, 'deleted');
  await kv.set('t', 'v', 30);
  await sleep(45);
  assert.equal(await kv.get('t'), undefined, 'expired by itself');
}

test('RateLimiter contract (memory)', () => rateLimiterContract(() => new MemoryRateLimiter()));
test('KeyValue contract (memory)', () => keyValueContract(() => new MemoryKeyValue()));

// ---- the bus: an event published on one node reaches the sockets of another ----
test('an event published on node A reaches a socket on node B, once, and not the excluded user', async () => {
  const net = createBusNetwork();
  const a = createLive(net.bus()), b = createLive(net.bus());
  const gotA: unknown[] = [], gotB: unknown[] = [], gotB2: unknown[] = [];
  a.join(7, e => gotA.push(e), 1);          // user 1 is on node A
  b.join(7, e => gotB.push(e), 2);          // user 2 on node B
  b.join(7, e => gotB2.push(e), 3);         // user 3 on node B
  const reachedRemote: number[] = [];
  b.onRemoteReached((_c, _e, uid) => reachedRemote.push(uid));

  const local = a.publish(7, { t: 'msg', n: 1 }, undefined, 3);   // user 3 is excluded (the typist)
  assert.equal(local, 1, 'node A reports only its own socket');
  await sleep(10);
  assert.deepEqual(gotA, [{ t: 'msg', n: 1 }], 'the sender node delivers locally exactly once (no echo from the bus)');
  assert.deepEqual(gotB, [{ t: 'msg', n: 1 }]);
  assert.deepEqual(gotB2, [], 'the excluded user is excluded on the other node too');
  assert.deepEqual(reachedRemote, [2], 'the other node knows which of its users it reached (for "delivered")');
});

test('a circle with nobody on the other node costs nothing, and one node alone works as before', async () => {
  const solo = createLive(new LocalBus());
  const got: unknown[] = [];
  const off = solo.join(1, e => got.push(e), 5);
  assert.equal(solo.publish(1, { t: 'x' }), 1);
  assert.equal(solo.online(), 1);
  off();
  assert.equal(solo.publish(1, { t: 'y' }), 0);
  assert.equal(solo.online(), 0);
  assert.deepEqual(got, [{ t: 'x' }]);
  // visibility is per node and counts connections
  solo.setVisible(5, false, true); solo.setVisible(5, false, true);
  assert.equal(solo.isVisible(5), true);
  solo.setVisible(5, true, false); assert.equal(solo.isVisible(5), true);
  solo.setVisible(5, true, false); assert.equal(solo.isVisible(5), false);
});
