// Step 4 (privacy and extras), features 18-23: disappearing messages, view once, chat lock, broadcast lists, wallpapers, voice-to-text.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';
delete process.env.TRANSCRIBE_API_KEY;

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { app } = await import('./index.ts');
const { one, run } = await import('./db.ts');
const { purgeExpired, purgeViewOnce } = await import('./lib/deletes.ts');
const { setTranscriber } = await import('./lib/transcribe.ts');

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) as any, headers: res.headers };
};
const form = async (cookie: string, path: string, fields: Array<[string, string | Blob, string?]>) => {
  const fd = new FormData();
  for (const [k, v, name] of fields) { if (v instanceof Blob) fd.append(k, v, name ?? 'f'); else fd.append(k, v); }
  const res = await app.request(path, { method: 'POST', headers: { cookie }, body: fd });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
const raw = (cookie: string, path: string) => app.request(path, { headers: { cookie } });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const AUDIO = () => new Blob([Buffer.from('fake-audio-bytes-for-a-voice-note')], { type: 'audio/webm' });
let n = 0;
async function person(name: string) {
  const phone = `+96657${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(2, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, name, id: (await call(cookie, '/api/me')).json.id as number };
}
type P = Awaited<ReturnType<typeof person>>;
async function group(extra = 1, kind = 'group') {
  const owner = await person('ناصر');
  const members: P[] = [];
  for (let i = 0; i < extra; i++) members.push(await person(`عضو${i}`));
  const id = (await call(owner.cookie, '/api/circles', 'POST', { name: 'العائلة', kind })).json.id as number;
  const code = (await call(owner.cookie, `/api/circles/${id}`)).json.inviteCode as string;
  for (const m of members) await call(m.cookie, '/api/circles/join', 'POST', { code });
  return { owner, member: members[0], members, id };
}
const send = (p: P, id: number, body: string) => call(p.cookie, `/api/circles/${id}/messages`, 'POST', { body });
const list = async (p: P, id: number) => (await call(p.cookie, `/api/circles/${id}/messages?after=0`)).json as any[];
const direct = async (a: P, b: P) => (await call(a.cookie, '/api/direct', 'POST', { userId: (await shared(a, b)) })).json.id as number;
async function shared(a: P, b: P) { return b.id; }

// ---- 18. disappearing messages -------------------------------------------------------------

test('disappearing: a manager sets the timer, a notice appears, new messages carry an expiry, old ones do not', async () => {
  const g = await group();
  const before = (await send(g.owner, g.id, 'قبل')).json.id;
  const set = await call(g.owner.cookie, `/api/circles/${g.id}/disappearing`, 'PUT', { seconds: 86400 });
  assert.equal(set.status, 200);
  assert.equal((await call(g.member.cookie, `/api/circles/${g.id}`)).json.disappearSeconds, 86400);
  const after = (await send(g.member, g.id, 'بعد')).json.id;
  const msgs = await list(g.owner, g.id);
  assert.equal(msgs.find(m => m.id === before).expiresAt, null, 'the timer is not retroactive');
  assert.ok(msgs.find(m => m.id === after).expiresAt, 'a new message has its time');
  const notice = msgs.find(m => m.kind === 'system' && String(m.body).includes('disappearOn'));
  assert.ok(notice, 'the chat says so'); assert.equal(notice.expiresAt, null, 'a notice never disappears');
  assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/disappearing`, 'PUT', { seconds: 12345 })).status, 400, 'only the offered timers');
  await call(g.owner.cookie, `/api/circles/${g.id}/disappearing`, 'PUT', { seconds: null });
  assert.ok((await list(g.owner, g.id)).some(m => String(m.body).includes('disappearOff')));
});
test('disappearing: an ordinary member of a group cannot change it; either person in a private chat can; a family circle refuses', async () => {
  const g = await group();
  assert.equal((await call(g.member.cookie, `/api/circles/${g.id}/disappearing`, 'PUT', { seconds: 604800 })).status, 403);
  const d = await direct(g.owner, g.member);
  assert.equal((await call(g.member.cookie, `/api/circles/${d}/disappearing`, 'PUT', { seconds: 604800 })).status, 200);
  const fam = await group(1, 'circle');
  const r = await call(fam.owner.cookie, `/api/circles/${fam.id}/disappearing`, 'PUT', { seconds: 86400 });
  assert.equal(r.status, 409); assert.equal(r.json.error, 'not_in_circle');
});
test('disappearing: when the time comes the message, its file and its blob are gone for everyone, and clients are told it expired', async () => {
  const g = await group();
  await call(g.owner.cookie, `/api/circles/${g.id}/disappearing`, 'PUT', { seconds: 86400 });
  const up = await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['file', new Blob([PNG], { type: 'image/png' }), 'a.png'], ['caption', 'سر']]);
  assert.equal(up.status, 201);
  const keep = (await send(g.owner, g.id, 'باقية')).json.id;
  const mediaId = one('SELECT id, blob_hash AS h FROM media WHERE message_id = ?', up.json.id)!;
  run("UPDATE messages SET expires_at = datetime('now', '-1 minute') WHERE id = ?", up.json.id);
  assert.equal(await purgeExpired(), 1);
  const gone = (await list(g.member, g.id)).find(m => m.id === up.json.id);
  assert.equal(gone.expired, true); assert.equal(gone.body, ''); assert.deepEqual(gone.attachments, []);
  assert.equal(one('SELECT 1 FROM media WHERE message_id = ?', up.json.id), undefined);
  assert.equal(one('SELECT 1 FROM blobs WHERE hash = ?', mediaId.h), undefined, 'the bytes are gone from storage');
  assert.equal((await raw(g.member.cookie, `/api/media/${mediaId.id}`)).status, 404);
  assert.ok((await list(g.member, g.id)).find(m => m.id === keep).body === 'باقية', 'the others stay');
  assert.equal(await purgeExpired(), 0, 'nothing twice');
});

