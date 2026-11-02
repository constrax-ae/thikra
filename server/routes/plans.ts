import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { audit, requireAdmin } from '../lib/admin.ts';
import { circleAccess, isManager, limited } from '../lib/helpers.ts';
import { PLAN_IDS, plans, quotaOf, savePlan, setSubscription, subscription, usage, type PlanId } from '../billing.ts';
import { usageTop } from '../lib/rollups.ts';
import { paymentsOn, stripeMode } from '../lib/stripe.ts';

// Storage plans: what a family sees (sizes, prices, "ask for more space") and what the owner edits (sizes, prices, grants, requests).
// Payments are not connected: a request goes to the owner, who grants space by hand until a payment provider is wired (it will write `subscriptions`).

const isPlan = (v: unknown): v is PlanId => typeof v === 'string' && (PLAN_IDS as readonly string[]).includes(v);
const GB = 1024 ** 3;
const listPlans = () => PLAN_IDS.map(id => ({ id, ...plans()[id] }));

app.get('/api/plans', c => c.json({ plans: listPlans(), paymentsLive: paymentsOn(), paymentsMode: paymentsOn() ? stripeMode() : null }));

app.post('/api/circles/:id/storage-request', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  if (await limited(`storreq:${a.user.id}`, 5, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const b = await c.req.json().catch(() => ({}));
  if (!isPlan(b.plan) || b.plan === 'free') return c.json({ error: 'invalid_value' }, 400);
  if (one("SELECT 1 FROM storage_requests WHERE circle_id = ? AND status = 'open'", a.circleId)) return c.json({ error: 'already_requested' }, 409);
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) || null : null;
  const r = run('INSERT INTO storage_requests (circle_id, user_id, plan, note) VALUES (?, ?, ?, ?)', a.circleId, a.user.id, b.plan, note);
  return c.json({ id: Number(r.lastInsertRowid) }, 201);
});

// ---- the owner's side -----------------------------------------------------------------------------------------------------
app.get('/api/admin/plans', requireAdmin('plans'), c => c.json({ plans: listPlans() }));
app.post('/api/admin/plans/:id', requireAdmin('plans'), async c => {
  const id = c.req.param('id');
  if (!isPlan(id)) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const gb = Number(b.quotaGB), pm = Number(b.priceMonthly), py = Number(b.priceYearly);
  const currency = typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency) ? b.currency.toUpperCase() : null;
  if (!Number.isFinite(gb) || gb < 1 || gb > 100_000 || !Number.isFinite(pm) || pm < 0 || pm > 100_000 || !Number.isFinite(py) || py < 0 || py > 1_000_000 || !currency) return c.json({ error: 'invalid_value' }, 400);
  const before = plans()[id];
  savePlan(id, { quotaBytes: Math.round(gb * GB), priceMonthly: pm, priceYearly: py, currency });
  audit(c, 'plan.set', { type: 'plan', id }, { from: before, to: plans()[id] });
  return c.json({ ok: true });
});

/** Families by how full their vault is (the ones about to need more space first), and the open requests. */
app.get('/api/admin/storage', requireAdmin('circles'), c => {
  // the 200 biggest archives (from the hourly rollup), plus every family with an open request or a paid plan; the fullest first. Never every family.
  const used = new Map(usageTop(200).map(u => [u.id, u.used]));
  const extra = all("SELECT circle_id AS id FROM storage_requests WHERE status = 'open' UNION SELECT circle_id FROM subscriptions WHERE plan != 'free' LIMIT 400").map(r => Number(r.id));
  const rows = [...new Set([...used.keys(), ...extra])].flatMap(id => {
    const r = one("SELECT id, name FROM circles WHERE id = ? AND deleted_at IS NULL AND kind != 'direct'", id);
    if (!r) return [];
    const sub = subscription(r.id);
    return [{ id: r.id, name: r.name, plan: sub.plan, status: sub.status, bonusBytes: sub.bonusBytes, usedBytes: used.get(id) ?? usage(id).archivedBytes, quotaBytes: quotaOf(sub), members: Number(one('SELECT COUNT(*) AS n FROM circle_members WHERE circle_id = ?', r.id)!.n) }];
  }).sort((a, b) => b.usedBytes / b.quotaBytes - a.usedBytes / a.quotaBytes).slice(0, 300);
  const requests = all(`SELECT r.id, r.circle_id AS circleId, c.name AS circle, u.name AS requester, r.plan, r.note, r.created_at AS createdAt
    FROM storage_requests r JOIN circles c ON c.id = r.circle_id LEFT JOIN users u ON u.id = r.user_id WHERE r.status = 'open' ORDER BY r.id`);
  return c.json({ circles: rows, requests });
});

/** Set a family's plan, its last paid day (`until`, 'YYYY-MM-DD' or null) and/or extra space, by hand, with a reason for the record. */
app.post('/api/admin/circles/:id/plan', requireAdmin('plans'), async c => {
  const id = Number(c.req.param('id'));
  if (!one('SELECT 1 FROM circles WHERE id = ? AND deleted_at IS NULL', id)) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const cur = subscription(id);
  const plan = b.plan === undefined ? cur.plan : isPlan(b.plan) ? b.plan : null;
  const bonusGB = b.bonusGB === undefined ? null : Number(b.bonusGB);
  const until = b.until === undefined ? undefined : b.until === null ? null : typeof b.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.until) && Date.parse(b.until) > 0 && Date.parse(b.until) < Date.now() + 10 * 365 * 86_400_000 ? b.until : false;
  if (!plan || until === false || (bonusGB !== null && (!Number.isFinite(bonusGB) || bonusGB < 0 || bonusGB > 100_000))) return c.json({ error: 'invalid_value' }, 400);
  setSubscription(id, plan, bonusGB === null ? null : Math.round(bonusGB * GB), until);
  audit(c, 'circle.plan', { type: 'circle', id }, { from: { plan: cur.plan, status: cur.status, bonusBytes: cur.bonusBytes, until: cur.periodEnd }, to: { plan, bonusGB, until: until === undefined ? 'unchanged' : until }, reason: typeof b.reason === 'string' ? b.reason.trim().slice(0, 300) || null : null });
  return c.json({ ok: true });
});
app.post('/api/admin/storage-requests/:id/decide', requireAdmin('plans'), async c => {
  const id = Number(c.req.param('id'));
  const r = one("SELECT id, circle_id, plan FROM storage_requests WHERE id = ? AND status = 'open'", id);
  if (!r) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.grant !== 'boolean') return c.json({ error: 'invalid_value' }, 400);
  if (b.grant && isPlan(r.plan)) setSubscription(r.circle_id, r.plan, null);
  run("UPDATE storage_requests SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?", b.grant ? 'granted' : 'declined', c.get('user').id, id);
  audit(c, 'storage.decide', { type: 'storage_request', id }, { circle: r.circle_id, plan: r.plan, grant: b.grant });
  return c.json({ ok: true });
});
