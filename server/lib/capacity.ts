import { all, one, run } from '../db.ts';
import { PLAN_IDS, plans, quotaOf, subscription } from '../billing.ts';
import { pushToUser } from '../push.ts';
import { quotaText } from './texts.ts';
import { orphansReport, usageTop } from './rollups.ts';

// Capacity and money, in numbers: how much is stored, what it costs, what it earns, who is about to run out. Metadata only.
const GB = 1024 ** 3;
const round = (n: number) => Math.round(n * 100) / 100;
export const DEFAULT_COST_PER_GB = 0.023;   // USD per GB-month, a typical object-storage price; the owner sets the real one
export const costPerGB = () => { const v = Number(one("SELECT value FROM settings WHERE key = 'storage_cost_per_gb'")?.value); return Number.isFinite(v) && v >= 0 && v < 100 ? v : DEFAULT_COST_PER_GB; };
export const setCostPerGB = (v: number) => run("INSERT OR REPLACE INTO settings (key, value) VALUES ('storage_cost_per_gb', ?)", String(v));

/** Families by archive size, biggest first: read from the hourly rollup (never a scan of every media row). */
const usedRows = (limit: number) => usageTop(limit);

export function capacitySummary() {
  const families = Number(one("SELECT COUNT(*) n FROM circles WHERE deleted_at IS NULL AND kind != 'direct'")!.n);
  const byPlan: Record<string, number> = Object.fromEntries(PLAN_IDS.map(p => [p, 0]));
  const revenue: Record<string, number> = {};
  const expiring: Array<{ id: number; name: string; plan: string; periodEnd: string; status: string }> = [];
  let grace = 0, readonly = 0, paying = 0;
  const subs = all("SELECT s.circle_id AS id, c.name FROM subscriptions s JOIN circles c ON c.id = s.circle_id WHERE c.deleted_at IS NULL AND s.plan != 'free'");
  for (const r of subs) {
    const sub = subscription(r.id);
    byPlan[sub.plan] = (byPlan[sub.plan] ?? 0) + 1;
    if (sub.status === 'grace') grace++;
    if (sub.status === 'readonly') readonly++;
    if (sub.status === 'active' || sub.status === 'grace') { paying++; const p = plans()[sub.plan]; revenue[p.currency] = round((revenue[p.currency] ?? 0) + p.priceMonthly); }
    if (sub.periodEnd && sub.status !== 'readonly' && Date.parse(`${sub.periodEnd.slice(0, 10)}T23:59:59Z`) - Date.now() < 7 * 86_400_000) expiring.push({ id: r.id, name: String(r.name).slice(0, 80), plan: sub.plan, periodEnd: sub.periodEnd.slice(0, 10), status: sub.status });
  }
  byPlan.free = Math.max(0, families - subs.length);
  const top = usedRows(10).map(r => {
    const c = one('SELECT name FROM circles WHERE id = ? AND deleted_at IS NULL', r.id);
    if (!c) return null;
    const sub = subscription(r.id), quota = quotaOf(sub), pct = quota ? Math.round((Number(r.used) / quota) * 100) : 100;
    return { id: r.id as number, name: String(c.name).slice(0, 80), plan: sub.plan, usedGB: round(Number(r.used) / GB), quotaGB: round(quota / GB), percent: pct };
  }).filter((x): x is NonNullable<typeof x> => !!x);
  const stored = Number(one('SELECT COALESCE(SUM(size), 0) n FROM blobs')!.n);
  const unit = costPerGB();
  const orphan = orphansReport();
  return {
    families, byPlan, paying, grace, readonly, expiring: expiring.slice(0, 10), top,
    storedGB: round(stored / GB), costPerGB: unit, estMonthlyCost: round((stored / GB) * unit), estMonthlyRevenue: revenue,
    orphans: { count: orphan.count, gb: round(orphan.bytes / GB), note: 'report only: nothing is deleted automatically' },
  };
}

// ---- warning managers before the space runs out --------------------------------------------------------------------------------
const LEVELS = [100, 95, 80];
/** Tell a family's managers once per level (80, 95, 100 percent); the level resets when the family drops below it. Returns how many families were warned. */
export async function checkQuotaAlerts(): Promise<number> {
  let warned = 0;
  for (const r of usedRows(5000)) {
    const c = one("SELECT name FROM circles WHERE id = ? AND deleted_at IS NULL AND kind != 'direct'", r.id);
    if (!c) continue;
    const quota = quotaOf(subscription(r.id)), pct = quota ? (Number(r.used) / quota) * 100 : 100;
    const level = LEVELS.find(l => pct >= l) ?? 0;
    const was = Number(one('SELECT level FROM quota_alerts WHERE circle_id = ?', r.id)?.level ?? 0);
    if (level === was) continue;
    run('INSERT INTO quota_alerts (circle_id, level) VALUES (?, ?) ON CONFLICT(circle_id) DO UPDATE SET level = excluded.level, at = datetime(\'now\')', r.id, level);
    if (level <= was) continue;
    warned++;
    for (const m of all("SELECT u.id, u.lang FROM circle_members cm JOIN users u ON u.id = cm.user_id WHERE cm.circle_id = ? AND cm.role IN ('owner','admin')", r.id)) {
      pushToUser(m.id, { title: 'Thekra', body: quotaText(m.lang, String(c.name), level), circle: r.id, tag: `quota-${r.id}`, url: `/#/circle/${r.id}` }).catch(e => console.error('[push]', e));
    }
  }
  run('UPDATE quota_alerts SET level = 0 WHERE level != 0 AND circle_id NOT IN (SELECT circle_id FROM circle_usage)');   // the rollup already holds exactly the families that have archived files
  return warned;
}
