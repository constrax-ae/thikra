// S- (safety): blocking people and reporting messages.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const { app, startServer } = await import('./index.ts');
const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
after(() => { server.close(); server.closeAllConnections?.(); });

let n = 0;
async function login(name: string) {
  const phone = `+9665${String(4_000_000 + n++).padStart(8, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, phone, id: (await (await app.request('/api/me', { headers: { cookie } })).json() as any).id as number };
}
const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
const admin = await login('المشرف'); // the first user of a fresh dev database is the platform admin

test('block: in a one-to-one chat neither side can send while a block stands; unblocking restores it; groups are unaffected', async () => {
  const a = await login('A'), b = await login('B'), c = await login('C');
  const chat = (await call(a.cookie, '/api/direct', 'POST', { phone: b.phone })).json.id as number;
  assert.equal((await call(b.cookie, `/api/circles/${chat}/messages`, 'POST', { body: 'hi' })).status, 201);
  assert.equal((await call(a.cookie, `/api/users/${b.id}/block`, 'POST', {})).status, 200);
  assert.equal((await call(b.cookie, `/api/circles/${chat}/messages`, 'POST', { body: 'hello?' })).json.error, 'blocked', 'the blocked person cannot send');
  assert.equal((await call(a.cookie, `/api/circles/${chat}/messages`, 'POST', { body: 'no' })).json.error, 'blocked', 'nor can the blocker, until they unblock');
  assert.equal((await call(a.cookie, '/api/me/blocks')).json.map((x: any) => x.name).join(), 'B');
  assert.equal((await call(b.cookie, '/api/me/blocks')).json.length, 0, 'B does not get a list showing who blocked them');
  // over the live socket too
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: b.cookie } });
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise<void>(r => ws.once('open', () => r()));
  ws.send(JSON.stringify({ t: 'send', circle: chat, client_msg_id: 'x', body: 'live' }));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(frames.find(f => f.t === 'err')?.error, 'blocked');
  ws.close();
  // a plain group the two share is not affected by the block
  const g = (await call(a.cookie, '/api/circles', 'POST', { name: 'g', kind: 'group' })).json.id;
  await call(b.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${g}`)).json.inviteCode });
  assert.equal((await call(b.cookie, `/api/circles/${g}/messages`, 'POST', { body: 'group is fine' })).status, 201);
  // unblock
  await call(a.cookie, `/api/users/${b.id}/block`, 'POST', { on: false });
  assert.equal((await call(b.cookie, `/api/circles/${chat}/messages`, 'POST', { body: 'back' })).status, 201);
  // you can only block someone you share a conversation with, and not yourself
  assert.equal((await call(c.cookie, `/api/users/${a.id}/block`, 'POST', {})).status, 404, 'a stranger cannot be probed or blocked');
  assert.equal((await call(a.cookie, `/api/users/${a.id}/block`, 'POST', {})).status, 404);
  // attachments and forwards are blocked too
  await call(a.cookie, `/api/users/${b.id}/block`, 'POST', {});
  const src = (await call(b.cookie, `/api/circles/${g}/messages`, 'POST', { body: 'to forward' })).json;
  assert.equal((await call(b.cookie, `/api/messages/${src.id}/forward`, 'POST', { circles: [chat] })).json.error, 'blocked');
});

test('report: valid reasons only, not your own message, once per message, members only; admins receive the reported text and can resolve', async () => {
  const a = await login('مُبلِّغ'), b = await login('مُبلَّغ عنه');
  const circle = (await call(a.cookie, '/api/circles', 'POST', { name: 'r' })).json.id;
  await call(b.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${circle}`)).json.inviteCode });
  const msg = (await call(b.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'نص مسيء للتجربة' })).json;
  const own = (await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'رسالتي' })).json;
  assert.equal((await call(a.cookie, `/api/messages/${msg.id}/report`, 'POST', { reason: 'bad' })).status, 400);
  assert.equal((await call(a.cookie, `/api/messages/${own.id}/report`, 'POST', { reason: 'spam' })).status, 400, 'you cannot report yourself');
  const outsider = await login('غريب');
  assert.equal((await call(outsider.cookie, `/api/messages/${msg.id}/report`, 'POST', { reason: 'spam' })).status, 404);
  const ok = await call(a.cookie, `/api/messages/${msg.id}/report`, 'POST', { reason: 'harassment', note: 'يضايقني' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.duplicate, false);
  assert.equal((await call(a.cookie, `/api/messages/${msg.id}/report`, 'POST', { reason: 'harassment' })).json.duplicate, true, 'once per message');

  assert.equal((await call(a.cookie, '/api/admin/reports')).status, 403, 'members cannot read reports');
  const list = (await call(admin.cookie, '/api/admin/reports')).json;
  const rep = list.find((r: any) => r.messageId === msg.id);
  assert.equal(rep.reason, 'harassment');
  assert.equal(rep.snapshot, 'نص مسيء للتجربة', 'the reported text, and only that, reaches the admin');
  assert.equal(rep.reporter, 'مُبلِّغ');
  assert.equal(rep.status, 'open');
  // the text stays in the report even if the author later deletes the message for everyone
  await call(b.cookie, `/api/messages/${msg.id}`, 'DELETE');
  assert.equal((await call(admin.cookie, '/api/admin/reports')).json.find((r: any) => r.id === rep.id).snapshot, 'نص مسيء للتجربة');
  assert.equal((await call(admin.cookie, `/api/admin/reports/${rep.id}/resolve`, 'POST', { resolution: 'تم التحذير' })).status, 200);
  const after = (await call(admin.cookie, '/api/admin/reports')).json.find((r: any) => r.id === rep.id);
  assert.deepEqual([after.status, after.resolution], ['resolved', 'تم التحذير']);
  assert.equal((await call(admin.cookie, `/api/admin/reports/${rep.id}/resolve`, 'POST', {})).status, 404, 'cannot resolve twice');
});
