import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { blobs } from '../storage.ts';
import { cleanName, sniff, BLOCKED_NAME } from '../sniff.ts';
import { circleAccess, isFrozen, isManager, limited, membership } from '../lib/helpers.ts';
import { isFile } from '../lib/moments.ts';
import { MAX_THUMB, serveMedia } from '../lib/attachments.ts';
import { albumLimit, albumOf, albumYears, classifyAlbumFile, cleanTaken } from '../lib/albums.ts';
import { dropBlobIfUnused } from '../lib/deletes.ts';
import { hasRoomToArchive, isReadOnly } from '../billing.ts';
import { count } from '../metrics.ts';

// Albums: the family's pictures and voices from an old chat. The client reads the export on the person's own device and uploads only
// the files they chose, one by one. Managers create and fill albums; every member browses them. Files are stored as ARCHIVED media of the
// circle (so they count against the family vault and are served like any attachment) with no chat message behind them.

app.post('/api/circles/:id/albums', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  if (one('SELECT kind FROM circles WHERE id = ?', a.circleId)!.kind !== 'circle') return c.json({ error: 'not_a_circle' }, 409);
  if (isReadOnly(a.circleId)) return c.json({ error: 'archive_readonly' }, 402);
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  const b = await c.req.json().catch(() => ({}));
  const title = String(b.title ?? '').trim().slice(0, 80);
  if (!title) return c.json({ error: 'name_required' }, 400);
  const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
  const r = run("INSERT INTO albums (circle_id, title, source, range_from, range_to, created_by) VALUES (?, ?, ?, ?, ?, ?)",
    a.circleId, title, b.source === 'whatsapp' ? 'whatsapp' : 'manual', day(b.from), day(b.to), a.user.id);
  return c.json({ id: Number(r.lastInsertRowid) }, 201);
});

app.get('/api/circles/:id/albums', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  return c.json(all('SELECT id, title, source, range_from AS rangeFrom, range_to AS rangeTo, created_at AS createdAt FROM albums WHERE circle_id = ? ORDER BY id DESC', a.circleId)
    .map(al => ({ ...al, years: albumYears(al.id) })));
});

/** One file into an album. Everything is checked before anything is stored. Re-sending the same file is a no-op (`duplicate`). */
app.post('/api/albums/:aid/items', async c => {
  const user = c.get('user');
  const al = one('SELECT id, circle_id FROM albums WHERE id = ?', Number(c.req.param('aid')));
  const member = al && membership(al.circle_id, user.id);
  if (!al || !member) return c.json({ error: 'not_found' }, 404);
  if (!isManager(member.role)) return c.json({ error: 'forbidden' }, 403);
  if (isReadOnly(al.circle_id)) return c.json({ error: 'archive_readonly' }, 402);
  if (await limited(`album:${user.id}`, 1500, 600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const form = await c.req.parseBody().catch(() => null);
  if (!form) return c.json({ error: 'invalid_attachment' }, 400);
  const file = form.file;
  if (!isFile(file) || file.size === 0) return c.json({ error: 'invalid_attachment' }, 400);
  const name = cleanName(file.name);
  if (BLOCKED_NAME.test(name)) return c.json({ error: 'invalid_attachment' }, 400);
  const when = cleanTaken(form.takenAt);
  if (!when) return c.json({ error: 'invalid_date' }, 400);
  const buf = Buffer.from(await file.arrayBuffer());
  const cls = classifyAlbumFile(buf, name);
  if (!cls) return c.json({ error: 'invalid_attachment' }, 400);
  if (buf.length > albumLimit(cls.kind)) return c.json({ error: 'attachment_too_large' }, 413);
  let thumb: { buf: Buffer; mime: string } | null = null;
  if (isFile(form.thumb) && form.thumb.size > 0 && cls.kind !== 'voice') {
    if (form.thumb.size > MAX_THUMB) return c.json({ error: 'invalid_attachment' }, 400);
    const tb = Buffer.from(await form.thumb.arrayBuffer());
    const ts = sniff(tb);
    if (!ts || ts.family !== 'image' || !ts.inline) return c.json({ error: 'invalid_attachment' }, 400);
    thumb = { buf: tb, mime: ts.mime };
  }
  const put = await blobs.put(buf);
  if (one('SELECT 1 FROM album_items WHERE album_id = ? AND blob_hash = ?', al.id, put.hash)) return c.json({ ok: true, duplicate: true });
  if (!hasRoomToArchive(al.circle_id, put.size)) return c.json({ error: 'storage_full' }, 413);
  run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', put.hash, put.size);
  const dim = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 20000 ? n : null; };
  const mediaKind = cls.kind === 'voice' ? 'audio' : cls.kind;
  const mid = Number(run(
    'INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, archived, name, width, height) VALUES (?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
    al.circle_id, user.id, put.hash, mediaKind, cls.mime, put.size, name, dim(form.w), dim(form.h)).lastInsertRowid);
  if (thumb) {
    const th = await blobs.put(thumb.buf);
    run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', th.hash, th.size);
    run("INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, archived, thumb_of) VALUES (?, NULL, ?, ?, 'thumb', ?, ?, 1, ?)", al.circle_id, user.id, th.hash, thumb.mime, th.size, mid);
  }
  const sender = typeof form.sender === 'string' ? form.sender.trim().slice(0, 60) : null;
  const r = run('INSERT INTO album_items (album_id, circle_id, media_id, blob_hash, kind, taken_at, day, year, sender) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    al.id, al.circle_id, mid, put.hash, cls.kind, when.takenAt, when.day, when.year, sender || null);
  count('album_item');
  return c.json({ id: Number(r.lastInsertRowid), kind: cls.kind }, 201);
});

/** The items of one album, oldest first, a page at a time (by year and kind if wanted). */
app.get('/api/albums/:aid/items', c => {
  const al = one('SELECT id, circle_id FROM albums WHERE id = ?', Number(c.req.param('aid')));
  if (!al || !membership(al.circle_id, c.get('user').id)) return c.json({ error: 'not_found' }, 404);
  const year = Number(c.req.query('year')) || null;
  const kind = ['image', 'voice', 'video'].includes(c.req.query('kind') ?? '') ? c.req.query('kind') : null;
  const after = Number(c.req.query('after')) || 0;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 60, 1), 200);
  return c.json(all(
    `SELECT i.id, i.kind, i.taken_at AS takenAt, i.year, i.sender, m.name, m.width AS w, m.height AS h, m.duration_ms AS durationMs,
            (SELECT t.id FROM media t WHERE t.thumb_of = i.media_id) IS NOT NULL AS hasThumb
       FROM album_items i JOIN media m ON m.id = i.media_id
      WHERE i.album_id = ? AND i.id > ? ${year ? 'AND i.year = ?' : ''} ${kind ? 'AND i.kind = ?' : ''}
      ORDER BY i.id LIMIT ?`, al.id, after, ...(year ? [year] : []), ...(kind ? [kind] : []), limit)
    .map(r => ({ ...r, hasThumb: !!r.hasThumb })));
});

