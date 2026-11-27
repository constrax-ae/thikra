process.env.THIKRA_DEV = '1';   // these tests sign in with the on-screen code, which only exists in explicit development mode
// Feature 1: "online" and "last seen". Online = the app is on screen in at least one of the person's connections.
// What must hold: allowed people learn it at once; a hidden status never leaks through the live frame or the HTTP route.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';
process.env.THIKRA_PRESENCE_GRACE_MS = '80';   // how long "left" waits before it is announced (4 s in real use)

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
  const phone = `+96655${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(2, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, id: (await call(cookie, '/api/me')).json.id as number };
}
type P = Awaited<ReturnType<typeof person>>;
/** A chat of the given kind with everyone in it. */
async function chat(kind: 'circle' | 'group', owner: P, ...others: P[]) {
  const id = (await call(owner.cookie, '/api/circles', 'POST', { name: 'x', kind })).json.id as number;
  const code = (await call(owner.cookie, `/api/circles/${id}`)).json.inviteCode;
  for (const o of others) await call(o.cookie, '/api/circles/join', 'POST', { code });
  return id;
}
async function connect(p: P) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: p.cookie } });
  opened.push(ws);
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const next = async (pred: (f: any) => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    for (;;) {
      const f = frames.find(pred);
      if (f) return f;
      if (Date.now() > end) throw new Error('timed out waiting for a frame; got ' + JSON.stringify(frames));
      await new Promise(r => setTimeout(r, 15));
    }
  };
  const closed = () => new Promise<void>(r => { ws.once('close', () => r()); ws.close(); });
  return { ws, frames, next, closed, send: (o: unknown) => ws.send(JSON.stringify(o)) };
}
const quiet = (ms = 200) => new Promise(r => setTimeout(r, ms));
const presenceOf = (frames: any[], user: number) => frames.filter(f => f.t === 'presence' && f.user === user);
const seen = async (viewer: P, target: P) => (await call(viewer.cookie, `/api/presence?ids=${target.id}`)).json as Array<{ id: number; online: boolean; lastSeen: string | null }>;

test('a family member sees you online at once, and "last seen" the moment you leave', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  await chat('circle', a, b);
  assert.deepEqual(await seen(b, a), [{ id: a.id, online: false, lastSeen: null }], 'never opened the app yet');
  const watcher = await connect(b);
  const mine = await connect(a);
  mine.send({ t: 'visible', on: true });
  const on = await watcher.next(f => f.t === 'presence' && f.user === a.id);
  assert.deepEqual(on, { t: 'presence', user: a.id, online: true, last_seen: null });
  assert.deepEqual(await seen(b, a), [{ id: a.id, online: true, lastSeen: null }]);
  await mine.closed();
  const off = await watcher.next(f => f.t === 'presence' && f.user === a.id && f.online === false);
  assert.match(off.last_seen, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  const [now] = await seen(b, a);
  assert.equal(now.online, false);
  assert.equal(now.lastSeen, off.last_seen);
  assert.equal(presenceOf(mine.frames, a.id).length, 0, 'you are not told about yourself');
});

test('two tabs open: closing one does not make you look offline', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  await chat('circle', a, b);
  const watcher = await connect(b);
  const one = await connect(a), two = await connect(a);
  one.send({ t: 'visible', on: true });
  two.send({ t: 'visible', on: true });
  await watcher.next(f => f.t === 'presence' && f.online === true);
  await one.closed();
  await quiet();
  assert.equal(presenceOf(watcher.frames, a.id).filter(f => !f.online).length, 0);
  assert.equal((await seen(b, a))[0].online, true);
  two.send({ t: 'visible', on: false });   // the tab went to the background: that is "left" too
  await watcher.next(f => f.t === 'presence' && f.online === false);
});

test('"nobody": no frame, and you are absent from what others can ask about', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  await chat('circle', a, b);
  assert.equal((await call(a.cookie, '/api/me', 'PATCH', { last_seen_privacy: 'nobody' })).json.last_seen_privacy, 'nobody');
  const watcher = await connect(b);
  const mine = await connect(a);
  mine.send({ t: 'visible', on: true });
  await quiet();
  assert.equal(presenceOf(watcher.frames, a.id).length, 0);
  assert.deepEqual(await seen(b, a), []);
  assert.deepEqual(await seen(a, a), [{ id: a.id, online: true, lastSeen: null }], 'your own is always yours');
});

test('"my family": someone from an ordinary group sees nothing, a family-circle member does', async () => {
  const a = await person('ناصر'), fam = await person('سارة'), friend = await person('خالد');
  await chat('circle', a, fam);
  await chat('group', a, friend);
  await call(a.cookie, '/api/me', 'PATCH', { last_seen_privacy: 'family' });
  const famSock = await connect(fam), friendSock = await connect(friend);
  const mine = await connect(a);
  mine.send({ t: 'visible', on: true });
  await famSock.next(f => f.t === 'presence' && f.user === a.id);
  await quiet();
  assert.equal(presenceOf(friendSock.frames, a.id).length, 0);
  assert.deepEqual(await seen(friend, a), []);
  assert.equal((await seen(fam, a)).length, 1);
});

test('reciprocal: if you hide yours, you do not see other people\'s', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  await chat('circle', a, b);
  await call(b.cookie, '/api/me', 'PATCH', { last_seen_privacy: 'nobody' });
  const watcher = await connect(b);
  const mine = await connect(a);
  mine.send({ t: 'visible', on: true });
  await quiet();
  assert.equal(presenceOf(watcher.frames, a.id).length, 0);
  assert.deepEqual(await seen(b, a), []);
});

test('a block hides it both ways', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  await chat('circle', a, b);
  assert.equal((await call(a.cookie, `/api/users/${b.id}/block`, 'POST', {})).status, 200);
  const bSock = await connect(b), aSock = await connect(a);
  aSock.send({ t: 'visible', on: true });
  bSock.send({ t: 'visible', on: true });
  await quiet();
  assert.equal(presenceOf(bSock.frames, a.id).length, 0);
  assert.equal(presenceOf(aSock.frames, b.id).length, 0);
  assert.deepEqual(await seen(b, a), []);
  assert.deepEqual(await seen(a, b), []);
});

test('a stranger (no shared chat) learns nothing, and bad input is refused', async () => {
  const a = await person('ناصر'), b = await person('سارة'), stranger = await person('غريب');
  await chat('circle', a, b);
  const mine = await connect(a);
  mine.send({ t: 'visible', on: true });
  await quiet(80);
  assert.deepEqual(await seen(stranger, a), []);
  assert.deepEqual((await call(stranger.cookie, '/api/presence?ids=abc,,-1,999999')).json, []);
  assert.equal((await call(stranger.cookie, `/api/presence?ids=${Array.from({ length: 201 }, (_, i) => i + 1).join(',')}`)).status, 400);
  assert.equal((await call(a.cookie, '/api/me', 'PATCH', { last_seen_privacy: 'friends' })).json.last_seen_privacy, 'everyone', 'an unknown value changes nothing');
  assert.equal((await app.request(`/api/presence?ids=${a.id}`)).status, 401);
});

test('hiding it WHILE online: people who could see you are told to forget you at once, not left showing "online"', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  await chat('circle', a, b);
  const watcher = await connect(b);
  const mine = await connect(a);
  mine.send({ t: 'visible', on: true });
  await watcher.next(f => f.t === 'presence' && f.user === a.id && f.online === true);
  await call(a.cookie, '/api/me', 'PATCH', { last_seen_privacy: 'nobody' });
  assert.deepEqual(await watcher.next(f => f.t === 'presence' && f.user === a.id && f.gone === true), { t: 'presence', user: a.id, gone: true });
  assert.deepEqual(await seen(b, a), []);
  await mine.closed();
  await quiet();
  assert.equal(presenceOf(watcher.frames, a.id).filter(f => f.online === false).length, 0, 'and the later "left" is not sent either');
});

test('blocking someone WHILE both are online: each is told to forget the other', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  await chat('circle', a, b);
  const aSock = await connect(a), bSock = await connect(b);
  aSock.send({ t: 'visible', on: true }); bSock.send({ t: 'visible', on: true });
  await bSock.next(f => f.t === 'presence' && f.user === a.id && f.online === true);
  await aSock.next(f => f.t === 'presence' && f.user === b.id && f.online === true);
  await call(a.cookie, `/api/users/${b.id}/block`, 'POST', {});
  await bSock.next(f => f.t === 'presence' && f.user === a.id && f.gone === true);
  await aSock.next(f => f.t === 'presence' && f.user === b.id && f.gone === true);
});

test('switching away and straight back (a glance at another app) announces nothing and does not touch "last seen"', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  await chat('circle', a, b);
  const watcher = await connect(b);
  const mine = await connect(a);
  mine.send({ t: 'visible', on: true });
  await watcher.next(f => f.t === 'presence' && f.user === a.id && f.online === true);
  watcher.frames.length = 0;
  for (let i = 0; i < 5; i++) { mine.send({ t: 'visible', on: false }); mine.send({ t: 'visible', on: true }); }
  await quiet(250);
  assert.deepEqual(presenceOf(watcher.frames, a.id), []);
  assert.deepEqual(await seen(b, a), [{ id: a.id, online: true, lastSeen: null }]);
});

test('someone who joined your chat AFTER they connected still hears you come online', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const late = await connect(b);                    // connected while sharing nothing with Nasser
  const id = (await call(a.cookie, '/api/circles', 'POST', { name: 'x' })).json.id as number;
  await call(b.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${id}`)).json.inviteCode });
  const mine = await connect(a);
  mine.send({ t: 'visible', on: true });
  await late.next(f => f.t === 'presence' && f.user === a.id && f.online === true);
});
