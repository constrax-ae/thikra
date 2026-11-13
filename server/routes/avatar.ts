import { app } from '../app.ts';
import { one, run } from '../db.ts';
import { blobs } from '../storage.ts';
import { sniff } from '../sniff.ts';
import { isFile } from '../lib/moments.ts';
import { limited } from '../lib/helpers.ts';
import { dropBlobIfUnused } from '../lib/deletes.ts';

// A person's profile picture. Set and removed only by the person; seen only by the person and by people who share a
// circle with them (a stranger who guesses a user id gets the same "not found" as for someone without a picture).

const MAX_AVATAR = 5 * 1024 * 1024;
const IMAGE = /^image\/(jpeg|png|webp)$/;

app.post('/api/me/avatar', async c => {
  const u = c.get('user');
  if (await limited(`avatar:${u.id}`, 20, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!isFile(file) || file.size === 0) return c.json({ error: 'invalid_attachment' }, 400);
  if (file.size > MAX_AVATAR) return c.json({ error: 'attachment_too_large' }, 413);
  const buf = Buffer.from(await file.arrayBuffer());
  const kind = sniff(buf);   // what it is comes from its bytes, never from its name or the claimed type
  if (!kind || !IMAGE.test(kind.mime)) return c.json({ error: 'invalid_attachment' }, 400);
  const { hash, size } = await blobs.put(buf);
  run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', hash, size);
  const old = one('SELECT avatar_hash FROM users WHERE id = ?', u.id)?.avatar_hash as string | null;
  run("UPDATE users SET avatar_hash = ?, avatar_at = datetime('now') WHERE id = ?", hash, u.id);
  if (old && old !== hash) await dropBlobIfUnused(old);
  return c.json({ ok: true, avatarAt: one('SELECT avatar_at FROM users WHERE id = ?', u.id)?.avatar_at });
});

app.delete('/api/me/avatar', async c => {
  const u = c.get('user');
  const old = one('SELECT avatar_hash FROM users WHERE id = ?', u.id)?.avatar_hash as string | null;
  run('UPDATE users SET avatar_hash = NULL, avatar_at = NULL WHERE id = ?', u.id);
  if (old) await dropBlobIfUnused(old);
  return c.json({ ok: true });
});

app.get('/api/users/:id/avatar', async c => {
  const me = c.get('user');
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'not_found' }, 404);
  const shares = id === me.id || !!one(
    'SELECT 1 FROM circle_members a JOIN circle_members b ON a.circle_id = b.circle_id JOIN circles c ON c.id = a.circle_id WHERE a.user_id = ? AND b.user_id = ? AND c.deleted_at IS NULL',
    me.id, id);
  const row = shares ? one('SELECT avatar_hash FROM users WHERE id = ?', id) : null;
  if (!row?.avatar_hash) return c.json({ error: 'not_found' }, 404);
  const data = await blobs.get(row.avatar_hash);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const kind = sniff(data);
  return new Response(new Uint8Array(data), {
    headers: { 'content-type': kind?.mime ?? 'image/jpeg', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=300' },
  });
});
