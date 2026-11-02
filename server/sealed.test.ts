// Sealed messages: a letter to the future. First version (date based, once or yearly, to a circle or one person).
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app, releaseDueSealed } = await import('./index.ts');
await (await import('./lib/ops.ts')).setFlag('sealed_after_death', true);   // these tests cover the after-death letters, which are off by default
const { run, one, all } = await import('./db.ts');

let n = 0;
async function login(name: string) {
  const phone = `+9665${String(2_000_000 + n++).padStart(8, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, id: (await (await app.request('/api/me', { headers: { cookie } })).json() as any).id as number };
}
const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
async function family() {
  const dad = await login('الأب'), son = await login('الابن'), other = await login('قريب');
  const circle = (await call(dad.cookie, '/api/circles', 'POST', { name: 'العائلة' })).json.id as number;
  const code = (await call(dad.cookie, `/api/circles/${circle}`)).json.inviteCode;
  for (const u of [son, other]) await call(u.cookie, '/api/circles/join', 'POST', { code });
  return { dad, son, other, circle };
}
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const seal = (u: { cookie: string }, circle: number, body: object) => call(u.cookie, `/api/circles/${circle}/sealed`, 'POST', body);
const bodies = async (u: { cookie: string }, circle: number) => ((await call(u.cookie, `/api/circles/${circle}/messages?after_seq=0`)).json as any[]).filter(m => m.kind === 'text');
const makeDue = (id: number) => run("UPDATE sealed_messages SET unlock_at = datetime('now', '-1 minute') WHERE id = ?", id);

test('sealing is validated, private to the author, and cancellable', async () => {
  const { dad, son, circle } = await family();
  assert.equal((await seal(dad, circle, { body: '', unlockAt: inFuture(1e7) })).status, 400);
  assert.equal((await seal(dad, circle, { body: 'x', unlockAt: inFuture(60_000) })).json.error, 'invalid_date', 'less than five minutes ahead');
  assert.equal((await seal(dad, circle, { body: 'x', unlockAt: inFuture(60 * 365 * 24 * 3600_000) })).json.error, 'invalid_date', 'more than fifty years');
  assert.equal((await seal(dad, circle, { body: 'x', unlockAt: 'not a date' })).json.error, 'invalid_date');
  const outsider = await login('غريب');
  assert.equal((await seal(outsider, circle, { body: 'x', unlockAt: inFuture(1e7) })).status, 404);
  assert.equal((await seal(dad, circle, { body: 'x', unlockAt: inFuture(1e7), recipientId: outsider.id })).status, 404, 'the recipient must be in the circle');

  const ok = await seal(dad, circle, { body: 'بنيّ، يوم زواجك أكون بجانبك', unlockAt: inFuture(30 * 24 * 3600_000) });
  assert.equal(ok.status, 201);
  assert.equal((await call(dad.cookie, `/api/circles/${circle}/sealed`)).json.length, 1);
  assert.equal((await call(son.cookie, `/api/circles/${circle}/sealed`)).json.length, 0, 'nobody else sees the list');
  assert.ok(!(await bodies(son, circle)).some(m => m.body.includes('زواجك')), 'and nobody sees the text in the chat before it opens');
  assert.equal(await releaseDueSealed(), 0, 'not due yet: nothing opens early');
  // cancelling: only the author, and the text is erased
  assert.equal((await call(son.cookie, `/api/sealed/${ok.json.id}`, 'DELETE')).status, 404);
  assert.equal((await call(dad.cookie, `/api/sealed/${ok.json.id}`, 'DELETE')).status, 200);
  assert.equal(one('SELECT body FROM sealed_messages WHERE id = ?', ok.json.id)!.body, '', 'a cancelled letter keeps no text');
  makeDue(ok.json.id);
  assert.equal(await releaseDueSealed(), 0, 'a cancelled one never opens');
});

test('at its time a sealed message opens in the circle, labelled with the day it was sealed, once', async () => {
  const { dad, son, circle } = await family();
  const s = await seal(dad, circle, { body: 'كل عام وأنتم بخير', unlockAt: inFuture(1e7) });
  makeDue(s.json.id);
  assert.equal(await releaseDueSealed(), 1);
  const msg = (await bodies(son, circle)).find(m => m.body === 'كل عام وأنتم بخير');
  assert.ok(msg, 'the circle sees it');
  assert.equal(msg.author, 'الأب');
  assert.equal(msg.sealedOn, new Date().toISOString().slice(0, 10), 'shown as sealed on the day it was written');
  assert.equal(await releaseDueSealed(), 0, 'it does not open twice');
  assert.equal((await call(dad.cookie, `/api/circles/${circle}/sealed`)).json.length, 0, 'no longer waiting');
  assert.equal(one('SELECT body FROM sealed_messages WHERE id = ?', s.json.id)!.body, '', 'the server keeps no second copy of the text');
});

test('to one person: delivered in your one-to-one chat, never in the circle', async () => {
  const { dad, son, other, circle } = await family();
  const s = await seal(dad, circle, { body: 'لك وحدك', unlockAt: inFuture(1e7), recipientId: son.id });
  makeDue(s.json.id);
  assert.equal(await releaseDueSealed(), 1);
  assert.ok(!(await bodies(other, circle)).some(m => m.body === 'لك وحدك'), 'not in the circle');
  const chats = (await call(son.cookie, '/api/circles')).json as any[];
  const direct = chats.find(c => c.kind === 'direct');
  assert.equal(direct.name, 'الأب');
  assert.equal(((await call(son.cookie, `/api/circles/${direct.id}/messages?after_seq=0`)).json as any[]).filter(m => m.body === 'لك وحدك').length, 1);
});

test('yearly: comes back every year, and stops when the recipient is recorded as deceased; leaving or blocking also stops it', async () => {
  const { dad, son, circle } = await family();
  const s = await seal(dad, circle, { body: 'عيد ميلاد سعيد يا بنيّ', unlockAt: inFuture(1e7), recipientId: son.id, yearly: true });
  makeDue(s.json.id);
  assert.equal(await releaseDueSealed(), 1);
  const row = one('SELECT status, unlock_at, body FROM sealed_messages WHERE id = ?', s.json.id)!;
  assert.equal(row.status, 'sealed', 'still waiting for next year');
  assert.ok(Date.parse(`${row.unlock_at.replace(' ', 'T')}Z`) > Date.now() + 360 * 24 * 3600_000, 'about a year from now');
  assert.equal(row.body, 'عيد ميلاد سعيد يا بنيّ', 'a recurring letter keeps its text for next year');
  // the family record marks the son as deceased: the next one must NOT be sent (we freeze rather than guess)
  run("UPDATE persons SET death_date = '2030-01-01' WHERE circle_id = ? AND user_id = ?", circle, son.id);
  makeDue(s.json.id);
  const before = (await call(son.cookie, '/api/circles')).json.length;
  assert.equal(await releaseDueSealed(), 0);
  const stopped = one('SELECT status, note FROM sealed_messages WHERE id = ?', s.json.id)!;
  assert.deepEqual([stopped.status, stopped.note], ['stopped', 'recipient_deceased']);
  assert.equal((await call(son.cookie, '/api/circles')).json.length, before);
  assert.equal((await call(dad.cookie, `/api/circles/${circle}/sealed`)).json[0].status, 'stopped', 'the author can see it was stopped');

  // a recipient who left the circle: stopped too
  const s2 = await seal(dad, circle, { body: 'x', unlockAt: inFuture(1e7), recipientId: son.id });
  run('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?', circle, son.id);
  makeDue(s2.json.id);
  assert.equal(await releaseDueSealed(), 0);
  assert.equal(one('SELECT note FROM sealed_messages WHERE id = ?', s2.json.id)!.note, 'recipient_left');
});
