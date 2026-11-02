import { all, one, run } from '../db.ts';
import { app, sha } from '../app.ts';
import { audit, requireAdmin } from '../lib/admin.ts';
import { limited } from '../lib/helpers.ts';
import { tryPin } from '../lib/pin.ts';
import { newSecret, otpauthUri, verifyCode } from '../lib/totp.ts';
import { getCookie } from 'hono/cookie';
import { csvResponse, toCsv } from '../lib/csv.ts';

// Staff security (ADMIN-PLAN slice 6): an authenticator app for the admin screen, the list of staff sessions, and the audit log as a file.
const STEP_UP_MS = 30 * 60_000;
const json = (c: { req: { json(): Promise<any> } }) => c.req.json().catch(() => ({}));
const mySession = (c: any) => { const t = getCookie(c, 'thikra_session'); return t ? sha(t) : null; };
const noStep = { stepUp: false } as const;

app.get('/api/admin/security/status', requireAdmin('stats', noStep), c => {
  const u = c.get('user');
  const t = one('SELECT enabled FROM admin_totp WHERE user_id = ?', u.id);
  const sess = mySession(c);
  const ok = sess ? Number(one('SELECT admin_ok_until n FROM sessions WHERE token = ?', sess)?.n ?? 0) : 0;
  return c.json({ totp: !!t?.enabled, pending: !!t && !t.enabled, verified: ok > Date.now(), verifiedUntil: ok > Date.now() ? ok : null, pin: !!u.has_pin, required: process.env.THIKRA_ADMIN_REQUIRE_TOTP === '1' });
});

