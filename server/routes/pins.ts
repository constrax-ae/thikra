import { MAX_PINS, PIN_HOURS, activePins } from '../lib/pins.ts';
import { app } from '../app.ts';
import { circleAccess, membership, tx } from '../lib/helpers.ts';
import { one, run } from '../db.ts';
import { publish } from '../live.ts';

app.get('/api/circles/:id/pins', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  return c.json(activePins(a.circleId, a.user.id));
});
// Any member can pin a message for 24 hours, 7 days or 30 days; at most 3 at a time (the oldest pin makes room).
app.post('/api/messages/:mid/pin', async c => {
  const m = one('SELECT id, circle_id, kind, deleted_at FROM messages WHERE id = ?', Number(c.req.param('mid')));
  const user = c.get('user');
  if (!m || !membership(m.circle_id, user.id) || m.kind === 'system' || m.deleted_at) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const hours = Number(b.hours ?? 168);
  if (!PIN_HOURS.has(hours)) return c.json({ error: 'invalid_pin' }, 400);
  tx(() => {
    run("DELETE FROM pinned_messages WHERE circle_id = ? AND expires_at <= datetime('now')", m.circle_id);
    run(`INSERT INTO pinned_messages (circle_id, message_id, pinned_by, expires_at) VALUES (?, ?, ?, datetime('now', '+${hours} hours'))
         ON CONFLICT(circle_id, message_id) DO UPDATE SET expires_at = excluded.expires_at, pinned_by = excluded.pinned_by`, m.circle_id, m.id, user.id);
    run(`DELETE FROM pinned_messages WHERE circle_id = ? AND message_id NOT IN
           (SELECT message_id FROM pinned_messages WHERE circle_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_PINS})`, m.circle_id, m.circle_id);
  });
  publish(m.circle_id, { t: 'pins', circle: m.circle_id });
  return c.json({ ok: true });
});
app.delete('/api/messages/:mid/pin', c => {
  const m = one('SELECT id, circle_id FROM messages WHERE id = ?', Number(c.req.param('mid')));
  if (!m || !membership(m.circle_id, c.get('user').id)) return c.json({ error: 'not_found' }, 404);
  run('DELETE FROM pinned_messages WHERE circle_id = ? AND message_id = ?', m.circle_id, m.id);
  publish(m.circle_id, { t: 'pins', circle: m.circle_id });
  return c.json({ ok: true });
});
