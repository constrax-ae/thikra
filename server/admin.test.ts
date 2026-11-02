process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+971500660001';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-admin-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { all, one, run } = await import('./db.ts');
const { codeAt, stepNow } = await import('./lib/totp.ts');
const { setStripeFetch } = await import('./lib/stripe.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
const smsCode = async (phone: string) => (await call(undefined, '/api/auth/request', { phone })).json.devCode as string;
async function signUp(phone: string, name: string) {
  const v = await call(undefined, '/api/auth/verify', { phone, code: await smsCode(phone), name });
  return { cookie: v.cookie!, id: (await call(v.cookie, '/api/me')).json.id as number };
}
const audits = () => one('SELECT COUNT(*) n FROM admin_audit')!.n as number;

// People: an owner (by configuration), a moderator, a support agent, ordinary members.
const owner = await signUp('+971500660001', 'Owner');
const mod = await signUp('+971500660002', 'Moderator');
const sup = await signUp('+971500660003', 'Support');
const alice = await signUp('+971500660004', 'Alice');
const bob = await signUp('+971500660005', 'Bob');
assert.equal((await call(owner.cookie, `/api/admin/users/${mod.id}/role`, { role: 'moderator' })).status, 200);
assert.equal((await call(owner.cookie, `/api/admin/users/${sup.id}/role`, { role: 'support' })).status, 200);

test('the owner configured by phone number is an owner; roles decide what each staff member may do', async () => {
  assert.equal(one('SELECT admin_role FROM users WHERE id = ?', owner.id)?.admin_role, 'owner');
  const probe = async (who: { cookie: string }, method: string, path: string, body?: unknown) => (await call(who.cookie, path, body, method)).status;
  // ordinary members: nothing
  for (const p of ['/api/admin/stats', '/api/admin/users', '/api/admin/audit', '/api/admin/reports', '/api/admin/staff']) assert.equal(await probe(alice, 'GET', p), 403, p);
  // support: look people up, nothing else
  assert.equal(await probe(sup, 'GET', '/api/admin/stats'), 200);
  assert.equal(await probe(sup, 'GET', '/api/admin/users'), 200);
  for (const p of ['/api/admin/reports', '/api/admin/audit', '/api/admin/backups', '/api/admin/metrics']) assert.equal(await probe(sup, 'GET', p), 403, `support ${p}`);
  assert.equal(await probe(sup, 'POST', `/api/admin/users/${bob.id}/suspend`, { days: 1 }), 403);
  assert.equal((await call(sup.cookie, `/api/admin/users/${bob.id}?reveal=1`)).status, 403, 'support cannot see a full number');
  // moderator: safety work and the audit log, not backups, metrics or roles
  for (const p of ['/api/admin/reports', '/api/admin/audit', '/api/admin/users', '/api/admin/circles']) assert.equal(await probe(mod, 'GET', p), 200, `moderator ${p}`);
  for (const p of ['/api/admin/backups', '/api/admin/metrics']) assert.equal(await probe(mod, 'GET', p), 403, `moderator ${p}`);
  assert.equal(await probe(mod, 'POST', `/api/admin/users/${bob.id}/role`, { role: 'support' }), 403);
  // owner: everything
  for (const p of ['/api/admin/stats', '/api/admin/metrics', '/api/admin/backups', '/api/admin/audit', '/api/admin/staff']) assert.equal(await probe(owner, 'GET', p), 200, `owner ${p}`);
});

test('the audit log is append-only: the database itself refuses to change or delete a row', async () => {
  await call(owner.cookie, '/api/admin/reports');
  assert.ok(audits() > 0);
  assert.throws(() => run("UPDATE admin_audit SET action = 'nothing happened'"), /append-only/);
  assert.throws(() => run('DELETE FROM admin_audit'), /append-only/);
  const rows = (await call(owner.cookie, '/api/admin/audit')).json as any[];
  assert.ok(rows.length && rows[0].actor === 'Owner' && rows[0].actorRole === 'owner');
  assert.ok(!JSON.stringify(rows).includes('+9715006600'), 'no full phone number in the log');
});

test('every mutating admin route writes an audit row (a new one without a fixture here fails this test)', async () => {
  // A report to act on, a backup to verify.
  const circle = (await call(alice.cookie, '/api/circles', { name: 'Fam', kind: 'circle' })).json.id;
  const code = one('SELECT invite_code FROM circles WHERE id = ?', circle)!.invite_code;
  await call(bob.cookie, '/api/circles/join', { code });
  const msg = (await call(bob.cookie, `/api/circles/${circle}/messages`, { body: 'rude words', client_msg_id: 'm1' })).json.id;
  await call(alice.cookie, `/api/messages/${msg}/report`, { reason: 'abuse', note: 'x' });
  const rid = one('SELECT id FROM reports ORDER BY id DESC LIMIT 1')!.id;
  const backup = (await call(owner.cookie, '/api/admin/backups', {}, 'POST')).json.id;

  const fixtures: Record<string, () => Promise<number>> = {
    'POST /api/admin/reports/:id/resolve': async () => (await call(owner.cookie, `/api/admin/reports/${rid}/resolve`, { resolution: 'ok' })).status,
    'POST /api/admin/reports/:id/action': async () => { const r2 = one("INSERT INTO reports (reporter_id, reported_user_id, circle_id, message_id, reason) VALUES (?, ?, ?, ?, 'spam') RETURNING id", sup.id, bob.id, circle, msg)!.id; return (await call(owner.cookie, `/api/admin/reports/${r2}/action`, { action: 'dismiss' })).status; },
    'POST /api/admin/backups': async () => (await call(owner.cookie, '/api/admin/backups', {}, 'POST')).status,
    'POST /api/admin/backups/:id/verify': async () => (await call(owner.cookie, `/api/admin/backups/${backup}/verify`, {}, 'POST')).status,
    'POST /api/admin/users/:id/suspend': async () => (await call(owner.cookie, `/api/admin/users/${bob.id}/suspend`, { days: 1 })).status,
    'POST /api/admin/users/:id/unsuspend': async () => (await call(owner.cookie, `/api/admin/users/${bob.id}/unsuspend`, {})).status,
    'POST /api/admin/users/:id/revoke-sessions': async () => (await call(owner.cookie, `/api/admin/users/${bob.id}/revoke-sessions`, {})).status,
    'POST /api/admin/users/:id/role': async () => (await call(owner.cookie, `/api/admin/users/${sup.id}/role`, { role: 'support' })).status,
    'POST /api/admin/sms/blocked': async () => (await call(owner.cookie, '/api/admin/sms/blocked', { codes: [] })).status,
    'POST /api/admin/flags/:name': async () => (await call(owner.cookie, '/api/admin/flags/signups_open', { on: true })).status,
    'POST /api/admin/plans/:id': async () => (await call(owner.cookie, '/api/admin/plans/family', { quotaGB: 100, priceMonthly: 1.99, priceYearly: 19.99, currency: 'USD' })).status,
    'POST /api/admin/circles/:id/plan': async () => (await call(owner.cookie, `/api/admin/circles/${circle}/plan`, { bonusGB: 1 })).status,
    'POST /api/admin/support/:id/reply': async () => { const k = one("INSERT INTO support_cases (user_id, subject) VALUES (?, 'x') RETURNING id", alice.id)!.id; return (await call(owner.cookie, `/api/admin/support/${k}/reply`, { body: 'hello' })).status; },
    'POST /api/admin/support/:id/close': async () => { const k = one("INSERT INTO support_cases (user_id, subject) VALUES (?, 'y') RETURNING id", alice.id)!.id; return (await call(owner.cookie, `/api/admin/support/${k}/close`, {})).status; },
    'POST /api/admin/families/:id/freeze': async () => (await call(owner.cookie, `/api/admin/families/${circle}/freeze`, { on: false })).status,
    'POST /api/admin/families/:id/remove-member': async () => (await call(owner.cookie, `/api/admin/families/${circle}/remove-member`, { userId: bob.id })).status,
    'POST /api/admin/families/:id/transfer': async () => { await call(bob.cookie, '/api/circles/join', { code }); return (await call(owner.cookie, `/api/admin/families/${circle}/transfer`, { userId: bob.id })).status; },
    'POST /api/admin/notes': async () => (await call(owner.cookie, '/api/admin/notes', { type: 'user', id: bob.id, body: 'n' })).status,
    'POST /api/admin/users/:id/ban': async () => (await call(owner.cookie, `/api/admin/users/${bob.id}/ban`, {})).status,
    'POST /api/admin/users/:id/unban': async () => (await call(owner.cookie, `/api/admin/users/${bob.id}/unban`, {})).status,
    'POST /api/admin/users/:id/delete': async () => { const x = await signUp('+971500660099', 'Temp'); return (await call(owner.cookie, `/api/admin/users/${x.id}/delete`, { confirm: true })).status; },
    'POST /api/admin/capacity/cost': async () => (await call(owner.cookie, '/api/admin/capacity/cost', { perGB: 0.023 })).status,
    'POST /api/admin/announcements': async () => (await call(owner.cookie, '/api/admin/announcements', { titleAr: 'أ', titleEn: 'a', bodyAr: 'ب', bodyEn: 'b' })).status === 201 ? 200 : 0,
    'POST /api/admin/announcements/:id/cancel': async () => { const id = (await call(owner.cookie, '/api/admin/announcements', { titleAr: 'أ', titleEn: 'a', bodyAr: 'ب', bodyEn: 'b' })).json.id; return (await call(owner.cookie, `/api/admin/announcements/${id}/cancel`, {})).status; },
    'POST /api/admin/broadcasts': async () => (await call(owner.cookie, '/api/admin/broadcasts', { bodyAr: 'أ', bodyEn: 'a', test: true })).status,
    'POST /api/admin/broadcasts/:id/cancel': async () => { const id = (await call(owner.cookie, '/api/admin/broadcasts', { bodyAr: 'أ', bodyEn: 'a', at: new Date(Date.now() + 3600_000).toISOString() })).json.id; return (await call(owner.cookie, `/api/admin/broadcasts/${id}/cancel`, {})).status; },
    'POST /api/admin/maintenance': async () => (await call(owner.cookie, '/api/admin/maintenance', { on: false })).status,
    'POST /api/admin/ops/costs': async () => (await call(owner.cookie, '/api/admin/ops/costs', { hostingUSD: 0, smsEachUSD: 0.05, budgetUSD: 0 })).status,
    'POST /api/admin/ops/app-config': async () => (await call(owner.cookie, '/api/admin/ops/app-config', { minVersion: '', latestVersion: '' })).status,
    'POST /api/admin/backups/:id/restore': async () => (await call(owner.cookie, `/api/admin/backups/${backup}/restore`, { confirm: 'RESTORE' })).status,
    'POST /api/admin/restore/cancel': async () => (await call(owner.cookie, '/api/admin/restore/cancel', {})).status,
    'POST /api/admin/agent/brief': async () => (await call(owner.cookie, '/api/admin/agent/brief', {})).status === 201 ? 200 : 0,
    'POST /api/admin/security/sessions/:id/revoke': async () => { const x = await signUp('+971500660097', 'Temp staff'); run("UPDATE users SET admin_role = 'support', is_admin = 1 WHERE id = ?", x.id); const t = one('SELECT token FROM sessions WHERE user_id = ?', x.id)!.token as string; const st = (await call(owner.cookie, `/api/admin/security/sessions/${t.slice(0, 12)}/revoke`, {})).status; run('DELETE FROM users WHERE id = ?', x.id); return st; },
    'POST /api/admin/security/totp/start': async () => { run('DELETE FROM admin_totp WHERE user_id = ?', owner.id); const st = (await call(owner.cookie, '/api/admin/security/totp/start', {})).status; run('DELETE FROM admin_totp WHERE user_id = ?', owner.id); return st; },
    'POST /api/admin/security/totp/enable': async () => { await call(owner.cookie, '/api/admin/security/totp/start', {}); const secret = one('SELECT secret FROM admin_totp WHERE user_id = ?', owner.id)!.secret as string; const st = (await call(owner.cookie, '/api/admin/security/totp/enable', { code: codeAt(secret, stepNow()) })).status; run('DELETE FROM admin_totp WHERE user_id = ?', owner.id); return st; },
    'POST /api/admin/security/totp/disable': async () => { run('INSERT OR REPLACE INTO admin_totp (user_id, secret, enabled, last_step) VALUES (?, ?, 1, ?)', owner.id, 'JBSWY3DPEHPK3PXP', stepNow() - 5); run('UPDATE sessions SET admin_ok_until = ? WHERE user_id = ?', Date.now() + 60_000, owner.id); const st = (await call(owner.cookie, '/api/admin/security/totp/disable', { code: codeAt('JBSWY3DPEHPK3PXP', stepNow()) })).status; run('DELETE FROM admin_totp WHERE user_id = ?', owner.id); return st; },
    'POST /api/admin/security/verify': async () => { run('INSERT OR REPLACE INTO admin_totp (user_id, secret, enabled, last_step) VALUES (?, ?, 1, ?)', owner.id, 'JBSWY3DPEHPK3PXP', stepNow() - 5); const st = (await call(owner.cookie, '/api/admin/security/verify', { code: codeAt('JBSWY3DPEHPK3PXP', stepNow()) })).status; run('DELETE FROM admin_totp WHERE user_id = ?', owner.id); return st; },
    'POST /api/admin/data-requests/:id/resolve': async () => { const q = one("INSERT INTO data_requests (user_id, kind, due_at) VALUES (?, 'export', datetime('now', '+30 days')) RETURNING id", alice.id)!.id; return (await call(owner.cookie, `/api/admin/data-requests/${q}/resolve`, { status: 'done' })).status; },
    'POST /api/admin/payments/:id/refund': async () => { process.env.STRIPE_SECRET_KEY = 'sk_test_abcdefghijklmnop'; setStripeFetch((async () => new Response(JSON.stringify({ id: 're_x' }), { status: 200 })) as typeof fetch); const q = one("INSERT INTO payments (circle_id, status, amount_cents, stripe_invoice, stripe_payment_intent) VALUES (?, 'paid', 199, 'in_fx', 'pi_fx') RETURNING id", circle)!.id; const st = (await call(owner.cookie, `/api/admin/payments/${q}/refund`, {})).status; delete process.env.STRIPE_SECRET_KEY; return st; },
    'POST /api/admin/circles/:id/cancel-subscription': async () => { process.env.STRIPE_SECRET_KEY = 'sk_test_abcdefghijklmnop'; setStripeFetch((async () => new Response('{}', { status: 200 })) as typeof fetch); run("INSERT OR REPLACE INTO subscriptions (circle_id, plan, status, stripe_subscription) VALUES (?, 'family', 'active', 'sub_fx')", circle); const st = (await call(owner.cookie, `/api/admin/circles/${circle}/cancel-subscription`, {})).status; delete process.env.STRIPE_SECRET_KEY; run('DELETE FROM subscriptions WHERE circle_id = ?', circle); return st; },
    'POST /api/admin/agent/ask': async () => (await call(owner.cookie, '/api/admin/agent/ask', { question: 'summary' })).status,
    'POST /api/admin/agent/proposals/:id/approve': async () => { const q = one("INSERT INTO agent_proposals (kind, args, reason) VALUES ('close_support', '{\"caseId\":1}', 'x') RETURNING id")!.id; one("INSERT INTO support_cases (id, user_id, subject) VALUES (1, ?, 'z') ON CONFLICT(id) DO NOTHING RETURNING id", alice.id); return (await call(owner.cookie, `/api/admin/agent/proposals/${q}/approve`, {})).status; },
    'POST /api/admin/agent/proposals/:id/reject': async () => { const q = one("INSERT INTO agent_proposals (kind, args, reason) VALUES ('close_support', '{\"caseId\":2}', 'x') RETURNING id")!.id; return (await call(owner.cookie, `/api/admin/agent/proposals/${q}/reject`, {})).status; },
    'POST /api/admin/storage-requests/:id/decide': async () => { const q = one("INSERT INTO storage_requests (circle_id, user_id, plan) VALUES (?, ?, 'family') RETURNING id", circle, alice.id)!.id; return (await call(owner.cookie, `/api/admin/storage-requests/${q}/decide`, { grant: false })).status; },
  };
  const mutating = [...new Set(app.routes.filter(r => r.path.startsWith('/api/admin/') && r.method !== 'GET').map(r => `${r.method} ${r.path}`))];
  assert.deepEqual(mutating.sort(), Object.keys(fixtures).sort(), 'every mutating admin route needs a fixture (and so an audit row)');
  for (const key of mutating) {
    const before = audits();
    assert.equal(await fixtures[key](), key === 'POST /api/admin/backups' ? 201 : 200, key);
    assert.ok(audits() > before, `${key} wrote no audit row`);
  }
  await call(owner.cookie, `/api/admin/users/${bob.id}/unsuspend`, {});
});

test('searching and looking people up: numbers are masked, the full number is revealed only on purpose and on record', async () => {
  const byName = (await call(sup.cookie, '/api/admin/users?q=Alice')).json as any[];
  assert.equal(byName.length, 1); assert.equal(byName[0].name, 'Alice');
  assert.ok(!byName[0].phone.includes('50066'), 'masked'); assert.ok(byName[0].phone.endsWith('0004'));
  const byDigits = (await call(sup.cookie, '/api/admin/users?q=0005')).json as any[];
  assert.deepEqual(byDigits.map(u => u.name), ['Bob']);
  const detail = (await call(mod.cookie, `/api/admin/users/${alice.id}`)).json;
  assert.equal(detail.name, 'Alice'); assert.ok(detail.circles >= 1); assert.equal(detail.phoneFull, undefined);
  const before = audits();
  const revealed = (await call(mod.cookie, `/api/admin/users/${alice.id}?reveal=1`)).json;
  assert.equal(revealed.phoneFull, '+971500660004');
  assert.equal(audits(), before + 1);
  assert.equal(one("SELECT action FROM admin_audit ORDER BY id DESC LIMIT 1")?.action, 'user.reveal_phone');
  const logged = all("SELECT detail FROM admin_audit WHERE action = 'users.search'").map(r => r.detail).join('');
  assert.ok(!logged.includes('Alice') && !logged.includes('0005'), 'what was typed in a search is never logged');
});

test('suspending a person ends their sessions at once and blocks sign-in until it is lifted or runs out', async () => {
  const carol = await signUp('+971500660006', 'Carol');
  assert.equal((await call(carol.cookie, '/api/me')).status, 200);
  assert.equal((await call(mod.cookie, `/api/admin/users/${carol.id}/suspend`, { reason: 'spam', days: 2 })).status, 200);
  assert.equal((await call(carol.cookie, '/api/me')).status, 401, 'her old session is gone');
  const login = await call(undefined, '/api/auth/verify', { phone: '+971500660006', code: await smsCode('+971500660006') });
  assert.equal(login.status, 403); assert.equal(login.json.error, 'suspended');
  // a suspension with an end date lifts itself
  run("UPDATE users SET suspended_until = datetime('now', '-1 minute') WHERE id = ?", carol.id);
  const again = await call(undefined, '/api/auth/verify', { phone: '+971500660006', code: await smsCode('+971500660006') });
  assert.equal(again.status, 200);
  // you cannot suspend yourself, and a moderator cannot touch an owner
  assert.equal((await call(mod.cookie, `/api/admin/users/${mod.id}/suspend`, {})).json.error, 'not_yourself');
  assert.equal((await call(mod.cookie, `/api/admin/users/${owner.id}/suspend`, {})).status, 403);
});

test('report decisions: remove a message, suspend, ban (the number is shut out for good), escalate; sealed letters stay protected', async () => {
  const circle = (await call(alice.cookie, '/api/circles', { name: 'Reports', kind: 'circle' })).json.id;
  const code = one('SELECT invite_code FROM circles WHERE id = ?', circle)!.invite_code;
  const dave = await signUp('+971500660007', 'Dave'); await call(dave.cookie, '/api/circles/join', { code });
  const post = async (cmid: string) => (await call(dave.cookie, `/api/circles/${circle}/messages`, { body: `bad ${cmid}`, client_msg_id: cmid })).json.id as number;
  const report = async (mid: number) => { await call(alice.cookie, `/api/messages/${mid}/report`, { reason: 'harassment' }); return one('SELECT id FROM reports ORDER BY id DESC LIMIT 1')!.id as number; };

  const m1 = await post('a'); const r1 = await report(m1);
  assert.equal((await call(mod.cookie, `/api/admin/reports/${r1}/action`, { action: 'nonsense' })).json.error, 'invalid_action');
  assert.equal((await call(mod.cookie, `/api/admin/reports/${r1}/action`, { action: 'remove_message', note: 'harassment' })).json.status, 'resolved');
  assert.equal(one('SELECT body, deleted_at FROM messages WHERE id = ?', m1)?.body, '');
  assert.ok(one('SELECT deleted_at FROM messages WHERE id = ?', m1)?.deleted_at);
  assert.equal((await call(mod.cookie, `/api/admin/reports/${r1}/action`, { action: 'dismiss' })).json.error, 'already_resolved');

  const m2 = await post('b'); const r2 = await report(m2);
  run("UPDATE messages SET sealed_on = '2026-01-01' WHERE id = ?", m2);
  assert.equal((await call(mod.cookie, `/api/admin/reports/${r2}/action`, { action: 'remove_message' })).json.error, 'sealed_protected', 'moderation does not override the sealed-letter rule');

  const m3 = await post('c'); const r3 = await report(m3);
  assert.equal((await call(mod.cookie, `/api/admin/reports/${r3}/action`, { action: 'escalate', note: 'owner please look' })).json.status, 'escalated');
  assert.equal(one('SELECT status FROM reports WHERE id = ?', r3)?.status, 'escalated');
  assert.equal((await call(owner.cookie, `/api/admin/reports/${r3}/action`, { action: 'suspend_user', days: 3 })).json.status, 'resolved');
  assert.equal((await call(dave.cookie, '/api/me')).status, 401);

  const m4 = await post('d').catch(() => 0);   // suspended: cannot post, so make the report row directly
  const r4 = one("INSERT INTO reports (reporter_id, reported_user_id, circle_id, message_id, reason) VALUES (?, ?, ?, ?, 'illegal') RETURNING id", bob.id, dave.id, circle, m1)!.id;
  void m4;
  assert.equal((await call(sup.cookie, `/api/admin/reports/${r4}/action`, { action: 'ban' })).status, 403, 'support cannot act on reports');
  assert.equal((await call(mod.cookie, `/api/admin/reports/${r4}/action`, { action: 'ban', note: 'illegal content' })).json.status, 'resolved');
  const after = await call(undefined, '/api/auth/request', { phone: '+971500660007' });
  assert.equal(after.status, 403); assert.equal(after.json.error, 'account_unavailable');
  assert.equal((await call(undefined, '/api/auth/verify', { phone: '+971500660007', code: '000000' })).status, 403);
  const stored = all('SELECT phone_hash FROM banned_phones').map(r => r.phone_hash).join('');
  assert.ok(!stored.includes('660007'), 'only a hash of the number is kept');
});

test('roles: only an owner changes them, the last owner stays, and a removed staff member loses access and sessions', async () => {
  assert.equal((await call(owner.cookie, `/api/admin/users/${owner.id}/role`, { role: 'support' })).json.error, 'last_owner');
  assert.equal((await call(owner.cookie, `/api/admin/users/${mod.id}/role`, { role: 'wizard' })).json.error, 'invalid_role');
  const eve = await signUp('+971500660008', 'Eve');
  assert.equal((await call(owner.cookie, `/api/admin/users/${eve.id}/role`, { role: 'moderator' })).status, 200);
  assert.equal((await call(eve.cookie, '/api/admin/reports')).status, 200);
  assert.equal((await call(owner.cookie, `/api/admin/users/${eve.id}/role`, { role: null })).status, 200);
  assert.equal((await call(eve.cookie, '/api/admin/reports')).status, 401, 'her sessions ended with the role');
  assert.deepEqual(((await call(owner.cookie, '/api/admin/staff')).json as any[]).map(s => s.role).sort(), ['moderator', 'owner', 'support']);
});

test('extra locks for staff: a PIN is required when asked for, and an address list can shut everyone else out', async () => {
  process.env.THIKRA_ADMIN_REQUIRE_PIN = '1';
  try {
    assert.equal((await call(owner.cookie, '/api/admin/stats')).json.error, 'admin_requires_pin');
    assert.equal((await call(alice.cookie, '/api/admin/stats')).json.error, 'forbidden', 'non-staff are refused before anything else');
    assert.equal((await call(owner.cookie, '/api/me/pin', { pin: '123456' })).status, 200);
    assert.equal((await call(owner.cookie, '/api/admin/stats')).status, 200);
  } finally { delete process.env.THIKRA_ADMIN_REQUIRE_PIN; }
  process.env.THIKRA_ADMIN_IPS = '10.9.9.9';
  try { assert.equal((await call(owner.cookie, '/api/admin/stats')).status, 403, 'this caller is not on the list'); }
  finally { delete process.env.THIKRA_ADMIN_IPS; }
  assert.equal((await call(owner.cookie, '/api/admin/stats')).status, 200);
});
