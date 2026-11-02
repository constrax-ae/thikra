import { EDIT_WINDOW_MS, REACTIONS } from '../lib/receipts.ts';
import { announceUpdate, circleAccess, markRead, membership, searchable } from '../lib/helpers.ts';
import { app } from '../app.ts';
import { one, run } from '../db.ts';
import { toMs } from '../lib/deletes.ts';

// ---- receipts, reactions, edits ------------------------------------------------------------

// HTTP twin of the socket's `read` frame, for clients without a live connection.
app.post('/api/circles/:id/read', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  markRead(a.circleId, a.user.id, Number(b.seq));
  return c.json({ ok: true });
});
// One reaction per member per message; the same emoji again, or `null`, removes it. Works on any message the member can see.
app.post('/api/messages/:mid/react', async c => {
  const m = one('SELECT id, circle_id, kind, deleted_at FROM messages WHERE id = ?', Number(c.req.param('mid')));
  const user = c.get('user');
  if (!m || !membership(m.circle_id, user.id) || m.kind === 'system' || m.deleted_at) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (b.emoji !== null && !REACTIONS.has(b.emoji)) return c.json({ error: 'invalid_reaction' }, 400);
  const cur = one('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?', m.id, user.id);
  if (b.emoji === null || cur?.emoji === b.emoji) run('DELETE FROM reactions WHERE message_id = ? AND user_id = ?', m.id, user.id);
  else run('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji', m.id, user.id, b.emoji);
  announceUpdate(m.circle_id, m.id);
  return c.json({ ok: true });
});
// The sender can fix a text message for 15 minutes; everyone sees "edited". What the archive already made of it is not rewritten.
app.patch('/api/messages/:mid', async c => {
  const m = one('SELECT id, circle_id, user_id, kind, created_at, deleted_at, sealed_on FROM messages WHERE id = ?', Number(c.req.param('mid')));
  const user = c.get('user');
  if (!m || !membership(m.circle_id, user.id) || m.kind !== 'text' || m.deleted_at) return c.json({ error: 'not_found' }, 404);
  if (m.sealed_on) return c.json({ error: 'sealed_protected' }, 403);
  if (m.user_id !== user.id) return c.json({ error: 'forbidden' }, 403);
  if (Date.now() - toMs(m.created_at) > EDIT_WINDOW_MS) return c.json({ error: 'edit_window_closed' }, 403);
  const b = await c.req.json().catch(() => ({}));
  const body = String(b.body ?? '').trim().slice(0, 4000);
  if (!body) return c.json({ error: 'empty' }, 400);
  run("UPDATE messages SET body = ?, search_text = ?, edited_at = datetime('now') WHERE id = ?", body, searchable(body), m.id);
  announceUpdate(m.circle_id, m.id);
  return c.json({ ok: true });
});
