import { all, one, run } from '../db.ts';
import { tx } from '../lib/helpers.ts';
import { app } from '../app.ts';
import { audit, endSessions, maskPhone, notesOf, phoneHash, requireAdmin } from '../lib/admin.ts';
import { actOnUser } from './admin.ts';
import { plans, quotaOf, subscription } from '../billing.ts';
import { csvResponse, toCsv } from '../lib/csv.ts';

// Running families and people from the admin screen (ADMIN-PLAN slice 1). Metadata only: no message text, no archive content, numbers masked.
const GB = 1024 ** 3;
const json = (c: { req: { json(): Promise<any> } }) => c.req.json().catch(() => ({}));
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const round = (n: number) => Math.round(n * 100) / 100;

const familyRow = (c: any) => {
  const used = Number(one('SELECT COALESCE(SUM(size), 0) n FROM (SELECT DISTINCT blob_hash, size FROM media WHERE circle_id = ? AND archived = 1)', c.id)!.n);
  const sub = subscription(c.id), quota = quotaOf(sub);
  return { id: c.id, name: c.name, kind: c.kind, createdAt: c.created_at, members: c.members, archived: c.archived, openReports: c.open_reports, lastActivity: c.last_activity ?? null,
    frozen: !!c.frozen_at, frozenReason: c.frozen_reason ?? null, plan: sub.plan, status: sub.status, usedGB: round(used / GB), quotaGB: round(quota / GB), percent: quota ? Math.round((used / quota) * 100) : 100 };
};
const FAMILY_SELECT = `SELECT c.id, c.name, c.kind, c.created_at, c.frozen_at, c.frozen_reason,
    (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id = c.id) AS members,
    (SELECT COUNT(*) FROM archive_entries e WHERE e.circle_id = c.id AND e.deleted_at IS NULL) AS archived,
    (SELECT COUNT(*) FROM reports r WHERE r.circle_id = c.id AND r.status != 'resolved') AS open_reports,
    (SELECT MAX(created_at) FROM messages x WHERE x.circle_id = c.id) AS last_activity
  FROM circles c LEFT JOIN subscriptions s ON s.circle_id = c.id LEFT JOIN circle_usage cu ON cu.circle_id = c.id WHERE c.deleted_at IS NULL AND c.kind != 'direct'`;

/** Families, newest first, a page at a time (`before` = the last id of the previous page). Filters: frozen, reported, readonly, near_quota, empty (one member). */
app.get('/api/admin/families', requireAdmin('circles'), c => {
  const q = text(c.req.query('q'), 40);
  const before = Number(c.req.query('before')) || Number.MAX_SAFE_INTEGER;
  const filter = c.req.query('filter') ?? '';
  // Every filter is applied in SQL BEFORE the page is cut, so the fullest families are found however old they are. Archive size comes from the hourly rollup (circle_usage).
  const p = plans();
  const quota = "(CASE s.plan WHEN 'family' THEN ? WHEN 'heritage' THEN ? ELSE ? END + COALESCE(s.bonus_bytes, 0))";
  const quotaArgs = [p.family.quotaBytes, p.heritage.quotaBytes, p.free.quotaBytes];
  const filters: Record<string, { sql: string; args: unknown[] }> = {
    frozen: { sql: 'c.frozen_at IS NOT NULL', args: [] },
    reported: { sql: "EXISTS (SELECT 1 FROM reports r WHERE r.circle_id = c.id AND r.status != 'resolved')", args: [] },
    empty: { sql: '(SELECT COUNT(*) FROM circle_members m WHERE m.circle_id = c.id) <= 1', args: [] },
    near_quota: { sql: `COALESCE(cu.archived_bytes, 0) * 100 >= 80 * ${quota}`, args: quotaArgs },
    readonly: { sql: "(s.status = 'readonly' OR (s.plan != 'free' AND s.status IN ('active', 'grace') AND s.period_end IS NOT NULL AND date(s.period_end, '+14 days') < date('now')))", args: [] },
  };
  const f = filters[filter];
  const rows = all(`${FAMILY_SELECT} AND c.id < ? ${q ? 'AND c.name LIKE ?' : ''} ${f ? `AND ${f.sql}` : ''} ORDER BY c.id DESC LIMIT 50`, before, ...(q ? [`%${q.replace(/[%_]/g, '')}%`] : []), ...(f ? f.args : [])).map(familyRow);
  return c.json(rows);
});