/** The file (or its small preview with ?thumb=1) of one album item, for circle members. */
app.get('/api/album-items/:id/file', async c => {
  const it = one('SELECT i.circle_id, i.media_id FROM album_items i WHERE i.id = ?', Number(c.req.param('id')));
  if (!it || !membership(it.circle_id, c.get('user').id)) return c.json({ error: 'not_found' }, 404);
  const m = c.req.query('thumb') === '1'
    ? one("SELECT blob_hash, kind, mime, name FROM media WHERE thumb_of = ?", it.media_id)
    : one('SELECT blob_hash, kind, mime, name FROM media WHERE id = ?', it.media_id);
  if (!m) return c.json({ error: 'not_found' }, 404);
  return serveMedia(c, m);
});

/** Remove one item (a manager) or a whole album (a manager). The files go when nothing else uses them. */
async function eraseItems(rows: Array<{ media_id: number }>) {
  for (const r of rows) {
    const ms = all('SELECT id, blob_hash FROM media WHERE id = ? OR thumb_of = ?', r.media_id, r.media_id);
    run('DELETE FROM media WHERE id = ? OR thumb_of = ?', r.media_id, r.media_id);
    for (const m of ms) await dropBlobIfUnused(m.blob_hash);
  }
}
app.delete('/api/album-items/:id', async c => {
  const it = one('SELECT id, circle_id, media_id FROM album_items WHERE id = ?', Number(c.req.param('id')));
  const m = it && membership(it.circle_id, c.get('user').id);
  if (!it || !m) return c.json({ error: 'not_found' }, 404);
  if (!isManager(m.role)) return c.json({ error: 'forbidden' }, 403);
  run('DELETE FROM album_items WHERE id = ?', it.id);
  await eraseItems([it as { media_id: number }]);
  return c.json({ ok: true });
});
app.delete('/api/circles/:id/albums/:aid', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  const al = albumOf(a.circleId, Number(c.req.param('aid')));
  if (!al) return c.json({ error: 'not_found' }, 404);
  const items = all('SELECT media_id FROM album_items WHERE album_id = ?', al.id) as Array<{ media_id: number }>;
  run('DELETE FROM album_items WHERE album_id = ?', al.id);
  run('DELETE FROM albums WHERE id = ?', al.id);
  await eraseItems(items);
  return c.json({ ok: true, removed: items.length });
});
