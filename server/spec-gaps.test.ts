process.env.THIKRA_DEV = '1';   // these tests sign in with the on-screen code, which only exists in explicit development mode
// The last gaps between the chat specification and this server: CHAT-01 clear history, GRP-01 member cap,
// GRP-02 pre-join history and expiring invites, CHAT-02 search facets, PRIV-04 unopened view-once expiry, MED-05 checksum.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { run, one } = await import('./db.ts');

let n = 0;
async function login(name: string) {
  const phone = `+9665${String(9_100_000 + n++).padStart(8, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, name, id: (await (await app.request('/api/me', { headers: { cookie } })).json() as any).id as number };
}
const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
const form = async (cookie: string, path: string, fields: Array<[string, string | Blob, string?]>) => {
  const fd = new FormData();
  for (const [k, v, name] of fields) { if (v instanceof Blob) fd.append(k, v, name ?? 'f'); else fd.append(k, v); }
  const res = await app.request(path, { method: 'POST', headers: { cookie }, body: fd });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
const say = (who: { cookie: string }, circle: number, body: string) => call(who.cookie, `/api/circles/${circle}/messages`, 'POST', { body });
const msgs = async (who: { cookie: string }, circle: number) => (await call(who.cookie, `/api/circles/${circle}/messages?after=0`)).json as any[];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function group(kind: 'group' | 'circle' = 'group') {
  const owner = await login('مالك'), member = await login('عضو');
  const id = (await call(owner.cookie, '/api/circles', 'POST', { name: 'الفريق', kind })).json.id as number;
  const code = (await call(owner.cookie, `/api/circles/${id}`)).json.inviteCode as string;
  await call(member.cookie, '/api/circles/join', 'POST', { code });
  return { owner, member, id, code };
}

test('CHAT-01 clear history: a cutoff for me alone — the chat stays, the others keep everything, new messages still arrive', async () => {
  const g = await group();
  await say(g.owner, g.id, 'قبل المسح ١');
  await say(g.owner, g.id, 'قبل المسح ٢');
  assert.equal((await msgs(g.member, g.id)).filter(m => m.kind !== 'system').length, 2);

  const cleared = await call(g.member.cookie, `/api/circles/${g.id}/clear`, 'POST', {});
  assert.equal(cleared.status, 200);
  assert.ok(cleared.json.clearedThrough > 0);
  assert.deepEqual((await msgs(g.member, g.id)).filter(m => m.kind !== 'system'), [], 'gone from my screen');
  assert.equal((await msgs(g.owner, g.id)).filter(m => m.kind !== 'system').length, 2, "and untouched in everyone else's");
  assert.equal(one('SELECT COUNT(*) AS n FROM messages WHERE circle_id = ?', g.id)!.n, 3, 'nothing was deleted: it is a cutoff, not a delete');

  await say(g.owner, g.id, 'بعد المسح');
  const after = (await msgs(g.member, g.id)).filter(m => m.kind !== 'system');
  assert.deepEqual(after.map(m => m.body), ['بعد المسح'], 'the chat goes on');
  // The chat is still in the list, with no unread left over from what I chose not to see.
  const row = (await call(g.member.cookie, '/api/circles')).json.find((x: any) => x.id === g.id);
  assert.equal(row.lastText, 'بعد المسح');
  assert.equal(row.unread, 1);
  // Search does not bring back what was cleared.
  assert.deepEqual((await call(g.member.cookie, `/api/circles/${g.id}/search?q=${encodeURIComponent('قبل')}`)).json, []);
  assert.equal((await call(g.member.cookie, `/api/search?q=${encodeURIComponent('قبل')}`)).json.results.length, 0);
  assert.equal((await call(g.owner.cookie, `/api/search?q=${encodeURIComponent('قبل')}`)).json.results.length, 2, 'the other member still finds them');
});

test('GRP-02 pre-join history: an ordinary group may keep its past to itself; a family circle may not', async () => {
  const g = await group();
  await say(g.owner, g.id, 'سرّ قديم');
  assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}`, 'PATCH', { historyPolicy: 'since_join' })).status, 200);
  assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}`)).json.historyPolicy, 'since_join');

  const late = await login('متأخر');
  await call(late.cookie, '/api/circles/join', 'POST', { code: g.code });
  assert.ok(!(await msgs(late, g.id)).some(m => m.body === 'سرّ قديم'), 'the newcomer never sees what was said before them');
  assert.equal((await call(late.cookie, `/api/search?q=${encodeURIComponent('سر')}`)).json.results.length, 0, 'nor through search');
  await say(g.owner, g.id, 'بعد وصوله');
  assert.ok((await msgs(late, g.id)).some(m => m.body === 'بعد وصوله'), 'and sees everything from the moment they joined');
  assert.ok((await msgs(g.member, g.id)).some(m => m.body === 'سرّ قديم'), 'people who were already there keep it all');

  const fam = await group('circle');
  assert.equal((await call(fam.owner.cookie, `/api/circles/${fam.id}`, 'PATCH', { historyPolicy: 'since_join' })).status, 200);
  assert.equal((await call(fam.owner.cookie, `/api/circles/${fam.id}`)).json.historyPolicy, 'all', 'a family circle keeps its memory open: the setting does not apply');
});

test('GRP-01 the member cap, and GRP-02 an invite that expires', async () => {
  const g = await group();
  const { MAX_MEMBERS } = await import('./lib/groups.ts');
  assert.equal(MAX_MEMBERS, 256, 'the figure the specification proposes');
  // Fill it without creating 254 accounts: the count is what the rule reads.
  for (let i = 0; i < MAX_MEMBERS - 2; i++) run("INSERT INTO users (phone, name) VALUES (?, 'ملء')", `+96650000${String(i).padStart(4, '0')}`);
  run("INSERT INTO circle_members (circle_id, user_id, role) SELECT ?, id, 'member' FROM users WHERE name = 'ملء'", g.id);
  const late = await login('الأخير');
  assert.equal((await call(late.cookie, '/api/circles/join', 'POST', { code: g.code })).json.error, 'chat_full');
  run("DELETE FROM circle_members WHERE circle_id = ? AND user_id IN (SELECT id FROM users WHERE name = 'ملء')", g.id);
  assert.equal((await call(late.cookie, '/api/circles/join', 'POST', { code: g.code })).status, 200, 'room again');

  // An invite with a life: a manager sets it, and after it the link is no longer a link.
  assert.equal((await call(g.member.cookie, `/api/circles/${g.id}/invite/expiry`, 'PUT', { days: 7 })).status, 403, 'managers only');
  const set = await call(g.owner.cookie, `/api/circles/${g.id}/invite/expiry`, 'PUT', { days: 7 });
  assert.equal(set.status, 200);
  assert.ok(set.json.inviteExpiresAt);
  assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/invite/expiry`, 'PUT', { days: 0 })).status, 400);
  run("UPDATE circles SET invite_expires_at = datetime('now', '-1 day') WHERE id = ?", g.id);
  const stranger = await login('غريب');
  assert.equal((await call(stranger.cookie, '/api/circles/join', 'POST', { code: g.code })).status, 410);
  await call(g.owner.cookie, `/api/circles/${g.id}/invite/expiry`, 'PUT', { days: null });
  assert.equal((await call(stranger.cookie, '/api/circles/join', 'POST', { code: g.code })).status, 200, 'and a manager can make it permanent again');
});

