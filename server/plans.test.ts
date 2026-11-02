process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-plans-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { run } = await import('./db.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
let n = 0;
async function signUp(name: string) {
  const phone = `+9665${String(7_000_000 + n++).padStart(8, '0')}`;
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode;
  const v = await app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code, name }) });
  return v.headers.get('set-cookie')!.split(';')[0];
}
const GB = 1024 ** 3;

test('storage plans: a small free space by default, editable by the owner only, with every change audited', async () => {
  const owner = await signUp('المالك'), mod = await signUp('مشرف'), family = await signUp('عائلة');
  run("UPDATE users SET admin_role = 'owner', is_admin = 1 WHERE name = 'المالك'");
  run("UPDATE users SET admin_role = 'moderator', is_admin = 1 WHERE name = 'مشرف'");
  const id = (await call(family, '/api/circles', { name: 'بيتنا' })).json.id;

  const shown = (await call(family, '/api/plans')).json;
  assert.equal(shown.paymentsLive, false);
  assert.deepEqual(shown.plans.map((p: any) => p.id), ['free', 'family', 'heritage']);
  assert.equal((await call(family, `/api/circles/${id}/billing`)).json.quotaBytes, 5 * GB, 'the free space');

  assert.equal((await call(family, '/api/admin/plans/free', { quotaGB: 50, priceMonthly: 0, priceYearly: 0, currency: 'usd' })).status, 403, 'a family cannot edit plans');
  assert.equal((await call(mod, '/api/admin/plans/free', { quotaGB: 50, priceMonthly: 0, priceYearly: 0, currency: 'USD' })).status, 403, 'nor a moderator');
  assert.equal((await call(owner, '/api/admin/plans/free', { quotaGB: 0, priceMonthly: 0, priceYearly: 0, currency: 'USD' })).status, 400, 'invalid size');
  assert.equal((await call(owner, '/api/admin/plans/nope', { quotaGB: 5, priceMonthly: 0, priceYearly: 0, currency: 'USD' })).status, 404);
  assert.equal((await call(owner, '/api/admin/plans/free', { quotaGB: 10, priceMonthly: 0, priceYearly: 0, currency: 'usd' })).status, 200);
  assert.equal((await call(family, `/api/circles/${id}/billing`)).json.quotaBytes, 10 * GB, 'the new free space applies at once');
  assert.ok((await call(owner, '/api/admin/audit')).json.some((r: any) => r.action === 'plan.set'));
});

test('asking for more space: managers only, one open request, the owner grants or declines, extra space can be given by hand', async () => {
  const owner = await signUp('مالك2'); run("UPDATE users SET admin_role = 'owner', is_admin = 1 WHERE name = 'مالك2'");
  const manager = await signUp('مدير'), member = await signUp('عضو');
  const id = (await call(manager, '/api/circles', { name: 'عائلتنا' })).json.id;
  const code = (await call(manager, `/api/circles/${id}`)).json.inviteCode;
  await call(member, '/api/circles/join', { code });

  assert.equal((await call(member, `/api/circles/${id}/storage-request`, { plan: 'family' })).status, 403, 'a plain member cannot ask');
  assert.equal((await call(manager, `/api/circles/${id}/storage-request`, { plan: 'free' })).status, 400);
  const asked = await call(manager, `/api/circles/${id}/storage-request`, { plan: 'family', note: 'امتلأت المساحة' });
  assert.equal(asked.status, 201);
  assert.equal((await call(manager, `/api/circles/${id}/storage-request`, { plan: 'heritage' })).status, 409, 'one open request');
  assert.equal((await call(manager, `/api/circles/${id}/billing`)).json.request.status, 'open');

  const overview = (await call(owner, '/api/admin/storage')).json;
  assert.ok(overview.circles.some((c: any) => c.id === id && c.plan === 'free'));
  const req = overview.requests.find((r: any) => r.circleId === id);
  assert.equal(req.plan, 'family'); assert.equal(req.requester, 'مدير');
  assert.equal((await call(manager, `/api/admin/storage-requests/${req.id}/decide`, { grant: true })).status, 403);

  assert.equal((await call(owner, `/api/admin/storage-requests/${req.id}/decide`, { grant: true })).status, 200);
  const bill = (await call(manager, `/api/circles/${id}/billing`)).json;
  assert.equal(bill.plan, 'family'); assert.equal(bill.status, 'active'); assert.equal(bill.quotaBytes, 100 * GB);
  assert.equal(bill.request.status, 'granted');
  assert.equal((await call(owner, `/api/admin/storage-requests/${req.id}/decide`, { grant: false })).status, 404, 'already decided');

  assert.equal((await call(owner, `/api/admin/circles/${id}/plan`, { bonusGB: 20 })).status, 200);
  assert.equal((await call(manager, `/api/circles/${id}/billing`)).json.quotaBytes, 120 * GB, 'plan plus the extra');
  assert.equal((await call(owner, `/api/admin/circles/${id}/plan`, { plan: 'free', bonusGB: 0 })).status, 200);
  const back = (await call(manager, `/api/circles/${id}/billing`)).json;
  assert.equal(back.plan, 'free'); assert.equal(back.status, 'free');
  assert.equal((await call(owner, `/api/admin/circles/${id}/plan`, { plan: 'gold' })).status, 400);
  const actions = (await call(owner, '/api/admin/audit')).json.map((r: any) => r.action);
  assert.ok(actions.includes('storage.decide') && actions.includes('circle.plan'));
});
