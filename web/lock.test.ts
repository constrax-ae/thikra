import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLock } from './src/lock.ts';

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), raw: m }; };

test('lock: the PIN is kept only as a salted hash on the device, never the digits', async () => {
  const store = memory();
  const lock = createLock(store, () => 0);
  assert.equal(lock.hasPin(), false);
  assert.equal(await lock.setPin('12'), false, 'too short');
  assert.equal(await lock.setPin('12ab'), false, 'digits only');
  assert.equal(await lock.setPin('482913'), true);
  assert.equal(lock.hasPin(), true);
  assert.equal(JSON.stringify([...store.raw.values()]).includes('482913'), false);
  assert.equal(lock.isUnlocked(), true, 'choosing a PIN opens the folder for this visit');
  lock.lock();
  assert.equal(lock.isUnlocked(), false);
  assert.deepEqual(await lock.unlock('000000'), { ok: false });
  assert.deepEqual(await lock.unlock('482913'), { ok: true });
  assert.equal(lock.isUnlocked(), true);
});

test('lock: five wrong tries make the person wait, and the wait survives a reload; a right PIN resets it', async () => {
  const store = memory(); let t = 1_000_000;
  const lock = createLock(store, () => t);
  await lock.setPin('1234'); lock.lock();
  for (let i = 0; i < 5; i++) assert.equal((await lock.unlock('9999')).ok, false);
  const w = await lock.unlock('1234');
  assert.equal(w.ok, false); assert.ok((w.waitS ?? 0) > 0 && (w.waitS ?? 0) <= 30, 'even the right PIN waits');
  const again = createLock(store, () => t);   // a reload does not clear it
  assert.ok(((await again.unlock('1234')).waitS ?? 0) > 0);
  t += 31_000;
  assert.deepEqual(await again.unlock('1234'), { ok: true });
  again.lock();
  for (let i = 0; i < 5; i++) await again.unlock('9999');
  assert.ok(((await again.unlock('1234')).waitS ?? 0) <= 30, 'the count started again after a right PIN');
});

test('lock: hidden for a minute locks again; a short look away does not; clearing forgets the PIN', async () => {
  let t = 0;
  const lock = createLock(memory(), () => t);
  await lock.setPin('1234');
  lock.hidden(); t += 20_000; lock.visible();
  assert.equal(lock.isUnlocked(), true);
  lock.hidden(); t += 61_000; lock.visible();
  assert.equal(lock.isUnlocked(), false);
  lock.clear();
  assert.equal(lock.hasPin(), false);
});

test('lock: listeners hear every change', async () => {
  const lock = createLock(memory(), () => 0);
  let n = 0; const off = lock.onChange(() => n++);
  await lock.setPin('1234'); lock.lock(); off(); lock.lock();
  assert.equal(n, 2);
});
