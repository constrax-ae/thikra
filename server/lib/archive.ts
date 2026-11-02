import { type Context } from 'hono';
import { type Env } from '../app.ts';
import { all, one, run, type Row } from '../db.ts';
import { isManager, membership } from './helpers.ts';
import { parseParties, setConflictStage, settleConflicts } from './moments.ts';

// ---- archive ------------------------------------------------------------------

/** What one member may see of a circle's archive: declined entries never; a fresh conflict stays hidden for 24h from everyone but managers and its parties. */
export function archiveFor(circleId: number, role: string, userId: number, q = ""): Row[] {
  try { settleConflicts(circleId); } catch (e) { console.error('[moments]', e); }
  const cols = `id, title, summary, category, event_date AS eventDate, source, kind, status, parties, protected,
    (visible_after IS NOT NULL AND visible_after > datetime('now')) AS pending`;
  const rows = q
    ? all(`SELECT ${cols} FROM archive_entries WHERE circle_id = ? AND deleted_at IS NULL AND declined = 0
           AND (title LIKE ? OR summary LIKE ?) ORDER BY event_date DESC, id DESC`, circleId, `%${q}%`, `%${q}%`)
    : all(`SELECT ${cols} FROM archive_entries WHERE circle_id = ? AND deleted_at IS NULL AND declined = 0
           ORDER BY event_date DESC, id DESC`, circleId);
  return rows
    .map(({ parties, ...r }) => ({ ...r, pending: !!r.pending, protected: !!r.protected, canAct: r.kind === 'conflict' && (isManager(role) || parseParties(parties).includes(userId)) }))
    .filter(r => !r.pending || r.canAct);
}
export function conflictAction(c: Context<Env>, action: 'decline' | 'resolve') {
  const e = one("SELECT * FROM archive_entries WHERE id = ? AND kind = 'conflict' AND deleted_at IS NULL", Number(c.req.param('eid')));
  const user = c.get('user');
  const m = e && membership(e.circle_id, user.id);
  if (!e || !m) return c.json({ error: 'not_found' }, 404);
  if (!isManager(m.role) && !parseParties(e.parties).includes(user.id)) return c.json({ error: 'forbidden' }, 403);
  if (action === 'decline') run('UPDATE archive_entries SET declined = 1 WHERE id = ?', e.id);
  else if (e.status === 'open') setConflictStage(e, 'resolved');
  return c.json({ ok: true });
}
// Import: the client reads a chat export on the user's own device and sends only the events the
// user ticked. Managers only, since it writes into the shared archive. Duplicates are skipped.
export const CATEGORIES = new Set(['birth', 'marriage', 'graduation', 'achievement', 'travel', 'health', 'passing', 'family_news']);