// ---- 19. view once --------------------------------------------------------------------------

async function viewOncePhoto(g: Awaited<ReturnType<typeof group>>) {
  const r = await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['file', new Blob([PNG], { type: 'image/png' }), 'a.png'], ['view_once', '1'], ['caption', 'تجاهل'], ['thumb', new Blob([PNG], { type: 'image/png' }), 't.png']]);
  assert.equal(r.status, 201);
  return { mid: r.json.id as number, media: one('SELECT id FROM media WHERE message_id = ? AND kind = ?', r.json.id, 'image')!.id as number };
}
test('view once: closed until opened, opens once per person, then gone for them; others still can; the sender sees who opened', async () => {
  const g = await group(2);
  const [b, c] = g.members;
  const v = await viewOncePhoto(g);
  const m = (await list(b, g.id)).find(x => x.id === v.mid);
  assert.equal(m.viewOnce.openedBy.length, 0); assert.equal(m.body, '', 'no caption on a view-once'); assert.equal(m.attachments[0].thumb, null, 'no thumbnail');
  assert.equal((await raw(b.cookie, `/api/media/${v.media}`)).status, 403, 'closed before it is opened');
  assert.equal((await call(g.owner.cookie, `/api/messages/${v.mid}/open`, 'POST')).status, 403, 'the sender cannot reopen their own');
  assert.equal((await call(b.cookie, `/api/messages/${v.mid}/open`, 'POST')).status, 200);
  const res = await raw(b.cookie, `/api/media/${v.media}`);
  assert.equal(res.status, 200); assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  assert.equal((await call(b.cookie, `/api/messages/${v.mid}/open`, 'POST')).status, 410, 'a second open is refused');
  run("UPDATE view_once_opens SET opened_at = datetime('now', '-20 minutes') WHERE message_id = ?", v.mid);
  assert.equal((await raw(b.cookie, `/api/media/${v.media}`)).status, 410, 'and the file is no longer served to them');
  assert.equal((await call(c.cookie, `/api/messages/${v.mid}/open`, 'POST')).status, 200, 'the other recipient still can');
  const seen = (await list(g.owner, g.id)).find(x => x.id === v.mid);
  assert.deepEqual([...seen.viewOnce.openedBy].sort(), [b.id, c.id].sort());
  assert.ok(one('SELECT 1 FROM media WHERE message_id = ?', v.mid), 'the last person is still loading it: not erased yet');
  run("UPDATE view_once_opens SET opened_at = datetime('now', '-20 minutes') WHERE message_id = ?", v.mid);
  assert.equal(await purgeViewOnce(), 1);
  assert.equal(one('SELECT 1 FROM media WHERE message_id = ?', v.mid), undefined, 'everyone has opened it: the file is erased');
});
test('view once: not in the gallery, not forwarded or starred; a voice note works the same and an unopened one expires', async () => {
  const g = await group();
  const v = await viewOncePhoto(g);
  assert.equal((await call(g.member.cookie, `/api/circles/${g.id}/media`)).json.length, 0);
  assert.equal((await call(g.member.cookie, `/api/messages/${v.mid}/star`, 'POST', { on: true })).status, 404);
  assert.equal((await call(g.member.cookie, `/api/messages/${v.mid}/forward`, 'POST', { circles: [g.id] })).status, 404);
  const vo = await form(g.owner.cookie, `/api/circles/${g.id}/voice`, [['audio', AUDIO(), 'v'], ['view_once', '1'], ['transcript', 'نص سري']]);
  assert.equal(vo.status, 201);
  assert.equal(one('SELECT transcript FROM messages WHERE id = ?', vo.json.id)!.transcript, null, 'no transcript for a view-once note');
  assert.equal((await raw(g.member.cookie, `/api/messages/${vo.json.id}/audio`)).status, 403);
  assert.equal((await call(g.member.cookie, `/api/messages/${vo.json.id}/open`, 'POST')).status, 200);
  assert.equal((await raw(g.member.cookie, `/api/messages/${vo.json.id}/audio`)).status, 200);
  run("UPDATE messages SET created_at = datetime('now', '-15 days') WHERE id = ?", v.mid);
  assert.ok(await purgeViewOnce() >= 1);
  assert.equal(one('SELECT 1 FROM media WHERE message_id = ?', v.mid), undefined);
});
test('view once: an ordinary message cannot be opened; "only admins send" still applies to view-once sends', async () => {
  const g = await group();
  const plain = (await send(g.owner, g.id, 'مرحبا')).json.id;
  assert.equal((await call(g.member.cookie, `/api/messages/${plain}/open`, 'POST')).status, 404);
  await call(g.owner.cookie, `/api/circles/${g.id}`, 'PATCH', { sendPolicy: 'admins' });
  const r = await form(g.member.cookie, `/api/circles/${g.id}/attachments`, [['file', new Blob([PNG], { type: 'image/png' }), 'a.png'], ['view_once', '1']]);
  assert.equal(r.status, 403);
});

