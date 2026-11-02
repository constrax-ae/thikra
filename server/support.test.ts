process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-support-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { run, one } = await import('./db.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
let n = 0;
async function signUp(name: string, role?: string) {
  const phone = `+9665${String(6_000_000 + n++).padStart(8, '0')}`;
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode;
  const v = await app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code, name }) });
  if (role) run("UPDATE users SET admin_role = ?, is_admin = 1 WHERE phone = ?", role, phone);
  return { cookie: v.headers.get('set-cookie')!.split(';')[0], phone };
}

await signUp('الأول');   // in development the very first person to sign up becomes the owner: keep that out of the way

test('support: a person writes to the team and sees only their own cases; staff of every role answer; reading and answering are on the record', async () => {
  const a = await signUp('سلمى'), b = await signUp('هدى'), staff = await signUp('دعم', 'support'), owner = await signUp('مالك', 'owner');
  assert.equal((await call(undefined, '/api/support')).status, 401);
  assert.equal((await call(a.cookie, '/api/support', { subject: '', body: 'x' })).status, 400);
  const made = await call(a.cookie, '/api/support', { subject: 'لا يصلني الرمز', body: 'جرّبت ثلاث مرات' });
  assert.equal(made.status, 201);
  const id = made.json.id;
  assert.equal((await call(b.cookie, '/api/support')).json.length, 0, 'another person sees none');
  assert.equal((await call(b.cookie, `/api/support/${id}/reply`, { body: 'أنا لست صاحبة الطلب' })).status, 404, 'nor can they write into it');
  const mine = (await call(a.cookie, '/api/support')).json;
  assert.equal(mine[0].status, 'open'); assert.equal(mine[0].messages[0].body, 'جرّبت ثلاث مرات');

  assert.equal((await call(a.cookie, '/api/admin/support')).status, 403, 'a plain user is not staff');
  const list = (await call(staff.cookie, '/api/admin/support?status=open')).json;
  assert.equal(list.length, 1); assert.equal(list[0].person, 'سلمى');
  assert.ok(!list[0].phone.includes('5600'), 'the number is masked for staff');
  const templates = (await call(staff.cookie, '/api/admin/support/templates')).json;
  assert.ok(templates.length >= 4 && templates.every((t: any) => t.ar && t.en));

  const before = Number(one('SELECT COUNT(*) AS n FROM admin_audit')!.n);
  const detail = (await call(staff.cookie, `/api/admin/support/${id}`)).json;
  assert.equal(detail.messages.length, 1);
  assert.equal(Number(one('SELECT COUNT(*) AS n FROM admin_audit')!.n), before + 1, 'reading a person\'s message is audited');
  assert.equal((await call(staff.cookie, `/api/admin/support/${id}/reply`, { body: '' })).status, 400);
  assert.equal((await call(staff.cookie, `/api/admin/support/${id}/reply`, { body: templates[3].ar })).status, 200);
  assert.equal(one('SELECT COUNT(*) AS n FROM admin_audit WHERE action = ?', 'support.reply')!.n, 1);
  assert.ok(!JSON.stringify(one("SELECT detail FROM admin_audit WHERE action = 'support.reply'")).includes('رمز'), 'the answer text is not copied into the audit log');
  const seen = (await call(a.cookie, '/api/support')).json[0];
  assert.equal(seen.status, 'answered'); assert.equal(seen.messages[1].fromStaff, 1);

  // writing again reopens it; the owner can close it; a closed case does not count toward the limit
  assert.equal((await call(a.cookie, `/api/support/${id}/reply`, { body: 'ما زال لا يصل' })).status, 201);
  assert.equal((await call(a.cookie, '/api/support')).json[0].status, 'open');
  assert.equal((await call(owner.cookie, `/api/admin/support/${id}/close`, {})).status, 200);
  assert.equal((await call(a.cookie, '/api/support')).json[0].status, 'closed');
  assert.equal((await call(owner.cookie, '/api/admin/support/99999/close', {})).status, 404);
});

test('support: at most three open cases per person', async () => {
  const a = await signUp('كثيرة');
  for (let i = 0; i < 3; i++) assert.equal((await call(a.cookie, '/api/support', { subject: `طلب ${i}`, body: 'نص' })).status, 201);
  assert.equal((await call(a.cookie, '/api/support', { subject: 'رابع', body: 'نص' })).json.error, 'too_many_open');
});

test('support: when staff answer, the person is notified on their devices (that there is an answer, never its text)', async () => {
  const { setTransport } = await import('./push.ts');
  const sent: any[] = [];
  setTransport(async (_sub, payload) => { sent.push(JSON.parse(payload)); });
  try {
    const person = await signUp('تستلم'), staff = await signUp('موظف', 'support');
    await call(person.cookie, '/api/push/subscribe', { endpoint: 'https://push.test/abc', keys: { p256dh: 'p', auth: 'a' } });
    const id = (await call(person.cookie, '/api/support', { subject: 'موضوع', body: 'نص طلبي السري' })).json.id;
    await call(staff.cookie, `/api/admin/support/${id}/reply`, { body: 'ردّنا السري عليك' });
    await new Promise(r => setTimeout(r, 80));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, '/#/you'); assert.match(sent[0].body, /ذكرى/);
    assert.ok(!JSON.stringify(sent[0]).includes('السري'), 'the answer\'s text never goes in a notification');
  } finally { setTransport(null); }
});
