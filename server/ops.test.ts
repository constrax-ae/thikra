process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+971500550001';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-ops-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { all, one, run } = await import('./db.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
const smsCode = async (phone: string) => (await call(undefined, '/api/auth/request', { phone })).json.devCode as string;
async function signUp(phone: string, name: string) {
  const v = await call(undefined, '/api/auth/verify', { phone, code: await smsCode(phone), name });
  return { cookie: v.cookie!, id: (await call(v.cookie, '/api/me')).json.id as number };
}

const owner = await signUp('+971500550001', 'Owner');
const mod = await signUp('+971500550002', 'Moderator');
const sup = await signUp('+971500550003', 'Support');
const maya = await signUp('+966500550004', 'Maya');
await call(owner.cookie, `/api/admin/users/${mod.id}/role`, { role: 'moderator' });
await call(owner.cookie, `/api/admin/users/${sup.id}/role`, { role: 'support' });

test('analytics: counts only, for owners and moderators', async () => {
  await call(maya.cookie, '/api/me');   // she is active today
  const circle = (await call(maya.cookie, '/api/circles', { name: 'Fam', kind: 'circle' })).json.id;
  await call(maya.cookie, `/api/circles/${circle}/messages`, { body: 'hello there', client_msg_id: 'a1' });
  const a = (await call(mod.cookie, '/api/admin/analytics')).json;
  assert.equal(a.days.length, 30);
  const today = a.days[29];
  assert.ok(today.signups >= 4 && today.dau >= 4 && today.messages >= 1 && today.circles >= 1);
  assert.ok(a.wau >= 4 && a.mau >= a.wau);
  assert.ok(a.trackingSince, 'says since when activity is known');
  for (const k of ['d1', 'd7', 'd30']) assert.ok(k in a.retention && 'cohort' in a.retention[k]);
  assert.ok(!JSON.stringify(a).includes('Maya') && !JSON.stringify(a).includes('hello there') && !JSON.stringify(a).includes('+9665'), 'no names, no text, no numbers');
  assert.equal((await call(sup.cookie, '/api/admin/analytics')).status, 403);
  assert.equal((await call(maya.cookie, '/api/admin/analytics')).status, 403);
  // an active day is written once per person per day, however many requests
  const before = one('SELECT COUNT(*) n FROM activity WHERE user_id = ?', maya.id)!.n;
  await call(maya.cookie, '/api/me'); await call(maya.cookie, '/api/circles');
  assert.equal(one('SELECT COUNT(*) n FROM activity WHERE user_id = ?', maya.id)!.n, before);
});

test('SMS operations: events are counted by country code (never the number), completion is shown, a country can be blocked from the screen', async () => {
  const log = all('SELECT * FROM sms_log');
  assert.ok(log.length >= 4);
  assert.ok(log.every(r => /^\d{1,4}$|^unknown$/.test(r.calling_code)), 'only a calling code is kept');
  assert.ok(!JSON.stringify(log).includes('5005500'), 'no phone number in the log');
  const s = (await call(owner.cookie, '/api/admin/sms')).json;
  assert.equal(s.provider, 'console'); assert.ok(typeof s.dailyCap === 'number');
  const ae = s.countries.find((c: any) => c.code === '971'); assert.ok(ae && ae.sent >= 3 && ae.verified >= 3);
  assert.ok(ae.completion > 0);
  assert.equal((await call(mod.cookie, '/api/admin/sms')).status, 403, 'owner only');

  const before = one("SELECT COUNT(*) n FROM sms_log WHERE status = 'blocked'")!.n;
  assert.equal((await call(owner.cookie, '/api/admin/sms/blocked', { codes: ['+966', 'abc', '99999'] })).json.blockedCodes.join(), '966');
  const blocked = await call(undefined, '/api/auth/request', { phone: '+966500550009' });
  assert.equal(blocked.status, 403); assert.equal(blocked.json.error, 'sms_blocked');
  assert.equal(one("SELECT COUNT(*) n FROM sms_log WHERE status = 'blocked'")!.n, before + 1);
  assert.equal((await call(undefined, '/api/auth/request', { phone: '+971500550009' })).status, 200, 'other countries still work');
  await call(owner.cookie, '/api/admin/sms/blocked', { codes: [] });
  assert.equal((await call(undefined, '/api/auth/request', { phone: '+966500550009' })).status, 200);
  assert.ok(one("SELECT 1 FROM admin_audit WHERE action = 'sms.set_blocked'"), 'the change is on the audit log');
});

