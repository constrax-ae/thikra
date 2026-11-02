process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-phone-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown) => {
  const res = await app.request(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
async function signUp(phone: string, name: string) {
  const r = await call(undefined, '/api/auth/request', { phone });
  const v = await call(undefined, '/api/auth/verify', { phone, code: r.json.devCode, name });
  return v.cookie!;
}

test('changing the number: the same account signs in with the new number, the old one is free', async () => {
  const cookie = await signUp('+971500770001', 'Mona');
  const other = await signUp('+971500770002', 'Other');
  // a number that belongs to someone else is refused, and so is the number the person already has
  assert.equal((await call(cookie, '/api/me/phone/request', { phone: '+971500770002' })).status, 409);
  assert.equal((await call(cookie, '/api/me/phone/request', { phone: '+971500770001' })).json.error, 'same_phone');
  assert.equal((await call(cookie, '/api/me/phone/request', { phone: 'abc' })).json.error, 'invalid_phone');
  // not signed in at all
  assert.equal((await call(undefined, '/api/me/phone/request', { phone: '+971500770009' })).status, 401);

  const req = await call(cookie, '/api/me/phone/request', { phone: '+971500770003' });
  assert.equal(req.status, 200);
  assert.equal((await call(cookie, '/api/me/phone/confirm', { phone: '+971500770003', code: '000000' })).json.error, 'wrong_code');
  const ok = await call(cookie, '/api/me/phone/confirm', { phone: '+971500770003', code: req.json.devCode });
  assert.equal(ok.json.ok, true);

  const me = await call(cookie, '/api/me');
  assert.equal(me.json.phone, '+971500770003');
  // the new number signs in as the same person; the old number is now a stranger and must give a name
  const r1 = await call(undefined, '/api/auth/request', { phone: '+971500770003' });
  assert.equal(r1.json.newUser, false);
  const r0 = await call(undefined, '/api/auth/request', { phone: '+971500770001' });
  assert.equal(r0.json.newUser, true);
  assert.ok(other);
});
