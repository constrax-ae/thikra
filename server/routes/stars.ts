import { MANY_TIMES } from '../lib/stars.ts';
import { MSG_COLS } from '../lib/messages.ts';
import { all, one, run, type Row } from '../db.ts';
import { app } from '../app.ts';
import { blockedInDirect, sendText } from '../lib/moments.ts';
import { announce, circleAccess, decorate, insertMessage, isFrozen, limited, membership, mayPost } from '../lib/helpers.ts';
import { isEncrypted } from '../lib/e2ee.ts';

// ---- stars and forwarding -------------------------------------------------------------------

// A personal bookmark: only you see it, and it never changes the message for anyone else.
app.post('/api/messages/:mid/star', async c => {
  const m = one('SELECT id, circle_id, kind, deleted_at, view_once FROM messages WHERE id = ?', Number(c.req.param('mid')));
  const user = c.get('user');
  if (!m || !membership(m.circle_id, user.id) || m.kind === 'system' || m.deleted_at || m.view_once) return c.json({ error: 'not_found' }, 404);
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

// Forward a message you can see into other circles you belong to: text, or a photo, video, document or voice note.
// Media travels as a copy of the SAME stored bytes (content-addressed, so nothing is uploaded or stored twice) under a
// new message of your own; the original is untouched. It carries a hop count (shown as "Forwarded", then "Forwarded
// many times"), is never read by the archive agent, and the quoted-reply link does not travel with it.
app.post('/api/messages/:mid/forward', async c => {
  const m = one('SELECT id, circle_id, kind, body, transcript, audio_path, forward_count, deleted_at, view_once FROM messages WHERE id = ?', Number(c.req.param('mid')));
  const user = c.get('user');
  if (!m || !membership(m.circle_id, user.id) || (m.kind !== 'text' && m.kind !== 'voice') || m.deleted_at || m.view_once) return c.json({ error: 'not_found' }, 404);
  if (one('SELECT 1 FROM message_hidden WHERE message_id = ? AND user_id = ?', m.id, user.id)) return c.json({ error: 'not_found' }, 404);   // deleted for me: not mine to pass on
  if (one('SELECT 1 FROM polls WHERE message_id = ?', m.id) || one("SELECT 1 FROM message_cards WHERE message_id = ? AND type != 'link'", m.id)) return c.json({ error: 'not_found' }, 404);   // a poll (or a live location) is not content to pass around
  if (isEncrypted(m.circle_id)) return c.json({ error: 'encrypted_chat' }, 409);   // forwarding is done on the device: decrypt, then encrypt for the other chat
  // The files of this message, with each one's thumbnail. 'thumb' rows hang off their own picture, not off the message.
  const atts = all("SELECT id, blob_hash, kind, mime, size, name, width, height, duration_ms, waveform FROM media WHERE message_id = ? AND kind != 'thumb' ORDER BY id", m.id);
  const thumbs = new Map<number, Row>(all("SELECT thumb_of, blob_hash, mime, size FROM media WHERE message_id = ? AND kind = 'thumb'", m.id).map(t => [t.thumb_of as number, t]));
  if (!atts.length && !String(m.body ?? '').trim()) return c.json({ error: 'not_found' }, 404);   // nothing to forward (a voice note whose audio row is gone)
  const b = await c.req.json().catch(() => ({}));
  const targets = [...new Set((Array.isArray(b.circles) ? b.circles : []).map(Number).filter(Number.isInteger))] as number[];
  if (!targets.length || targets.length > MANY_TIMES) return c.json({ error: 'invalid_targets' }, 400);
  // A chain message (passed along five times or more) goes to ONE chat at a time, as WhatsApp does: the friction is
  // the point — it is what stops a chain from fanning out through a family in an afternoon.
  if ((m.forward_count as number) >= MANY_TIMES && targets.length > 1) return c.json({ error: 'chain_one_chat' }, 400);
  if (targets.some(t => !membership(t, user.id))) return c.json({ error: 'not_found' }, 404);
  if (targets.some(t => isEncrypted(t))) return c.json({ error: 'encrypted_chat' }, 409);   // and nothing readable is put into an encrypted chat
  if (targets.some(t => isFrozen(t))) return c.json({ error: 'circle_frozen' }, 423);
  if (await limited(`fwd:${user.id}`, 30, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  if (targets.some(t => blockedInDirect(t, user.id))) return c.json({ error: 'blocked' }, 403);
  if (targets.some(t => !mayPost(t, user.id))) return c.json({ error: 'admins_only' }, 403);   // all or nothing: no half-forward
  const hops = (m.forward_count as number) + 1;
  const sent = targets.map(t => {
    if (!atts.length) return sendText(t, user.id, m.body, null, null, hops).id;
    const msg = insertMessage({
      circleId: t, userId: user.id, kind: m.kind as 'text' | 'voice', body: m.kind === 'voice' ? '' : m.body,
      audioPath: m.audio_path ?? undefined, transcript: m.transcript ?? null, forwardCount: hops,
    });
    for (const a of atts) {
      const copy = Number(run(
        'INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, name, width, height, duration_ms, waveform) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        t, msg.id, user.id, a.blob_hash, a.kind, a.mime, a.size, a.name, a.width, a.height, a.duration_ms, a.waveform).lastInsertRowid);
      const th = thumbs.get(a.id as number);
      if (th) run("INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, thumb_of) VALUES (?, ?, ?, ?, 'thumb', ?, ?, ?)",
        t, msg.id, user.id, th.blob_hash, th.mime, th.size, copy);
    }
    // The sender has seen their own chat up to here, as after any send of theirs.
    run('UPDATE circle_members SET read_seq = MAX(read_seq, ?), delivered_seq = MAX(delivered_seq, ?) WHERE circle_id = ? AND user_id = ?', msg.seq, msg.seq, t, user.id);
    announce(t, msg.id);
    return msg.id;
  });
  return c.json({ sent });
});
