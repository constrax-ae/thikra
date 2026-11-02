process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-sealed3-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { all } = await import('./db.ts');
const { setFlag } = await import('./lib/ops.ts');

const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
let n = 0;
async function signUp(name: string) {
  const phone = `+9665${String(4_000_000 + n++).padStart(8, '0')}`;
  const code = (await (await app.request('/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone }) })).json() as any).devCode;
  const v = await app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code, name }) });
  return v.headers.get('set-cookie')!.split(';')[0];
}
const days = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

test('only two kinds of sealed letters are offered: tied to an event, or scheduled; "after my death" is off unless the owner turns it on', async () => {
  const a = await signUp('كاتب');
  const id = (await call(a, '/api/circles', { name: 'عائلة' })).json.id;
  await call(a, `/api/circles/${id}`, { agentActive: true }, 'PATCH');
  const refused = await call(a, `/api/circles/${id}/sealed`, { body: 'x', trigger: 'death' });
  assert.equal(refused.status, 403); assert.equal(refused.json.error, 'feature_off');
  assert.equal((await call(a, `/api/circles/${id}/sealed-envelopes`)).json.deathEnabled, false, 'the screen is told to hide the option');
  assert.equal((await call(a, `/api/circles/${id}/sealed`, { body: 'عند زواج سارة', trigger: 'event', occasion: 'زواج سارة' })).status, 201, 'event letters work');
  assert.equal((await call(a, `/api/circles/${id}/sealed`, { body: 'سنة جديدة', trigger: 'date', unlockAt: days(30) })).status, 201, 'scheduled letters work');
  setFlag('sealed_after_death', true);
  assert.equal((await call(a, `/api/circles/${id}/sealed`, { body: 'x', trigger: 'death' })).status, 201, 'the owner can switch it on');
  assert.equal((await call(a, `/api/circles/${id}/sealed-envelopes`)).json.deathEnabled, true);
  setFlag('sealed_after_death', false);
});

test('a scheduled letter can open on several dates: one envelope per date, same content, duplicates and bad dates refused', async () => {
  const a = await signUp('جدولة');
  const id = (await call(a, '/api/circles', { name: 'عائلة الجدولة' })).json.id;
  const r = await call(a, `/api/circles/${id}/sealed`, { body: 'كل عيد وأنتم بخير', trigger: 'date', occasion: 'العيد', dates: [days(30), days(90), days(150), days(30)] });
  assert.equal(r.status, 201);
  assert.equal(r.json.ids.length, 3, 'the repeated date made no second envelope');
  const rows = all("SELECT unlock_at, body, yearly FROM sealed_messages WHERE circle_id = ? ORDER BY unlock_at", id);
  assert.equal(rows.length, 3); assert.ok(rows.every(x => x.body === 'كل عيد وأنتم بخير' && x.yearly === 0));
  assert.ok(rows[0].unlock_at < rows[1].unlock_at && rows[1].unlock_at < rows[2].unlock_at);
  assert.equal((await call(a, `/api/circles/${id}/sealed`, { body: 'x', trigger: 'date', dates: [days(30), 'not a date'] })).json.error, 'invalid_date');
  assert.equal((await call(a, `/api/circles/${id}/sealed`, { body: 'x', trigger: 'date', dates: [days(-1)] })).json.error, 'invalid_date', 'a date in the past');
  assert.equal((await call(a, `/api/circles/${id}/sealed`, { body: 'x', trigger: 'date', dates: Array.from({ length: 13 }, (_, i) => days(10 + i)) })).json.error, 'invalid_date', 'at most twelve');
  // the single-date way (and yearly) still works
  const one = await call(a, `/api/circles/${id}/sealed`, { body: 'سنوياً', trigger: 'date', unlockAt: days(40), yearly: true });
  assert.equal(one.status, 201); assert.equal(all('SELECT yearly FROM sealed_messages WHERE id = ?', one.json.id)[0].yearly, 1);
  // mine lists every envelope
  assert.equal((await call(a, '/api/me/sealed')).json.length, 4);
});
