process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+971500440001';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-ann-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const { app, startServer } = await import('./index.ts');
const { one, run } = await import('./db.ts');
const { setTransport, saveSubscription } = await import('./push.ts');
const { runBroadcasts, audienceCount, resetMaintenanceCache } = await import('./lib/announce.ts');
const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
after(() => { server.close(); server.closeAllConnections?.(); });

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
async function signUp(phone: string, name: string, lang?: string) {
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode as string;
  const v = await call(undefined, '/api/auth/verify', { phone, code, name });
  if (lang) run('UPDATE users SET lang = ? WHERE phone = ?', lang, phone);
  return { cookie: v.cookie!, id: (await call(v.cookie, '/api/me')).json.id as number };
}
const owner = await signUp('+971500440001', 'Owner', 'ar');
const mod = await signUp('+971500440002', 'Moderator');
const sara = await signUp('+971500440003', 'Sara', 'ar');
const john = await signUp('+966500440004', 'John', 'en');
await call(owner.cookie, `/api/admin/users/${mod.id}/role`, { role: 'moderator' });
const card = (list: any[], id: number) => list.find(x => x.id === String(id));

test('only the owner announces; a card needs both languages and reaches only its audience', async () => {
  const body = { titleAr: 'عنوان', titleEn: 'Title', bodyAr: 'نص', bodyEn: 'Body', level: 'info', days: 2, audience: { lang: 'ar' } };
  assert.equal((await call(mod.cookie, '/api/admin/announcements', body)).status, 403);
  assert.equal((await call(owner.cookie, '/api/admin/announcements', { ...body, titleEn: '', bodyEn: '' })).status, 400);
  const id = (await call(owner.cookie, '/api/admin/announcements', body)).json.id as number;
  assert.ok(card((await call(sara.cookie, '/api/announcements')).json, id), 'an Arabic reader sees it');
  assert.ok(!card((await call(john.cookie, '/api/announcements')).json, id), 'an English reader does not');
  assert.equal((await call(sara.cookie, `/api/announcements/${id}/dismiss`, {})).status, 200);
  assert.ok(!card((await call(sara.cookie, '/api/announcements')).json, id), 'dismissed');
  assert.equal((await call(owner.cookie, `/api/admin/announcements/${id}/cancel`, {})).status, 200);
  const listed = (await call(owner.cookie, '/api/admin/announcements')).json as any[];
  assert.equal(listed[0].status, 'cancelled'); assert.equal(listed[0].dismissed, 1);
});

test('a notice that needs agreement cannot just be closed, and the acceptance is recorded', async () => {
  const id = (await call(owner.cookie, '/api/admin/announcements', { titleAr: 'شروط جديدة', titleEn: 'New terms', bodyAr: 'اقرأ', bodyEn: 'Read', level: 'consent', days: 30 })).json.id as number;
  assert.equal(card((await call(john.cookie, '/api/announcements')).json, id).level, 'consent');
  assert.equal((await call(john.cookie, `/api/announcements/${id}/dismiss`, {})).status, 400);
  assert.equal((await call(john.cookie, `/api/announcements/${id}/dismiss`, { accepted: true })).status, 200);
  assert.equal(one('SELECT accepted FROM announcement_acks WHERE announcement_id = ? AND user_id = ?', id, john.id)!.accepted, 1);
  assert.equal((await call(owner.cookie, '/api/admin/announcements')).json.find((a: any) => a.id === id).accepted, 1);
});

test('audiences are counted by language, country and plan before anything is sent', async () => {
  assert.equal(audienceCount({}), 4);
  assert.equal(audienceCount({ lang: 'en' }), 1);
  assert.equal(audienceCount({ country: '966' }), 1);
  assert.equal(audienceCount({ country: '971', lang: 'ar' }), 3);
  assert.equal((await call(owner.cookie, '/api/admin/audience?lang=en')).json.count, 1);
  assert.equal(audienceCount({ managersOnly: true }), 0);
  assert.equal(audienceCount({ plan: 'family' }), 0);
});

