// The three things a person arranges for themselves, and the one that moves:
// chat lists (private filters), per-chat notification rules, storage per chat with a bulk clear-out, and live location.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { app, startServer } = await import('./index.ts');
const { setTransport } = await import('./push.ts');
const { run, one } = await import('./db.ts');
const server = startServer(0);
await new Promise(r => server.once('listening', r));
after(() => { server.close(); server.closeAllConnections?.(); });

const pushed: Array<{ to: string; body: string }> = [];
setTransport(async (sub, payload) => { pushed.push({ to: sub.endpoint, body: JSON.parse(payload).body }); });
const settle = () => new Promise(r => setTimeout(r, 80));

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
let n = 0;
async function person(name: string) {
  const phone = `+96652${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(2, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const id = (await call(cookie, '/api/me')).json.id as number;
  run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)', id, `push:${id}`, 'k', 'a');
  return { cookie, name, id };
}
async function group(label = 'الشلة') {
  const a = await person('ناصر'), b = await person('سارة');
  const id = (await call(a.cookie, '/api/circles', 'POST', { name: label, kind: 'group' })).json.id as number;
  const code = (await call(a.cookie, `/api/circles/${id}`)).json.inviteCode as string;
  await call(b.cookie, '/api/circles/join', 'POST', { code });
  return { a, b, id };
}
const messages = async (p: { cookie: string }, id: number) => (await call(p.cookie, `/api/circles/${id}/messages?after=0`)).json as any[];

// ---- chat lists ------------------------------------------------------------------------------

test('a chat list is one person\'s own filter: they make it, fill it, rename it, and nobody else can see or touch it', async () => {
  const { a, b, id } = await group();
  const made = await call(a.cookie, '/api/lists', 'POST', { name: '  الإخوة  ' });
  assert.equal(made.status, 201);
  assert.equal(made.json.name, 'الإخوة', 'the name is trimmed');
  const lid = made.json.id as number;

  assert.equal((await call(a.cookie, `/api/lists/${lid}`, 'PATCH', { circleIds: [id] })).status, 200);
  assert.deepEqual((await call(a.cookie, '/api/lists')).json, [{ id: lid, name: 'الإخوة', circleIds: [id] }]);
  assert.deepEqual((await call(b.cookie, '/api/lists')).json, [], 'the other person has no idea it exists');
  assert.equal((await call(b.cookie, `/api/lists/${lid}`, 'PATCH', { name: 'mine now' })).status, 404, 'and cannot rename it');
  assert.equal((await call(b.cookie, `/api/lists/${lid}`, 'DELETE')).status, 404, 'or delete it');

  await call(a.cookie, `/api/lists/${lid}`, 'PATCH', { name: 'العائلة' });
  assert.equal((await call(a.cookie, '/api/lists')).json[0].name, 'العائلة');
});

test('a list holds only chats the person is really in, and deleting the list leaves the chats alone', async () => {
  const { a, b, id } = await group();
  const other = (await call(b.cookie, '/api/circles', 'POST', { name: 'غيرها', kind: 'group' })).json.id as number;
  const lid = (await call(a.cookie, '/api/lists', 'POST', { name: 'L' })).json.id as number;
  await call(a.cookie, `/api/lists/${lid}`, 'PATCH', { circleIds: [id, other, 999999] });
  assert.deepEqual((await call(a.cookie, '/api/lists')).json[0].circleIds, [id], 'a chat they are not in is simply left out');

  assert.equal((await call(a.cookie, `/api/lists/${lid}`, 'DELETE')).status, 200);
  assert.deepEqual((await call(a.cookie, '/api/lists')).json, []);
  assert.ok((await call(a.cookie, `/api/circles/${id}`)).json.name, 'the chat is still there');
});

test('a name is required, and twenty lists are enough for anyone', async () => {
  const a = await person('ليلى');
  assert.equal((await call(a.cookie, '/api/lists', 'POST', { name: '   ' })).status, 400);
  for (let i = 0; i < 20; i++) assert.equal((await call(a.cookie, '/api/lists', 'POST', { name: `L${i}` })).status, 201);
  const over = await call(a.cookie, '/api/lists', 'POST', { name: 'one too many' });
  assert.equal(over.status, 409);
  assert.equal(over.json.error, 'too_many_lists');
});

// ---- what a chat may interrupt you with --------------------------------------------------------

test('a chat set to «mentions only» wakes the phone only when the name is written, and «none» never does', async () => {
  const { a, b, id } = await group();
  const to = `push:${b.id}`;
  const sent = async (body: string, mentions?: number[]) => {
    pushed.length = 0;
    await call(a.cookie, `/api/circles/${id}/messages`, 'POST', mentions ? { body, mentions } : { body });
    await settle();
    return pushed.filter(p => p.to === to).length;
  };
  assert.equal(await sent('مرحبا'), 1, 'by default every message');

  assert.equal((await call(b.cookie, `/api/circles/${id}/prefs`, 'PATCH', { notify: 'mentions' })).status, 200);
  assert.equal(await sent('رسالة عادية'), 0, 'an ordinary message stays quiet');
  assert.equal(await sent('يا @سارة', [b.id]), 1, 'their name still reaches them');

  await call(b.cookie, `/api/circles/${id}/prefs`, 'PATCH', { notify: 'none' });
  assert.equal(await sent('يا @سارة مرة أخرى', [b.id]), 0, 'none means none, mention or not');
  assert.equal((await call(b.cookie, `/api/circles/${id}`)).json.notify, 'none', 'and the chat says so when it is opened');

  await call(b.cookie, `/api/circles/${id}/prefs`, 'PATCH', { notify: 'all' });
  assert.equal(await sent('ورجعنا'), 1);
  assert.equal((await call(b.cookie, `/api/circles/${id}`)).json.notify, 'all');
  assert.equal((await call(b.cookie, `/api/circles/${id}/prefs`, 'PATCH', { notify: 'loud' })).status, 400, 'nothing else is a setting');
});

// ---- storage per chat, and clearing it out ------------------------------------------------------

const attach = async (p: { cookie: string; id: number }, circleId: number, kind: string, size: number, ageDays: number, archived = 0) => {
  const sent = await call(p.cookie, `/api/circles/${circleId}/messages`, 'POST', { body: `ملف ${kind}` });
  const mid = sent.json.id as number;
  assert.ok(mid, 'the message carrying the file was stored');
  const hash = String(size).padStart(64, 'a');
  run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', hash, size);
  run(`INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, archived, created_at)
       VALUES (?, ?, ?, ?, ?, 'application/octet-stream', ?, ?, datetime('now', ?))`, circleId, mid, p.id, hash, kind, size, archived, `-${ageDays} days`);
  return mid;
};

test('every chat says what it is using, split by what the files are', async () => {
  const { a, id } = await group('المقاسات');
  await attach(a, id, 'image', 5_000_000, 1);
  await attach(a, id, 'video', 50_000_000, 400);
  const mine = ((await call(a.cookie, '/api/storage/chats')).json as any[]).find(r => r.id === id);
  assert.equal(mine.bytes, 55_000_000);
  assert.equal(mine.imageBytes, 5_000_000);
  assert.equal(mine.videoBytes, 50_000_000);
  assert.equal(mine.files, 2);
});

test('a clear-out counts before it deletes, is for managers only, and never touches the family archive', async () => {
  const { a, b, id } = await group('التنظيف');
  const fresh = await attach(a, id, 'image', 5_000_000, 1);
  const old = await attach(a, id, 'video', 50_000_000, 400);
  const kept = await attach(a, id, 'image', 7_000_000, 500, 1);   // archived: the Memory

  const count = await call(a.cookie, `/api/circles/${id}/media/cleanup`, 'POST', { olderThanDays: 365 });
  assert.deepEqual([count.json.preview, count.json.messages, count.json.bytes], [true, 1, 50_000_000], 'by default it only counts');
  assert.ok(one('SELECT 1 FROM media WHERE message_id = ?', old), 'and nothing is gone yet');

  assert.equal((await call(b.cookie, `/api/circles/${id}/media/cleanup`, 'POST', { olderThanDays: 365, preview: false })).status, 403, 'a member cannot sweep a chat everyone shares');

  const did = await call(a.cookie, `/api/circles/${id}/media/cleanup`, 'POST', { olderThanDays: 365, preview: false });
  assert.deepEqual([did.json.preview, did.json.messages], [false, 1]);
  assert.equal(one('SELECT 1 FROM media WHERE message_id = ?', old), undefined, 'the old video is gone');
  assert.ok(one('SELECT deleted_at FROM messages WHERE id = ?', old)!.deleted_at, 'and its message is a tombstone, like any deleted message');
  assert.ok(one('SELECT 1 FROM media WHERE message_id = ?', fresh), 'the recent photo stays');
  assert.ok(one('SELECT 1 FROM media WHERE message_id = ?', kept), 'the archived photo stays, whatever its age');
});

test('a clear-out can be asked for by kind and by size', async () => {
  const { a, id } = await group('بالنوع');
  await attach(a, id, 'image', 1_000_000, 10);
  await attach(a, id, 'video', 30_000_000, 10);
  const videos = await call(a.cookie, `/api/circles/${id}/media/cleanup`, 'POST', { kinds: ['video'] });
  assert.deepEqual([videos.json.messages, videos.json.bytes], [1, 30_000_000]);
  const big = await call(a.cookie, `/api/circles/${id}/media/cleanup`, 'POST', { minBytes: 10_000_000 });
  assert.equal(big.json.messages, 1, 'only what is actually big');
});

// ---- live location -------------------------------------------------------------------------------

test('a live location moves while it runs, only for the person sharing it, and stops dead when they say so', async () => {
  const { a, b, id } = await group('الطريق');
  const made = await call(a.cookie, `/api/circles/${id}/cards`, 'POST', { type: 'live', lat: 24.7136, lng: 46.6753, accuracy: 12, minutes: 60 });
  assert.equal(made.status, 201);
  const mid = made.json.id as number;
  const card = () => messages(b, id).then(ms => ms.find(m => m.id === mid).card);
  const first = await card();
  assert.equal(first.type, 'live');
  assert.equal(first.ended, false);
  assert.ok(Date.parse(first.until) > Date.now(), 'it runs until a moment in the future');

  assert.equal((await call(a.cookie, `/api/messages/${mid}/live`, 'PUT', { lat: 24.8, lng: 46.7 })).status, 200);
  assert.equal((await card()).lat, 24.8, 'the one card is overwritten: there is no trail of where they have been');

  assert.equal((await call(b.cookie, `/api/messages/${mid}/live`, 'PUT', { lat: 0, lng: 0 })).status, 404, 'nobody else can move someone\'s pin');
  assert.equal((await card()).lat, 24.8);

  assert.equal((await call(a.cookie, `/api/messages/${mid}/live/stop`, 'POST')).status, 200);
  assert.equal((await card()).ended, true);
  const after = await call(a.cookie, `/api/messages/${mid}/live`, 'PUT', { lat: 25, lng: 47 });
  assert.equal(after.status, 409);
  assert.equal(after.json.error, 'live_over');
});

test('a live location must say how long it runs, and only the three lengths offered', async () => {
  const { a, id } = await group('المدة');
  for (const minutes of [undefined, 0, 5, 1000]) {
    const r = await call(a.cookie, `/api/circles/${id}/cards`, 'POST', { type: 'live', lat: 1, lng: 1, ...(minutes === undefined ? {} : { minutes }) });
    assert.equal(r.status, 400, `minutes=${minutes}`);
  }
  for (const minutes of [15, 60, 480]) assert.equal((await call(a.cookie, `/api/circles/${id}/cards`, 'POST', { type: 'live', lat: 1, lng: 1, minutes })).status, 201);
});
