import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { createBackup, listBackups, pruneBackups, verifyBackup } from '../backup.ts';
import { offsite, status as offsiteStatus } from '../offsite-store.ts';
import { online } from '../live.ts';
import { activityWindows, statsSeries, totals } from '../lib/rollups.ts';
import { ROLES, audit, notesOf, can, endSessions, isBanned, maskPhone, phoneHash, requireAdmin, roleOf, staff, type Role } from '../lib/admin.ts';
import { eraseMessage } from '../lib/deletes.ts';
import { smsInfo } from '../lib/auth.ts';
import { FLAGS, blockedCodes, flag, isFlag, setBlockedCodes, setFlag, type FlagName } from '../lib/ops.ts';
import { sentTodayCount } from '../sms.ts';
import { snapshot } from '../metrics.ts';

const json = (c: { req: { json(): Promise<any> } }) => c.req.json().catch(() => ({}));
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

app.get('/api/admin/stats', requireAdmin('stats'), c => c.json(totals()));

// Admin sees circle metadata only, never message content.
// Reports sent by members. This is the one place an admin sees message text, and only the text of reported messages: so every look is audited.
app.get('/api/admin/reports', requireAdmin('reports'), c => {
  const rows = all(
    `SELECT r.id, r.reason, r.note, r.snapshot, r.status, r.resolution, r.action, r.created_at AS createdAt, r.resolved_at AS resolvedAt, r.message_id AS messageId, r.circle_id AS circleId,
            r.reported_user_id AS reportedUserId, ru.name AS reporter, tu.name AS reported, rb.name AS resolvedBy
       FROM reports r LEFT JOIN users ru ON ru.id = r.reporter_id LEFT JOIN users tu ON tu.id = r.reported_user_id LEFT JOIN users rb ON rb.id = r.resolved_by
      ORDER BY r.status = 'resolved', r.status = 'open' DESC, r.id DESC LIMIT 200`);
  audit(c, 'reports.view', { type: 'reports', id: 'list' }, { count: rows.length });
  return c.json(rows);
});

// The older single action ("resolve with a note"): kept for clients that use it.
app.post('/api/admin/reports/:id/resolve', requireAdmin('reports.act'), async c => {
  const b = await json(c);
  const id = Number(c.req.param('id'));
  const r = run("UPDATE reports SET status = 'resolved', action = 'dismiss', resolution = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ? AND status != 'resolved'", text(b.resolution, 500) || null, c.get('user').id, id);
  if (!Number(r.changes)) return c.json({ error: 'not_found' }, 404);
  audit(c, 'report.resolve', { type: 'report', id });
  return c.json({ ok: true });
});