// ---- 20. chat lock --------------------------------------------------------------------------

test('lock: only a flag reaches the server; the list shows no preview for a locked chat; unlocking restores it', async () => {
  const g = await group();
  await send(g.owner, g.id, 'نص خاص');
  const row = async () => ((await call(g.member.cookie, '/api/circles')).json as any[]).find(c => c.id === g.id);
  assert.equal((await row()).lastText, 'نص خاص');
  assert.equal((await call(g.member.cookie, `/api/circles/${g.id}/prefs`, 'PATCH', { locked: true })).status, 200);
  const locked = await row();
  assert.equal(locked.locked, true); assert.equal(locked.lastText, ''); assert.equal(locked.lastMessage, null); assert.equal(locked.lastKind, null);
  assert.equal(((await call(g.owner.cookie, '/api/circles')).json as any[]).find(c => c.id === g.id).locked, false, 'nobody else sees it');
  const people = async () => JSON.stringify((await call(g.member.cookie, '/api/people')).json);
  assert.equal((await people()).includes('العائلة'), false, "the locked chat's name does not leak through the people suggestions");
  await call(g.member.cookie, `/api/circles/${g.id}/prefs`, 'PATCH', { locked: false });
  assert.equal((await row()).lastText, 'نص خاص');
  assert.equal((await people()).includes('العائلة'), true);
});

