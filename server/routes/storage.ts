import { PERSON_COLS, cleanDate } from '../lib/storage.ts';
import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { circleAccess, isManager, membership, poke } from '../lib/helpers.ts';
import { eraseMessage } from '../lib/deletes.ts';
import { subscription, usage } from '../billing.ts';
import { isEncrypted } from '../lib/e2ee.ts';

// ---- storage, plan and persons -------------------------------------------------------

app.get('/api/circles/:id/billing', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const sub = subscription(a.circleId);
  const sponsor = sub.sponsorId ? (one('SELECT name FROM users WHERE id = ?', sub.sponsorId)?.name ?? null) : null;
  const request = one('SELECT plan, status, created_at AS createdAt FROM storage_requests WHERE circle_id = ? ORDER BY id DESC LIMIT 1', a.circleId) ?? null;
  return c.json({ plan: sub.plan, status: sub.status, sponsor, periodEnd: sub.periodEnd, bonusBytes: sub.bonusBytes, request, stripe: !!one('SELECT stripe_customer s FROM subscriptions WHERE circle_id = ?', a.circleId)?.s, ...usage(a.circleId) });
});
app.get('/api/circles/:id/persons', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  return c.json(all(`SELECT ${PERSON_COLS} FROM persons WHERE circle_id = ? ORDER BY id`, a.circleId));
});
app.post('/api/circles/:id/persons', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  if (isEncrypted(a.circleId)) return c.json({ error: 'encrypted_chat' }, 409);   // a readable name must never be stored for an encrypted group
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? '').trim().slice(0, 60);
  const birth = cleanDate(b.birthDate ?? null);
  const death = cleanDate(b.deathDate ?? null);
  if (!name || birth === undefined || death === undefined) return c.json({ error: 'invalid_person' }, 400);
  const relation = typeof b.relation === 'string' ? b.relation.trim().slice(0, 40) || null : null;
  const r = run('INSERT INTO persons (circle_id, name, relation, birth_date, death_date) VALUES (?, ?, ?, ?, ?)', a.circleId, name, relation, birth, death);
  return c.json({ id: Number(r.lastInsertRowid) }, 201);
});
app.patch('/api/persons/:pid', async c => {
  const p = one('SELECT * FROM persons WHERE id = ?', Number(c.req.param('pid')));
  const m = p && membership(p.circle_id, c.get('user').id);
  if (!p || !m) return c.json({ error: 'not_found' }, 404);
  if (!isManager(m.role)) return c.json({ error: 'forbidden' }, 403);
  if (isEncrypted(p.circle_id)) return c.json({ error: 'encrypted_chat' }, 409);
  const b = await c.req.json().catch(() => ({}));
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : p.name;
  const birth = 'birthDate' in b ? cleanDate(b.birthDate) : p.birth_date;
  const death = 'deathDate' in b ? cleanDate(b.deathDate) : p.death_date;
  if (birth === undefined || death === undefined) return c.json({ error: 'invalid_person' }, 400);
  const relation = 'relation' in b ? (typeof b.relation === 'string' ? b.relation.trim().slice(0, 40) || null : null) : p.relation;
  run('UPDATE persons SET name = ?, relation = ?, birth_date = ?, death_date = ? WHERE id = ?', name, relation, birth, death, p.id);
  return c.json({ ok: true });
});

// ---- what each chat is using, and clearing out the big old files ------------------------------
// Two different things, deliberately: SEEING the usage is private and harmless, so anyone may do it for their own
// chats. REMOVING files is not — media here lives on the server and belongs to everyone in the chat, so a sweep
// deletes for everyone, is for managers only, and always offers to count first.

/** Every chat this person is in, biggest first: what its files add up to and what they are. */
app.get('/api/storage/chats', c => {
  const u = c.get('user');
  return c.json(all(
    `SELECT c.id, c.name, c.kind, cm.role,
            COALESCE(SUM(m.size), 0) AS bytes,
            COALESCE(SUM(CASE WHEN m.kind = 'image' THEN m.size ELSE 0 END), 0) AS imageBytes,
            COALESCE(SUM(CASE WHEN m.kind = 'video' THEN m.size ELSE 0 END), 0) AS videoBytes,
            COALESCE(SUM(CASE WHEN m.kind = 'audio' THEN m.size ELSE 0 END), 0) AS voiceBytes,
            COALESCE(SUM(CASE WHEN m.kind = 'file'  THEN m.size ELSE 0 END), 0) AS fileBytes,
            COALESCE(SUM(CASE WHEN m.archived = 1 THEN m.size ELSE 0 END), 0) AS archivedBytes,
            COUNT(m.id) AS files
       FROM circle_members cm
       JOIN circles c ON c.id = cm.circle_id AND c.deleted_at IS NULL
       LEFT JOIN (SELECT DISTINCT circle_id, blob_hash, id, kind, size, archived FROM media WHERE kind != 'thumb') m ON m.circle_id = c.id
      WHERE cm.user_id = ? AND cm.request = 0
      GROUP BY c.id ORDER BY bytes DESC, c.id`, u.id));
});

const KINDS = ['image', 'video', 'audio', 'file'] as const;

/**
 * Clear out files in one chat: by kind, by age, by size. `preview` (the default) only counts them.
 * Archived media is never swept — it is the family's Memory, which is the point of the product.
 * What goes, goes for everyone, through the same path as deleting a message, so each one leaves its tombstone.
 */
app.post('/api/circles/:id/media/cleanup', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  const kinds = Array.isArray(b.kinds) && b.kinds.length ? KINDS.filter(k => b.kinds.includes(k)) : [...KINDS];
  if (!kinds.length) return c.json({ error: 'invalid_value' }, 400);
  const days = Number.isFinite(b.olderThanDays) && b.olderThanDays >= 0 ? Math.min(3650, Math.floor(b.olderThanDays)) : 0;
  const minBytes = Number.isFinite(b.minBytes) && b.minBytes > 0 ? Math.floor(b.minBytes) : 0;
  const marks = kinds.map(() => '?').join(',');
  const rows = all(
    `SELECT m.id AS mid, SUM(md.size) AS bytes FROM messages m
       JOIN media md ON md.message_id = m.id
      WHERE m.circle_id = ? AND m.deleted_at IS NULL AND md.archived = 0 AND md.kind IN (${marks})
        AND md.created_at <= datetime('now', ?)
      GROUP BY m.id HAVING SUM(md.size) >= ?`, a.circleId, ...kinds, `-${days} days`, minBytes);
  const bytes = rows.reduce((n, r) => n + Number(r.bytes), 0);
  if (b.preview !== false) return c.json({ preview: true, messages: rows.length, bytes });
  for (const r of rows) {
    const m = one('SELECT id, circle_id FROM messages WHERE id = ?', r.mid);
    if (m) await eraseMessage(m, a.user.id, true);
  }
  if (rows.length) poke(a.circleId);
  return c.json({ preview: false, messages: rows.length, bytes });
});