const ACTIONS = ['dismiss', 'warn', 'remove_message', 'suspend_user', 'ban', 'escalate'] as const;
/** The moderator's decision on a report. Each decision is one audited step; the ones that touch a person need the user-moderation permission as well. */
app.post('/api/admin/reports/:id/action', requireAdmin('reports.act'), async c => {
  const b = await json(c);
  const id = Number(c.req.param('id'));
  const action = String(b.action ?? '') as typeof ACTIONS[number];
  if (!ACTIONS.includes(action)) return c.json({ error: 'invalid_action' }, 400);
  const me = c.get('user');
  const rep = one('SELECT id, status, message_id, reported_user_id, circle_id FROM reports WHERE id = ?', id);
  if (!rep) return c.json({ error: 'not_found' }, 404);
  if (rep.status === 'resolved') return c.json({ error: 'already_resolved' }, 409);
  const note = text(b.note, 500) || null;
  const detail: Record<string, unknown> = { reportId: id, reportedUserId: rep.reported_user_id, messageId: rep.message_id };

  if (action === 'remove_message') {
    const m = rep.message_id && one('SELECT id, circle_id, deleted_at, sealed_on FROM messages WHERE id = ?', rep.message_id);
    if (!m) return c.json({ error: 'message_gone' }, 409);
    // An opened sealed letter belongs to the family's memory and only its author may erase it (owner's rule): moderation does not override it.
    if (m.sealed_on) return c.json({ error: 'sealed_protected' }, 409);
    if (!m.deleted_at) await eraseMessage(m, null);
  }
  if (action === 'suspend_user' || action === 'ban') {
    if (!can(me, 'users.act')) return c.json({ error: 'forbidden' }, 403);
    const target = rep.reported_user_id && one('SELECT id, phone, admin_role FROM users WHERE id = ?', rep.reported_user_id);
    if (!target) return c.json({ error: 'user_gone' }, 409);
    if (target.id === me.id) return c.json({ error: 'not_yourself' }, 400);
    if (target.admin_role === 'owner' && roleOf(me) !== 'owner') return c.json({ error: 'forbidden' }, 403);
    if (action === 'ban') {
      run('INSERT OR IGNORE INTO banned_phones (phone_hash, reason, banned_by) VALUES (?, ?, ?)', phoneHash(target.phone), note, me.id);
      run("UPDATE users SET suspended_at = datetime('now'), suspended_until = NULL, suspended_reason = ? WHERE id = ?", note ?? 'banned', target.id);
    } else {
      const days = Number(b.days);
      run("UPDATE users SET suspended_at = datetime('now'), suspended_until = CASE WHEN ? > 0 THEN datetime('now', '+' || ? || ' days') END, suspended_reason = ? WHERE id = ?", days > 0 ? Math.min(days, 3650) : 0, days > 0 ? Math.min(days, 3650) : 0, note, target.id);
      detail.days = days > 0 ? Math.min(days, 3650) : null;
    }
    endSessions(target.id);
  }
  const status = action === 'escalate' ? 'escalated' : 'resolved';
  run(`UPDATE reports SET status = ?, action = ?, resolution = ?, resolved_by = ?, resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') END WHERE id = ?`, status, action, note, me.id, status, id);
  audit(c, `report.${action}`, { type: 'report', id }, detail);
  return c.json({ ok: true, status });
});

// Backups (server/backup.ts): list, take one now, verify one. Nightly ones run by themselves (startServer).
/** Is the copy of the data OFF the server's disk working? (a copy on the same disk does not survive losing the disk) */
app.get('/api/admin/offsite', requireAdmin('backups'), async c => { await offsite(); return c.json({ ...offsiteStatus }); });
app.get('/api/admin/backups', requireAdmin('backups'), async c => c.json((await listBackups()).map(m => ({ id: m.id, createdAt: m.createdAt, dbBytes: m.dbBytes, counts: m.counts, files: m.blobs.length }))));
app.post('/api/admin/backups', requireAdmin('backups'), async c => {
  const m = await createBackup();
  await pruneBackups(7);
  audit(c, 'backup.create', { type: 'backup', id: m.id });
  return c.json({ id: m.id, createdAt: m.createdAt, dbBytes: m.dbBytes, counts: m.counts, files: m.blobs.length }, 201);
});
app.post('/api/admin/backups/:id/verify', requireAdmin('backups'), async c => {
  const report = await verifyBackup(c.req.param('id'));
  audit(c, 'backup.verify', { type: 'backup', id: String(c.req.param('id')) }, { ok: (report as { ok?: boolean }).ok ?? null });
  return c.json(report);
});
// Numbers about the server's health: latency percentiles, counters, live connections. No content, no names.
app.get('/api/admin/metrics', requireAdmin('metrics'), c => c.json(snapshot({ connections: online() })));
app.get('/api/admin/circles', requireAdmin('circles'), c => c.json(all(
  `SELECT c.id, c.name, c.sensitivity, c.agent_active AS agentActive, c.created_at AS createdAt,
     (SELECT COUNT(*) FROM circle_members WHERE circle_id = c.id) AS members,
     (SELECT COUNT(*) FROM archive_entries WHERE circle_id = c.id AND deleted_at IS NULL) AS archived
   FROM circles c WHERE c.deleted_at IS NULL AND c.id < ? ORDER BY c.id DESC LIMIT 100`, Number(c.req.query('before')) || Number.MAX_SAFE_INTEGER)));

