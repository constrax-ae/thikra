process.env.THIKRA_DEV = '1';   // these tests sign in with the on-screen code, which only exists in explicit development mode
// AUTH-01 "optional bio": the one-line About under your name, who sees it, and its limits.

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

const memberOf = async (viewer: { cookie: string }, chat: number, id: number) =>
  ((await call(viewer.cookie, `/api/circles/${chat}`)).json.members as any[]).find(m => m.id === id);

test('an About line is saved trimmed, on one line, and shown to the people you share a chat with', async () => {
  const aisha = await person('Aisha'), omar = await person('Omar');
  const r = await call(aisha.cookie, '/api/me', 'PATCH', { about: '  At work\nuntil   5  ' });
  assert.equal(r.status, 200);
  assert.equal(r.json.about, 'At work until 5');
  assert.equal((await call(aisha.cookie, '/api/me')).json.about, 'At work until 5', 'it comes back with the profile');
  const { json: { id } } = await call(omar.cookie, '/api/direct', 'POST', { phone: aisha.phone });
  assert.equal((await memberOf(omar, id, aisha.id)).about, 'At work until 5');
  assert.equal((await memberOf(omar, id, omar.id)).about, null, 'nobody has one until they write it');
});

test('an empty line removes it; other profile changes leave it alone', async () => {
  const p = await person('Dima');
  await call(p.cookie, '/api/me', 'PATCH', { about: 'Busy' });
  assert.equal((await call(p.cookie, '/api/me', 'PATCH', { name: 'Dima S' })).json.about, 'Busy', 'changing the name keeps it');
  assert.equal((await call(p.cookie, '/api/me', 'PATCH', { about: '   ' })).json.about, null);
  assert.equal((await call(p.cookie, '/api/me')).json.about, null);
});

test('at most 140 characters, counted as a person counts them', async () => {
  const p = await person('Long');
  assert.equal((await call(p.cookie, '/api/me', 'PATCH', { about: '😀'.repeat(140) })).status, 200, '140 emoji is 140, not 280');
  const over = await call(p.cookie, '/api/me', 'PATCH', { about: 'x'.repeat(141) });
  assert.equal(over.status, 413);
  assert.equal(over.json.error, 'too_long');
  assert.equal((await call(p.cookie, '/api/me')).json.about, '😀'.repeat(140), 'a refused change keeps the old line');
});

test('someone who blocked you shows you no About line', async () => {
  const a = await person('Blocker'), b = await person('Blocked');
  await call(a.cookie, '/api/me', 'PATCH', { about: 'Private line' });
  const { json: { id } } = await call(a.cookie, '/api/direct', 'POST', { phone: b.phone });
  assert.equal((await memberOf(b, id, a.id)).about, 'Private line');
  assert.equal((await call(a.cookie, `/api/users/${b.id}/block`, 'POST', {})).status, 200);
  assert.equal((await memberOf(b, id, a.id)).about, null);
  assert.equal((await memberOf(a, id, a.id)).about, 'Private line', 'they still see their own');
});