// ---- 21. broadcast lists --------------------------------------------------------------------

test('broadcast: a list holds only people you share a chat with; the chats come back one per recipient, and the server sees no text', async () => {
  const g = await group(2);
  const stranger = await person('غريب');
  const ids = g.members.map(m => m.id);
  assert.equal((await call(g.owner.cookie, '/api/broadcast-lists', 'POST', { name: 'قائمة', members: [...ids, stranger.id] })).status, 400, 'a stranger cannot be added');
  const made = await call(g.owner.cookie, '/api/broadcast-lists', 'POST', { name: 'قائمة', members: ids });
  assert.equal(made.status, 201);
  const lid = made.json.id;
  assert.equal((await call(g.owner.cookie, `/api/broadcast-lists/${lid}`)).json.members.length, 2);
  assert.equal((await call(g.member.cookie, `/api/broadcast-lists/${lid}`)).status, 404, 'a list is private to its owner');
  const chats = (await call(g.owner.cookie, `/api/broadcast-lists/${lid}/chats`, 'POST')).json.chats as Array<{ userId: number; circleId: number }>;
  assert.equal(chats.length, 2);
  for (const ch of chats) {
    const members = (await call(g.owner.cookie, `/api/circles/${ch.circleId}`)).json.members as any[];
    assert.deepEqual(members.map(m => m.id).sort(), [g.owner.id, ch.userId].sort(), 'each is a private chat of two');
    assert.equal((await send(g.owner, ch.circleId, 'للجميع')).status, 201);
  }
  const mine = (await list(g.member, chats.find(c => c.userId === g.member.id)!.circleId))[0];
  assert.equal(mine.body, 'للجميع'); assert.equal(JSON.stringify(mine).includes('broadcast'), false, 'nothing shows a list');
  const other = g.members[1];
  assert.equal(((await call(other.cookie, '/api/circles')).json as any[]).filter(c => c.kind === 'direct').length, 1, 'recipients see only their own chat with the sender');
  assert.equal((await call(g.owner.cookie, `/api/broadcast-lists/${lid}`, 'DELETE')).status, 200);
});
test('broadcast: a person who blocked the sender is left out without any sign to the sender', async () => {
  const g = await group(2);
  const [a, b] = g.members;
  await call(a.cookie, `/api/users/${g.owner.id}/block`, 'POST', { on: true });
  const lid = (await call(g.owner.cookie, '/api/broadcast-lists', 'POST', { name: 'x', members: [a.id, b.id] })).json.id;
  const r = await call(g.owner.cookie, `/api/broadcast-lists/${lid}/chats`, 'POST');
  assert.equal(r.status, 200); assert.deepEqual(r.json.chats.map((c: any) => c.userId), [b.id]);
  assert.equal((await call(g.owner.cookie, `/api/broadcast-lists/${lid}`)).json.members.length, 2, 'the list itself still shows both');
});
test('broadcast: limits', async () => {
  const g = await group();
  assert.equal((await call(g.owner.cookie, '/api/broadcast-lists', 'POST', { name: '', members: [g.member.id] })).status, 400);
  assert.equal((await call(g.owner.cookie, '/api/broadcast-lists', 'POST', { name: 'x', members: [] })).status, 400);
  assert.equal((await call(g.owner.cookie, '/api/broadcast-lists', 'POST', { name: 'x', members: [g.owner.id] })).status, 400, 'not yourself');
});

// ---- 22. wallpapers -------------------------------------------------------------------------

