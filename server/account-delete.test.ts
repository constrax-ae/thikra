process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-del-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { one, run } = await import('./db.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
let n = 0;
async function signUp(name: string, role?: string) {
  const phone = `+9665${String(3_000_000 + n++).padStart(8, '0')}`;
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode;
  const v = await app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code, name }) });
  if (role) run("UPDATE users SET admin_role = ?, is_admin = 1 WHERE phone = ?", role, phone);
  return { cookie: v.headers.get('set-cookie')!.split(';')[0], id: Number(one('SELECT id FROM users WHERE phone = ?', phone)!.id) };
}
await signUp('الأول');   // in development the very first person to sign up becomes the owner: keep that out of the way

test('deleting an account works after a person has used every part of the app, and leaves no row pointing at them', async () => {
  const host = await signUp('المضيف'), guest = await signUp('الضيف', 'moderator');
  const circle = (await call(host.cookie, '/api/circles', { name: 'عائلة' })).json.id;
  const code = (await call(host.cookie, `/api/circles/${circle}`)).json.inviteCode;
  await call(guest.cookie, '/api/circles/join', { code });
  await call(host.cookie, `/api/circles/${circle}/members/${guest.id}`, { role: 'admin' }, 'PATCH');

  // the guest touches everything: messages, an album, a sealed letter, a support case, a storage request, a story edit, and staff work that is audited
  await call(guest.cookie, `/api/circles/${circle}/messages`, { body: 'مرحبا', client_msg_id: 'g1' });
  await call(guest.cookie, `/api/circles/${circle}/albums`, { title: 'ألبوم', source: 'manual' });
  await call(guest.cookie, `/api/circles/${circle}/sealed`, { body: 'لاحقاً', trigger: 'date', unlockAt: new Date(Date.now() + 40 * 86400_000).toISOString() });
  await call(guest.cookie, '/api/support', { subject: 'سؤال', body: 'نص' });
  await call(guest.cookie, `/api/circles/${circle}/storage-request`, { plan: 'family' });
  run("INSERT INTO archive_entries (circle_id, title, summary, category, event_date, source, kind) VALUES (?, 'حدث', 'x', 'birth', '2026-02-01', 'manual', 'event')", circle);
  await call(guest.cookie, `/api/circles/${circle}/story/2026/1`, { title: 'عنوان', text: 'نص', lang: 'ar' }, 'PUT');
  assert.equal((await call(guest.cookie, '/api/admin/support')).status, 200, 'a moderator is staff');
  const caseId = (await call(guest.cookie, '/api/support')).json[0].id;
  assert.equal((await call(guest.cookie, `/api/admin/support/${caseId}/close`, {})).status, 200);
  assert.ok(Number(one('SELECT COUNT(*) AS n FROM admin_audit WHERE actor_id = ?', guest.id)!.n) > 0, 'the staff action is in the audit log');

  const res = await call(guest.cookie, '/api/me', undefined, 'DELETE');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(one('SELECT 1 FROM users WHERE id = ?', guest.id), undefined);
  for (const [table, col] of [['circle_members', 'user_id'], ['support_cases', 'user_id'], ['sealed_messages', 'author_id'], ['messages', 'user_id']] as const) {
    assert.equal(Number(one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, guest.id)!.n), 0, `${table} still points at the deleted person`);
  }
  assert.equal(one('SELECT created_by FROM albums WHERE circle_id = ?', circle)!.created_by, null, 'the album stays for the family, no longer tied to the person');
  assert.ok(Number(one('SELECT COUNT(*) AS n FROM admin_audit')!.n) > 0, 'the audit log is never erased');
});
