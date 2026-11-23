import { app } from '../app.ts';
import { all, one, run } from '../db.ts';
import { blobs } from '../storage.ts';
import { sniff } from '../sniff.ts';
import { MAX_IMAGE } from '../lib/attachments.ts';
import { isFile } from '../lib/moments.ts';
import { addMember, tellManagers } from '../lib/groups.ts';
import { dropBlobIfUnused } from '../lib/deletes.ts';
import { circleAccess, circleChanged, isFrozen, isManager, limited, systemMessage } from '../lib/helpers.ts';

// ---- the group's photo ----------------------------------------------------------------------
// Stored like any image of the chat (a media row of this chat with no message), so the one rule "only members can fetch this chat's media" covers it.

/** Who may change the group's name, photo and description: managers, or every member when the group says so. Never in a one-to-one chat. */
function mayEdit(circleId: number, role: string) {
  const c = one('SELECT kind, edit_policy FROM circles WHERE id = ?', circleId)!;
  return c.kind !== 'direct' && (isManager(role) || c.edit_policy === 'all');
}
app.put('/api/circles/:id/photo', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!mayEdit(a.circleId, a.role)) return c.json({ error: 'forbidden' }, 403);
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  if (await limited(`photo:${a.user.id}`, 10, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!isFile(file) || file.size === 0) return c.json({ error: 'invalid_attachment' }, 400);
  if (file.size > MAX_IMAGE) return c.json({ error: 'attachment_too_large' }, 413);
  const buf = Buffer.from(await file.arrayBuffer());
  const sn = sniff(buf);   // by its bytes, never by its name or declared type
  if (!sn || sn.family !== 'image' || !sn.inline) return c.json({ error: 'invalid_attachment' }, 400);
  const { hash, size } = await blobs.put(buf);
  run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', hash, size);
  const old = one('SELECT m.id, m.blob_hash AS hash FROM circles c JOIN media m ON m.id = c.photo_media_id WHERE c.id = ?', a.circleId);
  const photo = Number(run("INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, name) VALUES (?, NULL, ?, ?, 'image', ?, ?, 'photo')",
    a.circleId, a.user.id, hash, sn.mime, size).lastInsertRowid);
  run('UPDATE circles SET photo_media_id = ? WHERE id = ?', photo, a.circleId);
  if (old) {   // the previous photo can no longer be fetched, and its file goes unless something else still uses it
    run('DELETE FROM media WHERE id = ? AND circle_id = ? AND message_id IS NULL', old.id, a.circleId);
    await dropBlobIfUnused(old.hash as string);
  }
  systemMessage(a.circleId, 'photoChanged', { name: a.user.name });
  circleChanged(a.circleId);
  return c.json({ photo });
});
app.delete('/api/circles/:id/photo', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!mayEdit(a.circleId, a.role)) return c.json({ error: 'forbidden' }, 403);
  const old = one('SELECT m.id, m.blob_hash AS hash FROM circles c JOIN media m ON m.id = c.photo_media_id WHERE c.id = ?', a.circleId);
  if (old) {
    run('UPDATE circles SET photo_media_id = NULL WHERE id = ?', a.circleId);
    run('DELETE FROM media WHERE id = ? AND circle_id = ? AND message_id IS NULL', old.id, a.circleId);
    await dropBlobIfUnused(old.hash as string);
    systemMessage(a.circleId, 'photoRemoved', { name: a.user.name });
    circleChanged(a.circleId);
  }
  return c.json({ ok: true });
});

// ---- join approval ----------------------------------------------------------------------------

// The people waiting to join, oldest first. Managers only.
app.get('/api/circles/:id/join-requests', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  return c.json(all('SELECT u.id, u.name, r.created_at AS askedAt FROM join_requests r JOIN users u ON u.id = r.user_id WHERE r.circle_id = ? ORDER BY r.created_at, u.id', a.circleId));
});
// Approve (the person becomes a member) or reject (the request disappears; they never see the group).
app.post('/api/circles/:id/join-requests/:uid', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  const uid = Number(c.req.param('uid'));
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.approve !== 'boolean') return c.json({ error: 'invalid_value' }, 400);
  const user = one('SELECT u.id, u.name FROM join_requests r JOIN users u ON u.id = r.user_id WHERE r.circle_id = ? AND r.user_id = ?', a.circleId, uid);
  if (!user) return c.json({ error: 'not_found' }, 404);
  if (b.approve) {
    if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
    addMember(a.circleId, user);
  } else run('DELETE FROM join_requests WHERE circle_id = ? AND user_id = ?', a.circleId, uid);
  tellManagers(a.circleId);
  return c.json({ ok: true });
});