// ---- the audit log (A-03) ------------------------------------------------------------------------------------------------
app.get('/api/admin/audit', requireAdmin('audit'), c => {
  const before = Number(c.req.query('before')) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const action = c.req.query('action');
  const rows = all(
    `SELECT a.id, a.actor_id AS actorId, u.name AS actor, a.actor_role AS actorRole, a.action, a.target_type AS targetType, a.target_id AS targetId, a.detail, a.created_at AS createdAt
       FROM admin_audit a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.id < ? ${action ? 'AND a.action = ?' : ''} ORDER BY a.id DESC LIMIT ?`, ...(action ? [before, action, limit] : [before, limit]));
  return c.json(rows.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })));
});

// ---- people (A-02) -----------------------------------------------------------------------------------------------------
const personRow = (u: any) => ({
  id: u.id, name: u.name, phone: maskPhone(u.phone), lang: u.lang, region: u.region ?? null, createdAt: u.created_at, role: u.admin_role ?? (u.is_admin ? 'owner' : null),
  suspended: !!u.suspended_at, suspendedUntil: u.suspended_until ?? null, suspendedReason: u.suspended_reason ?? null, circles: u.circles ?? 0, lastActive: u.last_active ?? null,
});
/** The people-list filters: who needs attention, in one tap. */
const PEOPLE_FILTERS: Record<string, string> = {
  suspended: 'u.suspended_at IS NOT NULL',
  staff: 'u.admin_role IS NOT NULL',
  new7: "date(u.created_at) >= date('now','-6 days')",
  inactive30: "NOT EXISTS (SELECT 1 FROM activity a WHERE a.user_id = u.id AND a.day >= date('now','-29 days'))",
  nopin: 'u.pin_hash IS NULL',
};
app.get('/api/admin/users', requireAdmin('users.read'), c => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 40);
  const before = Number(c.req.query('before')) || Number.MAX_SAFE_INTEGER;
  const digits = q.replace(/\D/g, '');
  // A phone is found by its last digits (4 or more) and never shown in full here; a name is found by what it contains.
  const where = !q ? '1=1' : digits.length >= 4 && digits.length >= q.length - 2 ? 'u.phone LIKE ?' : 'u.name LIKE ?';
  const arg = !q ? [] : [digits.length >= 4 && digits.length >= q.length - 2 ? `%${digits}` : `%${q.replace(/[%_]/g, '')}%`];
  const extra = PEOPLE_FILTERS[c.req.query('filter') ?? ''] ?? '1=1';
  const rows = all(
    `SELECT u.*, (SELECT COUNT(*) FROM circle_members m WHERE m.user_id = u.id) AS circles, (SELECT MAX(day) FROM activity a WHERE a.user_id = u.id) AS last_active
       FROM users u WHERE u.id < ? AND ${where} AND ${extra} ORDER BY u.id DESC LIMIT 50`, before, ...arg);
  if (q) audit(c, 'users.search', { type: 'users', id: 'search' }, { byPhone: digits.length >= 4, results: rows.length });   // what was typed is never logged
  return c.json(rows.map(personRow));
});
app.get('/api/admin/users/:id', requireAdmin('users.read'), c => {
  const id = Number(c.req.param('id'));
  const u = one('SELECT u.*, (SELECT COUNT(*) FROM circle_members m WHERE m.user_id = u.id) AS circles, (SELECT MAX(day) FROM activity a WHERE a.user_id = u.id) AS last_active FROM users u WHERE u.id = ?', id);
  if (!u) return c.json({ error: 'not_found' }, 404);
  const out: Record<string, unknown> = {
    familiesOf: all("SELECT c.id, c.name, m.role, c.frozen_at IS NOT NULL AS frozen FROM circle_members m JOIN circles c ON c.id = m.circle_id WHERE m.user_id = ? AND c.deleted_at IS NULL AND c.kind != 'direct' ORDER BY c.id DESC LIMIT 50", id),
    notes: notesOf('user', id),
    openReportsAgainst: one("SELECT COUNT(*) n FROM reports WHERE reported_user_id = ? AND status != 'resolved'", id)!.n,
    supportCases: one('SELECT COUNT(*) n FROM support_cases WHERE user_id = ?', id)!.n,
    ...personRow(u), hasPin: !!u.pin_hash, messages: one("SELECT COUNT(*) n FROM messages WHERE user_id = ? AND kind != 'system'", id)!.n,
    reportsAgainst: one('SELECT COUNT(*) n FROM reports WHERE reported_user_id = ?', id)!.n, activeSessions: one('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND expires_at > ?', id, Date.now())!.n,
    banned: isBanned(u.phone),
  };
  if (c.req.query('reveal') === '1') {
    if (!can(c.get('user'), 'users.reveal')) return c.json({ error: 'forbidden' }, 403);
    out.phoneFull = u.phone;
    audit(c, 'user.reveal_phone', { type: 'user', id });   // a full number is shown only on purpose, and it is on record
  }
  return c.json(out);
});

