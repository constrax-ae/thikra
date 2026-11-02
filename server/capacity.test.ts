process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+971500550101';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-cap-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { one, run } = await import('./db.ts');
const { setTransport, saveSubscription } = await import('./push.ts');
const { checkQuotaAlerts, capacitySummary } = await import('./lib/capacity.ts');
const { isReadOnly, subscription } = await import('./billing.ts');
const { digest } = await import('./lib/opsagent.ts');
const { refreshUsage } = await import('./lib/rollups.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
async function signUp(phone: string, name: string) {
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode as string;
  const v = await call(undefined, '/api/auth/verify', { phone, code, name });
  return { cookie: v.cookie!, id: (await call(v.cookie, '/api/me')).json.id as number };
}
const owner = await signUp('+971500550101', 'Owner');
const mod = await signUp('+971500550102', 'Moderator');
const alice = await signUp('+971500550103', 'Alice');
await call(owner.cookie, `/api/admin/users/${mod.id}/role`, { role: 'moderator' });
const fam = (await call(alice.cookie, '/api/circles', { name: 'Alice family', kind: 'circle' })).json.id as number;
const GB = 1024 ** 3;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const plan = (body: unknown) => call(owner.cookie, `/api/admin/circles/${fam}/plan`, body);
const addMedia = (n: string, size: number) => { run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', n, size); run("INSERT INTO media (circle_id, uploader_id, blob_hash, kind, mime, size, archived) VALUES (?, ?, ?, 'image', 'image/jpeg', ?, 1)", fam, alice.id, n, size); refreshUsage(); };

test('a paid plan has a last day: active, then 14 days of grace, then read-only, and a new date brings it back', async () => {
  assert.equal((await plan({ plan: 'family', until: day(30), reason: 'paid by bank transfer' })).status, 200);
  assert.equal(subscription(fam).status, 'active');
  assert.equal((await plan({ until: day(-3) })).status, 200);
  assert.equal(subscription(fam).status, 'grace');
  assert.equal(isReadOnly(fam), false, 'grace: everything still works');
  assert.equal((await plan({ until: day(-20) })).status, 200);
  assert.equal(subscription(fam).status, 'readonly');
  assert.equal(isReadOnly(fam), true, 'after grace the archive is read-only (nothing deleted)');
  assert.equal((await plan({ until: day(10) })).status, 200);
  assert.equal(subscription(fam).status, 'active');
  assert.equal((await plan({ until: '2026-13-45x' })).status, 400);
  assert.equal((await plan({ until: day(9999) })).status, 400);
  assert.equal((await plan({ plan: 'free' })).status, 200);
  assert.equal(subscription(fam).periodEnd, null, 'a free plan has no end');
  const row = one("SELECT detail FROM admin_audit WHERE action = 'circle.plan' ORDER BY id DESC LIMIT 1")!.detail;
  assert.ok(row.includes('"to"'), 'the change is on record');
});

test('capacity shows stored space, estimated cost and income, and who is about to lapse; moderators do not see money', async () => {
  await plan({ plan: 'family', until: day(3) });
  addMedia('h1', 2 * GB);
  const c = (await call(owner.cookie, '/api/admin/capacity')).json;
  assert.equal(c.byPlan.family, 1); assert.equal(c.paying, 1);
  assert.ok(c.storedGB >= 2 && c.estMonthlyCost > 0);
  assert.ok(c.estMonthlyRevenue.USD > 0);
  assert.equal(c.expiring[0].id, fam);
  assert.equal(c.top[0].id, fam);
  assert.equal((await call(mod.cookie, '/api/admin/capacity')).status, 403);
  assert.equal((await call(owner.cookie, '/api/admin/capacity/cost', { perGB: 0.05 })).status, 200);
  assert.equal((await call(owner.cookie, '/api/admin/capacity')).json.costPerGB, 0.05);
  assert.equal((await call(owner.cookie, '/api/admin/capacity/cost', { perGB: -1 })).status, 400);
  assert.ok((await digest()).items.some(i => i.code === 'plan_expiring'), 'the daily list warns about plans ending this week');
  assert.ok(capacitySummary().orphans.note.includes('nothing is deleted'));
});

test('managers are warned once at 80, 95 and 100 percent, and again only after the level was left and reached anew', async () => {
  await plan({ plan: 'free', bonusGB: 0 });   // free: 5 GB
  const pushes: string[] = [];
  setTransport(async (_s, payload) => { pushes.push(JSON.parse(payload).body); });
  saveSubscription(alice.id, { endpoint: 'https://push.example.test/alice', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } }, 'test');
  run('DELETE FROM media WHERE circle_id = ?', fam); refreshUsage(); addMedia('q1', Math.round(4.2 * GB));      // 84%
  assert.equal(await checkQuotaAlerts(), 1);
  assert.equal(await checkQuotaAlerts(), 0, 'not twice for the same level');
  addMedia('q2', Math.round(0.6 * GB));                                                          // 96%
  assert.equal(await checkQuotaAlerts(), 1);
  addMedia('q3', Math.round(0.6 * GB));                                                          // 108%
  assert.equal(await checkQuotaAlerts(), 1);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(pushes.length, 3);
  assert.match(pushes[2], /امتلأت/, 'the last one says it is full and that nothing is deleted');
  run('DELETE FROM media WHERE circle_id = ?', fam); refreshUsage();
  await checkQuotaAlerts();
  addMedia('q4', Math.round(4.3 * GB));
  assert.equal(await checkQuotaAlerts(), 1, 'warned again after dropping and climbing back');
});