app.get('/api/admin/families/:id', requireAdmin('circles'), c => {
  const id = Number(c.req.param('id'));
  const row = one(`${FAMILY_SELECT} AND c.id = ?`, id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const sub = subscription(id);
  return c.json({
    ...familyRow(row), bonusGB: round(sub.bonusBytes / GB), periodEnd: sub.periodEnd ? sub.periodEnd.slice(0, 10) : null, agentActive: !!one('SELECT agent_active a FROM circles WHERE id = ?', id)!.a,
    membersList: all(`SELECT u.id, u.name, u.phone, m.role, m.joined_at AS joinedAt, u.suspended_at IS NOT NULL AS suspended FROM circle_members m JOIN users u ON u.id = m.user_id WHERE m.circle_id = ? ORDER BY m.role = 'owner' DESC, m.role = 'admin' DESC, m.joined_at LIMIT 200`, id)
      .map(m => ({ id: m.id, name: m.name, phone: maskPhone(m.phone), role: m.role, joinedAt: m.joinedAt, suspended: !!m.suspended })),
    notes: notesOf('circle', id),
    history: all("SELECT a.action, a.created_at AS createdAt, u.name AS actor FROM admin_audit a LEFT JOIN users u ON u.id = a.actor_id WHERE a.target_type = 'circle' AND a.target_id = ? ORDER BY a.id DESC LIMIT 10", String(id)),
    supportCases: one('SELECT COUNT(*) n FROM support_cases k WHERE k.user_id IN (SELECT user_id FROM circle_members WHERE circle_id = ?)', id)!.n,
  });
});

const liveFamily = (c: any) => {
  const id = Number(c.req.param('id'));
  const row = one('SELECT id, owner_id, frozen_at FROM circles WHERE id = ? AND deleted_at IS NULL', id);
  return row ? { id, row } : null;
};

/** Put a family on hold (read-only) or release it. Nothing is deleted either way. */
app.post('/api/admin/families/:id/freeze', requireAdmin('circles.act'), async c => {
  const f = liveFamily(c); if (!f) return c.json({ error: 'not_found' }, 404);
  const b = await json(c);
  if (typeof b.on !== 'boolean') return c.json({ error: 'invalid_value' }, 400);
  const reason = text(b.reason, 300) || null;
  run(b.on ? "UPDATE circles SET frozen_at = datetime('now'), frozen_reason = ? WHERE id = ?" : 'UPDATE circles SET frozen_at = NULL, frozen_reason = ? WHERE id = ?', b.on ? reason : null, f.id);
  audit(c, b.on ? 'circle.freeze' : 'circle.unfreeze', { type: 'circle', id: f.id }, { reason: b.on ? reason : null });
  return c.json({ ok: true });
});

app.post('/api/admin/families/:id/remove-member', requireAdmin('circles.act'), async c => {
  const f = liveFamily(c); if (!f) return c.json({ error: 'not_found' }, 404);
  const b = await json(c);
  const uid = Number(b.userId);
  const m = one('SELECT role FROM circle_members WHERE circle_id = ? AND user_id = ?', f.id, uid);
  if (!m) return c.json({ error: 'not_found' }, 404);
  if (m.role === 'owner') return c.json({ error: 'owner_cannot_leave' }, 409);   // hand the family over first
  run('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?', f.id, uid);
  audit(c, 'circle.remove_member', { type: 'circle', id: f.id }, { userId: uid, reason: text(b.reason, 300) || null });
  return c.json({ ok: true });
});

/** When a family's manager is gone or locked out: another member becomes the owner and the old owner stays on as an admin. */
app.post('/api/admin/families/:id/transfer', requireAdmin('circles.act'), async c => {
  const f = liveFamily(c); if (!f) return c.json({ error: 'not_found' }, 404);
  const b = await json(c);
  const uid = Number(b.userId);
  if (!one('SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = ?', f.id, uid)) return c.json({ error: 'not_found' }, 404);
  if (uid === f.row.owner_id) return c.json({ error: 'invalid_value' }, 400);
  tx(() => {
    run("UPDATE circle_members SET role = 'admin' WHERE circle_id = ? AND user_id = ?", f.id, f.row.owner_id);
    run("UPDATE circle_members SET role = 'owner' WHERE circle_id = ? AND user_id = ?", f.id, uid);
    run('UPDATE circles SET owner_id = ? WHERE id = ?', uid, f.id);
  });
  audit(c, 'circle.transfer', { type: 'circle', id: f.id }, { from: f.row.owner_id, to: uid, reason: text(b.reason, 300) || null });
  return c.json({ ok: true });
});

/** A private note on a person or a family (a case history for whoever works on it next). The text is never copied into the audit log. */
app.post('/api/admin/notes', requireAdmin('notes'), async c => {
  const b = await json(c);
  const type = b.type === 'circle' ? 'circle' : b.type === 'user' ? 'user' : null;
  const id = Number(b.id), body = text(b.body, 1000);
  if (!type || !Number.isInteger(id) || !body) return c.json({ error: 'invalid_value' }, 400);
  if (!one(type === 'user' ? 'SELECT 1 FROM users WHERE id = ?' : 'SELECT 1 FROM circles WHERE id = ?', id)) return c.json({ error: 'not_found' }, 404);
  run('INSERT INTO admin_notes (target_type, target_id, author_id, body) VALUES (?, ?, ?, ?)', type, id, c.get('user').id, body);
  audit(c, 'note.add', { type, id });
  return c.json({ ok: true });
});

// ---- bans and account deletion ------------------------------------------------------------------------------------------------
app.post('/api/admin/users/:id/ban', requireAdmin('users.act'), async c => {
  const t = actOnUser(c); if (t.error) return t.error;
  const b = await json(c);
  run('INSERT OR IGNORE INTO banned_phones (phone_hash, reason, banned_by) VALUES (?, ?, ?)', phoneHash(t.target!.phone), text(b.reason, 300) || null, c.get('user').id);
  endSessions(t.id!);
  audit(c, 'user.ban', { type: 'user', id: t.id! });
  return c.json({ ok: true });
});
app.post('/api/admin/users/:id/unban', requireAdmin('users.act'), c => {
  const t = actOnUser(c); if (t.error) return t.error;
  run('DELETE FROM banned_phones WHERE phone_hash = ?', phoneHash(t.target!.phone));
  audit(c, 'user.unban', { type: 'user', id: t.id! });
  return c.json({ ok: true });
});
/** Erase an account (the same wipe the person can do themselves). A family's owner cannot be erased until the family is handed over. Needs `confirm: true`. */
app.post('/api/admin/users/:id/delete', requireAdmin('users.delete'), async c => {
  const t = actOnUser(c); if (t.error) return t.error;
  const b = await json(c);
  if (b.confirm !== true) return c.json({ error: 'confirm_required' }, 400);
  if (Number(one('SELECT COUNT(*) n FROM circles WHERE owner_id = ?', t.id)!.n) > 0) return c.json({ error: 'owns_circles' }, 409);
  const families = Number(one('SELECT COUNT(*) n FROM circle_members WHERE user_id = ?', t.id)!.n);
  tx(() => { run('DELETE FROM persons WHERE user_id = ?', t.id); run('DELETE FROM users WHERE id = ?', t.id); });
  audit(c, 'user.delete', { type: 'user', id: t.id! }, { families, reason: text(b.reason, 300) || null });
  return c.json({ ok: true });
});

// ---- files for the owner ---------------------------------------------------------------------------------------------------------------
/** Families as a spreadsheet: plan, members, storage, state (up to 50,000 rows, newest first). Taking it is written in the audit log. */
app.get('/api/admin/export/families', requireAdmin('plans'), c => {
  const rows = all(`${FAMILY_SELECT} ORDER BY c.id DESC LIMIT 50000`).map(familyRow);
  audit(c, 'export.families', { type: 'export', id: 'families' }, { rows: rows.length });
  return csvResponse('thekra-families', toCsv(['id', 'name', 'created', 'members', 'archived', 'plan', 'status', 'used_gb', 'quota_gb', 'percent', 'open_reports', 'frozen', 'last_activity'],
    rows.map(f => [f.id, f.name, f.createdAt, f.members, f.archived, f.plan, f.status, f.usedGB, f.quotaGB, f.percent, f.openReports, f.frozen ? 'yes' : '', f.lastActivity])));
});
/** People as a spreadsheet, numbers masked (up to 50,000 rows). Owner only; taking it is on record. */
app.get('/api/admin/export/people', requireAdmin('roles'), c => {
  const rows = all('SELECT u.id, u.name, u.phone, u.lang, u.created_at, u.admin_role, u.suspended_at, (SELECT COUNT(*) FROM circle_members m WHERE m.user_id = u.id) AS circles FROM users u ORDER BY u.id DESC LIMIT 50000');
  audit(c, 'export.people', { type: 'export', id: 'people' }, { rows: rows.length });
  return csvResponse('thekra-people', toCsv(['id', 'name', 'phone_masked', 'lang', 'created', 'role', 'suspended', 'families'], rows.map(u => [u.id, u.name, maskPhone(u.phone), u.lang, u.created_at, u.admin_role, u.suspended_at ? 'yes' : '', u.circles])));
});
