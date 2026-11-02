process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+966500000777, +971500000888';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');

async function register(phone: string, name: string) {
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, me: await (await app.request('/api/me', { headers: { cookie } })).json() as any };
}

test('platform admin comes from configuration: being the first to register no longer makes you admin', async () => {
  const first = await register('+966500000111', 'أول مسجّل');
  assert.equal(first.me.is_admin, 0, 'the first user is an ordinary user once admins are configured');
  assert.equal((await app.request('/api/admin/stats', { headers: { cookie: first.cookie } })).status, 403);
  const listed = await register('+966500000777', 'مشرف مُعيَّن');
  assert.equal(listed.me.is_admin, 1);
  assert.equal((await app.request('/api/admin/stats', { headers: { cookie: listed.cookie } })).status, 200);
  const listed2 = await register('+971500000888', 'مشرف ثانٍ');
  assert.equal(listed2.me.is_admin, 1, 'a second listed phone (spaces in the list are fine)');
});

test('every response carries the security headers; attachments keep their own stricter policy', async () => {
  const res = await app.request('/healthz');
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/, 'no inline or third-party scripts');
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/, 'scripts may not be unsafe-inline/eval');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('permissions-policy') ?? '', /geolocation=\(\)/);
  const api = await app.request('/api/me');
  assert.ok(api.headers.get('content-security-policy'), 'API responses too');
});
