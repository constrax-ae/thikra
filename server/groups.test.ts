// Step 2 (groups), features 7-10: photo and description, admin-only messages, who may edit, join approval.

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
const { one } = await import('./db.ts');
const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
const opened: WebSocket[] = [];
after(() => { for (const w of opened) w.terminate(); server.close(); server.closeAllConnections?.(); });

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
const upload = async (cookie: string, path: string, method: string, fields: Record<string, string | Blob>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) { if (v instanceof Blob) form.append(k, v, 'f.png'); else form.append(k, v); }
  const res = await app.request(path, { method, headers: { cookie }, body: form });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
// The smallest valid PNG (1x1), and something that only claims to be one.
const PNG = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' });
const FAKE = new Blob([Buffer.from('<script>alert(1)</script>')], { type: 'image/png' });
let n = 0;
async function person(name: string) {
  const phone = `+96659${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(2, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, name, id: (await call(cookie, '/api/me')).json.id as number };
}
type P = Awaited<ReturnType<typeof person>>;
async function group(kind: 'group' | 'circle' = 'group') {
  const owner = await person('ناصر'), admin = await person('سارة'), member = await person('خالد');
  const id = (await call(owner.cookie, '/api/circles', 'POST', { name: 'الشلة', kind })).json.id as number;
  const code = (await call(owner.cookie, `/api/circles/${id}`)).json.inviteCode as string;
  for (const p of [admin, member]) await call(p.cookie, '/api/circles/join', 'POST', { code });
  await call(owner.cookie, `/api/circles/${id}/members/${admin.id}`, 'PATCH', { role: 'admin' });
  return { owner, admin, member, id, code };
}
async function socket(p: P) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: p.cookie } });
  opened.push(ws);
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const next = async (pred: (f: any) => boolean) => { for (let i = 0; i < 200; i++) { const f = frames.find(pred); if (f) return f; await new Promise(r => setTimeout(r, 10)); } throw new Error('no frame: ' + JSON.stringify(frames)); };
  return { frames, next, send: (o: unknown) => ws.send(JSON.stringify(o)) };
}
const detail = async (p: P, id: number) => (await call(p.cookie, `/api/circles/${id}`)).json;
const bodies = async (p: P, id: number) => ((await call(p.cookie, `/api/circles/${id}/messages?after=0`)).json as any[]).map(m => m.body);

// ---- 8: admin-only messages --------------------------------------------------------------

test('8: with "only admins send", a member cannot post by ANY route, and admins and the owner can', async () => {
  const { owner, admin, member, id } = await group();
  assert.equal((await detail(member, id)).sendPolicy, 'all');
  assert.equal((await call(member.cookie, `/api/circles/${id}`, 'PATCH', { sendPolicy: 'admins' })).status, 403, 'a member cannot change it');
  assert.equal((await call(admin.cookie, `/api/circles/${id}`, 'PATCH', { sendPolicy: 'admins' })).status, 200);
  assert.equal((await detail(member, id)).sendPolicy, 'admins');

  // text over HTTP
  const http = await call(member.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'ممنوع' });
  assert.deepEqual([http.status, http.json.error], [403, 'admins_only']);
  // text over the live socket
  const s = await socket(member);
  s.send({ t: 'send', circle: id, client_msg_id: 'x1', body: 'ممنوع' });
  assert.equal((await s.next(f => f.t === 'err' && f.client_msg_id === 'x1')).error, 'admins_only');
  // a voice note
  const voice = await upload(member.cookie, `/api/circles/${id}/voice`, 'POST', { audio: new Blob([Buffer.from('RIFFxxxxWAVEfmt ')], { type: 'audio/wav' }), transcript: 'ممنوع', duration: '1000' });
  assert.equal(voice.status, 403);
  // a photo
  const photo = await upload(member.cookie, `/api/circles/${id}/attachments`, 'POST', { file: PNG, caption: 'ممنوع' });
  assert.deepEqual([photo.status, photo.json.error], [403, 'admins_only']);
  // forwarding INTO the group from elsewhere
  const other = (await call(member.cookie, '/api/circles', 'POST', { name: 'لي', kind: 'group' })).json.id as number;
  const mine = (await call(member.cookie, `/api/circles/${other}/messages`, 'POST', { body: 'من مكان آخر' })).json.id as number;
  await call(member.cookie, `/api/messages/${mine}/forward`, 'POST', { circles: [id] });
  // a poll
  assert.equal((await call(member.cookie, `/api/circles/${id}/polls`, 'POST', { question: 'ممنوع؟', options: ['نعم', 'لا'] })).status, 403);

  assert.deepEqual((await bodies(owner, id)).filter(b => !String(b).startsWith('sys:')), [], 'nothing of the member\'s reached the group');
  assert.equal((await call(admin.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'إعلان' })).status, 201);
  assert.equal((await call(owner.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'من المالك' })).status, 201);
  // members still read, react and mark read
  const last = ((await call(member.cookie, `/api/circles/${id}/messages?after=0`)).json as any[]).at(-1);
  assert.equal((await call(member.cookie, `/api/messages/${last.id}/react`, 'POST', { emoji: '👍' })).status, 200);
  // and everyone was told when it changed
  assert.ok((await bodies(member, id)).some(b => String(b).includes('"k":"sendAdmins"')));
  // back to everyone
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { sendPolicy: 'all' });
  assert.equal((await call(member.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'مسموح' })).status, 201);
  assert.equal((await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { sendPolicy: 'nobody' })).status, 200);
  assert.equal((await detail(owner, id)).sendPolicy, 'all', 'an unknown value changes nothing');
});

test('8: a member who is made admin can post at once, and one who is demoted cannot', async () => {
  const { owner, admin, member, id } = await group();
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { sendPolicy: 'admins' });
  await call(owner.cookie, `/api/circles/${id}/members/${member.id}`, 'PATCH', { role: 'admin' });
  assert.equal((await call(member.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'صرت مشرفاً' })).status, 201);
  await call(owner.cookie, `/api/circles/${id}/members/${admin.id}`, 'PATCH', { role: 'member' });
  assert.equal((await call(admin.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'لم أعد' })).status, 403);
});

test('8: a one-to-one chat has no such setting', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const g = (await call(a.cookie, '/api/circles', 'POST', { name: 'x', kind: 'group' })).json.id;
  await call(b.cookie, '/api/circles/join', 'POST', { code: (await detail(a, g)).inviteCode });
  const direct = (await call(a.cookie, '/api/direct', 'POST', { userId: b.id })).json.id as number;
  assert.equal((await call(a.cookie, `/api/circles/${direct}`, 'PATCH', { sendPolicy: 'admins' })).status, 403);
  assert.equal((await call(b.cookie, `/api/circles/${direct}/messages`, 'POST', { body: 'أهلاً' })).status, 201);
});

// ---- 7 and 9: photo, description, and who may edit them --------------------------------------

test('7 and 9: by default only admins edit the name, description and photo; with "everyone" a member can; everyone sees it at once', async () => {
  const { owner, admin, member, id } = await group();
  assert.deepEqual([(await detail(member, id)).editPolicy, (await detail(member, id)).description, (await detail(member, id)).photo], ['admins', null, null]);
  assert.equal((await call(member.cookie, `/api/circles/${id}`, 'PATCH', { description: 'وصف' })).status, 403);
  assert.equal((await upload(member.cookie, `/api/circles/${id}/photo`, 'PUT', { file: PNG })).status, 403);

  const watcher = await socket(member);
  assert.equal((await call(admin.cookie, `/api/circles/${id}`, 'PATCH', { description: '  مجموعة الأصدقاء  ' })).status, 200);
  assert.equal((await detail(member, id)).description, 'مجموعة الأصدقاء');
  const up = await upload(admin.cookie, `/api/circles/${id}/photo`, 'PUT', { file: PNG });
  assert.equal(up.status, 200);
  const photo = (await detail(member, id)).photo as number;
  assert.equal(photo, up.json.photo);
  assert.equal((await call(owner.cookie, '/api/circles')).json.find((c: any) => c.id === id).photo, photo, 'the chat list has it too');
  const img = await app.request(`/api/media/${photo}`, { headers: { cookie: member.cookie } });
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type') ?? '', /^image\/png/);
  const stranger = await person('غريب');
  assert.equal((await app.request(`/api/media/${photo}`, { headers: { cookie: stranger.cookie } })).status, 404, 'only members see the photo');
  // the chat says who changed what, and connected members hear that the group changed
  const notes = (await bodies(member, id)).join('\n');
  assert.ok(notes.includes('"k":"descChanged"') && notes.includes('"k":"photoChanged"'));
  await watcher.next(f => f.t === 'circle' && f.circle === id);

  // "everyone can edit"
  assert.equal((await call(member.cookie, `/api/circles/${id}`, 'PATCH', { editPolicy: 'all' })).status, 403, 'a member cannot give themselves the right');
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { editPolicy: 'all' });
  assert.equal((await call(member.cookie, `/api/circles/${id}`, 'PATCH', { name: 'اسم جديد', description: 'من عضو' })).status, 200);
  assert.deepEqual([(await detail(owner, id)).name, (await detail(owner, id)).description], ['اسم جديد', 'من عضو']);
  assert.equal((await upload(member.cookie, `/api/circles/${id}/photo`, 'PUT', { file: PNG })).status, 200);
  // ...but nothing else opens up with it
  assert.equal((await call(member.cookie, `/api/circles/${id}`, 'PATCH', { sendPolicy: 'admins', inviteEnabled: false, invitePolicy: 'members', joinApproval: true })).status, 200);
  const d = await detail(owner, id);
  assert.deepEqual([d.sendPolicy, d.inviteEnabled, d.invitePolicy, d.joinApproval], ['all', true, 'admins', false], 'a member\'s other settings are ignored');
  assert.equal((await call(member.cookie, `/api/circles/${id}/photo`, 'DELETE')).status, 200);
  assert.equal((await detail(owner, id)).photo, null);
});

test('7: a photo must really be an image, and the description has a limit and can be cleared', async () => {
  const { owner, id } = await group();
  assert.equal((await upload(owner.cookie, `/api/circles/${id}/photo`, 'PUT', { file: FAKE })).status, 400);
  assert.equal((await upload(owner.cookie, `/api/circles/${id}/photo`, 'PUT', { notfile: 'x' })).status, 400);
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { description: 'ش'.repeat(900) });
  assert.equal(((await detail(owner, id)).description as string).length, 500);
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { description: '   ' });
  assert.equal((await detail(owner, id)).description, null);
});

// ---- 9: who can add members (the invite) -------------------------------------------------------

test('9: "add members": only admins see the invite by default; with "everyone", members see it too', async () => {
  const { owner, member, id } = await group();
  assert.equal((await detail(member, id)).inviteCode, undefined);
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { invitePolicy: 'members' });
  assert.equal(typeof (await detail(member, id)).inviteCode, 'string');
});

// ---- 10: join approval ----------------------------------------------------------------------

test('10: with approval on, nobody joins by the link alone: admins approve or reject, and a rejected person sees nothing', async () => {
  const { owner, admin, member, id, code } = await group();
  assert.equal((await call(member.cookie, `/api/circles/${id}`, 'PATCH', { joinApproval: true })).status, 403);
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { joinApproval: true });
  assert.equal((await detail(member, id)).joinApproval, true);

  const adminSock = await socket(admin), memberSock = await socket(member);
  const yes = await person('منى'), no = await person('فهد');
  const asked = await call(yes.cookie, '/api/circles/join', 'POST', { code });
  assert.deepEqual([asked.status, asked.json], [202, { pending: true }], 'no id: the person learns nothing about the group yet');
  await call(no.cookie, '/api/circles/join', 'POST', { code });
  assert.equal((await call(yes.cookie, '/api/circles/join', 'POST', { code })).status, 202, 'asking twice is one request');
  assert.equal((await call(yes.cookie, `/api/circles/${id}`)).status, 404);
  assert.ok(!((await call(yes.cookie, '/api/circles')).json as any[]).some(c => c.id === id));
  await adminSock.next(f => f.t === 'join_requests' && f.circle === id);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(memberSock.frames.filter(f => f.t === 'join_requests').length, 0, 'ordinary members are not told');

  assert.equal((await call(member.cookie, `/api/circles/${id}/join-requests`)).status, 403);
  const list = (await call(admin.cookie, `/api/circles/${id}/join-requests`)).json as any[];
  assert.deepEqual(list.map(r => [r.id, r.name]), [[yes.id, 'منى'], [no.id, 'فهد']]);
  assert.equal((await detail(owner, id)).joinRequests, 2);
  assert.equal((await detail(member, id)).joinRequests, undefined);

  assert.equal((await call(member.cookie, `/api/circles/${id}/join-requests/${yes.id}`, 'POST', { approve: true })).status, 403);
  assert.equal((await call(admin.cookie, `/api/circles/${id}/join-requests/${yes.id}`, 'POST', { approve: true })).status, 200);
  assert.equal((await call(yes.cookie, `/api/circles/${id}`)).status, 200);
  assert.ok((await bodies(owner, id)).some(b => String(b).includes('"k":"joined"') && String(b).includes('منى')));

  assert.equal((await call(admin.cookie, `/api/circles/${id}/join-requests/${no.id}`, 'POST', { approve: false })).status, 200);
  assert.equal((await call(no.cookie, `/api/circles/${id}`)).status, 404);
  assert.equal((await call(no.cookie, `/api/circles/${id}/messages?after=0`)).status, 404);
  assert.deepEqual((await call(admin.cookie, `/api/circles/${id}/join-requests`)).json, []);
  assert.equal((await call(admin.cookie, `/api/circles/${id}/join-requests/${no.id}`, 'POST', { approve: true })).status, 404, 'there is no request left to approve');
  assert.equal(one('SELECT COUNT(*) AS n FROM circle_members WHERE circle_id = ?', id)!.n, 4);
});

test('10: turning approval off lets the link work again, and a member who is already in is never made to wait', async () => {
  const { owner, member, id, code } = await group();
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { joinApproval: true });
  const again = await call(member.cookie, '/api/circles/join', 'POST', { code });
  assert.deepEqual([again.status, again.json.id], [200, id]);
  const waiting = await person('ليلى');
  await call(waiting.cookie, '/api/circles/join', 'POST', { code });
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { joinApproval: false });
  const now = await call(waiting.cookie, '/api/circles/join', 'POST', { code });
  assert.equal(now.json.id, id);
  assert.deepEqual((await call(owner.cookie, `/api/circles/${id}/join-requests`)).json, [], 'and the request is gone');
});

// ---- found by the independent review ---------------------------------------------------------

test('review: replacing or removing the photo drops the old file, unless a message still uses the same picture', async () => {
  const { owner, id } = await group();
  const other = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' });
  const first = (await upload(owner.cookie, `/api/circles/${id}/photo`, 'PUT', { file: PNG })).json.photo as number;
  const hash1 = one('SELECT blob_hash AS h FROM media WHERE id = ?', first)!.h as string;
  await upload(owner.cookie, `/api/circles/${id}/photo`, 'PUT', { file: other });
  assert.equal(one('SELECT 1 AS x FROM blobs WHERE hash = ?', hash1), undefined, 'the replaced photo\'s file is gone');
  const second = (await detail(owner, id)).photo as number;
  const hash2 = one('SELECT blob_hash AS h FROM media WHERE id = ?', second)!.h as string;
  // the same picture is also sent as a message: removing the group photo must not take the message's picture away
  const sent = await upload(owner.cookie, `/api/circles/${id}/attachments`, 'POST', { file: other });
  assert.equal(sent.status, 201);
  await call(owner.cookie, `/api/circles/${id}/photo`, 'DELETE');
  assert.ok(one('SELECT 1 AS x FROM blobs WHERE hash = ?', hash2), 'still used by the message');
});

test('review: a role change, a removal and a transfer reach open screens at once', async () => {
  const { owner, admin, member, id } = await group();
  const watcher = await socket(member);
  const heard = async () => { await watcher.next(f => f.t === 'circle' && f.circle === id); watcher.frames.length = 0; };
  await call(owner.cookie, `/api/circles/${id}/members/${member.id}`, 'PATCH', { role: 'admin' });
  await heard();
  await call(owner.cookie, `/api/circles/${id}/transfer`, 'POST', { userId: admin.id });
  await heard();
  const extra = await person('ليلى');
  await call(extra.cookie, '/api/circles/join', 'POST', { code: (await detail(admin, id)).inviteCode });
  await heard();
  await call(admin.cookie, `/api/circles/${id}/members/${extra.id}`, 'DELETE');
  await heard();
});

test('review: with "only admins send", a member cannot rewrite an earlier message either', async () => {
  const { owner, member, id } = await group();
  const mid = (await call(member.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'قبل القفل' })).json.id as number;
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { sendPolicy: 'admins' });
  const edit = await call(member.cookie, `/api/messages/${mid}`, 'PATCH', { body: 'إعلان من عضو' });
  assert.deepEqual([edit.status, edit.json.error], [403, 'admins_only']);
  assert.ok((await bodies(owner, id)).includes('قبل القفل'));
});

test('review: someone who was rejected cannot keep asking and pinging the admins', async () => {
  const { owner, admin, id, code } = await group();
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { joinApproval: true });
  const pest = await person('مزعج');
  const adminSock = await socket(admin);
  for (let i = 0; i < 3; i++) {
    assert.equal((await call(pest.cookie, '/api/circles/join', 'POST', { code })).status, 202);
    await call(owner.cookie, `/api/circles/${id}/join-requests/${pest.id}`, 'POST', { approve: false });
  }
  await new Promise(r => setTimeout(r, 100));
  adminSock.frames.length = 0;
  const again = await call(pest.cookie, '/api/circles/join', 'POST', { code });
  assert.equal(again.status, 202, 'the answer looks the same, so nothing is learned from it');
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual((await call(owner.cookie, `/api/circles/${id}/join-requests`)).json, [], 'but no new request is filed');
  assert.equal(adminSock.frames.filter(f => f.t === 'join_requests').length, 0, 'and nobody is pinged');
});
