process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-pin-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { run, one } = await import('./db.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown) => {
  const res = await app.request(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
const smsCode = async (phone: string) => (await call(undefined, '/api/auth/request', { phone })).json.devCode as string;
async function signUp(phone: string, name: string) { return (await call(undefined, '/api/auth/verify', { phone, code: await smsCode(phone), name })).cookie!; }

test('two-step verification: the PIN is required after the code, wrong PINs lock, the PIN never leaks', async () => {
  const phone = '+971500880001';
  const cookie = await signUp(phone, 'Huda');
  assert.equal((await call(cookie, '/api/me')).json.has_pin, 0);
  assert.equal((await call(cookie, '/api/me/pin', { pin: '12ab' })).json.error, 'invalid_pin');
  assert.equal((await call(cookie, '/api/me/pin', { pin: '123456' })).json.ok, true);
  const me = await call(cookie, '/api/me');
  assert.equal(me.json.has_pin, 1);
  assert.ok(!JSON.stringify(me.json).includes('pin_hash') && !/[0-9a-f]{32}:[0-9a-f]{32}/.test(JSON.stringify(me.json)), 'the hash is never sent');

  // sign in elsewhere: the code alone gives no session
  const first = await call(undefined, '/api/auth/verify', { phone, code: await smsCode(phone) });
  assert.equal(first.json.needPin, true);
  assert.equal(first.cookie, undefined, 'no session before the PIN');
  assert.equal((await call(undefined, '/api/auth/pin', { ticket: first.json.ticket, pin: '000000' })).json.left, 4);
  const good = await call(undefined, '/api/auth/pin', { ticket: first.json.ticket, pin: '123456' });
  assert.equal(good.json.ok, true);
  assert.equal((await call(good.cookie, '/api/me')).status, 200);
  assert.equal((await call(undefined, '/api/auth/pin', { ticket: first.json.ticket, pin: '123456' })).status, 400, 'a ticket works once');

  // five mistakes lock the PIN for a while, even with the right one
  const t2 = (await call(undefined, '/api/auth/verify', { phone, code: await smsCode(phone) })).json.ticket;
  for (let i = 0; i < 5; i++) await call(undefined, '/api/auth/pin', { ticket: t2, pin: '111111' });
  const locked = await call(undefined, '/api/auth/pin', { ticket: t2, pin: '123456' });
  assert.equal(locked.status, 429); assert.equal(locked.json.error, 'pin_locked');
  run('UPDATE users SET pin_locked_until = NULL WHERE phone = ?', phone);   // time passes

  // changing needs the current PIN; removing needs it too
  assert.equal((await call(cookie, '/api/me/pin', { pin: '654321', current: '999999' })).json.error, 'wrong_pin');
  assert.equal((await call(cookie, '/api/me/pin', { pin: '654321', current: '123456' })).json.ok, true);
  assert.equal((await call(cookie, '/api/me/pin/remove', { pin: '123456' })).json.error, 'wrong_pin');
  assert.equal((await call(cookie, '/api/me/pin/remove', { pin: '654321' })).json.ok, true);
  assert.equal((await call(cookie, '/api/me')).json.has_pin, 0);
});

test('forgotten PIN: a 7-day wait, then the code alone signs in and the PIN is cleared', async () => {
  const phone = '+971500880002';
  const cookie = await signUp(phone, 'Salem');
  await call(cookie, '/api/me/pin', { pin: '222222' });
  const t = (await call(undefined, '/api/auth/verify', { phone, code: await smsCode(phone) })).json.ticket;
  const forgot = await call(undefined, '/api/auth/pin-forgot', { ticket: t });
  const days = (forgot.json.resetAt - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days <= 7, 'seven days');
  // before the wait is over the PIN is still needed
  assert.equal((await call(undefined, '/api/auth/verify', { phone, code: await smsCode(phone) })).json.needPin, true);
  run('UPDATE users SET pin_reset_at = ? WHERE phone = ?', Date.now() - 1000, phone);   // seven days pass
  const after = await call(undefined, '/api/auth/verify', { phone, code: await smsCode(phone) });
  assert.equal(after.json.ok, true); assert.ok(after.cookie, 'signed in without the PIN');
  assert.equal(one('SELECT pin_hash FROM users WHERE phone = ?', phone)?.pin_hash, null, 'the old PIN is cleared');
});
