import { REPORT_REASONS } from '../lib/safety.ts';
import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { count, snapshot } from '../metrics.ts';
import { limited, membership } from '../lib/helpers.ts';

// ---- blocking and reporting -----------------------------------------------------------------

// Block or unblock a person. In a one-to-one chat neither of you can send to the other while a block stands.
// (The blocked person is told "blocked" when they try: clearer than WhatsApp's silent single tick, at a small privacy cost.)
app.post('/api/users/:id/block', async c => {
  const me = c.get('user');
  const target = Number(c.req.param('id'));
  if (!Number.isInteger(target) || target === me.id || !one('SELECT 1 FROM users WHERE id = ?', target)) return c.json({ error: 'not_found' }, 404);
  // You can only block someone you actually share a conversation with: this must not become a way to probe user ids.
  if (!one('SELECT 1 FROM circle_members a JOIN circle_members b ON a.circle_id = b.circle_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1', me.id, target)) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (b.on === false) run('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', me.id, target);
  else run('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)', me.id, target);
  return c.json({ ok: true });
});
app.get('/api/me/blocks', c => c.json(all('SELECT u.id, u.name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY b.created_at DESC', c.get('user').id)));
// Report a message. The reporter chooses to send it, so the platform admins receive a copy of its text (and nothing else
// from the conversation); the reporter is told this in the app. One report per person per message.
app.post('/api/messages/:mid/report', async c => {
  const m = one('SELECT m.id, m.circle_id, m.user_id, m.kind, m.body, m.transcript FROM messages m WHERE m.id = ?', Number(c.req.param('mid')));
  const user = c.get('user');
  if (!m || !membership(m.circle_id, user.id) || m.kind === 'system') return c.json({ error: 'not_found' }, 404);
  if (m.user_id === user.id) return c.json({ error: 'invalid_report' }, 400);
  const b = await c.req.json().catch(() => ({}));
  if (!REPORT_REASONS.has(b.reason)) return c.json({ error: 'invalid_report' }, 400);
  if (await limited(`report:${user.id}`, 10, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : null;
  const snapshot = String((m.kind === 'voice' ? m.transcript : m.body) ?? '').slice(0, 4000);
  const r = run('INSERT OR IGNORE INTO reports (reporter_id, reported_user_id, circle_id, message_id, reason, note, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)',
    user.id, m.user_id, m.circle_id, m.id, b.reason, note || null, snapshot);
  count('report_filed');
  return c.json({ ok: true, duplicate: Number(r.changes) === 0 });
});