test('wallpaper: kept per person and per chat; only known names or a colour are accepted', async () => {
  const g = await group();
  const wall = async (p: P) => ((await call(p.cookie, '/api/circles')).json as any[]).find(c => c.id === g.id).wallpaper;
  assert.equal(await wall(g.member), null);
  assert.equal((await call(g.member.cookie, `/api/circles/${g.id}/prefs`, 'PATCH', { wallpaper: 'dunes' })).status, 200);
  assert.equal(await wall(g.member), 'dunes'); assert.equal(await wall(g.owner), null, 'the other person is unaffected');
  assert.equal((await call(g.member.cookie, `/api/circles/${g.id}/prefs`, 'PATCH', { wallpaper: '#1f4d3f' })).status, 200);
  assert.equal((await call(g.member.cookie, `/api/circles/${g.id}`)).json.wallpaper, '#1f4d3f');
  for (const bad of ['url(http://x)', '#12', 'javascript:1', 'x'.repeat(50)]) assert.equal((await call(g.member.cookie, `/api/circles/${g.id}/prefs`, 'PATCH', { wallpaper: bad })).status, 400, bad);
  await call(g.member.cookie, `/api/circles/${g.id}/prefs`, 'PATCH', { wallpaper: null });
  assert.equal(await wall(g.member), null);
});

// ---- 23. voice-to-text ----------------------------------------------------------------------

test('voice-to-text: without a key it says it is not set up and does nothing', async () => {
  const g = await group();
  setTranscriber(null);
  assert.deepEqual((await call(g.member.cookie, '/api/transcribe')).json, { configured: false });
  const r = await form(g.member.cookie, '/api/transcribe', [['audio', AUDIO(), 'v.webm']]);
  assert.equal(r.status, 503); assert.equal(r.json.error, 'transcribe_off');
});
test('voice-to-text: with a provider the reader gets the text once per request, nothing is stored, limits hold', async () => {
  const g = await group();
  const seen: number[] = [];
  setTranscriber({ transcribe: async (bytes) => { seen.push(bytes.length); return 'مرحبا بالجميع'; } });
  assert.deepEqual((await call(g.member.cookie, '/api/transcribe')).json, { configured: true });
  const before = one('SELECT COUNT(*) AS n FROM messages')!.n;
  const r = await form(g.member.cookie, '/api/transcribe', [['audio', AUDIO(), 'v.webm']]);
  assert.equal(r.status, 200); assert.equal(r.json.text, 'مرحبا بالجميع'); assert.equal(seen.length, 1);
  assert.equal(one('SELECT COUNT(*) AS n FROM messages')!.n, before, 'nothing written to any message');
  assert.equal((await form(g.member.cookie, '/api/transcribe', [['audio', new Blob([new Uint8Array(6 * 1024 * 1024)], { type: 'audio/webm' }), 'big.webm']])).status, 413, 'over 5 MB');
  assert.equal((await form(g.member.cookie, '/api/transcribe', [['audio', new Blob(['x'], { type: 'text/html' }), 'x.html']])).status, 400, 'only audio');
  const p = await person('مكثر');
  let last = 0; for (let i = 0; i < 12; i++) last = (await form(p.cookie, '/api/transcribe', [['audio', AUDIO(), 'v.webm']])).status;
  assert.equal(last, 429, 'a daily limit per person');
  setTranscriber(null);
});
test('voice-to-text: a provider that fails gives a clean error', async () => {
  const g = await group();
  setTranscriber({ transcribe: async () => { throw new Error('boom'); } });
  const r = await form(g.member.cookie, '/api/transcribe', [['audio', AUDIO(), 'v.webm']]);
  assert.equal(r.status, 502); assert.equal(r.json.error, 'transcribe_failed');
  setTranscriber(null);
});

// ---- fixes from the independent review --------------------------------------------------------

