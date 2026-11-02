process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+971500110001';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-sec-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { one, run } = await import('./db.ts');
const { codeAt, stepNow, unbase32, base32 } = await import('./lib/totp.ts');
const { digest } = await import('./lib/opsagent.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), text: undefined as string | undefined, cookie: res.headers.get('set-cookie')?.split(';')[0], res };
};
const login = async (phone: string, name: string) => {
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode as string;
  const v = await call(undefined, '/api/auth/verify', { phone, code, name });
  return { cookie: v.cookie!, id: (await call(v.cookie, '/api/me')).json.id as number, phone };
};
const owner = await login('+971500110001', 'Owner');
const mod = await login('+971500110002', 'Moderator');
const sup = await login('+971500110003', 'Support');
let sara = await login('+971500110004', '=SUM(1)');
await call(owner.cookie, `/api/admin/users/${mod.id}/role`, { role: 'moderator' });
await call(owner.cookie, `/api/admin/users/${sup.id}/role`, { role: 'support' });

test('the one-time code algorithm matches the RFC 6238 test vector', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(unbase32(secret).toString(), '12345678901234567890');
  assert.equal(codeAt(secret, Math.floor(59 / 30)), '287082');          // 6-digit tail of the standard's 94287082
  assert.equal(codeAt(secret, Math.floor(1111111109 / 30)), '081804');   // 07081804
});

