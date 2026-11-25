import { createHash } from 'node:crypto';
import { BLOCKED_NAME, cleanName, sniff, sniffText, type Sniffed } from '../sniff.ts';
import { MAX_FILES, MAX_IMAGE, MAX_OTHER, MAX_THUMB, serveMedia } from '../lib/attachments.ts';
import { afterMessage, blockedInDirect, isFile } from '../lib/moments.ts';
import { all, one, run } from '../db.ts';
import { analyze } from '../lib/messages.ts';
import { announce, circleAccess, insertMessage, isFrozen, limited, mayPost, membership } from '../lib/helpers.ts';
import { app } from '../app.ts';
import { blobs } from '../storage.ts';
import { dropUpload, readUpload, uploadOf } from '../lib/uploads.ts';
import { count } from '../metrics.ts';
import { viewOnceRefusal } from '../lib/viewonce.ts';
import { isEncrypted } from '../lib/e2ee.ts';

app.post('/api/circles/:id/attachments', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (isEncrypted(a.circleId)) return c.json({ error: 'encrypted_chat' }, 409);   // an encrypted chat takes only ciphertext (POST /api/circles/:id/e2ee/messages)
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  if (blockedInDirect(a.circleId, a.user.id)) return c.json({ error: 'blocked' }, 403);
  if (!mayPost(a.circleId, a.user.id)) return c.json({ error: 'admins_only' }, 403);   // before anything is stored
  if (await limited(`upload:${a.user.id}`, 30, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const form = await c.req.parseBody({ all: true }).catch(() => null);
  if (!form) return c.json({ error: 'invalid_attachment' }, 400);
  const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  const once = form.view_once === '1' || form.view_once === 'true';   // opened one time by each recipient; no caption, no thumbnail
  const caption = !once && typeof form.caption === 'string' ? form.caption.trim().slice(0, 4000) : '';
  const cmid = typeof form.client_msg_id === 'string' && form.client_msg_id.length <= 64 ? form.client_msg_id : null;
  const replyRaw = Number(form.reply_to);
  const replyTo = Number.isInteger(replyRaw) && one('SELECT 1 FROM messages WHERE id = ? AND circle_id = ?', replyRaw, a.circleId) ? replyRaw : null;
  // A retry of an upload that already went through returns the original: nothing is stored twice. (Checked first: by then its resumable pieces are gone.)
  if (cmid) {
    const prev = one('SELECT id, seq FROM messages WHERE circle_id = ? AND user_id = ? AND client_msg_id = ?', a.circleId, a.user.id, cmid);
    if (prev) { for (const id of list(form.upload)) { const up = uploadOf(id, a.user.id); if (up) await dropUpload(up.id); } return c.json({ id: prev.id, seq: prev.seq }, 200); }
  }

  // The files come either inside this request, or as the ids of resumable uploads that have finished (POST /api/circles/:id/uploads); never a mix.
  type Incoming = { name: string; size: number; checksum?: string | null; read(): Promise<Buffer | null>; uploadId?: string };
  const direct = (list(form.file).filter(isFile) as File[]).map((f): Incoming => ({ name: f.name, size: f.size, read: async () => Buffer.from(await f.arrayBuffer()) }));
  const ids = list(form.upload);
  if (direct.length && ids.length) return c.json({ error: 'invalid_attachment' }, 400);
  const resumed: Incoming[] = [];
  for (const id of ids) {
    const up = uploadOf(id, a.user.id);
    if (!up || up.circle_id !== a.circleId || resumed.some(x => x.uploadId === up.id)) return c.json({ error: 'upload_not_found' }, 404);
    if (up.received !== up.size) return c.json({ error: 'upload_incomplete', offset: up.received }, 409);
    resumed.push({ name: up.name, size: up.size, checksum: (up.checksum as string | null) ?? null, read: () => readUpload(up), uploadId: up.id });
  }
  const uploads = direct.length ? direct : resumed;
  if (!uploads.length || uploads.length > (once ? 1 : MAX_FILES)) return c.json({ error: 'invalid_attachment' }, 400);
  // Check everything before storing anything: a bad file means no message and no stray blobs.
  const checked: Array<{ buf: Buffer; sn: Sniffed; name: string; w: number | null; h: number | null; thumb: { buf: Buffer; mime: string } | null }> = [];
  for (let i = 0; i < uploads.length; i++) {
    const f = uploads[i];
    const name = cleanName(f.name);
    if (BLOCKED_NAME.test(name) || f.size === 0) return c.json({ error: 'invalid_attachment' }, 400);
    if (f.size > MAX_OTHER) return c.json({ error: 'attachment_too_large', max: MAX_OTHER, name }, 413);
    const buf = await f.read();
    if (!buf) return c.json({ error: 'upload_not_found' }, 404);
    // MED-05: what arrived must be what the sender said they were sending. A mismatch is a corrupt or tampered
    // upload, so no message is made and the pieces are dropped.
    if (f.checksum && createHash('sha256').update(buf).digest('hex') !== f.checksum) {
      for (const g of resumed) await dropUpload(g.uploadId!);
      return c.json({ error: 'checksum_mismatch' }, 422);
    }
    const sn = sniff(buf) ?? sniffText(name, buf);
    if (!sn) return c.json({ error: 'invalid_attachment' }, 400);
    if (sn.family === 'image' && sn.inline && buf.length > MAX_IMAGE) return c.json({ error: 'attachment_too_large', max: MAX_IMAGE, name }, 413);
    let thumb: { buf: Buffer; mime: string } | null = null;
    const t = list(form.thumb)[i];
    if (!once && isFile(t) && t.size > 0 && (sn.family === 'image' || sn.family === 'video')) {
      if (t.size > MAX_THUMB) return c.json({ error: 'invalid_attachment' }, 400);
      const tb = Buffer.from(await t.arrayBuffer());
      const ts = sniff(tb);
      if (!ts || ts.family !== 'image' || !ts.inline) return c.json({ error: 'invalid_attachment' }, 400);
      thumb = { buf: tb, mime: ts.mime };
    }
    const dim = (v: unknown) => { const n = Number(list(v)[i]); return Number.isInteger(n) && n > 0 && n <= 20000 ? n : null; };
    if (once && !(sn.family === 'image' && sn.inline) && sn.family !== 'video') return c.json({ error: 'invalid_attachment' }, 400);   // only photos and videos can be view-once
    checked.push({ buf, sn, name, w: dim(form.w), h: dim(form.h), thumb });
  }

  const sent = insertMessage({ circleId: a.circleId, userId: a.user.id, kind: 'text', body: caption, clientMsgId: cmid, replyTo, viewOnce: once });
  // The same message arrived twice at the same moment (a retry while the first was still being read): the first one stands, nothing is added to it.
  if (sent.duplicate) { for (const f of resumed) await dropUpload(f.uploadId!); return c.json({ id: sent.id, seq: sent.seq }, 200); }
  const store = async (buf: Buffer) => { const { hash, size } = await blobs.put(buf); run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', hash, size); return { hash, size }; };
  for (const f of checked) {
    const { hash, size } = await store(f.buf);
    const kind = f.sn.family === 'image' && f.sn.inline ? 'image' : f.sn.family === 'video' ? 'video' : 'file';
    const mid = Number(run(
      'INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, name, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      a.circleId, sent.id, a.user.id, hash, kind, f.sn.mime, size, f.name, f.w, f.h).lastInsertRowid);
    if (f.thumb) {
      const th = await store(f.thumb.buf);
      run("INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, thumb_of) VALUES (?, ?, ?, ?, 'thumb', ?, ?, ?)",
        a.circleId, sent.id, a.user.id, th.hash, f.thumb.mime, th.size, mid);
    }
  }
  for (const f of resumed) await dropUpload(f.uploadId!);
  run('UPDATE circle_members SET read_seq = MAX(read_seq, ?), delivered_seq = MAX(delivered_seq, ?) WHERE circle_id = ? AND user_id = ?', sent.seq, sent.seq, a.circleId, a.user.id);
  count('attachment_ok');
  announce(a.circleId, sent.id);
  if (caption && !once) { analyze(a.circleId, sent.id, caption); afterMessage(a.circleId, a.user.id, caption, sent.id); }
  return c.json({ id: sent.id, seq: sent.seq }, 201);
});
// Serve a file to circle members only. Content-addressed, so it can be cached forever. Videos support Range (seeking and
// playing before the download finishes). Anything that is not a known-safe image/video is a download, never rendered.
app.get('/api/media/:id', async c => {
  const m = one('SELECT circle_id, message_id, blob_hash, kind, mime, name, (SELECT view_once FROM messages WHERE id = media.message_id) AS view_once FROM media WHERE id = ? AND kind != \'audio\'', Number(c.req.param('id')));
  if (!m || !membership(m.circle_id, c.get('user').id)) return c.json({ error: 'not_found' }, 404);
  const no = m.view_once ? viewOnceRefusal(m.message_id, c.get('user').id) : null;   // a view-once file is served only inside the person's own short window
  if (no) return c.json({ error: no.error }, no.status);
  return serveMedia(c, m);
});
// The circle's media gallery: every attachment still visible to you, newest first.
app.get('/api/circles/:id/media', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const kind = ['image', 'video', 'file'].includes(c.req.query('kind') ?? '') ? c.req.query('kind') : null;
  return c.json(all(
    `SELECT m.id, m.kind, m.mime, m.name, m.size, m.width AS w, m.height AS h, m.message_id AS messageId, msg.seq, msg.created_at AS createdAt,
            (SELECT t.id FROM media t WHERE t.thumb_of = m.id) AS thumb, u.name AS author
       FROM media m JOIN messages msg ON msg.id = m.message_id LEFT JOIN users u ON u.id = m.uploader_id
      WHERE m.circle_id = ? AND m.kind IN ('image','video','file') ${kind ? 'AND m.kind = ?' : ''} AND msg.deleted_at IS NULL AND msg.view_once = 0
        AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = msg.id AND h.user_id = ?)
      ORDER BY m.id DESC LIMIT 300`, ...(kind ? [a.circleId, kind, a.user.id] : [a.circleId, a.user.id])));
});
// A voice note's audio. Served in parts when asked (Range), which is what lets a player jump to any moment of it.
app.get('/api/messages/:mid/audio', async c => {
  const m = one(
    "SELECT m.circle_id, m.id AS message_id, m.view_once, md.blob_hash, md.mime, md.kind, md.name FROM messages m JOIN media md ON md.message_id = m.id WHERE m.id = ? AND md.kind = 'audio'",
    Number(c.req.param('mid')));
  if (!m || !membership(m.circle_id, c.get('user').id)) return c.json({ error: 'not_found' }, 404);
  const no = m.view_once ? viewOnceRefusal(m.message_id, c.get('user').id) : null;
  if (no) return c.json({ error: no.error }, no.status);
  // Through serveMedia for its byte ranges: the iPhone's player asks for the file in ranges and
  // will not play a voice note from a server that answers with the whole file only.
  return serveMedia(c, m);
});
