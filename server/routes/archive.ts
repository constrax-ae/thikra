import { CATEGORIES, archiveFor, conflictAction } from '../lib/archive.ts';
import { all, one, run, type Row } from '../db.ts';
import { app } from '../app.ts';
import { eventMedia } from '../lib/albums.ts';
import { circleAccess, isManager, membership, systemMessage, tx } from '../lib/helpers.ts';
import { cleanDate } from '../lib/storage.ts';
import { isReadOnly } from '../billing.ts';

app.get('/api/circles/:id/archive', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const rows = archiveFor(a.circleId, a.role, a.user.id, (c.req.query('q') ?? '').trim());
  const media = eventMedia(a.circleId, rows as Array<{ id: number; eventDate: string }>);   // album pictures and voices from the days of each event
  return c.json(rows.map(r => ({ ...r, media: media.get(r.id) ?? [] })));
});
// The Memory tab: everything the agent documented across all your family circles, newest first, with the same visibility rules
// as each circle's own archive (so a hidden conflict never leaks through here).
app.get('/api/me/memory', c => {
  const u = c.get('user');
  const circles = all(
    `SELECT c.id, c.name, cm.role FROM circles c JOIN circle_members cm ON cm.circle_id = c.id AND cm.user_id = ?
      WHERE c.kind = 'circle' AND c.deleted_at IS NULL`, u.id);
  const entries: Row[] = circles.flatMap(ci => archiveFor(ci.id, ci.role, u.id).map(e => ({ ...e, circleId: ci.id, circleName: ci.name })));
  entries.sort((x, y) => String(y.eventDate).localeCompare(String(x.eventDate)) || y.id - x.id);
  return c.json(entries.slice(0, 300));
});
app.post('/api/circles/:id/import', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  if (one('SELECT kind FROM circles WHERE id = ?', a.circleId)!.kind !== 'circle') return c.json({ error: 'not_a_circle' }, 409);
  if (isReadOnly(a.circleId)) return c.json({ error: 'archive_readonly' }, 402);
  const b = await c.req.json().catch(() => ({}));
  const list: unknown[] | null = Array.isArray(b.entries) ? b.entries : null;
  if (!list || list.length === 0 || list.length > 500) return c.json({ error: 'invalid_import' }, 400);

  let added = 0, skipped = 0;
  tx(() => {
    for (const raw of list) {
      const e = (raw ?? {}) as Row;
      const date = cleanDate(e.date);
      const title = String(e.title ?? '').trim().slice(0, 80);
      const summary = String(e.summary ?? '').trim().slice(0, 500);
      const duplicate = date && one('SELECT 1 FROM archive_entries WHERE circle_id = ? AND event_date = ? AND summary = ? AND deleted_at IS NULL', a.circleId, date, summary);
      if (!date || !title || !summary || duplicate) { skipped++; continue; }
      run("INSERT INTO archive_entries (circle_id, title, summary, category, event_date, source) VALUES (?, ?, ?, ?, ?, 'manual')",
        a.circleId, title, summary, CATEGORIES.has(e.category) ? e.category : null, date);
      added++;
    }
  });
  if (added > 0) systemMessage(a.circleId, 'imported', { name: a.user.name, n: added });
  return c.json({ added, skipped });
});
// The owner or either party can refuse to have a conflict documented, or mark it as settled.
app.post('/api/archive/:eid/decline', c => conflictAction(c, 'decline'));
app.post('/api/archive/:eid/resolve', c => conflictAction(c, 'resolve'));
// The circle owner or an admin can remove any entry; this always overrides the agent (report §5.1).
app.delete('/api/archive/:eid', c => {
  const e = one('SELECT id, circle_id, protected, message_id FROM archive_entries WHERE id = ? AND deleted_at IS NULL', Number(c.req.param('eid')));
  const m = e && membership(e.circle_id, c.get('user').id);
  if (!e || !m) return c.json({ error: 'not_found' }, 404);
  if (e.protected) {
    // an opened sealed message stays in the family archive: only its own author may take it out (and its message with it)
    const authorId = e.message_id ? one('SELECT user_id FROM messages WHERE id = ?', e.message_id)?.user_id : null;
    if (authorId !== c.get('user').id) return c.json({ error: 'sealed_protected' }, 403);
  } else if (!isManager(m.role)) return c.json({ error: 'forbidden' }, 403);
  run("UPDATE archive_entries SET deleted_at = datetime('now') WHERE id = ?", e.id);
  return c.json({ ok: true });
});