test('broadcasts: a test goes to me only; a scheduled one goes out when due, in each person\'s language, and counts who has no device', async () => {
  const got: Array<{ endpoint: string; body: string }> = [];
  setTransport(async (s, payload) => { got.push({ endpoint: s.endpoint, body: JSON.parse(payload).body }); });
  const sub = (id: string) => ({ endpoint: `https://push.example.test/${id}`, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });
  saveSubscription(owner.id, sub('owner'), 't'); saveSubscription(sara.id, sub('sara'), 't'); saveSubscription(john.id, sub('john'), 't');
  const b = { bodyAr: 'تحديث جديد', bodyEn: 'A new update' };
  assert.equal((await call(mod.cookie, '/api/admin/broadcasts', b)).status, 403);
  assert.equal((await call(owner.cookie, '/api/admin/broadcasts', { ...b, bodyEn: '' })).status, 400);
  const t = (await call(owner.cookie, '/api/admin/broadcasts', { ...b, test: true })).json;
  assert.equal(t.sent, 1); assert.deepEqual(got.map(g => g.endpoint), ['https://push.example.test/owner']);
  got.length = 0;
  const later = (await call(owner.cookie, '/api/admin/broadcasts', { ...b, at: new Date(Date.now() + 3600_000).toISOString() })).json.id;
  const now = (await call(owner.cookie, '/api/admin/broadcasts', b)).json;
  assert.equal(now.reach, 4);
  assert.equal(await runBroadcasts(), 1, 'only the due one');
  assert.equal(got.length, 3);
  assert.equal(got.find(g => g.endpoint.endsWith('john'))!.body, 'A new update');
  assert.equal(got.find(g => g.endpoint.endsWith('sara'))!.body, 'تحديث جديد');
  const row = (await call(owner.cookie, '/api/admin/broadcasts')).json.find((x: any) => x.id === now.id);
  assert.equal(row.status, 'sent'); assert.equal(row.sent, 3); assert.equal(row.skipped, 1, 'the moderator has no device');
  assert.equal((await call(owner.cookie, `/api/admin/broadcasts/${later}/cancel`, {})).status, 200);
  assert.equal(await runBroadcasts(), 0);
  assert.equal((await call(owner.cookie, '/api/admin/broadcasts', b)).status, 201);
  assert.equal((await call(owner.cookie, '/api/admin/broadcasts', b)).status, 201);
  assert.equal((await call(owner.cookie, '/api/admin/broadcasts', b)).status, 429, 'no more than 3 live (not cancelled) broadcasts a day');
});

test('maintenance makes the app read-only (HTTP and live), keeps staff and support working, shows a notice, and lifts itself', async () => {
  const circle = (await call(sara.cookie, '/api/circles', { name: 'Fam', kind: 'circle' })).json.id as number;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: sara.cookie } });
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise<void>(r => ws.once('open', () => r()));
  const wsSend = async (cmid: string) => { ws.send(JSON.stringify({ t: 'send', circle, client_msg_id: cmid, body: 'hi' })); await new Promise(r => setTimeout(r, 200)); return frames.filter(f => f.client_msg_id === cmid).pop(); };

  assert.equal((await call(owner.cookie, '/api/admin/maintenance', { on: true, messageAr: 'نحدّث الخادم', messageEn: 'Updating' })).status, 200);
  resetMaintenanceCache();
  assert.equal((await call(sara.cookie, `/api/circles/${circle}/messages`, { body: 'x', client_msg_id: 'm1' })).status, 503);
  assert.equal((await call(sara.cookie, `/api/circles/${circle}/messages`)).status, 200, 'reading works');
  assert.equal((await wsSend('w1')).error, 'maintenance');
  assert.equal((await call(sara.cookie, '/api/support', { subject: 'Help', body: 'x' })).status, 201, 'support still works');
  assert.equal((await call(owner.cookie, '/api/admin/stats')).status, 200, 'staff still work');
  assert.equal((await call(sara.cookie, '/api/announcements')).json.find((c: any) => c.id === 'maintenance').bodyAr, 'نحدّث الخادم');

  await call(owner.cookie, '/api/admin/maintenance', { on: true, until: new Date(Date.now() - 1000).toISOString() });
  resetMaintenanceCache();
  assert.equal((await call(sara.cookie, `/api/circles/${circle}/messages`, { body: 'y', client_msg_id: 'm2' })).status, 201, 'an end date in the past: it lifted itself');
  assert.equal((await call(owner.cookie, '/api/admin/maintenance', { on: true, from: '2030-01-02T00:00:00Z', until: '2030-01-01T00:00:00Z' })).status, 400);
  await call(owner.cookie, '/api/admin/maintenance', { on: false });
  resetMaintenanceCache();
  assert.equal((await call(sara.cookie, '/api/announcements')).json.find((c: any) => c.id === 'maintenance'), undefined);
  ws.close();
});

