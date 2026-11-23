import { AUDIO_ALIAS, AUDIO_MIME, MAX_AUDIO, afterMessage, blockedInDirect, cleanWaveform, isFile, clampPage, messagesAfter, messagesBefore, messagesChanged, messagesSince, sendText } from '../lib/moments.ts';
import { analyze } from '../lib/messages.ts';
import { announce, circleAccess, insertMessage, isFrozen, mayPost } from '../lib/helpers.ts';
import { app } from '../app.ts';
import { blobs } from '../storage.ts';
import { one, run } from '../db.ts';
import { isEncrypted } from '../lib/e2ee.ts';

app.get('/api/circles/:id/messages', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (c.req.query('after_rev') !== undefined) return c.json(messagesChanged(a.circleId, a.user.id, Number(c.req.query('after_rev')) || 0));
  if (c.req.query('after_seq') !== undefined) return c.json(messagesSince(a.circleId, a.user.id, Number(c.req.query('after_seq')) || 0));
  // Scrolling up through history: `before_seq` is the seq of the oldest message the screen holds; pages of 50 unless `limit` says otherwise.
  const before = c.req.query('before_seq');
  if (before !== undefined) {
    const seq = Number(before);
    if (!Number.isInteger(seq) || seq < 1) return c.json({ error: 'invalid_value' }, 400);
    return c.json(messagesBefore(a.circleId, a.user.id, seq, clampPage(c.req.query('limit') ?? undefined)));
  }
  const limit = c.req.query('limit');
  return c.json(messagesAfter(a.circleId, a.user.id, Number(c.req.query('after') ?? 0) || 0, limit === undefined ? undefined : clampPage(limit)));
});
app.post('/api/circles/:id/messages', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  const b = await c.req.json().catch(() => ({}));
  const body = String(b.body ?? '').trim().slice(0, 4000);
  if (!body) return c.json({ error: 'empty' }, 400);
  const cmid = typeof b.client_msg_id === 'string' && b.client_msg_id.length <= 64 ? b.client_msg_id : null;
  const replyTo = Number.isInteger(b.reply_to) ? b.reply_to as number : null;
  try {
    const sent = sendText(a.circleId, a.user.id, body, cmid, replyTo, 0, b.mentions, b.preview);
    return c.json({ id: sent.id, seq: sent.seq }, sent.duplicate ? 200 : 201);
  } catch (e: any) {
    if (e?.code === 'blocked') return c.json({ error: 'blocked' }, 403);
    throw e;   // a post refused by the group's rules is answered by app.onError (403 admins_only)
  }
});
app.post('/api/circles/:id/voice', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (isEncrypted(a.circleId)) return c.json({ error: 'encrypted_chat' }, 409);   // an encrypted chat takes only ciphertext (POST /api/circles/:id/e2ee/messages)
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  if (!mayPost(a.circleId, a.user.id)) return c.json({ error: 'admins_only' }, 403);   // before anything is stored
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.audio;
  if (!isFile(file) || file.size === 0 || file.size > MAX_AUDIO) {
    console.warn(`[voice] rejected in circle ${a.circleId}: ${!isFile(file) ? 'no audio file in the form' : file.size === 0 ? 'empty file' : `too large (${file.size} bytes)`}`);
    return c.json({ error: 'invalid_audio' }, 400);
  }
  const raw = file.type.split(';')[0].trim().toLowerCase();
  const mime = AUDIO_ALIAS[raw] ?? raw;
  if (!AUDIO_MIME.has(mime)) { console.warn(`[voice] rejected in circle ${a.circleId}: type "${file.type}" is not accepted`); return c.json({ error: 'invalid_audio' }, 400); }

  // The device keeps a recording until the server confirms it and retries with the same id: a retry returns the first one, nothing is stored twice.
  const once = form?.view_once === '1' || form?.view_once === 'true';   // opened one time by each listener: no transcript, no archive
  const cmid = typeof form?.client_msg_id === 'string' && form.client_msg_id.length <= 64 && form.client_msg_id ? form.client_msg_id : null;
  if (cmid) {
    const prev = one('SELECT id, seq FROM messages WHERE circle_id = ? AND user_id = ? AND client_msg_id = ?', a.circleId, a.user.id, cmid);
    if (prev) return c.json({ id: prev.id, seq: prev.seq }, 200);
  }
  if (blockedInDirect(a.circleId, a.user.id)) return c.json({ error: 'blocked' }, 403);
  const replyRaw = Number(form?.reply_to);
  const replyTo = Number.isInteger(replyRaw) && one('SELECT 1 FROM messages WHERE id = ? AND circle_id = ?', replyRaw, a.circleId) ? replyRaw : null;
  const { hash, size } = await blobs.put(Buffer.from(await file.arrayBuffer()));
  run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', hash, size);
  // Speech-to-text is not wired up yet: a client may supply a transcript, otherwise the clip waits for one.
  const transcript = !once && typeof form?.transcript === 'string' ? form.transcript.trim().slice(0, 4000) : '';
  const dur = Number(form?.duration);
  const durationMs = Number.isInteger(dur) && dur > 0 && dur <= 15 * 60_000 ? dur : null; // as measured by the recorder; the file itself often lacks a usable length
  const sent = insertMessage({
    circleId: a.circleId, userId: a.user.id, kind: 'voice', body: '', audioPath: hash, clientMsgId: cmid, replyTo,
    transcript: transcript || null, archiveStatus: transcript || once ? 'none' : 'pending_transcript', viewOnce: once,
  });
  const messageId = sent.id;
  if (sent.duplicate) return c.json({ id: sent.id, seq: sent.seq }, 200);   // the same recording arrived twice at once
  run("INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, duration_ms, waveform) VALUES (?, ?, ?, ?, 'audio', ?, ?, ?, ?)",
    a.circleId, messageId, a.user.id, hash, mime, size, durationMs, cleanWaveform(form?.waveform));
  run('UPDATE circle_members SET read_seq = MAX(read_seq, ?), delivered_seq = MAX(delivered_seq, ?) WHERE circle_id = ? AND user_id = ?', sent.seq, sent.seq, a.circleId, a.user.id);
  announce(a.circleId, messageId);
  if (transcript) {
    analyze(a.circleId, messageId, transcript);
    afterMessage(a.circleId, a.user.id, transcript, messageId);
  }
  return c.json({ id: messageId, seq: sent.seq }, 201);
});
