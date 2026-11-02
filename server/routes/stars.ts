import { MANY_TIMES } from '../lib/stars.ts';
import { MSG_COLS } from '../lib/messages.ts';
import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { blockedInDirect, sendText } from '../lib/moments.ts';
import { circleAccess, decorate, isFrozen, limited, membership } from '../lib/helpers.ts';

// ---- stars and forwarding -------------------------------------------------------------------

// A personal bookmark: only you see it, and it never changes the message for anyone else.
app.post('/api/messages/:mid/star', async c => {
  const m = one('SELECT id, circle_id, kind, deleted_at FROM messages WHERE id = ?', Number(c.req.param('mid')));
  const user = c.get('user');
  if (!m || !membership(m.circle_id, user.id) || m.kind === 'system' || m.deleted_at) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (b.on === false) run('DELETE FROM stars WHERE user_id = ? AND message_id = ?', user.id, m.id);
  else run('INSERT OR IGNORE INTO stars (user_id, message_id) VALUES (?, ?)', user.id, m.id);
  return c.json({ ok: true });
});
app.get('/api/circles/:id/starred', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const rows = all(
    `SELECT ${MSG_COLS} FROM stars s JOIN messages m ON m.id = s.message_id LEFT JOIN users u ON u.id = m.user_id
       WHERE s.user_id = ? AND m.circle_id = ? AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 200`, a.user.id, a.circleId);
  return c.json(decorate(a.circleId, rows));
});
 // like WhatsApp: forwarded this many hops is shown as "forwarded many times"

// Forward a text message you can see into another circle you belong to. It carries a hop count (shown as "Forwarded",
// then "Forwarded many times"), is never read by the archive agent, and the quoted-reply link does not travel with it.
app.post('/api/messages/:mid/forward', async c => {
  const m = one('SELECT id, circle_id, kind, body, forward_count, deleted_at FROM messages WHERE id = ?', Number(c.req.param('mid')));
  const user = c.get('user');
  if (!m || !membership(m.circle_id, user.id) || m.kind !== 'text' || m.deleted_at) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const targets = [...new Set((Array.isArray(b.circles) ? b.circles : []).map(Number).filter(Number.isInteger))] as number[];
  if (!targets.length || targets.length > MANY_TIMES) return c.json({ error: 'invalid_targets' }, 400);
  if (targets.some(t => !membership(t, user.id))) return c.json({ error: 'not_found' }, 404);
  if (targets.some(t => isFrozen(t))) return c.json({ error: 'circle_frozen' }, 423);
  if (await limited(`fwd:${user.id}`, 30, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  if (targets.some(t => blockedInDirect(t, user.id))) return c.json({ error: 'blocked' }, 403);
  const sent = targets.map(t => sendText(t, user.id, m.body, null, null, (m.forward_count as number) + 1).id);
  return c.json({ sent });
});
