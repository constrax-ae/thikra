import { app } from '../app.ts';
import { all, one, run } from '../db.ts';
import { announce, announceUpdate, circleAccess, insertMessage, isFrozen, limited, mayPost, membership, tx } from '../lib/helpers.ts';
import { bumpRev, cleanPoll } from '../lib/polls.ts';
import { isEncrypted } from '../lib/e2ee.ts';

// (The memory agent deliberately does not read polls: nothing here calls analyze.)

// ---- polls -----------------------------------------------------------------------------------
// A poll is an ordinary message whose text is the question, with its options beside it. So it is ordered, synced, replied to, deleted
// and searched like any message, and only what is new about it lives here: creating, voting, closing.

app.post('/api/circles/:id/polls', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  if (isEncrypted(a.circleId)) return c.json({ error: 'encrypted_chat' }, 409);   // an encrypted chat takes only ciphertext (POST /api/circles/:id/e2ee/messages)
  if (!mayPost(a.circleId, a.user.id)) return c.json({ error: 'admins_only' }, 403);
  // A poll is for groups. (This also means a blocked person cannot reach someone with one in a one-to-one chat.)
  if (one('SELECT kind FROM circles WHERE id = ?', a.circleId)?.kind === 'direct') return c.json({ error: 'forbidden' }, 403);
  if (await limited(`poll:${a.user.id}`, 20, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const b = await c.req.json().catch(() => ({}));
  const poll = cleanPoll(b);
  if (!poll) return c.json({ error: 'invalid_poll' }, 400);
  const cmid = typeof b.client_msg_id === 'string' && b.client_msg_id.length <= 64 ? b.client_msg_id : null;
  const sent = tx(() => {
    const m = insertMessage({ circleId: a.circleId, userId: a.user.id, kind: 'text', body: poll.question, clientMsgId: cmid });
    if (!m.duplicate) {
      run('INSERT INTO polls (message_id, multiple) VALUES (?, ?)', m.id, poll.multiple ? 1 : 0);
      poll.options.forEach((text, pos) => run('INSERT INTO poll_options (message_id, pos, text) VALUES (?, ?, ?)', m.id, pos, text));
      run('UPDATE circle_members SET read_seq = MAX(read_seq, ?), delivered_seq = MAX(delivered_seq, ?) WHERE circle_id = ? AND user_id = ?', m.seq, m.seq, a.circleId, a.user.id);
    }
    return m;
  });
  if (!sent.duplicate) announce(a.circleId, sent.id);
  return c.json({ id: sent.id, seq: sent.seq }, sent.duplicate ? 200 : 201);
});

/** The poll behind a message, if the caller may act on it: a member of its chat, and the message still there. */
function pollFor(mid: number, userId: number) {
  const m = one('SELECT m.id, m.circle_id, m.user_id, m.deleted_at, p.multiple, p.closed_at FROM messages m JOIN polls p ON p.message_id = m.id WHERE m.id = ?', mid);
  return m && !m.deleted_at && membership(m.circle_id, userId) ? m : null;
}
// Vote: `options` REPLACES my votes in this poll (empty = take my vote back). So nobody can vote twice, and changing is just voting again.
app.post('/api/messages/:mid/vote', async c => {
  const user = c.get('user');
  const p = pollFor(Number(c.req.param('mid')), user.id);
  if (!p) return c.json({ error: 'not_found' }, 404);
  if (p.closed_at) return c.json({ error: 'poll_closed' }, 409);
  if (isFrozen(p.circle_id)) return c.json({ error: 'circle_frozen' }, 423);
  const b = await c.req.json().catch(() => ({}));
  if (!Array.isArray(b.options)) return c.json({ error: 'invalid_value' }, 400);
  const wanted = [...new Set(b.options)] as unknown[];
  const valid = new Set(all('SELECT id FROM poll_options WHERE message_id = ?', p.id).map(r => r.id as number));
  if (wanted.some(x => !Number.isInteger(x) || !valid.has(x as number))) return c.json({ error: 'invalid_value' }, 400);
  if (!p.multiple && wanted.length > 1) return c.json({ error: 'single_choice' }, 400);
  const mine = all('SELECT option_id AS id FROM poll_votes WHERE message_id = ? AND user_id = ?', p.id, user.id).map(r => r.id as number).sort();
  if (JSON.stringify(mine) === JSON.stringify([...(wanted as number[])].sort())) return c.json({ ok: true });   // nothing changes: nothing to announce
  tx(() => {
    run('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?', p.id, user.id);
    for (const id of wanted as number[]) run('INSERT INTO poll_votes (option_id, user_id, message_id) VALUES (?, ?, ?)', id, user.id, p.id);
    bumpRev(p.id);
  });
  announceUpdate(p.circle_id, p.id);
  return c.json({ ok: true });
});
// Only the person who made the poll closes it. The result stays as it was.
app.post('/api/messages/:mid/poll/close', c => {
  const user = c.get('user');
  const p = pollFor(Number(c.req.param('mid')), user.id);
  if (!p) return c.json({ error: 'not_found' }, 404);
  if (p.user_id !== user.id) return c.json({ error: 'forbidden' }, 403);
  if (!p.closed_at) {
    tx(() => { run("UPDATE polls SET closed_at = datetime('now') WHERE message_id = ?", p.id); bumpRev(p.id); });
    announceUpdate(p.circle_id, p.id);
  }
  return c.json({ ok: true });
});