/** Step 1: a new secret, shown once as text and as an otpauth link (the screen draws no QR code: a typed key works in every authenticator app). Not active until a code proves it works. */
/** A signed-in screen alone must not be able to put a second factor on the account (a stolen session would lock the owner out): the account's own PIN is asked for, when there is one. */
const pinOk = (u: Record<string, any>, pin: unknown) => { if (!u.has_pin) return { ok: true as const }; const r = tryPin(u.id, pin); return r.ok ? { ok: true as const } : { ok: false as const, error: r.error }; };
app.post('/api/admin/security/totp/start', requireAdmin('stats', noStep), async c => {
  const u = c.get('user');
  const gate = pinOk(u, (await json(c)).pin);
  if (!gate.ok) return c.json({ error: gate.error }, 400);
  if (one('SELECT 1 FROM admin_totp WHERE user_id = ? AND enabled = 1', u.id)) return c.json({ error: 'already_enabled' }, 409);
  const secret = newSecret();
  run('INSERT INTO admin_totp (user_id, secret, enabled) VALUES (?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled = 0, last_step = 0', u.id, secret);
  audit(c, 'security.totp_start', { type: 'user', id: u.id });
  return c.json({ secret, uri: otpauthUri(secret, u.name || `staff-${u.id}`) });
});
/** Step 2: the first code from the app switches it on (and counts as verified for this session). */
app.post('/api/admin/security/totp/enable', requireAdmin('stats', noStep), async c => {
  const u = c.get('user');
  if (await limited(`totp:${u.id}`, 8, 10 * 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const row = one('SELECT secret, last_step FROM admin_totp WHERE user_id = ? AND enabled = 0', u.id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const body = await json(c);
  const gate = pinOk(u, body.pin);
  if (!gate.ok) return c.json({ error: gate.error }, 400);
  const step = verifyCode(row.secret, body.code, Number(row.last_step));
  if (step === null) return c.json({ error: 'wrong_code' }, 400);
  run('UPDATE admin_totp SET enabled = 1, last_step = ? WHERE user_id = ?', step, u.id);
  const sess = mySession(c); if (sess) run('UPDATE sessions SET admin_ok_until = ? WHERE token = ?', Date.now() + STEP_UP_MS, sess);
  audit(c, 'security.totp_enable', { type: 'user', id: u.id });
  return c.json({ ok: true });
});
/** Prove it is you now: a valid code opens the admin screen on this session for 30 minutes. */
app.post('/api/admin/security/verify', requireAdmin('stats', noStep), async c => {
  const u = c.get('user');
  if (await limited(`totp:${u.id}`, 8, 10 * 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const row = one('SELECT secret, last_step FROM admin_totp WHERE user_id = ? AND enabled = 1', u.id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const step = verifyCode(row.secret, (await json(c)).code, Number(row.last_step));
  if (step === null) { audit(c, 'security.verify_failed', { type: 'user', id: u.id }); return c.json({ error: 'wrong_code' }, 400); }
  run('UPDATE admin_totp SET last_step = ? WHERE user_id = ?', step, u.id);
  const sess = mySession(c); if (sess) run('UPDATE sessions SET admin_ok_until = ? WHERE token = ?', Date.now() + STEP_UP_MS, sess);
  audit(c, 'security.verify', { type: 'user', id: u.id });
  return c.json({ ok: true, until: Date.now() + STEP_UP_MS });
});
/** Switching it off needs a current code (so a stolen signed-in screen cannot remove the lock). */
app.post('/api/admin/security/totp/disable', requireAdmin('stats'), async c => {
  const u = c.get('user');
  const row = one('SELECT secret, last_step FROM admin_totp WHERE user_id = ? AND enabled = 1', u.id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const step = verifyCode(row.secret, (await json(c)).code, Number(row.last_step));
  if (step === null) return c.json({ error: 'wrong_code' }, 400);
  run('DELETE FROM admin_totp WHERE user_id = ?', u.id);
  audit(c, 'security.totp_disable', { type: 'user', id: u.id });
  return c.json({ ok: true });
});

// ---- staff sessions ---------------------------------------------------------------------------------------------------------------
/** Every live session of every staff member: who, since when, from what browser, and whether it passed the code check. The id is the first 12 characters of the token's hash. */
app.get('/api/admin/security/sessions', requireAdmin('roles'), c => {
  const mine = mySession(c);
  return c.json(all("SELECT s.token, s.user_id AS userId, u.name, u.admin_role AS role, s.created_at AS createdAt, s.user_agent AS agent, s.admin_ok_until AS okUntil FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.admin_role IS NOT NULL AND s.expires_at > ? ORDER BY s.rowid DESC LIMIT 100", Date.now())
    .map(r => ({ id: String(r.token).slice(0, 12), userId: r.userId, name: r.name, role: r.role, createdAt: r.createdAt, agent: r.agent, verified: Number(r.okUntil ?? 0) > Date.now(), current: r.token === mine })));
});
app.post('/api/admin/security/sessions/:id/revoke', requireAdmin('roles'), c => {
  const id = String(c.req.param('id'));
  if (!/^[0-9a-f]{12}$/.test(id)) return c.json({ error: 'invalid_value' }, 400);
  const row = one("SELECT s.token, s.user_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token LIKE ? AND u.admin_role IS NOT NULL", `${id}%`);
  if (!row) return c.json({ error: 'not_found' }, 404);
  run('DELETE FROM sessions WHERE token = ?', row.token);
  audit(c, 'security.session_revoke', { type: 'user', id: row.user_id });
  return c.json({ ok: true });
});

// ---- the audit log as a file ------------------------------------------------------------------------------------------------------
/** CSV of the audit log (newest first, up to 5000 rows, optionally from a date). Cells that start like a formula are defused. Taking the file is itself written in the log. */
app.get('/api/admin/audit/export', requireAdmin('audit'), c => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('from') ?? '') ? c.req.query('from')! : '1970-01-01';
  const rows = all("SELECT a.id, a.created_at, u.name AS actor, a.actor_role, a.action, a.target_type, a.target_id, a.detail FROM admin_audit a LEFT JOIN users u ON u.id = a.actor_id WHERE date(a.created_at) >= ? ORDER BY a.id DESC LIMIT 5000", from);
  const csv = toCsv(['id', 'time_utc', 'actor', 'role', 'action', 'target_type', 'target_id', 'detail'], rows.map(r => [r.id, r.created_at, r.actor, r.actor_role, r.action, r.target_type, r.target_id, r.detail]));
  audit(c, 'audit.export', { type: 'audit', id: 'csv' }, { rows: rows.length, from });
  return new Response('﻿' + csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="thekra-audit-${new Date().toISOString().slice(0, 10)}.csv"` } });
});

// ---- people's requests about their data ------------------------------------------------------------------------------------------
const DAYS = 30;
app.post('/api/me/data-requests', async c => {
  const u = c.get('user');
  const b = await json(c);
  const kind = b.kind === 'delete' ? 'delete' : b.kind === 'export' ? 'export' : null;
  if (!kind) return c.json({ error: 'invalid_value' }, 400);
  if (one("SELECT 1 FROM data_requests WHERE user_id = ? AND kind = ? AND status = 'open'", u.id, kind)) return c.json({ error: 'already_requested' }, 409);
  if (await limited(`datareq:${u.id}`, 5, 24 * 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) || null : null;
  const id = Number(run("INSERT INTO data_requests (user_id, kind, note, due_at) VALUES (?, ?, ?, datetime('now', ?))", u.id, kind, note, `+${DAYS} days`).lastInsertRowid);
  return c.json({ id, dueDays: DAYS }, 201);
});
app.get('/api/me/data-requests', c => c.json(all('SELECT id, kind, status, due_at AS dueAt, created_at AS createdAt, handled_at AS handledAt, response FROM data_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20', c.get('user').id)));

app.get('/api/admin/data-requests', requireAdmin('users.act'), c => c.json(all("SELECT r.id, r.kind, r.status, r.note, r.due_at AS dueAt, r.created_at AS createdAt, r.handled_at AS handledAt, u.id AS userId, u.name, (r.status = 'open' AND r.due_at < datetime('now')) AS overdue FROM data_requests r JOIN users u ON u.id = r.user_id ORDER BY (r.status = 'open') DESC, r.due_at LIMIT 100").map(r => ({ ...r, overdue: !!r.overdue }))));
app.post('/api/admin/data-requests/:id/resolve', requireAdmin('users.act'), async c => {
  const id = Number(c.req.param('id'));
  const b = await json(c);
  const status = b.status === 'rejected' ? 'rejected' : b.status === 'done' ? 'done' : null;
  if (!status) return c.json({ error: 'invalid_value' }, 400);
  const response = typeof b.response === 'string' ? b.response.trim().slice(0, 500) || null : null;
  if (!Number(run("UPDATE data_requests SET status = ?, response = ?, handled_by = ?, handled_at = datetime('now') WHERE id = ? AND status = 'open'", status, response, c.get('user').id, id).changes)) return c.json({ error: 'not_found' }, 404);
  audit(c, 'data_request.resolve', { type: 'data_request', id }, { status });
  return c.json({ ok: true });
});
