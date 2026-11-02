import { eraseMessage, DELETE_WINDOW_MS, MANAGER_DELETE_WINDOW_MS, dropBlobIfUnused, toMs } from '../lib/deletes.ts';
import { all, one, run } from '../db.ts';
import { analyze } from '../lib/messages.ts';
import { app } from '../app.ts';
import { circleAccess, isManager, membership, poke, tx } from '../lib/helpers.ts';
import { isReadOnly } from '../billing.ts';
import { sqlTime } from '../lib/moments.ts';

app.delete('/api/messages/:mid', async c => {
  const m = one('SELECT id, circle_id, user_id, kind, created_at, deleted_at, sealed_on FROM messages WHERE id = ?', Number(c.req.param('mid')));
  const user = c.get('user');
  const member = m && membership(m.circle_id, user.id);
  if (!m || !member || m.kind === 'system' || m.deleted_at) return c.json({ error: 'not_found' }, 404);
  // An opened sealed message belongs to the family's memory: nobody can erase it except its own author, if it opened by mistake
  // (owner's rule, 2026-10-19). Not the owner, not an admin, and no time limit for the author.
  if (m.sealed_on) { if (m.user_id !== user.id) return c.json({ error: 'sealed_protected' }, 403); }
  else {
    if (!isManager(member.role) && m.user_id !== user.id) return c.json({ error: 'forbidden' }, 403);
    const window = isManager(member.role) ? MANAGER_DELETE_WINDOW_MS : DELETE_WINDOW_MS;
    if (Date.now() - toMs(m.created_at) > window) return c.json({ error: 'delete_window_closed' }, 403);
  }

  await eraseMessage(m, user.id);
  return c.json({ ok: true });
});
app.post('/api/messages/:mid/hide', c => {
  const m = one('SELECT id, circle_id, kind FROM messages WHERE id = ?', Number(c.req.param('mid')));
  if (!m || !membership(m.circle_id, c.get('user').id) || m.kind === 'system') return c.json({ error: 'not_found' }, 404);
  run('INSERT OR IGNORE INTO message_hidden (user_id, message_id) VALUES (?, ?)', c.get('user').id, m.id);
  return c.json({ ok: true });
});
// Lets open chats learn that a message was deleted without reloading everything. Call without `since` to get
// the server clock, then pass back the `now` of the previous answer.
app.get('/api/circles/:id/deletions', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const now = sqlTime(Date.now());
  const since = c.req.query('since');
  if (!since || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(since)) return c.json({ items: [], now });
  const items = all('SELECT id, deleted_by AS by FROM messages WHERE circle_id = ? AND deleted_at >= ?', a.circleId, since);
  return c.json({ items, now });
});
// Manual archive request by any member. Still rejected below the absolute floor.
app.post('/api/messages/:mid/archive', c => {
  const m = one('SELECT id, circle_id, kind, body, transcript FROM messages WHERE id = ?', Number(c.req.param('mid')));
  if (!m || !membership(m.circle_id, c.get('user').id) || m.kind === 'system') return c.json({ error: 'not_found' }, 404);
  const text = m.kind === 'voice' ? m.transcript : m.body;
  if (!text) return c.json({ error: 'no_text' }, 409);
  if (isReadOnly(m.circle_id)) return c.json({ error: 'archive_readonly' }, 402);
  analyze(m.circle_id, m.id, text, true);
  poke(m.circle_id);
  return c.json(one('SELECT archive_status AS archiveStatus, score, reason FROM messages WHERE id = ?', m.id));
});