test('a frozen family refuses new messages on the live connection too, but a retry of a stored one is accepted', async () => {
  const circle = (await call(sara.cookie, '/api/circles', { name: 'Held', kind: 'circle' })).json.id as number;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: sara.cookie } });
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise<void>(r => ws.once('open', () => r()));
  const wsSend = async (cmid: string) => { ws.send(JSON.stringify({ t: 'send', circle, client_msg_id: cmid, body: 'hi' })); await new Promise(r => setTimeout(r, 200)); return frames.filter(f => f.client_msg_id === cmid).pop(); };
  assert.equal((await wsSend('a1')).t, 'ack');
  await call(owner.cookie, `/api/admin/families/${circle}/freeze`, { on: true, reason: 'x' });
  assert.equal((await wsSend('a2')).error, 'circle_frozen');
  const retry = await wsSend('a1');
  assert.equal(retry.t, 'ack'); assert.equal(retry.duplicate, true);
  ws.close();
});

test('suspending or banning a person closes their open live connection at once', async () => {
  const circle = (await call(sara.cookie, '/api/circles', { name: 'Live', kind: 'circle' })).json.id as number;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: sara.cookie } });
  await new Promise<void>(r => ws.once('open', () => r()));
  const closed = new Promise<number>(r => ws.once('close', code => r(code)));
  assert.equal((await call(owner.cookie, `/api/admin/users/${sara.id}/suspend`, { days: 1 })).status, 200);
  assert.equal(await Promise.race([closed, new Promise<number>(r => setTimeout(() => r(-1), 2000))]), 4001, 'the socket was closed by the server');
  await call(owner.cookie, `/api/admin/users/${sara.id}/unsuspend`, {});
  void circle;
});

test('a broadcast is walked in pages, and one that stopped halfway resumes without skipping or repeating anyone', async () => {
  process.env.THIKRA_BROADCAST_PAGE = '2';
  const got: string[] = [];
  setTransport(async (s) => { got.push(s.endpoint); });
  run('DELETE FROM push_subscriptions');
  const people = [owner, sara, john];
  for (const p of people) saveSubscription(p.id, { endpoint: `https://push.example.test/page-${p.id}`, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } }, 't');
  const total = audienceCount({});
  run("UPDATE broadcasts SET status = 'cancelled' WHERE status IN ('scheduled', 'sending')");   // only this test's broadcasts below
  run("INSERT INTO broadcasts (body_ar, body_en, audience, scheduled_at) VALUES ('أ', 'a', '{}', datetime('now', '-1 minute'))");
  const id = Number(one('SELECT MAX(id) n FROM broadcasts')!.n);
  assert.equal(await runBroadcasts(), 1);
  const row = one('SELECT status, sent, skipped, cursor FROM broadcasts WHERE id = ?', id)!;
  assert.equal(row.status, 'sent'); assert.equal(Number(row.sent) + Number(row.skipped), total, 'everyone was visited across the pages');
  assert.equal(got.length, 3, 'each person with a device got it once');

  // a send that died halfway: status 'sending', cursor after the first people, untouched for 20 minutes
  got.length = 0;
  const cursor = people[0].id;
  run("INSERT INTO broadcasts (body_ar, body_en, audience, scheduled_at, status, cursor, touched_at) VALUES ('ب', 'b', '{}', datetime('now', '-1 hour'), 'sending', ?, datetime('now', '-20 minutes'))", cursor);
  const id2 = Number(one('SELECT MAX(id) n FROM broadcasts')!.n);
  assert.equal(await runBroadcasts(), 1);
  assert.equal(one('SELECT status FROM broadcasts WHERE id = ?', id2)!.status, 'sent');
  assert.ok(!got.some(e => e.endsWith(`page-${people[0].id}`)), 'the person before the cursor is not told again');
  assert.equal(got.length, 2);
  delete process.env.THIKRA_BROADCAST_PAGE;
});