test('with an authenticator on, a new session is locked until a valid code; a code works once; a wrong one is refused', async () => {
  const st = await call(owner.cookie, '/api/admin/security/status');
  assert.equal(st.json.totp, false);
  const start = (await call(owner.cookie, '/api/admin/security/totp/start', {})).json;
  assert.match(start.uri, /^otpauth:\/\/totp\//);
  assert.equal((await call(owner.cookie, '/api/admin/security/totp/enable', { code: '000000' })).status, 400, 'a wrong first code does not switch it on');
  const secret = one('SELECT secret FROM admin_totp WHERE user_id = ?', owner.id)!.secret as string;
  assert.equal((await call(owner.cookie, '/api/admin/security/totp/enable', { code: codeAt(secret, stepNow()) })).status, 200);
  assert.equal((await call(owner.cookie, '/api/admin/stats')).status, 200, 'the session that proved the code stays open');

  const again = await login('+971500110001', 'Owner');   // a second device or a stolen cookie
  assert.equal((await call(again.cookie, '/api/admin/stats')).json.error, 'admin_totp_required');
  assert.equal((await call(again.cookie, '/api/admin/security/verify', { code: '123456' })).status, 400);
  const good = codeAt(secret, stepNow() + 1);
  assert.equal((await call(again.cookie, '/api/admin/security/verify', { code: good })).status, 200);
  assert.equal((await call(again.cookie, '/api/admin/stats')).status, 200);
  const third = await login('+971500110001', 'Owner');
  assert.equal((await call(third.cookie, '/api/admin/security/verify', { code: good })).status, 400, 'the same code cannot be used twice');
  assert.equal((await call(third.cookie, '/api/admin/stats')).json.error, 'admin_totp_required');
  assert.ok(Number(one("SELECT COUNT(*) n FROM admin_audit WHERE action = 'security.verify_failed'")!.n) >= 2, 'failed checks are on record');

  // staff sessions: listed, and endable by the owner
  const list = (await call(owner.cookie, '/api/admin/security/sessions')).json as any[];
  assert.ok(list.some(s => s.current) && list.some(s => s.name === 'Owner' && !s.current));
  const other = list.find(s => !s.current && s.name === 'Owner')!;
  assert.equal((await call(mod.cookie, '/api/admin/security/sessions')).status, 403);
  assert.equal((await call(owner.cookie, `/api/admin/security/sessions/${other.id}/revoke`, {})).status, 200);
  assert.equal((await call(owner.cookie, '/api/admin/security/sessions/nothexadecimal/revoke', {})).status, 400);

  // switching it off needs a code
  assert.equal((await call(owner.cookie, '/api/admin/security/totp/disable', { code: '111111' })).status, 400);
  run('UPDATE admin_totp SET last_step = ? WHERE user_id = ?', stepNow() - 5, owner.id);   // (a fresh step: the clock cannot be moved in a test)
  assert.equal((await call(owner.cookie, '/api/admin/security/totp/disable', { code: codeAt(secret, stepNow()) })).status, 200);
  assert.equal(one('SELECT COUNT(*) n FROM admin_totp WHERE user_id = ?', owner.id)!.n, 0, 'off again');
  assert.equal((await call(owner.cookie, '/api/admin/stats')).status, 200);
});

test('a policy can require every staff member to use the authenticator', async () => {
  process.env.THIKRA_ADMIN_REQUIRE_TOTP = '1';
  assert.equal((await call(mod.cookie, '/api/admin/stats')).json.error, 'admin_requires_totp');
  assert.equal((await call(mod.cookie, '/api/admin/security/status')).status, 200, 'but the way to switch it on stays open');
  delete process.env.THIKRA_ADMIN_REQUIRE_TOTP;
  assert.equal((await call(mod.cookie, '/api/admin/stats')).status, 200);
});

test('the audit log leaves as a CSV with formulas defused, only for staff who may read it, and taking it is on record', async () => {
  await call(owner.cookie, `/api/admin/users/${sara.id}/suspend`, { days: 1 });
  const res = await app.request('/api/admin/audit/export', { headers: { cookie: owner.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /id,time_utc,actor,role,action,target_type,target_id,detail/);
  assert.match(csv, /"user.suspend"/);
  assert.ok(!/(^|,)"[=+@-]/m.test(csv.split('\n').slice(1).join('\n')), 'no cell starts like a formula');
  assert.equal((await app.request('/api/admin/audit/export', { headers: { cookie: sup.cookie } })).status, 403);
  assert.ok(Number(one("SELECT COUNT(*) n FROM admin_audit WHERE action = 'audit.export'")!.n) >= 1);
  await call(owner.cookie, `/api/admin/users/${sara.id}/unsuspend`, {});
});

test('people can ask for their data or its erasure; the team sees what is late; answering is on record', async () => {
  sara.cookie = (await login('+971500110004', '=SUM(1)')).cookie;   // suspending earlier ended her sessions
  assert.equal((await call(sara.cookie, '/api/me/data-requests', { kind: 'nonsense' })).status, 400);
  const made = await call(sara.cookie, '/api/me/data-requests', { kind: 'delete', note: 'please erase everything' });
  assert.equal(made.status, 201); assert.equal(made.json.dueDays, 30);
  assert.equal((await call(sara.cookie, '/api/me/data-requests', { kind: 'delete' })).status, 409, 'one open request per kind');
  assert.equal((await call(sup.cookie, '/api/admin/data-requests')).status, 403);
  const open = ((await call(mod.cookie, '/api/admin/data-requests')).json as any[]).find(r => r.id === made.json.id)!;
  assert.equal(open.overdue, false);
  run("UPDATE data_requests SET due_at = datetime('now', '-1 day') WHERE id = ?", made.json.id);
  assert.equal(((await call(mod.cookie, '/api/admin/data-requests')).json as any[]).find(r => r.id === made.json.id).overdue, true);
  assert.ok((await digest()).items.some(i => i.code === 'data_requests' && i.sev === 'high'), 'late requests reach the daily list as serious');
  assert.equal((await call(mod.cookie, `/api/admin/data-requests/${made.json.id}/resolve`, { status: 'done', response: 'erased on request' })).status, 200);
  assert.equal((await call(mod.cookie, `/api/admin/data-requests/${made.json.id}/resolve`, { status: 'done' })).status, 404, 'answered once');
  const mine = (await call(sara.cookie, '/api/me/data-requests')).json as any[];
  assert.equal(mine[0].status, 'done'); assert.equal(mine[0].response, 'erased on request');
});

test('putting an authenticator on the account asks for the account PIN, so a stolen signed-in screen cannot lock the owner out', async () => {
  const boss = await login('+971500110010', 'Boss');
  await call(owner.cookie, `/api/admin/users/${boss.id}/role`, { role: 'moderator' });
  assert.equal((await call(boss.cookie, '/api/me/pin', { pin: '482915' })).status, 200);
  assert.equal((await call(boss.cookie, '/api/admin/security/totp/start', {})).json.error, 'wrong_pin');
  assert.equal((await call(boss.cookie, '/api/admin/security/totp/start', { pin: '000000' })).status, 400);
  const start = await call(boss.cookie, '/api/admin/security/totp/start', { pin: '482915' });
  assert.equal(start.status, 200);
  const secret = one('SELECT secret FROM admin_totp WHERE user_id = ?', boss.id)!.secret as string;
  assert.equal((await call(boss.cookie, '/api/admin/security/totp/enable', { code: codeAt(secret, stepNow()) })).json.error, 'wrong_pin', 'the right code alone is not enough');
  assert.equal((await call(boss.cookie, '/api/admin/security/totp/enable', { code: codeAt(secret, stepNow()), pin: '482915' })).status, 200);
});
