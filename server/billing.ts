// Plans, storage quota and the read-only rule. The quota belongs to the circle (the family vault),
// and only ARCHIVED media counts against it: chat media is temporary, the archive is permanent.
// Payments are not wired yet: a payment provider will only ever write to the `subscriptions` table.
// The sizes and prices of the plans are the owner's to change (admin screen): defaults are below, overrides live in the settings table.

import { one, run, type Row } from './db.ts';

const GB = 1024 ** 3;

export type PlanId = 'free' | 'family' | 'heritage';
export const PLAN_IDS: readonly PlanId[] = ['free', 'family', 'heritage'];
export interface PlanDef { quotaBytes: number; priceMonthly: number; priceYearly: number; currency: string }

/** Suggested starting point, like a photo-storage service: a small free space for every family, then bigger spaces for the families that outgrow it. Prices are placeholders until the owner decides. */
export const DEFAULT_PLANS: Record<PlanId, PlanDef> = {
  free: { quotaBytes: 5 * GB, priceMonthly: 0, priceYearly: 0, currency: 'USD' },
  family: { quotaBytes: 100 * GB, priceMonthly: 1.99, priceYearly: 19.99, currency: 'USD' },
  heritage: { quotaBytes: 2048 * GB, priceMonthly: 9.99, priceYearly: 99.99, currency: 'USD' },
};

let cache: { at: number; v: Record<PlanId, PlanDef> } | null = null;
/** The plans in force now (cached for a few seconds). */
export function plans(): Record<PlanId, PlanDef> {
  if (cache && Date.now() - cache.at < 3000) return cache.v;
  let saved: Partial<Record<PlanId, Partial<PlanDef>>> = {};
  try { saved = JSON.parse(String(one("SELECT value FROM settings WHERE key = 'plans'")?.value ?? '{}')); } catch { /* bad value: use the defaults */ }
  const v = Object.fromEntries(PLAN_IDS.map(id => [id, { ...DEFAULT_PLANS[id], ...(saved[id] ?? {}) }])) as Record<PlanId, PlanDef>;
  cache = { at: Date.now(), v };
  return v;
}
export function savePlan(id: PlanId, def: PlanDef) {
  const all = { ...plans(), [id]: def };
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'plans', JSON.stringify(all));
  cache = null;
}

export interface Subscription {
  plan: PlanId;
  status: 'free' | 'active' | 'grace' | 'readonly';
  sponsorId: number | null;
  periodEnd: string | null;
  bonusBytes: number;
}

export function subscription(circleId: number): Subscription {
  const row = one('SELECT plan, status, sponsor_id, period_end, bonus_bytes FROM subscriptions WHERE circle_id = ?', circleId) as Row | undefined;
  const plan = (row && (PLAN_IDS as readonly string[]).includes(row.plan) ? row.plan : 'free') as PlanId;
  let status: Subscription['status'] = row?.status ?? 'free';
  // A paid period that ended: 14 days of grace (everything keeps working, managers are warned), then the archive is read-only. Nothing is ever deleted.
  if (row && plan !== 'free' && row.period_end && (status === 'active' || status === 'grace')) {
    const end = Date.parse(`${String(row.period_end).slice(0, 10)}T23:59:59Z`);
    if (Date.now() > end + GRACE_DAYS * 86_400_000) status = 'readonly';
    else if (Date.now() > end) status = 'grace';
  }
  return { plan, status, sponsorId: row?.sponsor_id ?? null, periodEnd: row?.period_end ?? null, bonusBytes: Number(row?.bonus_bytes ?? 0) };
}
export const GRACE_DAYS = 14;

/** The space a circle may use: its plan plus any extra the owner granted. */
export const quotaOf = (sub: Subscription) => plans()[sub.plan].quotaBytes + sub.bonusBytes;

/** Distinct blobs only, so the same file sent twice is counted once. */
export function usage(circleId: number) {
  const sum = (archived: 0 | 1) => Number(one(
    'SELECT COALESCE(SUM(size), 0) AS n FROM (SELECT DISTINCT blob_hash, size FROM media WHERE circle_id = ? AND archived = ?)',
    circleId, archived)!.n);
  return { archivedBytes: sum(1), chatBytes: sum(0), quotaBytes: quotaOf(subscription(circleId)) };
}

/** A lapsed subscription freezes the archive: nothing new is written, nothing is ever deleted. */
export const isReadOnly = (circleId: number) => subscription(circleId).status === 'readonly';

export const hasRoomToArchive = (circleId: number, extraBytes: number) => {
  const u = usage(circleId);
  return u.archivedBytes + extraBytes <= u.quotaBytes;
};

/**
 * Write a family's plan. `periodEnd`: undefined keeps it, null clears it, a date ('YYYY-MM-DD') is the last paid day. A free plan has none. Setting a plan always makes it active.
 * `stripe` records which Stripe customer and subscription pay for it (undefined keeps what is there).
 */
export function setSubscription(circleId: number, plan: PlanId, bonusBytes: number | null, periodEnd?: string | null, stripe?: { customer?: string | null; subscription?: string | null; provider?: string }) {
  const cur = subscription(circleId);
  const status = plan === 'free' ? 'free' : 'active';
  const bonus = bonusBytes ?? cur.bonusBytes;
  const end = plan === 'free' ? null : periodEnd === undefined ? cur.periodEnd : periodEnd;
  run(`INSERT INTO subscriptions (circle_id, plan, status, bonus_bytes, period_end, provider) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(circle_id) DO UPDATE SET plan = excluded.plan, status = excluded.status, bonus_bytes = excluded.bonus_bytes, period_end = excluded.period_end, provider = excluded.provider, updated_at = datetime('now')`, circleId, plan, status, bonus, end, stripe?.provider ?? 'manual');
  if (stripe && (stripe.customer !== undefined || stripe.subscription !== undefined)) {
    run('UPDATE subscriptions SET stripe_customer = COALESCE(?, stripe_customer), stripe_subscription = COALESCE(?, stripe_subscription) WHERE circle_id = ?', stripe.customer ?? null, stripe.subscription ?? null, circleId);
  }
}
