process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+971500770001';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-people-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { one, run } = await import('./db.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
async function signUp(phone: string, name: string) {
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode as string;
  const v = await call(undefined, '/api/auth/verify', { phone, code, name });
  return { cookie: v.cookie!, id: (await call(v.cookie, '/api/me')).json.id as number, phone };
}
const owner = await signUp('+971500770001', 'Owner');
const mod = await signUp('+971500770002', 'Moderator');
const sup = await signUp('+971500770003', 'Support');
const alice = await signUp('+971500770004', 'Alice');
const bob = await signUp('+971500770005', 'Bob');
const carol = await signUp('+971500770006', 'Carol');
await call(owner.cookie, `/api/admin/users/${mod.id}/role`, { role: 'moderator' });
await call(owner.cookie, `/api/admin/users/${sup.id}/role`, { role: 'support' });
const fam = (await call(alice.cookie, '/api/circles', { name: 'Alice family', kind: 'circle' })).json.id as number;
const code = one('SELECT invite_code FROM circles WHERE id = ?', fam)!.invite_code;
await call(bob.cookie, '/api/circles/join', { code });
await call(carol.cookie, '/api/circles/join', { code });
await call(bob.cookie, `/api/circles/${fam}/messages`, { body: 'secret family words', client_msg_id: 'a1' });

test('the family list and page show people, storage and state, never message text or full numbers', async () => {
  const list = (await call(owner.cookie, '/api/admin/families')).json as any[];
  const f = list.find(x => x.id === fam)!;
  assert.equal(f.members, 3); assert.equal(f.plan, 'free'); assert.equal(f.frozen, false); assert.ok(f.quotaGB >= 1);
  assert.ok(!list.some(x => x.kind === 'direct'));
  const d = (await call(owner.cookie, `/api/admin/families/${fam}`)).json;
  assert.deepEqual(d.membersList.map((m: any) => m.role).slice(0, 1), ['owner']);
  const all = JSON.stringify(d) + JSON.stringify(list);
  assert.ok(!all.includes('secret family words') && !all.includes('9715007700'), 'no content, masked numbers');
  assert.equal((await call(owner.cookie, '/api/admin/families?q=zzz')).json.length, 0);
  assert.equal((await call(owner.cookie, '/api/admin/families?filter=frozen')).json.length, 0);
  assert.equal((await call(alice.cookie, '/api/admin/families')).status, 403);
  assert.equal((await call(sup.cookie, '/api/admin/families')).status, 403);
});

test('freezing a family makes it read-only (nothing new in, nothing lost) and releasing restores it', async () => {
  assert.equal((await call(sup.cookie, `/api/admin/families/${fam}/freeze`, { on: true })).status, 403);
  assert.equal((await call(mod.cookie, `/api/admin/families/${fam}/freeze`, { on: true, reason: 'dispute' })).status, 200);
  assert.equal((await call(bob.cookie, `/api/circles/${fam}/messages`, { body: 'hello', client_msg_id: 'a2' })).status, 423);
  assert.equal((await call(bob.cookie, `/api/circles/${fam}/messages`)).status, 200, 'reading still works');
  assert.equal((await call(owner.cookie, '/api/admin/families?filter=frozen')).json.length, 1);
  assert.equal((await call(owner.cookie, `/api/admin/families/${fam}/freeze`, { on: false })).status, 200);
  assert.equal((await call(bob.cookie, `/api/circles/${fam}/messages`, { body: 'hello', client_msg_id: 'a3' })).status, 201);
  assert.ok(((await call(owner.cookie, `/api/admin/families/${fam}`)).json.history as any[]).some(h => h.action === 'circle.freeze'));
});

