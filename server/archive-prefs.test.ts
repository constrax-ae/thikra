// Feature 4: archive and "mark as unread" are private to the person, and one setting decides what a new message does to an archived chat.

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
  const phone = `+96657${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(2, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, id: (await call(cookie, '/api/me')).json.id as number };
}
async function pair() {
  const a = await person('ناصر'), b = await person('سارة');
  const circle = (await call(a.cookie, '/api/circles', 'POST', { name: 'عائلة' })).json.id as number;
  await call(b.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${circle}`)).json.inviteCode });
  return { a, b, circle };
}
const row = async (cookie: string, circle: number) => ((await call(cookie, '/api/circles')).json as any[]).find(c => c.id === circle);
const say = (cookie: string, circle: number, body: string) => call(cookie, `/api/circles/${circle}/messages`, 'POST', { body });

test('by default an archived chat stays archived when a message arrives (and still counts it as unread)', async () => {
  const { a, b, circle } = await pair();
  assert.equal((await call(b.cookie, '/api/me')).json.keep_archived, 1);
  await call(b.cookie, `/api/circles/${circle}/prefs`, 'PATCH', { archived: true });
  await say(a.cookie, circle, 'مرحبا');
  const r = await row(b.cookie, circle);
  assert.equal(r.archived, true);
  assert.equal(r.unread, 1);
});

test('with "keep chats archived" off, a new message from someone else brings the chat back; your own message does not', async () => {
  const { a, b, circle } = await pair();
  assert.equal((await call(b.cookie, '/api/me', 'PATCH', { keep_archived: false })).json.keep_archived, 0);
  assert.equal((await call(b.cookie, '/api/me')).json.keep_archived, 0, 'the choice is stored');
  await call(b.cookie, `/api/circles/${circle}/prefs`, 'PATCH', { archived: true });
  await call(a.cookie, `/api/circles/${circle}/prefs`, 'PATCH', { archived: true });   // Nasser keeps the default
  await say(b.cookie, circle, 'أنا أكتب');
  assert.equal((await row(b.cookie, circle)).archived, true, 'writing in your own archived chat does not unarchive it');
  assert.equal((await row(a.cookie, circle)).archived, true, 'Nasser keeps his chats archived');
  await say(a.cookie, circle, 'رد');
  assert.equal((await row(b.cookie, circle)).archived, false);
  assert.equal((await call(b.cookie, '/api/me', 'PATCH', { keep_archived: 'yes' })).json.keep_archived, 0, 'only true or false changes it');
});

test('"mark as unread" is yours alone: the other person sees no change and hears nothing', async () => {
  const { a, b, circle } = await pair();
  await say(a.cookie, circle, 'هل قرأت؟');
  const seq = (await call(a.cookie, `/api/circles/${circle}`)).json.lastSeq;
  await call(b.cookie, `/api/circles/${circle}/read`, 'POST', { seq });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: a.cookie } });
  opened.push(ws);
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const before = (await call(a.cookie, `/api/circles/${circle}`)).json.members.find((m: any) => m.id === b.id);
  frames.length = 0;
  assert.equal((await call(b.cookie, `/api/circles/${circle}/prefs`, 'PATCH', { markedUnread: true })).status, 200);
  await new Promise(r => setTimeout(r, 150));
  assert.equal((await row(b.cookie, circle)).markedUnread, true);
  assert.deepEqual((await call(a.cookie, `/api/circles/${circle}`)).json.members.find((m: any) => m.id === b.id), before, 'her marks, as Nasser sees them, did not move');
  assert.deepEqual(frames, [], 'no frame reached Nasser');
  assert.equal((await row(a.cookie, circle)).markedUnread, false);
});
