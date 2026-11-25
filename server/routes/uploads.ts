import { bodyLimit } from 'hono/body-limit';
import { BLOCKED_NAME, cleanName } from '../sniff.ts';
import { MAX_OTHER } from '../lib/attachments.ts';
import { MAX_CHUNK, MAX_OPEN, appendUpload, cleanChecksum, dropUpload, openCount, openUpload, purgeStaleUploads, uploadOf } from '../lib/uploads.ts';
import { blockedInDirect } from '../lib/moments.ts';
import { circleAccess, isFrozen, limited, mayPost } from '../lib/helpers.ts';
import { app } from '../app.ts';
import { isEncrypted } from '../lib/e2ee.ts';

// ---- resumable uploads (the rules are in lib/uploads.ts) ------------------------------------
// 1. POST /api/circles/:id/uploads { name, size }      -> { id, offset: 0, chunk }
// 2. PUT  /api/uploads/:uid?offset=N   (raw bytes)       -> { offset }     (409 with the real offset if N is not where the server is)
// 3. GET  /api/uploads/:uid                              -> { offset, size }   (after a dropped connection: where to continue)
// 4. POST /api/circles/:id/attachments with `upload` = the ids, in order   -> the message
//    DELETE /api/uploads/:uid cancels. Nothing appears in the chat before step 4.

app.post('/api/circles/:id/uploads', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  if (blockedInDirect(a.circleId, a.user.id)) return c.json({ error: 'blocked' }, 403);
  if (!mayPost(a.circleId, a.user.id)) return c.json({ error: 'admins_only' }, 403);   // refused before a single byte is sent
  if (await limited(`upload-open:${a.user.id}`, 60, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const b = await c.req.json().catch(() => ({}));
  const encrypted = isEncrypted(a.circleId);
  const name = encrypted ? 'blob' : cleanName(String(b.name ?? ''));   // an encrypted file has no name the server may keep (the real one is inside the ciphertext)
  if (BLOCKED_NAME.test(name) || !Number.isInteger(b.size) || b.size <= 0) return c.json({ error: 'invalid_attachment' }, 400);
  if (b.size > MAX_OTHER) return c.json({ error: 'attachment_too_large', max: MAX_OTHER, name }, 413);
  // MED-05: the sender may declare the file's SHA-256 here; the server checks the bytes against it before the
  // message is made, so a file that arrived wrong never reaches the chat.
  const checksum = cleanChecksum(b.checksum);
  if (checksum === undefined) return c.json({ error: 'invalid_value' }, 400);
  await purgeStaleUploads();
  if (openCount(a.user.id) >= MAX_OPEN) return c.json({ error: 'too_many_requests' }, 429);
  return c.json({ id: openUpload(a.user.id, a.circleId, name, b.size, checksum), offset: 0, chunk: MAX_CHUNK }, 201);
});
app.get('/api/uploads/:uid', c => {
  const up = uploadOf(c.req.param('uid'), c.get('user').id);
  return up ? c.json({ offset: up.received, size: up.size }) : c.json({ error: 'upload_not_found' }, 404);
});
app.put('/api/uploads/:uid', bodyLimit({ maxSize: MAX_CHUNK, onError: c => c.json({ error: 'chunk_too_large', max: MAX_CHUNK }, 413) }), async c => {
  const up = uploadOf(c.req.param('uid'), c.get('user').id);
  if (!up) return c.json({ error: 'upload_not_found' }, 404);
  const offset = Number(c.req.query('offset'));
  if (!Number.isInteger(offset) || offset < 0) return c.json({ error: 'invalid_value' }, 400);
  const piece = Buffer.from(await c.req.arrayBuffer());
  const r = await appendUpload(up, offset, piece);
  return r.ok ? c.json({ offset: r.offset }) : c.json({ error: 'offset_mismatch', offset: r.offset }, 409);
});
app.delete('/api/uploads/:uid', async c => {
  const up = uploadOf(c.req.param('uid'), c.get('user').id);
  if (up) await dropUpload(up.id);
  return c.json({ ok: true });   // cancelling twice, or something already gone, is still "cancelled"
});
