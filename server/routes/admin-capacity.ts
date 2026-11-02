import { app } from '../app.ts';
import { audit, requireAdmin } from '../lib/admin.ts';
import { capacitySummary, costPerGB, setCostPerGB } from '../lib/capacity.ts';

// Capacity and money for the owner: stored GB, estimated cost and income, who is near the limit or past their paid period. Numbers only.
app.get('/api/admin/capacity', requireAdmin('plans'), c => c.json(capacitySummary()));

app.post('/api/admin/capacity/cost', requireAdmin('plans'), async c => {
  const b = await c.req.json().catch(() => ({}));
  const v = Number(b.perGB);
  if (!Number.isFinite(v) || v < 0 || v >= 100) return c.json({ error: 'invalid_value' }, 400);
  const before = costPerGB();
  setCostPerGB(v);
  audit(c, 'capacity.set_cost', { type: 'capacity', id: 'cost' }, { from: before, to: v });
  return c.json({ ok: true });
});
