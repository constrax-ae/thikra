import { PERSON_COLS, cleanDate } from '../lib/storage.ts';
import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { circleAccess, isManager, membership } from '../lib/helpers.ts';
import { subscription, usage } from '../billing.ts';

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
  const b = await c.req.json().catch(() => ({}));
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : p.name;
  const birth = 'birthDate' in b ? cleanDate(b.birthDate) : p.birth_date;
  const death = 'deathDate' in b ? cleanDate(b.deathDate) : p.death_date;
  if (birth === undefined || death === undefined) return c.json({ error: 'invalid_person' }, 400);
  const relation = 'relation' in b ? (typeof b.relation === 'string' ? b.relation.trim().slice(0, 40) || null : null) : p.relation;
  run('UPDATE persons SET name = ?, relation = ?, birth_date = ?, death_date = ? WHERE id = ?', name, relation, birth, death, p.id);
  return c.json({ ok: true });
});