test('CHAT-02 search facets: narrow by what it is and when it was said', async () => {
  const g = await group();
  await say(g.owner, g.id, 'التقرير جاهز');
  await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['file', new Blob([PNG], { type: 'image/png' }), 'x.png'], ['caption', 'التقرير بالصورة']]);
  const find = async (q: string, extra = '') => (await call(g.owner.cookie, `/api/search?q=${encodeURIComponent(q)}${extra}`)).json.results as any[];
  assert.equal((await find('التقرير')).length, 2);
  assert.equal((await find('التقرير', '&kind=photo')).length, 1, 'photos only');
  assert.equal((await find('التقرير', '&kind=photo'))[0].attachment, 'image');
  assert.equal((await find('التقرير', '&kind=text')).length, 1, 'plain text only');
  assert.equal((await find('التقرير', '&kind=voice')).length, 0);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await find('التقرير', `&from=${today}`)).length, 2, 'from today');
  assert.equal((await find('التقرير', '&to=2020-01-01')).length, 0, 'nothing that old');
  assert.equal((await find('التقرير', '&kind=nonsense&from=not-a-date')).length, 2, 'a filter that makes no sense narrows nothing');
  // and inside one chat
  const inChat = (await call(g.owner.cookie, `/api/circles/${g.id}/search?q=${encodeURIComponent('التقرير')}&kind=photo`)).json as any[];
  assert.equal(inChat.length, 1);
});

