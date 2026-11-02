// A published deployment is on the open internet: with no SMS provider a sign-in code must never be shown for a real person's number.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.REPLIT_DEPLOYMENT = '1';          // what Replit sets on a deployment
process.env.THIKRA_DEMO_MODE = '1';
process.env.THIKRA_ADMIN_PHONES = '+971557898998';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-public-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { PROD } = await import('./app.ts');

const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('on a deployment, no on-screen code for a real number (not even the admin\'s), so nobody can sign in as someone else', async () => {
  assert.equal(PROD, true, 'a deployment counts as production');
  for (const phone of ['+971500123456', '+971557898998']) {
    const res = await post('/api/auth/request', { phone });
    const json = await res.json() as any;
    assert.equal(json.devCode, undefined, `${phone} must not get its code shown`);
    // and guessing does not work either
    assert.equal((await post('/api/auth/verify', { phone, code: '123456', name: 'مهاجم' })).status, 400);
  }
});

test('in demo mode the fake demo numbers (and only those) still get their code on screen, and are never admins', async () => {
  const phone = '+966500000003';
  const json = await (await post('/api/auth/request', { phone })).json() as any;
  assert.match(json.devCode, /^\d{6}$/);
  const v = await post('/api/auth/verify', { phone, code: json.devCode, name: 'خالد' });
  assert.equal(v.status, 200);
  const me = await (await app.request('/api/me', { headers: { cookie: v.headers.get('set-cookie')!.split(';')[0] } })).json() as any;
  assert.ok(!me.is_admin, 'a demo number is a normal person');
  const other = await (await post('/api/auth/request', { phone: '+966500000009' })).json() as any;
  assert.equal(other.devCode, undefined, 'a number next to the demo ones is not a demo number');
});