export const actOnUser = (c: any) => {
  const id = Number(c.req.param('id'));
  const me = c.get('user');
  const target = one('SELECT id, phone, admin_role FROM users WHERE id = ?', id);
  if (!target) return { error: c.json({ error: 'not_found' }, 404) };
  if (target.id === me.id) return { error: c.json({ error: 'not_yourself' }, 400) };
  if (target.admin_role === 'owner' && roleOf(me) !== 'owner') return { error: c.json({ error: 'forbidden' }, 403) };
  return { target, id };
};
app.post('/api/admin/users/:id/suspend', requireAdmin('users.act'), async c => {
  const t = actOnUser(c); if (t.error) return t.error;
  const b = await json(c);
  const days = Math.min(Math.max(Number(b.days) || 0, 0), 3650);
  const reason = text(b.reason, 300) || null;
  run("UPDATE users SET suspended_at = datetime('now'), suspended_until = CASE WHEN ? > 0 THEN datetime('now', '+' || ? || ' days') END, suspended_reason = ? WHERE id = ?", days, days, reason, t.id);
  endSessions(t.id!);
  audit(c, 'user.suspend', { type: 'user', id: t.id! }, { days: days || null });
  return c.json({ ok: true });
});
app.post('/api/admin/users/:id/unsuspend', requireAdmin('users.act'), c => {
  const t = actOnUser(c); if (t.error) return t.error;
  run('UPDATE users SET suspended_at = NULL, suspended_until = NULL, suspended_reason = NULL WHERE id = ?', t.id);
  audit(c, 'user.unsuspend', { type: 'user', id: t.id! });
  return c.json({ ok: true });
});
app.post('/api/admin/users/:id/revoke-sessions', requireAdmin('users.act'), c => {
  const t = actOnUser(c); if (t.error) return t.error;
  endSessions(t.id!);
  audit(c, 'user.revoke_sessions', { type: 'user', id: t.id! });
  return c.json({ ok: true });
});

