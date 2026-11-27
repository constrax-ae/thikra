// Fail closed: a server started with NO settings at all (no NODE_ENV=production, no THIKRA_DEV=1) must not hand out sign-in
// codes and must not make the first person platform admin. Both only happen when someone turns development mode on on purpose.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
delete process.env.NODE_ENV;
delete process.env.REPLIT_DEPLOYMENT;
delete process.env.THIKRA_DEV;
delete process.env.THIKRA_ADMIN_PHONES;
delete process.env.THIKRA_SHOW_SIGNIN_CODES;
delete process.env.THIKRA_DEMO_MODE;
delete process.env.THIKRA_SMS_PROVIDER;
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');

const post = (path: string, body: unknown, cookie?: string) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

/** Run `fn` while collecting what the server prints, so the test can read the code the console SMS provider "sent". */
async function captured<T>(fn: () => T | Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { return { out: await fn(), lines }; } finally { console.log = log; }
}

test('with no settings, the answer to a sign-in request never contains the code', async () => {
  const { out: res } = await captured(() => post('/api/auth/request', { phone: '+971500000001' }));
  const json = await res.json() as any;
  assert.equal(res.status, 200);
  assert.equal(json.devCode, undefined, 'the code must not be in the answer');
  assert.ok(!JSON.stringify(json).match(/\d{6}/), 'no six-digit code anywhere in the answer');
});

test('with no settings, the first person to register is NOT made platform admin', async () => {
  const phone = '+971500000002';
  const { lines } = await captured(() => post('/api/auth/request', { phone }));
  const code = lines.join('\n').split('->')[1]?.match(/(\d{6})/)?.[1];   // only the server log has it (console SMS provider)
  assert.ok(code, 'the console provider still logs the code for the operator');
  const v = await post('/api/auth/verify', { phone, code, name: 'First' });
  assert.equal(v.status, 200);
  const cookie = v.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await app.request('/api/admin/stats', { headers: { cookie } })).status, 403, 'the first user is an ordinary person');
});

test('THIKRA_DEV=1 (read when asked, not at import) turns the development behaviour back on', async () => {
  process.env.THIKRA_DEV = '1';
  try {
    const json = await (await post('/api/auth/request', { phone: '+971500000003' })).json() as any;
    assert.match(json.devCode ?? '', /^\d{6}$/);
  } finally { delete process.env.THIKRA_DEV; }
});
