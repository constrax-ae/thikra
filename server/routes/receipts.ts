import { EDIT_WINDOW_MS, REACTIONS } from '../lib/receipts.ts';
import { messageInfo } from '../lib/marks.ts';
import { pruneMentions } from '../lib/polls.ts';
import { pruneLinkCard } from '../lib/cards.ts';
import { announceUpdate, circleAccess, markRead, membership, searchable, mayPost } from '../lib/helpers.ts';
import { app } from '../app.ts';
import { one, run } from '../db.ts';
import { toMs } from '../lib/deletes.ts';
import { isEncrypted } from '../lib/e2ee.ts';

// ---- receipts, reactions, edits ------------------------------------------------------------

// HTTP twin of the socket's `read` frame, for clients without a live connection.
app.post('/api/circles/:id/read', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  markRead(a.circleId, a.user.id, Number(b.seq));
  return c.json({ ok: true });
});
// "Info" on your own message: who has read it and who has received it, with the time for each person. Only the author may ask.
app.get('/api/messages/:mid/info', c => {
  const m = one('SELECT id, circle_id, user_id, seq, kind, deleted_at FROM messages WHERE id = ?', Number(c.req.param('mid')));
  const user = c.get('user');
  if (!m || !membership(m.circle_id, user.id) || m.kind === 'system' || m.deleted_at) return c.json({ error: 'not_found' }, 404);
  if (m.user_id !== user.id) return c.json({ error: 'forbidden' }, 403);
  return c.json(messageInfo({ id: m.id, circle_id: m.circle_id, user_id: m.user_id, seq: m.seq }));
});
// One reaction per member per message; the same emoji again, or `null`, removes it. Works on any message the member can see.
app.post('/api/messages/:mid/react', async c => {
  const m = one('SELECT id, circle_id, kind, deleted_at FROM messages WHERE id = ?', Number(c.req.param('mid')));
  const user = c.get('user');
  if (!m || !membership(m.circle_id, user.id) || m.kind === 'system' || m.deleted_at) return c.json({ error: 'not_found' }, 404);
  if (isEncrypted(m.circle_id)) return c.json({ error: 'encrypted_chat' }, 409);   // a reaction there is a control message (kind ctl): the emoji is not stored readable
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
  if (isEncrypted(m.circle_id)) return c.json({ error: 'encrypted_chat' }, 409);   // an edit there is a control message (POST /api/circles/:id/e2ee/messages, kind edit)
  if (m.sealed_on) return c.json({ error: 'sealed_protected' }, 403);
  if (m.user_id !== user.id) return c.json({ error: 'forbidden' }, 403);
  if (one('SELECT 1 FROM polls WHERE message_id = ?', m.id)) return c.json({ error: 'forbidden' }, 403);   // a poll's question cannot change under the votes
  if (one("SELECT 1 FROM message_cards WHERE message_id = ? AND type != 'link'", m.id)) return c.json({ error: 'forbidden' }, 403);   // a contact, location, sticker or GIF has no text to fix
  if (!mayPost(m.circle_id, user.id)) return c.json({ error: 'admins_only' }, 403);   // rewriting an old message is posting too
  if (Date.now() - toMs(m.created_at) > EDIT_WINDOW_MS) return c.json({ error: 'edit_window_closed' }, 403);
  const b = await c.req.json().catch(() => ({}));
  const body = String(b.body ?? '').trim().slice(0, 4000);
  if (!body) return c.json({ error: 'empty' }, 400);
  run("UPDATE messages SET body = ?, search_text = ?, edited_at = datetime('now') WHERE id = ?", body, searchable(body), m.id);
  pruneMentions(m.id, body);
  pruneLinkCard(m.id, body);
  announceUpdate(m.circle_id, m.id);
  return c.json({ ok: true });
});
