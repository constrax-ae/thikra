process.env.THIKRA_DEV = '1';   // these tests sign in with the on-screen code, which only exists in explicit development mode
// Feature 3: "message info". For your own message: who has read it and who has received it, with the time for each person.
// Read times obey the read-receipts setting on BOTH sides, exactly like the blue ticks.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const { app, startServer } = await import('./index.ts');
const { run, all } = await import('./db.ts');

const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
const opened: WebSocket[] = [];
after(() => { for (const w of opened) w.terminate(); server.close(); server.closeAllConnections?.(); });

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
};
let n = 0;
async function person(name: string) {
  const phone = `+96656${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(2, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, name, id: (await call(cookie, '/api/me')).json.id as number };
}
type P = Awaited<ReturnType<typeof person>>;
async function trio() {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const circle = (await call(a.cookie, '/api/circles', 'POST', { name: 'عائلة' })).json.id as number;
  const code = (await call(a.cookie, `/api/circles/${circle}`)).json.inviteCode;
  await call(b.cookie, '/api/circles/join', 'POST', { code });
  await call(c.cookie, '/api/circles/join', 'POST', { code });
  return { a, b, c, circle };
}
/** A connected (not reading) device: receiving a pushed message is what "delivered" means. */
async function online(p: P) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: p.cookie } });
  opened.push(ws);
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  return { until: async (pred: (f: any) => boolean) => { for (let i = 0; i < 200; i++) { if (frames.some(pred)) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('no frame'); } };
}
async function say(p: P, circle: number, body: string) {
  const r = await call(p.cookie, `/api/circles/${circle}/messages`, 'POST', { body });
  assert.equal(r.status < 300, true, JSON.stringify(r.json));
  const list = (await call(p.cookie, `/api/circles/${circle}/messages?after=0`)).json as any[];
  return list.filter(m => m.body === body).at(-1) as { id: number; seq: number };
}
const info = (p: P, mid: number) => call(p.cookie, `/api/messages/${mid}/info`);
const ids = (list: any[]) => list.map(x => x.id);
const TIME = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;

test('your message: who read it and who received it, each with a time; nobody else can ask', async () => {
  const { a, b, c, circle } = await trio();
  const bDevice = await online(b);
  const m = await say(a, circle, 'وصلتوا؟');
  await bDevice.until(f => f.t === 'msg' && f.m.id === m.id);
  let r = await info(a, m.id);
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r.json.readBy), []);
  assert.deepEqual(ids(r.json.deliveredTo), [b.id]);
  assert.match(r.json.deliveredTo[0].at, TIME);
  assert.equal(r.json.deliveredTo[0].name, 'سارة');
  assert.deepEqual(r.json.pending, [{ id: c.id, name: 'خالد' }], 'Khalid has not received it yet');

  await call(c.cookie, `/api/circles/${circle}/read`, 'POST', { seq: m.seq });
  r = await info(a, m.id);
  assert.deepEqual(ids(r.json.readBy), [c.id]);
  assert.match(r.json.readBy[0].at, TIME);
  assert.deepEqual(ids(r.json.deliveredTo), [b.id]);
  assert.deepEqual(r.json.pending, []);
  assert.ok(!ids([...r.json.readBy, ...r.json.deliveredTo, ...r.json.pending]).includes(a.id), 'the sender is not in their own lists');

  assert.equal((await info(b, m.id)).status, 403, 'only the author may ask');
  const stranger = await person('غريب');
  assert.equal((await info(stranger, m.id)).status, 404, 'a non-member cannot tell the message exists');
  assert.equal((await info(a, 99999999)).status, 404);
});

test('read receipts off on either side: the person shows under "delivered", never under "read"', async () => {
  const { a, b, c, circle } = await trio();
  const m = await say(a, circle, 'مرحبا');
  await call(b.cookie, `/api/circles/${circle}/read`, 'POST', { seq: m.seq });
  await call(c.cookie, `/api/circles/${circle}/read`, 'POST', { seq: m.seq });
  assert.deepEqual(ids((await info(a, m.id)).json.readBy).sort(), [b.id, c.id].sort());

  await call(c.cookie, '/api/me', 'PATCH', { read_receipts: false });      // Khalid stops sharing
  let r = (await info(a, m.id)).json;
  assert.deepEqual(ids(r.readBy), [b.id]);
  assert.deepEqual(ids(r.deliveredTo), [c.id]);
  assert.match(r.deliveredTo[0].at, TIME, 'still a delivery time');

  await call(a.cookie, '/api/me', 'PATCH', { read_receipts: false });      // the sender stops sharing: reciprocal, sees no reads at all
  r = (await info(a, m.id)).json;
  assert.deepEqual(ids(r.readBy), []);
  assert.deepEqual(ids(r.deliveredTo).sort(), [b.id, c.id].sort());
});

test('a later message does not borrow an earlier one\'s time, and one read covers everything before it', async () => {
  const { a, b, circle } = await trio();
  const first = await say(a, circle, 'واحد');
  const second = await say(a, circle, 'اثنان');
  await call(b.cookie, `/api/circles/${circle}/read`, 'POST', { seq: first.seq });
  assert.deepEqual(ids((await info(a, first.id)).json.readBy), [b.id]);
  assert.deepEqual(ids((await info(a, second.id)).json.readBy), [], 'read up to the first only');
  await call(b.cookie, `/api/circles/${circle}/read`, 'POST', { seq: second.seq });
  const third = await say(a, circle, 'ثلاثة');
  await call(b.cookie, `/api/circles/${circle}/read`, 'POST', { seq: third.seq });
  assert.deepEqual(ids((await info(a, second.id)).json.readBy), [b.id]);
  assert.equal(all('SELECT 1 FROM receipt_marks WHERE circle_id = ? AND user_id = ? AND kind = ?', circle, b.id, 'r').length, 3, 'three steps of the read mark, three rows');
});

test('one read that jumps over many messages stores ONE row, and every message it covers takes its time from that row', async () => {
  const { a, b, circle } = await trio();
  const sent = [];
  for (let i = 0; i < 6; i++) sent.push(await say(a, circle, `رسالة ${i}`));
  const before = all('SELECT 1 FROM receipt_marks WHERE circle_id = ? AND user_id = ?', circle, b.id).length;
  await call(b.cookie, `/api/circles/${circle}/read`, 'POST', { seq: sent[5].seq });
  const rows = all('SELECT kind, seq FROM receipt_marks WHERE circle_id = ? AND user_id = ? ORDER BY kind', circle, b.id);
  assert.equal(rows.length - before, 2, 'one read row and one delivered row (her phone received them at that same moment), not six of each');
  const times = await Promise.all(sent.map(async m => (await info(a, m.id)).json.readBy[0].at));
  assert.equal(new Set(times).size, 1);
  assert.match(times[0], TIME);
});

test('someone with read receipts off: "delivered" never carries the moment they READ', async () => {
  const { a, c, circle } = await trio();
  const cDevice = await online(c);
  const m = await say(a, circle, 'وصلت قبل الميزة');
  await cDevice.until(f => f.t === 'msg' && f.m.id === m.id);
  run('DELETE FROM receipt_marks WHERE circle_id = ?', circle);            // as if it was delivered before delivery times were stored
  await call(c.cookie, '/api/me', 'PATCH', { read_receipts: false });
  await call(c.cookie, `/api/circles/${circle}/read`, 'POST', { seq: m.seq });   // he reads it now, privately
  const r = (await info(a, m.id)).json;
  assert.deepEqual(r.readBy, []);
  assert.deepEqual(r.deliveredTo.map((x: any) => [x.id, x.at]), [[c.id, null]], 'no delivery time is known, and his reading time must not stand in for it');
});

test('marks from before this feature (no stored time): the person is in the right list with no time', async () => {
  const { a, b, circle } = await trio();
  const m = await say(a, circle, 'قديمة');
  await call(b.cookie, `/api/circles/${circle}/read`, 'POST', { seq: m.seq });
  run('DELETE FROM receipt_marks WHERE circle_id = ?', circle);
  const r = (await info(a, m.id)).json;
  assert.deepEqual(r.readBy.map((x: any) => [x.id, x.at]), [[b.id, null]]);
});

test('a deleted message has no info', async () => {
  const { a, circle } = await trio();
  const m = await say(a, circle, 'تُحذف');
  run("UPDATE messages SET deleted_at = datetime('now') WHERE id = ?", m.id);
  assert.equal((await info(a, m.id)).status, 404);
});