test('staff can remove a member, hand the family to someone else, and keep private notes', async () => {
  assert.equal((await call(owner.cookie, `/api/admin/families/${fam}/remove-member`, { userId: alice.id })).status, 409, 'the owner is handed over first');
  assert.equal((await call(owner.cookie, `/api/admin/families/${fam}/transfer`, { userId: bob.id, reason: 'owner locked out' })).status, 200);
  assert.equal(one('SELECT role FROM circle_members WHERE circle_id = ? AND user_id = ?', fam, bob.id)!.role, 'owner');
  assert.equal(one('SELECT role FROM circle_members WHERE circle_id = ? AND user_id = ?', fam, alice.id)!.role, 'admin');
  assert.equal((await call(owner.cookie, `/api/admin/families/${fam}/remove-member`, { userId: carol.id, reason: 'abuse' })).status, 200);
  assert.equal((await call(owner.cookie, `/api/admin/families/${fam}`)).json.members, 2);
  assert.equal((await call(sup.cookie, '/api/admin/notes', { type: 'user', id: carol.id, body: 'removed from Alice family after a complaint' })).status, 200);
  const person = (await call(sup.cookie, `/api/admin/users/${carol.id}`)).json;
  assert.equal(person.notes[0].body, 'removed from Alice family after a complaint');
  assert.ok(!one("SELECT detail FROM admin_audit WHERE action = 'note.add' ORDER BY id DESC LIMIT 1")!.detail?.includes('complaint'), 'the note text is not copied into the log');
  assert.deepEqual(person.familiesOf, [], 'she is in no family now');
  assert.equal((await call(owner.cookie, '/api/admin/notes', { type: 'user', id: 99999, body: 'x' })).status, 404);
});

test('ban stops a number from coming back; delete needs confirmation and an owner', async () => {
  const dave = await signUp('+971500770007', 'Dave');
  assert.equal((await call(mod.cookie, `/api/admin/users/${dave.id}/ban`, { reason: 'spam' })).status, 200);
  assert.equal((await call(dave.cookie, '/api/me')).status, 401, 'signed out at once');
  assert.notEqual((await call(undefined, '/api/auth/request', { phone: dave.phone })).status, 200, 'cannot ask for a code again');
  assert.equal((await call(owner.cookie, `/api/admin/users/${dave.id}/unban`, {})).status, 200);
  assert.equal((await call(undefined, '/api/auth/request', { phone: dave.phone })).status, 200);

  assert.equal((await call(mod.cookie, `/api/admin/users/${dave.id}/delete`, { confirm: true })).status, 403, 'only the owner erases accounts');
  assert.equal((await call(owner.cookie, `/api/admin/users/${dave.id}/delete`, {})).status, 400, 'confirmation needed');
  assert.equal((await call(owner.cookie, `/api/admin/users/${bob.id}/delete`, { confirm: true })).status, 409, 'owns a family');
  assert.equal((await call(owner.cookie, `/api/admin/users/${dave.id}/delete`, { confirm: true, reason: 'asked to be forgotten' })).status, 200);
  assert.equal(one('SELECT COUNT(*) n FROM users WHERE id = ?', dave.id)!.n, 0);
});

test('the people list filters who needs attention and shows the last active day', async () => {
  await call(owner.cookie, `/api/admin/users/${carol.id}/suspend`, { days: 1 });
  const s = (await call(owner.cookie, '/api/admin/users?filter=suspended')).json as any[];
  assert.deepEqual(s.map(p => p.name), ['Carol']);
  assert.deepEqual(((await call(owner.cookie, '/api/admin/users?filter=staff')).json as any[]).map(p => p.name).sort(), ['Moderator', 'Owner', 'Support']);
  const all = (await call(owner.cookie, '/api/admin/users')).json as any[];
  assert.ok(all.every(p => 'lastActive' in p));
  await call(owner.cookie, `/api/admin/users/${carol.id}/unsuspend`, {});
});

