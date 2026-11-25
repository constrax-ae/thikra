import { type Context } from 'hono';
import { REPORT_REASONS } from '../lib/safety.ts';
import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { count, snapshot } from '../metrics.ts';
import { limited, membership } from '../lib/helpers.ts';
import { forgetPresence } from '../lib/presence.ts';
import { isEncrypted } from '../lib/e2ee.ts';

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
  else {
    run('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)', me.id, target);
    // Neither sees the other's "online" or "last seen" from now on: both screens drop it at once.
    forgetPresence(me.id, [target]); forgetPresence(target, [me.id]);
  }
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
  // An encrypted chat: the server has nothing to copy. The reporting device sends the words it chose to share (it decrypted them), and the report says they are unverified.
  const encrypted = isEncrypted(m.circle_id);
  const snapshot = encrypted ? (typeof b.snapshot === 'string' ? b.snapshot.slice(0, 4000) : '') : String((m.kind === 'voice' ? m.transcript : m.body) ?? '').slice(0, 4000);
  const r = run('INSERT OR IGNORE INTO reports (reporter_id, reported_user_id, circle_id, message_id, reason, note, snapshot, unverified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    user.id, m.user_id, m.circle_id, m.id, b.reason, note || null, snapshot, encrypted ? 1 : 0);
  count('report_filed');
  return c.json({ ok: true, duplicate: Number(r.changes) === 0 });
});

/**
 * Report a PERSON, or a whole CHAT, rather than one message: the two things a member could not do until now, and the
 * two things they reach for when the trouble is a pattern rather than a sentence. Neither carries any conversation
 * content — only the reason, the note the reporter chose to write, and who or where. (A message report still carries
 * that message's text, with the reporter told so; that is the only content moderation ever sees.)
 * One open report per person per target, and the same ten-an-hour limit as message reports.
 */
async function fileReport(c: Context, target: { user?: number; circle?: number }) {
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  if (!REPORT_REASONS.has(b.reason)) return c.json({ error: 'invalid_report' }, 400);
  if (await limited(`report:${user.id}`, 10, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const open = one(
    `SELECT 1 FROM reports WHERE reporter_id = ? AND message_id IS NULL AND status != 'resolved'
       AND COALESCE(reported_user_id, 0) = ? AND COALESCE(circle_id, 0) = ?`, user.id, target.user ?? 0, target.circle ?? 0);
  if (open) return c.json({ ok: true, duplicate: true });
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) : null;
  run('INSERT INTO reports (reporter_id, reported_user_id, circle_id, message_id, reason, note, snapshot) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
    user.id, target.user ?? null, target.circle ?? null, b.reason, note || null);
  count('report_filed');
  return c.json({ ok: true, duplicate: false });
}

app.post('/api/users/:id/report', async c => {
  const me = c.get('user');
  const target = Number(c.req.param('id'));
  if (!Number.isInteger(target) || target === me.id || !one('SELECT 1 FROM users WHERE id = ?', target)) return c.json({ error: 'not_found' }, 404);
  // Only about someone you actually share a conversation with — as with blocking, this must not become a way to probe user ids.
  const shared = one('SELECT a.circle_id AS id FROM circle_members a JOIN circle_members b ON a.circle_id = b.circle_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1', me.id, target);
  if (!shared) return c.json({ error: 'not_found' }, 404);
  return fileReport(c, { user: target });
});

app.post('/api/circles/:id/report', async c => {
  const me = c.get('user');
  const circleId = Number(c.req.param('id'));
  if (!membership(circleId, me.id)) return c.json({ error: 'not_found' }, 404);
  return fileReport(c, { circle: circleId });
});