test('feature flags: only owners flip them, each flip is audited, and they really switch the feature', async () => {
  const list = (await call(owner.cookie, '/api/admin/flags')).json as any[];
  assert.deepEqual(list.map(f => f.name).sort(), ['agent_enabled', 'sealed_after_death', 'sealed_enabled', 'signups_open']);
  assert.ok(list.every(f => f.description && f.on === (f.name !== 'sealed_after_death')), 'every flag is on by default, except the after-death letters');
  assert.equal((await call(mod.cookie, '/api/admin/flags')).status, 403);
  assert.equal((await call(owner.cookie, '/api/admin/flags/nonsense', { on: true })).status, 404);
  assert.equal((await call(owner.cookie, '/api/admin/flags/signups_open', { on: 'yes' })).json.error, 'invalid_value');

  // sign-ups off: a new number is refused before any SMS is sent; an existing person still signs in
  await call(owner.cookie, '/api/admin/flags/signups_open', { on: false });
  const smsBefore = one('SELECT COUNT(*) n FROM sms_log')!.n;
  const no = await call(undefined, '/api/auth/request', { phone: '+971500550077' });
  assert.equal(no.status, 403); assert.equal(no.json.error, 'signups_closed');
  assert.equal(one('SELECT COUNT(*) n FROM sms_log')!.n, smsBefore, 'no SMS was paid for');
  assert.equal((await call(undefined, '/api/auth/request', { phone: '+966500550004' })).status, 200);
  await call(owner.cookie, '/api/admin/flags/signups_open', { on: true });
  assert.equal((await call(undefined, '/api/auth/request', { phone: '+971500550077' })).status, 200);

  // sealed letters off
  const circle = (await call(maya.cookie, '/api/circles', { name: 'Sealed', kind: 'circle' })).json.id;
  await call(owner.cookie, '/api/admin/flags/sealed_enabled', { on: false });
  assert.equal((await call(maya.cookie, `/api/circles/${circle}/sealed`, { body: 'x', trigger: 'date', unlockAt: new Date(Date.now() + 3600e3).toISOString() })).json.error, 'feature_off');
  await call(owner.cookie, '/api/admin/flags/sealed_enabled', { on: true });

  // the agent off: nothing is documented; on again: it is
  await call(maya.cookie, `/api/circles/${circle}`, { agentActive: true, sensitivity: 'strict' }, 'PATCH');
  const news = 'الحمدلله رزقنا بمولود جديد اسمه أحمد يوم الخميس، ألف مبروك لأخوي';
  await call(owner.cookie, '/api/admin/flags/agent_enabled', { on: false });
  await call(maya.cookie, `/api/circles/${circle}/messages`, { body: news, client_msg_id: 'n1' });
  assert.equal(one('SELECT COUNT(*) n FROM archive_entries WHERE circle_id = ?', circle)!.n, 0, 'the agent is paused platform-wide');
  await call(owner.cookie, '/api/admin/flags/agent_enabled', { on: true });
  await call(maya.cookie, `/api/circles/${circle}/messages`, { body: news + ' ', client_msg_id: 'n2' });
  assert.equal(one('SELECT COUNT(*) n FROM archive_entries WHERE circle_id = ?', circle)!.n, 1, 'and back on');
  assert.equal(all("SELECT id FROM admin_audit WHERE action = 'flag.set'").length, 6);
});