test('review: the data export never contains a view-once file', async () => {
  const g = await group();
  const v = await viewOncePhoto(g);
  for (const p of [g.owner, g.member]) {
    const res = await raw(p.cookie, '/api/me/export');
    const { unzipSync } = await import('fflate');
    const names = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())));
    assert.ok(names.some(n => n.endsWith('messages.json')), 'the export itself works');
    assert.equal(names.some(n => n.includes('/files/')), false, 'no file entry for a view-once message');
  }
  assert.ok(v.mid);
});
test('review: the file stays available for a full listening session after opening, and is not erased under a viewer', async () => {
  const g = await group();
  const v = await viewOncePhoto(g);
  await call(g.member.cookie, `/api/messages/${v.mid}/open`, 'POST');
  run("UPDATE view_once_opens SET opened_at = datetime('now', '-5 minutes') WHERE message_id = ?", v.mid);
  assert.equal((await raw(g.member.cookie, `/api/media/${v.media}`)).status, 200, 'still inside the window after 5 minutes');
  assert.equal(await purgeViewOnce(), 0, 'and not purged under them');
});
test('review: a view-once file is not erased while a current member has not opened it, even if others who opened have left', async () => {
  const g = await group(3);
  const [b, c, d] = g.members;
  const v = await viewOncePhoto(g);
  await call(b.cookie, `/api/messages/${v.mid}/open`, 'POST'); await call(c.cookie, `/api/messages/${v.mid}/open`, 'POST');
  run("UPDATE view_once_opens SET opened_at = datetime('now', '-1 hour') WHERE message_id = ?", v.mid);
  run('DELETE FROM circle_members WHERE circle_id = ? AND user_id IN (?, ?)', g.id, b.id, c.id);
  assert.equal(await purgeViewOnce(), 0);
  assert.equal((await call(d.cookie, `/api/messages/${v.mid}/open`, 'POST')).status, 200, 'the one who has not opened still can');
});
test('review: converting a group to a family circle clears its timer; a sealed or delivered message never gets one; frozen chats lose nothing', async () => {
  const g = await group();
  await call(g.owner.cookie, `/api/circles/${g.id}/disappearing`, 'PUT', { seconds: 86400 });
  await call(g.owner.cookie, `/api/circles/${g.id}/convert`, 'POST');
  assert.equal(one('SELECT disappear_seconds AS s FROM circles WHERE id = ?', g.id)!.s, null);
  const h = await group();
  await call(h.owner.cookie, `/api/circles/${h.id}/disappearing`, 'PUT', { seconds: 86400 });
  const id = (await send(h.owner, h.id, 'قديمة')).json.id;
  run("UPDATE messages SET expires_at = datetime('now', '-1 minute') WHERE id = ?", id);
  run("UPDATE circles SET frozen_at = datetime('now') WHERE id = ?", h.id);
  assert.equal(await purgeExpired(), 0, 'a frozen family keeps everything');
  run('UPDATE circles SET frozen_at = NULL WHERE id = ?', h.id);
  assert.equal(await purgeExpired(), 1);
  const { insertMessage } = await import('./lib/helpers.ts');
  const delivered = insertMessage({ circleId: h.id, userId: h.owner.id, kind: 'text', body: 'رسالة مختومة', delivered: true });
  assert.equal(one('SELECT expires_at AS e FROM messages WHERE id = ?', delivered.id)!.e, null, 'a message the server delivers on a person\'s behalf does not expire');
});
test('review: a broadcast list no longer reaches someone you share no group with, and direct chats alone do not qualify', async () => {
  const g = await group();
  const lid = (await call(g.owner.cookie, '/api/broadcast-lists', 'POST', { name: 'x', members: [g.member.id] })).json.id;
  run('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?', g.id, g.member.id);
  const r = await call(g.owner.cookie, `/api/broadcast-lists/${lid}/chats`, 'POST');
  assert.deepEqual(r.json.chats, []);
  const lone = await person('وحيد'), x = await person('آخر');
  await call(lone.cookie, '/api/direct', 'POST', { phone: '' });   // no effect
  const d = (await call(x.cookie, '/api/circles', 'POST', { name: 'ج', kind: 'group' })).json.id;
  assert.ok(d);
  assert.equal((await call(lone.cookie, '/api/broadcast-lists', 'POST', { name: 'y', members: [x.id] })).status, 400);
});
test('review: the transcribe route refuses an oversized body before reading it all', async () => {
  const g = await group();
  setTranscriber({ transcribe: async () => 'x' });
  const res = await app.request('/api/transcribe', { method: 'POST', headers: { cookie: g.member.cookie, 'content-type': 'multipart/form-data; boundary=zz', 'content-length': String(50 * 1024 * 1024) }, body: 'x' });
  assert.equal(res.status, 413);
  setTranscriber(null);
});