// ---- staff and roles (A-08) -----------------------------------------------------------------------------------------------
app.get('/api/admin/staff', requireAdmin('users.read'), c => c.json(staff()));
app.post('/api/admin/users/:id/role', requireAdmin('roles'), async c => {
  const id = Number(c.req.param('id'));
  const b = await json(c);
  const role = b.role === null ? null : (String(b.role) as Role);
  if (role !== null && !ROLES.includes(role)) return c.json({ error: 'invalid_role' }, 400);
  const target = one('SELECT id, admin_role FROM users WHERE id = ?', id);
  if (!target) return c.json({ error: 'not_found' }, 404);
  // There must always be someone who can give and take roles.
  if (target.admin_role === 'owner' && role !== 'owner' && one("SELECT COUNT(*) n FROM users WHERE admin_role = 'owner'")!.n <= 1) return c.json({ error: 'last_owner' }, 409);
  run('UPDATE users SET admin_role = ?, is_admin = ? WHERE id = ?', role, role ? 1 : 0, id);
  if (!role) endSessions(id);
  audit(c, 'staff.set_role', { type: 'user', id }, { from: target.admin_role ?? null, to: role });
  return c.json({ ok: true });
});

// ---- usage, without content (A-07) -----------------------------------------------------------------------------------------
/** Daily numbers for the last 30 days plus weekly/monthly users and retention. Counts only: no names, no messages. Retention counts only days since the activity table began. */
app.get('/api/admin/analytics', requireAdmin('analytics'), c => c.json({
  days: statsSeries(30).map(d => ({ d: d.d, signups: d.signups, dau: d.dau, messages: d.messages, circles: d.circles })),
  ...activityWindows(),
  sealed: Object.fromEntries(all('SELECT status, COUNT(*) n FROM sealed_messages GROUP BY status').map(r => [r.status, r.n])),
  archivedLast30: one("SELECT COUNT(*) n FROM archive_entries WHERE deleted_at IS NULL AND created_at >= datetime('now', '-29 days')")!.n,
}));

// ---- SMS operations (A-09) -----------------------------------------------------------------------------------------------
app.get('/api/admin/sms', requireAdmin('sms'), c => {
  const rows = all("SELECT calling_code AS code, status, COUNT(*) AS n FROM sms_log WHERE day >= date('now', '-13 days') GROUP BY calling_code, status");
  type Tally = { sent: number; failed: number; blocked: number; capped: number; verified: number };
  const by = new Map<string, Tally>();
  for (const r of rows) { const e = by.get(r.code) ?? { sent: 0, failed: 0, blocked: 0, capped: 0, verified: 0 }; e[r.status as keyof Tally] = r.n; by.set(r.code, e); }
  const countries = [...by.entries()].map(([code, v]) => ({ code, ...v, completion: v.sent ? Math.round((v.verified / v.sent) * 1000) / 10 : null })).sort((a, b) => b.sent - a.sent);
  return c.json({ ...smsInfo(), usedToday: sentTodayCount(), blockedCodes: blockedCodes(), countries });
});
app.post('/api/admin/sms/blocked', requireAdmin('sms'), async c => {
  const b = await json(c);
  const codes = (Array.isArray(b.codes) ? b.codes : []).map((x: unknown) => String(x).replace(/\D/g, '')).filter((x: string) => x.length >= 1 && x.length <= 4);
  const unique = [...new Set<string>(codes)].slice(0, 100);
  const before = blockedCodes();
  setBlockedCodes(unique);
  audit(c, 'sms.set_blocked', { type: 'sms', id: 'blocked' }, { before, after: unique });
  return c.json({ ok: true, blockedCodes: unique });
});

// ---- feature flags (A-06) --------------------------------------------------------------------------------------------------
app.get('/api/admin/flags', requireAdmin('flags'), c => c.json(Object.entries(FLAGS).map(([name, f]) => ({ name, on: flag(name as FlagName), default: f.default, description: f.description }))));
app.post('/api/admin/flags/:name', requireAdmin('flags'), async c => {
  const name = String(c.req.param('name'));
  if (!isFlag(name)) return c.json({ error: 'not_found' }, 404);
  const b = await json(c);
  if (typeof b.on !== 'boolean') return c.json({ error: 'invalid_value' }, 400);
  const before = flag(name);
  setFlag(name, b.on);
  audit(c, 'flag.set', { type: 'flag', id: name }, { from: before, to: b.on });
  return c.json({ ok: true, name, on: b.on });
});
