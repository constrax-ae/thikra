process.env.THIKRA_DEV = '1';   // these tests sign in with the on-screen code, which only exists in explicit development mode
// Message requests (AUTH-02) and the text limit (MSG-01): a one-to-one chat from someone you do not know waits as a
// request until you accept it; it can be declined, blocked or reported; and a stranger learns nothing from it.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { app } = await import('./index.ts');
const { one } = await import('./db.ts');
const { canSeePresence } = await import('./lib/presence.ts');

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
let n = 0;
async function person(name: string) {
  const phone = `+96658${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(2, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, name, phone, id: (await call(cookie, '/api/me')).json.id as number };
}
const listOf = async (p: { cookie: string }) => (await call(p.cookie, '/api/circles')).json as any[];
const say = (p: { cookie: string }, chat: number, body: string) => call(p.cookie, `/api/circles/${chat}/messages`, 'POST', { body, client_msg_id: crypto.randomUUID() });

test('a stranger\'s first message arrives as a request; the sender sees an ordinary chat', async () => {
  const aisha = await person('Aisha'), omar = await person('Omar');
  const { json: { id } } = await call(aisha.cookie, '/api/direct', 'POST', { phone: omar.phone });
  assert.equal((await say(aisha, id, 'Hello Omar')).status, 201);
  const forOmar = (await listOf(omar)).find(c => c.id === id);
  assert.equal(forOmar.request, true, 'Omar sees it as a request');
  assert.equal((await listOf(aisha)).find(c => c.id === id).request, false, 'Aisha (who started it) does not');
  assert.equal((await call(omar.cookie, `/api/circles/${id}`)).json.request, true);
  // Asking again for the same chat gives the same chat: one per pair.
  assert.equal((await call(aisha.cookie, '/api/direct', 'POST', { phone: omar.phone })).json.id, id);
});

test('a waiting request sends no read receipt and reveals no presence; accepting it turns both on', async () => {
  const aisha = await person('Aisha'), omar = await person('Omar');
  const { json: { id } } = await call(aisha.cookie, '/api/direct', 'POST', { phone: omar.phone });
  const sent = await say(aisha, id, 'Are you there?');
  await call(omar.cookie, `/api/circles/${id}/read`, 'POST', { seq: sent.json.seq });
  assert.equal(one('SELECT read_seq FROM circle_members WHERE circle_id = ? AND user_id = ?', id, omar.id)!.read_seq, 0, 'opening a request is not reading it');
  assert.equal(canSeePresence(aisha.id, omar.id), false, 'the stranger cannot see Omar online');
  assert.equal(canSeePresence(omar.id, aisha.id), false);
  assert.equal((await call(omar.cookie, `/api/requests/${id}/accept`, 'POST')).status, 200);
  assert.equal((await listOf(omar)).find(c => c.id === id).request, false);
  await call(omar.cookie, `/api/circles/${id}/read`, 'POST', { seq: sent.json.seq });
  assert.equal(one('SELECT read_seq FROM circle_members WHERE circle_id = ? AND user_id = ?', id, omar.id)!.read_seq, sent.json.seq, 'after accepting, reading counts');
  assert.equal(canSeePresence(aisha.id, omar.id), true);
  assert.equal((await call(omar.cookie, `/api/requests/${id}/accept`, 'POST')).status, 404, 'nothing left to accept');
});

test('people who share a circle or group never get a request, nor does someone you already accepted', async () => {
  const sara = await person('Sara'), john = await person('John');
  const { json: g } = await call(sara.cookie, '/api/circles', 'POST', { name: 'Family', kind: 'group' });
  const code = (await call(sara.cookie, `/api/circles/${g.id}`)).json.inviteCode;
  await call(john.cookie, '/api/circles/join', 'POST', { code });
  const { json: { id } } = await call(sara.cookie, '/api/direct', 'POST', { phone: john.phone });
  assert.equal((await listOf(john)).find(c => c.id === id).request, false, 'they share a group');

  const aisha = await person('Aisha'), omar = await person('Omar');
  const plain = (await call(aisha.cookie, '/api/direct', 'POST', { phone: omar.phone })).json.id;
  await call(omar.cookie, `/api/requests/${plain}/accept`, 'POST');
  const other = await call(aisha.cookie, '/api/direct', 'POST', { phone: omar.phone, encrypted: true });
  if (other.status === 409) return;   // encryption off in this run: nothing more to check
  assert.equal((await listOf(omar)).find(c => c.id === other.json.id).request, false, 'Omar already accepted Aisha once');
});

test('only the person asked can answer, and only their own request', async () => {
  const aisha = await person('Aisha'), omar = await person('Omar'), eve = await person('Eve');
  const { json: { id } } = await call(aisha.cookie, '/api/direct', 'POST', { phone: omar.phone });
  assert.equal((await call(aisha.cookie, `/api/requests/${id}/accept`, 'POST')).status, 404, 'the sender cannot accept for Omar');
  assert.equal((await call(eve.cookie, `/api/requests/${id}/accept`, 'POST')).status, 404, 'an outsider cannot');
  assert.equal((await call(eve.cookie, `/api/requests/${id}/decline`, 'POST')).status, 404);
  assert.equal((await call(omar.cookie, `/api/requests/abc/accept`, 'POST')).status, 404);
});

test('declining hides the chat without telling the sender; declining with block stops their messages', async () => {
  const aisha = await person('Aisha'), omar = await person('Omar');
  const { json: { id } } = await call(aisha.cookie, '/api/direct', 'POST', { phone: omar.phone });
  await say(aisha, id, 'Buy now!');
  assert.equal((await call(omar.cookie, `/api/requests/${id}/decline`, 'POST', { block: true })).status, 200);
  assert.equal((await listOf(omar)).find(c => c.id === id), undefined, 'gone from Omar\'s list');
  assert.ok((await listOf(aisha)).find(c => c.id === id), 'Aisha still has her chat');
  assert.equal((await say(aisha, id, 'Hello?')).status, 403, 'blocked: she cannot send any more');
  assert.ok(one('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', omar.id, aisha.id));
});

test('reporting a request files a report with the sender, then declines and blocks', async () => {
  const aisha = await person('Spammer'), omar = await person('Omar');
  const { json: { id } } = await call(aisha.cookie, '/api/direct', 'POST', { phone: omar.phone });
  await say(aisha, id, 'Win a prize at bad.example');
  assert.equal((await call(omar.cookie, `/api/requests/${id}/report`, 'POST', { reason: 'nonsense' })).status, 400);
  assert.equal((await call(omar.cookie, `/api/requests/${id}/report`, 'POST', { reason: 'spam' })).status, 200);
  const r = one('SELECT reported_user_id, reason, snapshot FROM reports WHERE reporter_id = ? AND circle_id = ?', omar.id, id)!;
  assert.equal(r.reported_user_id, aisha.id);
  assert.equal(r.reason, 'spam');
  assert.equal(r.snapshot, 'Win a prize at bad.example');
  assert.equal((await listOf(omar)).find(c => c.id === id), undefined);
  assert.equal((await say(aisha, id, 'again')).status, 403);
});

test('a text longer than 10,000 characters is refused, never cut short', async () => {
  const aisha = await person('Aisha'), omar = await person('Omar');
  const { json: { id } } = await call(aisha.cookie, '/api/direct', 'POST', { phone: omar.phone });
  const long = await say(aisha, id, 'x'.repeat(10_001));
  assert.equal(long.status, 413);
  assert.equal(long.json.error, 'too_long');
  const ok = await say(aisha, id, 'y'.repeat(10_000));
  assert.equal(ok.status, 201);
  assert.equal(one('SELECT length(body) AS n FROM messages WHERE id = ?', ok.json.id)!.n, 10_000, 'stored whole');
  const edit = await call(aisha.cookie, `/api/messages/${ok.json.id}`, 'PATCH', { body: 'z'.repeat(10_001) });
  assert.equal(edit.status, 413, 'an edit cannot grow past the limit either');
});
