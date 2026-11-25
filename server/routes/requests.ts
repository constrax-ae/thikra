import { REPORT_REASONS } from '../lib/safety.ts';
import { one, run } from '../db.ts';
import { app } from '../app.ts';
import { count } from '../metrics.ts';
import { limited } from '../lib/helpers.ts';
import { isEncrypted } from '../lib/e2ee.ts';
import { forgetPresence } from '../lib/presence.ts';

// ---- message requests --------------------------------------------------------------------------
// A one-to-one chat from someone you do not know arrives as a request (see directChat). Only the person it was sent
// to can answer it, and only while it is still waiting.

/** The request waiting for you in this chat, with who sent it; undefined if there is none. */
function pending(c: { req: { param: (k: string) => string }; get: (k: 'user') => { id: number } }) {
  const id = Number(c.req.param('id'));
  const me = c.get('user').id;
  if (!Number.isInteger(id)) return undefined;
  const row = one(`SELECT cm.request, o.user_id AS sender FROM circle_members cm JOIN circles ci ON ci.id = cm.circle_id AND ci.kind = 'direct' AND ci.deleted_at IS NULL
                     JOIN circle_members o ON o.circle_id = cm.circle_id AND o.user_id != cm.user_id
                    WHERE cm.circle_id = ? AND cm.user_id = ?`, id, me);
  return row && row.request === 1 ? { circleId: id, me, sender: row.sender as number } : undefined;
}

// Accept: the chat joins your list like any other, and from now on it behaves like one (notifications, read receipts).
app.post('/api/requests/:id/accept', c => {
  const p = pending(c);
  if (!p) return c.json({ error: 'not_found' }, 404);
  run('UPDATE circle_members SET request = 0 WHERE circle_id = ? AND user_id = ?', p.circleId, p.me);
  count('request_accepted');
  return c.json({ ok: true });
});
// Decline: the chat leaves your list and stays out of it. The sender is not told, and is not blocked unless you ask.
app.post('/api/requests/:id/decline', async c => {
  const p = pending(c);
  if (!p) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  run('UPDATE circle_members SET request = 2 WHERE circle_id = ? AND user_id = ?', p.circleId, p.me);
  if (b.block === true) {
    run('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)', p.me, p.sender);
    forgetPresence(p.me, [p.sender]); forgetPresence(p.sender, [p.me]);
  }
  count('request_declined');
  return c.json({ ok: true });
});
// Report: the platform admins receive the sender and, for an encrypted chat, only the words the reporting device chose
// to send (it decrypted them; the report says they are unverified). Reporting also declines and blocks.
app.post('/api/requests/:id/report', async c => {
  const p = pending(c);
  if (!p) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (!REPORT_REASONS.has(b.reason)) return c.json({ error: 'invalid_report' }, 400);
  if (await limited(`report:${p.me}`, 10, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const encrypted = isEncrypted(p.circleId);
  const last = one("SELECT id, body FROM messages WHERE circle_id = ? AND user_id = ? AND kind != 'system' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", p.circleId, p.sender);
  const snapshot = encrypted ? (typeof b.snapshot === 'string' ? b.snapshot.slice(0, 4000) : '') : String(last?.body ?? '').slice(0, 4000);
  run('INSERT OR IGNORE INTO reports (reporter_id, reported_user_id, circle_id, message_id, reason, note, snapshot, unverified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    p.me, p.sender, p.circleId, last?.id ?? null, b.reason, 'message request', snapshot, encrypted ? 1 : 0);
  run('UPDATE circle_members SET request = 2 WHERE circle_id = ? AND user_id = ?', p.circleId, p.me);
  run('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)', p.me, p.sender);
  forgetPresence(p.me, [p.sender]); forgetPresence(p.sender, [p.me]);
  count('report_filed');
  return c.json({ ok: true });
});
