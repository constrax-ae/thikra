// MSG-03: in a one-to-one chat nobody is an admin. Whoever started it is stored as its "owner", but that must not let them
// delete the other person's messages for everyone; only their own, within the normal window. Group managers keep their power.

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

test('in a one-to-one chat the person who started it cannot delete the other person\'s message for everyone', async () => {
  const a = await person('Starter'), b = await person('Other');
  const { json: { id } } = await call(a.cookie, '/api/direct', 'POST', { phone: b.phone });
  await call(b.cookie, `/api/requests/${id}/accept`, 'POST', {});
  const theirs = (await say(b, id, 'my words')).json;
  const mine = (await say(a, id, 'starter words')).json;
  const r = await call(a.cookie, `/api/messages/${theirs.id}`, 'DELETE');
  assert.equal(r.status, 403, 'not the starter\'s message to take back');
  assert.equal(r.json.error, 'forbidden');
  assert.equal((await call(a.cookie, `/api/messages/${mine.id}`, 'DELETE')).status, 200, 'their own message, yes');
  assert.equal((await call(b.cookie, `/api/messages/${theirs.id}`, 'DELETE')).status, 200, 'and the other person their own');
});

test('a group\'s owner can still take back a member\'s message', async () => {
  const owner = await person('Owner'), member = await person('Member');
  const g = (await call(owner.cookie, '/api/circles', 'POST', { kind: 'group', name: 'Rules' })).json;
  const code = (await call(owner.cookie, `/api/circles/${g.id}`)).json.inviteCode;
  assert.equal((await call(member.cookie, '/api/circles/join', 'POST', { code })).status, 200);
  const msg = (await say(member, g.id, 'out of line')).json;
  assert.equal((await call(owner.cookie, `/api/messages/${msg.id}`, 'DELETE')).status, 200);
});
