import { AUDIO_MIME, MAX_AUDIO, afterMessage, isFile, messagesAfter, messagesChanged, messagesSince, sendText } from '../lib/moments.ts';
import { analyze } from '../lib/messages.ts';
import { announce, circleAccess, insertMessage, isFrozen } from '../lib/helpers.ts';
import { app } from '../app.ts';
import { blobs } from '../storage.ts';
import { run } from '../db.ts';

app.get('/api/circles/:id/messages', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (c.req.query('after_rev') !== undefined) return c.json(messagesChanged(a.circleId, a.user.id, Number(c.req.query('after_rev')) || 0));
  if (c.req.query('after_seq') !== undefined) return c.json(messagesSince(a.circleId, a.user.id, Number(c.req.query('after_seq')) || 0));
  return c.json(messagesAfter(a.circleId, a.user.id, Number(c.req.query('after') ?? 0) || 0));
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
    const sent = sendText(a.circleId, a.user.id, body, cmid, replyTo);
    return c.json({ id: sent.id, seq: sent.seq }, sent.duplicate ? 200 : 201);
  } catch (e: any) {
    if (e?.code === 'blocked') return c.json({ error: 'blocked' }, 403);
    throw e;
  }
});
app.post('/api/circles/:id/voice', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.audio;
  if (!isFile(file) || file.size === 0 || file.size > MAX_AUDIO) return c.json({ error: 'invalid_audio' }, 400);
  const mime = file.type.split(';')[0].trim().toLowerCase();
  if (!AUDIO_MIME.has(mime)) return c.json({ error: 'invalid_audio' }, 400);

  const { hash, size } = await blobs.put(Buffer.from(await file.arrayBuffer()));
  run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', hash, size);
  // Speech-to-text is not wired up yet: a client may supply a transcript, otherwise the clip waits for one.
  const transcript = typeof form?.transcript === 'string' ? form.transcript.trim().slice(0, 4000) : '';
  const dur = Number(form?.duration);
  const durationMs = Number.isInteger(dur) && dur > 0 && dur <= 15 * 60_000 ? dur : null; // as measured by the recorder; the file itself often lacks a usable length
  const messageId = insertMessage({
    circleId: a.circleId, userId: a.user.id, kind: 'voice', body: '', audioPath: hash,
    transcript: transcript || null, archiveStatus: transcript ? 'none' : 'pending_transcript',
  }).id;
  run("INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, duration_ms) VALUES (?, ?, ?, ?, 'audio', ?, ?, ?)",
    a.circleId, messageId, a.user.id, hash, mime, size, durationMs);
  announce(a.circleId, messageId);
  if (transcript) {
    analyze(a.circleId, messageId, transcript);
    afterMessage(a.circleId, a.user.id, transcript, messageId);
  }
  return c.json({ id: messageId }, 201);
});
