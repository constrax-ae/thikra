// Step 2 (groups), features 11 and 12: @mentions and polls.

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
const { setTransport } = await import('./push.ts');
const { run, one, all } = await import('./db.ts');
const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
const opened: WebSocket[] = [];
after(() => { for (const w of opened) w.terminate(); server.close(); server.closeAllConnections?.(); });

const pushed: Array<{ to: string; body: string }> = [];
setTransport(async (sub, payload) => { pushed.push({ to: sub.endpoint, body: JSON.parse(payload).body }); });
const settle = () => new Promise(r => setTimeout(r, 80));

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
let n = 0;
async function person(name: string) {
  const phone = `+96651${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(2, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const id = (await call(cookie, '/api/me')).json.id as number;
  run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)', id, `push:${id}`, 'k', 'a');   // a phone that gets notifications
  return { cookie, name, id };
}
type P = Awaited<ReturnType<typeof person>>;
async function group() {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const id = (await call(a.cookie, '/api/circles', 'POST', { name: 'الشلة', kind: 'group' })).json.id as number;
  const code = (await call(a.cookie, `/api/circles/${id}`)).json.inviteCode as string;
  for (const p of [b, c]) await call(p.cookie, '/api/circles/join', 'POST', { code });
  return { a, b, c, id };
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
const messages = async (p: P, id: number) => (await call(p.cookie, `/api/circles/${id}/messages?after=0`)).json as any[];
const row = async (p: P, id: number) => ((await call(p.cookie, '/api/circles')).json as any[]).find(c => c.id === id);

// ---- 11: mentions -------------------------------------------------------------------------

test('11: a mention is stored with the message, shown to everyone, and marks the chat for the person mentioned until they read it', async () => {
  const { a, b, c, id } = await group();
  const sent = await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'يا @سارة شوفي هذا', mentions: [b.id] });
  assert.equal(sent.status, 201);
  const m = (await messages(c, id)).at(-1);
  assert.deepEqual(m.mentions, [{ id: b.id, name: 'سارة' }]);
  assert.equal((await row(b, id)).mentioned, true);
  assert.equal((await row(c, id)).mentioned, false, 'only the person mentioned');
  assert.equal((await row(a, id)).mentioned, false);
  await call(b.cookie, `/api/circles/${id}/read`, 'POST', { seq: m.seq });
  assert.equal((await row(b, id)).mentioned, false, 'reading clears the badge');
});

test('11: over the live socket too, and the pushed message carries the mentions', async () => {
  const { a, b, id } = await group();
  const sender = await socket(a), other = await socket(b);
  sender.send({ t: 'send', circle: id, client_msg_id: 'm1', body: '@سارة', mentions: [b.id] });
  await sender.next(f => f.t === 'ack' && f.client_msg_id === 'm1');
  assert.deepEqual((await other.next(f => f.t === 'msg' && f.m.body === '@سارة')).m.mentions, [{ id: b.id, name: 'سارة' }]);
});

test('11: a mention notifies even when the chat is muted; an ordinary message in a muted chat does not', async () => {
  const { a, b, c, id } = await group();
  await call(b.cookie, `/api/circles/${id}/prefs`, 'PATCH', { muted: true });
  await call(c.cookie, `/api/circles/${id}/prefs`, 'PATCH', { muted: true });
  pushed.length = 0;
  await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'رسالة عادية' });
  await settle();
  assert.equal(pushed.length, 0, 'muted: silent');
  await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: '@سارة مهم', mentions: [b.id] });
  await settle();
  assert.deepEqual(pushed.map(p => p.to), [`push:${b.id}`], 'Sara is told, Khalid (muted, not mentioned) is not');
});

test('11: only members of that chat can be mentioned; yourself, strangers, repeats and junk are dropped; at most 20', async () => {
  const { a, b, c, id } = await group();
  const stranger = await person('غريب');
  await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'x', mentions: [b.id, b.id, a.id, stranger.id, 'abc', -1, 99999999, null] });
  assert.deepEqual((await messages(c, id)).at(-1).mentions, [{ id: b.id, name: 'سارة' }]);
  assert.equal((await row(stranger, id)), undefined);
  await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'y', mentions: 'سارة' });
  assert.deepEqual((await messages(c, id)).at(-1).mentions, [], 'not a list: no mentions, the message still goes');
  await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'z', mentions: Array.from({ length: 50 }, () => c.id).concat(b.id) });
  assert.ok((await messages(c, id)).at(-1).mentions.length <= 20);
});

test('11: a retry of the same message does not mention twice, and a deleted message no longer marks the chat', async () => {
  const { a, b, id } = await group();
  const first = await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: '@سارة', mentions: [b.id], client_msg_id: 'same' });
  const again = await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: '@سارة', mentions: [b.id], client_msg_id: 'same' });
  assert.equal(again.json.id, first.json.id);
  assert.equal(all('SELECT 1 FROM message_mentions WHERE message_id = ?', first.json.id).length, 1);
  assert.equal((await row(b, id)).mentioned, true);
  assert.equal((await call(a.cookie, `/api/messages/${first.json.id}`, 'DELETE')).status, 200);
  assert.equal((await row(b, id)).mentioned, false);
});

// ---- 12: polls ----------------------------------------------------------------------------

const poll = async (p: P, id: number, mid: number) => (await messages(p, id)).find(m => m.id === mid).poll;
const counts = (pl: any) => pl.options.map((o: any) => o.voters.length);

test('12: a poll is a message everyone sees; one vote each, changeable, and results reach everyone at once', async () => {
  const { a, b, c, id } = await group();
  const watcher = await socket(c);
  const made = await call(a.cookie, `/api/circles/${id}/polls`, 'POST', { question: '  أين نتعشى؟ ', options: ['البيت', ' المطعم ', 'البحر'] });
  assert.equal(made.status, 201);
  const mid = made.json.id as number;
  const pushedMsg = await watcher.next(f => f.t === 'msg' && f.m.id === mid);
  assert.equal(pushedMsg.m.body, 'أين نتعشى؟');
  let p = await poll(b, id, mid);
  assert.deepEqual([p.multiple, p.closed, p.options.map((o: any) => o.text), counts(p)], [false, false, ['البيت', 'المطعم', 'البحر'], [0, 0, 0]]);
  const [home, rest, sea] = p.options.map((o: any) => o.id as number);

  assert.equal((await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [rest] })).status, 200);
  const update = await watcher.next(f => f.t === 'update' && f.m.id === mid);
  assert.deepEqual(update.m.poll.options[1].voters, [b.id], 'everyone hears, with who voted');
  assert.equal((await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [rest] })).status, 200, 'the same vote again changes nothing');
  assert.deepEqual(counts(await poll(a, id, mid)), [0, 1, 0]);
  assert.equal((await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [home, sea] })).status, 400, 'single choice: one option');
  await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [sea] });
  assert.deepEqual(counts(await poll(a, id, mid)), [0, 0, 1], 'changing a vote moves it, never adds a second');
  await call(c.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [sea] });
  await call(a.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [home] });
  p = await poll(a, id, mid);
  assert.deepEqual(counts(p), [1, 0, 2]);
  assert.equal(p.voters, 3);
  await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [] });
  assert.deepEqual(counts(await poll(a, id, mid)), [1, 0, 1], 'a vote can be taken back');

  // a device that was away catches up through the ordinary sync
  const before = (await messages(a, id)).find(m => m.id === mid).rev as number;
  await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [home] });
  const changed = (await call(a.cookie, `/api/circles/${id}/messages?after_rev=${before}`)).json as any[];
  assert.deepEqual(changed.map(m => m.id), [mid]);
});

test('12: multiple choice lets a person pick several, still once each', async () => {
  const { a, b, id } = await group();
  const mid = (await call(a.cookie, `/api/circles/${id}/polls`, 'POST', { question: 'ماذا نحضر؟', options: ['قهوة', 'شاي', 'حلى'], multiple: true })).json.id as number;
  const opts = (await poll(a, id, mid)).options.map((o: any) => o.id as number);
  assert.equal((await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [opts[0], opts[2], opts[0]] })).status, 200);
  const p = await poll(a, id, mid);
  assert.deepEqual([p.multiple, counts(p), p.voters], [true, [1, 0, 1], 1]);
});

test('12: only the creator closes a poll; after that nobody can vote and the result stays', async () => {
  const { a, b, c, id } = await group();
  const mid = (await call(a.cookie, `/api/circles/${id}/polls`, 'POST', { question: 'س؟', options: ['نعم', 'لا'] })).json.id as number;
  const [yes] = (await poll(a, id, mid)).options.map((o: any) => o.id as number);
  await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [yes] });
  assert.equal((await call(b.cookie, `/api/messages/${mid}/poll/close`, 'POST', {})).status, 403);
  assert.equal((await call(a.cookie, `/api/messages/${mid}/poll/close`, 'POST', {})).status, 200);
  const closed = await call(c.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [yes] });
  assert.deepEqual([closed.status, closed.json.error], [409, 'poll_closed']);
  const p = await poll(c, id, mid);
  assert.deepEqual([p.closed, counts(p)], [true, [1, 0]]);
});

test('12: what makes a poll: a question, 2 to 12 different options, sensible lengths', async () => {
  const { a, id } = await group();
  const make = (body: unknown) => call(a.cookie, `/api/circles/${id}/polls`, 'POST', body);
  assert.equal((await make({ question: '', options: ['أ', 'ب'] })).status, 400);
  assert.equal((await make({ question: 'س', options: ['أ'] })).status, 400);
  assert.equal((await make({ question: 'س', options: ['أ', ' أ '] })).status, 400, 'the same option twice');
  assert.equal((await make({ question: 'س', options: ['أ', '', '  '] })).status, 400, 'empty options do not count');
  assert.equal((await make({ question: 'س', options: Array.from({ length: 13 }, (_, i) => `خيار ${i}`) })).status, 400);
  assert.equal((await make({ question: 'س', options: 'أ,ب' })).status, 400);
  assert.equal((await make({ question: 'س', options: Array.from({ length: 12 }, (_, i) => `خيار ${i}`) })).status, 201);
  const long = await make({ question: 'س'.repeat(900), options: ['أ'.repeat(900), 'ب'] });
  const p = (await messages(a, id)).find(m => m.id === long.json.id);
  assert.deepEqual([p.body.length, p.poll.options[0].text.length], [300, 100]);
});

test('12: outsiders cannot vote or see; a vote for an option of another poll is refused; a poll cannot be edited or forwarded', async () => {
  const { a, b, id } = await group();
  const stranger = await person('غريب');
  const mid = (await call(a.cookie, `/api/circles/${id}/polls`, 'POST', { question: 'س؟', options: ['نعم', 'لا'] })).json.id as number;
  const other = (await call(a.cookie, `/api/circles/${id}/polls`, 'POST', { question: 'ص؟', options: ['١', '٢'] })).json.id as number;
  const foreign = (await poll(a, id, other)).options[0].id as number;
  assert.equal((await call(stranger.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [foreign] })).status, 404);
  assert.equal((await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [foreign] })).status, 400);
  assert.equal((await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: 'x' })).status, 400);
  assert.equal((await call(b.cookie, `/api/messages/99999999/vote`, 'POST', { options: [] })).status, 404);
  assert.equal((await call(a.cookie, `/api/messages/${mid}`, 'PATCH', { body: 'سؤال آخر' })).status, 403);
  assert.equal((await call(a.cookie, `/api/messages/${mid}/forward`, 'POST', { circles: [id] })).status, 404);
  const plain = (await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'ليست استطلاعاً' })).json.id;
  assert.equal((await call(b.cookie, `/api/messages/${plain}/vote`, 'POST', { options: [] })).status, 404);
  assert.equal((await messages(a, id)).find(m => m.id === plain).poll, null);
});

test('12: a poll deleted for everyone shows no question and takes no more votes', async () => {
  const { a, b, id } = await group();
  const mid = (await call(a.cookie, `/api/circles/${id}/polls`, 'POST', { question: 'س؟', options: ['نعم', 'لا'] })).json.id as number;
  const [yes] = (await poll(a, id, mid)).options.map((o: any) => o.id as number);
  assert.equal((await call(a.cookie, `/api/messages/${mid}`, 'DELETE')).status, 200);
  assert.equal((await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [yes] })).status, 404);
  assert.equal((await messages(b, id)).find(m => m.id === mid).poll, null);
  assert.equal(one('SELECT COUNT(*) AS n FROM poll_votes WHERE message_id = ?', mid)!.n, 0);
});

// ---- found by the independent review ---------------------------------------------------------

test('review: no polls in a one-to-one chat, so a blocked person cannot reach you with one', async () => {
  const { a, b } = await group();
  const direct = (await call(a.cookie, '/api/direct', 'POST', { userId: b.id })).json.id as number;
  await call(a.cookie, `/api/users/${b.id}/block`, 'POST', {});
  const tried = await call(b.cookie, `/api/circles/${direct}/polls`, 'POST', { question: 'س؟', options: ['نعم', 'لا'] });
  assert.equal(tried.status, 403);
  await call(a.cookie, `/api/users/${b.id}/block`, 'POST', { on: false });
  assert.equal((await call(b.cookie, `/api/circles/${direct}/polls`, 'POST', { question: 'س؟', options: ['نعم', 'لا'] })).status, 403, 'not even unblocked: a poll is for groups');
  assert.deepEqual((await messages(a, direct)).filter(m => m.kind !== 'system'), []);
});

test('review: the @ badge goes away when I delete the message for myself, and when the mention is edited out', async () => {
  const { a, b, id } = await group();
  const one1 = (await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: '@سارة أولى', mentions: [b.id] })).json.id as number;
  assert.equal((await row(b, id)).mentioned, true);
  assert.equal((await call(b.cookie, `/api/messages/${one1}/hide`, 'POST', {})).status, 200);
  assert.equal((await row(b, id)).mentioned, false, 'hidden for me: no badge for it');
  const two = (await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: '@سارة ثانية', mentions: [b.id] })).json.id as number;
  assert.equal((await row(b, id)).mentioned, true);
  await call(a.cookie, `/api/messages/${two}`, 'PATCH', { body: 'ثانية بلا إشارة' });
  assert.deepEqual((await messages(b, id)).find(m => m.id === two).mentions, []);
  assert.equal((await row(b, id)).mentioned, false);
  const three = (await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: '@سارة ثالثة', mentions: [b.id] })).json.id as number;
  await call(a.cookie, `/api/messages/${three}`, 'PATCH', { body: '@سارة ثالثة معدّلة' });
  assert.deepEqual((await messages(b, id)).find(m => m.id === three).mentions, [{ id: b.id, name: 'سارة' }], 'an edit that keeps the name keeps the mention');
});

test('review: two votes at the same moment still leave one vote', async () => {
  const { a, b, id } = await group();
  const mid = (await call(a.cookie, `/api/circles/${id}/polls`, 'POST', { question: 'س؟', options: ['نعم', 'لا'] })).json.id as number;
  const [yes, no] = (await poll(a, id, mid)).options.map((o: any) => o.id as number);
  await Promise.all([yes, no, yes, no, yes].map(o => call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [o] })));
  const p = await poll(a, id, mid);
  assert.equal(p.options.reduce((n: number, o: any) => n + o.voters.length, 0), 1);
  assert.equal(p.voters, 1);
});

test('review: someone who left the group still shows by name in a poll they voted in', async () => {
  const { a, b, id } = await group();
  const mid = (await call(a.cookie, `/api/circles/${id}/polls`, 'POST', { question: 'س؟', options: ['نعم', 'لا'] })).json.id as number;
  const [yes] = (await poll(a, id, mid)).options.map((o: any) => o.id as number);
  await call(b.cookie, `/api/messages/${mid}/vote`, 'POST', { options: [yes] });
  await call(b.cookie, `/api/circles/${id}/members/${b.id}`, 'DELETE');
  assert.equal((await poll(a, id, mid)).names[b.id], 'سارة');
});