test('a frozen family is read-only for every write: edits, deletes, reactions, pins, archive, join, forwarding; personal actions stay', async () => {
  const f = (await call(alice.cookie, '/api/circles', { name: 'Held', kind: 'circle' })).json.id as number;
  const code2 = one('SELECT invite_code FROM circles WHERE id = ?', f)!.invite_code;
  await call(bob.cookie, '/api/circles/join', { code: code2 });
  const mid = (await call(bob.cookie, `/api/circles/${f}/messages`, { body: 'keep me', client_msg_id: 'fz1' })).json.id as number;
  const other = (await call(bob.cookie, '/api/circles', { name: 'Other', kind: 'circle' })).json.id as number;
  assert.equal((await call(owner.cookie, `/api/admin/families/${f}/freeze`, { on: true, reason: 'dispute' })).status, 200);
  const blocked = async (label: string, r: Promise<{ status: number }>) => assert.equal((await r).status, 423, label);
  await blocked('edit', call(bob.cookie, `/api/messages/${mid}`, { body: 'changed' }, 'PATCH'));
  await blocked('delete', call(bob.cookie, `/api/messages/${mid}`, undefined, 'DELETE'));
  await blocked('react', call(bob.cookie, `/api/messages/${mid}/react`, { emoji: '👍' }));
  await blocked('pin', call(bob.cookie, `/api/messages/${mid}/pin`, {}));
  await blocked('archive a message', call(bob.cookie, `/api/messages/${mid}/archive`, {}));
  await blocked('rename the family', call(alice.cookie, `/api/circles/${f}`, { name: 'x' }, 'PATCH'));
  await blocked('delete the family', call(alice.cookie, `/api/circles/${f}`, undefined, 'DELETE'));
  await blocked('remove a member', call(alice.cookie, `/api/circles/${f}/members/${bob.id}`, undefined, 'DELETE'));
  await blocked('forward into it', call(bob.cookie, `/api/messages/${one('SELECT id FROM messages WHERE circle_id = ? LIMIT 1', other)?.id ?? (await call(bob.cookie, `/api/circles/${other}/messages`, { body: 'src', client_msg_id: 'fz2' })).json.id}/forward`, { circles: [f] }));
  const newcomer = await signUp('+971500770088', 'Newcomer');
  assert.equal((await call(newcomer.cookie, '/api/circles/join', { code: code2 })).status, 423, 'join');
  assert.equal(one('SELECT body FROM messages WHERE id = ?', mid)!.body, 'keep me');
  assert.equal(one('SELECT deleted_at FROM messages WHERE id = ?', mid)!.deleted_at, null, 'nothing was deleted');
  // what stays open: reading, marking read, one's own preferences, reporting
  assert.equal((await call(bob.cookie, `/api/circles/${f}/messages`)).status, 200);
  assert.notEqual((await call(bob.cookie, `/api/circles/${f}/read`, { seq: 1 })).status, 423);
  assert.notEqual((await call(bob.cookie, `/api/circles/${f}/prefs`, { muted: true }, 'PATCH')).status, 423);
  assert.notEqual((await call(alice.cookie, `/api/messages/${mid}/report`, { reason: 'spam' })).status, 423);
  await call(owner.cookie, `/api/admin/families/${f}/freeze`, { on: false });
  assert.equal((await call(bob.cookie, `/api/messages/${mid}/react`, { emoji: '👍' })).status === 423, false);
});

test('the near-the-limit and read-only filters find old families even when hundreds of newer ones exist', async () => {
  const old = (await call(alice.cookie, '/api/circles', { name: 'Old and full', kind: 'circle' })).json.id as number;
  run("INSERT OR REPLACE INTO circle_usage (circle_id, archived_bytes) VALUES (?, ?)", old, 4.5 * 1024 ** 3);   // 90% of the free 5 GB
  const lapsed = (await call(alice.cookie, '/api/circles', { name: 'Old and lapsed', kind: 'circle' })).json.id as number;
  run("INSERT INTO subscriptions (circle_id, plan, status, period_end, provider) VALUES (?, 'family', 'active', date('now', '-30 days'), 'manual')", lapsed);
  for (let i = 0; i < 320; i++) run("INSERT INTO circles (name, owner_id, invite_code, kind) VALUES (?, ?, ?, 'circle')", `Filler ${i}`, alice.id, `fill${i}x`);
  const near = ((await call(owner.cookie, '/api/admin/families?filter=near_quota')).json as any[]).map(f => f.id);
  assert.deepEqual(near, [old]);
  const ro = ((await call(owner.cookie, '/api/admin/families?filter=readonly')).json as any[]).map(f => f.id);
  assert.deepEqual(ro, [lapsed], 'a paid plan 30 days past its last day is read-only');
});