test('PRIV-04 a view-once photo nobody opened is gone after a fortnight', async () => {
  const g = await group();
  const sent = await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['file', new Blob([PNG], { type: 'image/png' }), 'once.png'], ['view_once', '1']]);
  assert.equal(sent.status, 201);
  const { UNOPENED_DAYS } = await import('./lib/viewonce.ts');
  assert.equal(UNOPENED_DAYS, 14, 'the figure the specification proposes');
  assert.equal((await call(g.member.cookie, `/api/messages/${sent.json.id}/open`, 'POST', {})).status, 200, 'inside the fortnight it opens');

  const second = await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['file', new Blob([PNG], { type: 'image/png' }), 'old.png'], ['view_once', '1']]);
  run("UPDATE messages SET created_at = datetime('now', '-15 days') WHERE id = ?", second.json.id);
  const late = await call(g.member.cookie, `/api/messages/${second.json.id}/open`, 'POST', {});
  assert.equal(late.status, 410);
  assert.equal(late.json.error, 'view_once_gone');
  const att = (await msgs(g.member, g.id)).find(m => m.id === second.json.id)?.attachments?.[0];
  if (att) assert.equal((await app.request(`/api/media/${att.id}`, { headers: { cookie: g.member.cookie } })).status, 410, 'and its file is not served either');
});

test('MED-05 a file must be what the sender said it was: the declared SHA-256 is checked before the message exists', async () => {
  const g = await group();
  const open = async (checksum?: string) => call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'a.png', size: PNG.length, ...(checksum === undefined ? {} : { checksum }) });
  assert.equal((await open('not-a-hash')).status, 400, 'a checksum that is not one is refused, not ignored');

  const good = createHash('sha256').update(PNG).digest('hex');
  const up = await open(good);
  assert.equal(up.status, 201);
  await app.request(`/api/uploads/${up.json.id}?offset=0`, { method: 'PUT', headers: { cookie: g.owner.cookie, 'content-type': 'application/octet-stream' }, body: new Blob([PNG]) });
  assert.equal((await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['upload', up.json.id]])).status, 201, 'matching bytes go through');

  const wrong = await open(createHash('sha256').update(Buffer.concat([PNG, Buffer.from('x')])).digest('hex'));
  await app.request(`/api/uploads/${wrong.json.id}?offset=0`, { method: 'PUT', headers: { cookie: g.owner.cookie, 'content-type': 'application/octet-stream' }, body: new Blob([PNG]) });
  const bad = await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['upload', wrong.json.id]]);
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, 'checksum_mismatch');
  assert.equal((await msgs(g.owner, g.id)).filter(m => m.attachments?.length).length, 1, 'the bad one left no message behind');
});

test('RT-03 where you are signed in: each device listed with when it was last used, and any of them can be ended', async () => {
  const me = await login('سارة');
  // A second and third sign-in from "other devices" (each verify makes its own session).
  const phone = (await call(me.cookie, '/api/me')).json.phone as string;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1' }, body: JSON.stringify(body) });
  const second = await (async () => {
    const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
    const res = await post('/api/auth/verify', { phone, code: devCode });
    return res.headers.get('set-cookie')!.split(';')[0];
  })();

  const list = (cookie: string) => call(cookie, '/api/me/sessions').then(r => r.json as any[]);
  const mine = await list(me.cookie);
  assert.equal(mine.length, 2, 'both sign-ins are listed');
  assert.equal(mine.filter(s => s.current).length, 1, 'exactly one of them is this one');
  assert.equal(mine[0].current, true, 'this device first');
  assert.ok(mine.every(s => s.lastSeenAt || s.createdAt), 'each says when it was last used');
  assert.ok(mine.every(s => !('token' in s)), 'no token, hashed or otherwise, leaves the server');
  assert.ok((await list(second)).find(s => s.current && s.userAgent?.includes('iPhone')), 'the other device sees itself, named by what the browser said');

  // Ending someone else's session: that cookie stops working at once, mine keeps going.
  const other = mine.find(s => !s.current)!;
  assert.equal((await call(me.cookie, `/api/me/sessions/${other.id}`, 'DELETE')).json.signedOutHere, false);
  assert.equal((await app.request('/api/me', { headers: { cookie: second } })).status, 401);
  assert.equal((await call(me.cookie, '/api/me')).status, 200);
  assert.equal((await call(me.cookie, `/api/me/sessions/${other.id}`, 'DELETE')).status, 404, 'and it is gone, not merely hidden');

  // "End every other session": the one asking survives, the rest do not.
  const third = await (async () => {
    const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
    return (await post('/api/auth/verify', { phone, code: devCode })).headers.get('set-cookie')!.split(';')[0];
  })();
  assert.equal((await call(me.cookie, '/api/me/sessions/revoke-others', 'POST', {})).json.ended, 1);
  assert.equal((await app.request('/api/me', { headers: { cookie: third } })).status, 401);
  assert.equal((await list(me.cookie)).length, 1);

  // One person never sees another's devices.
  const someone = await login('آخر');
  assert.equal((await list(someone.cookie)).length, 1);
  assert.equal((await call(someone.cookie, `/api/me/sessions/${(await list(me.cookie))[0].id}`, 'DELETE')).status, 404, "nor can end one that is not theirs");
});
