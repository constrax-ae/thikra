import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { audit, requireAdmin } from '../lib/admin.ts';
import { circleAccess, isManager, limited } from '../lib/helpers.ts';
import { PLAN_IDS, plans, setSubscription, subscription, type PlanId } from '../billing.ts';
import { StripeError, cancelAtPeriodEnd, cancelNow, createCheckout, createPortal, paymentsOn, priceId, refundPayment, retrievePrice, stripeMode, verifyWebhook, webhookSecret } from '../lib/stripe.ts';

// Payments through Stripe (see docs/PAYMENTS.md). The browser never sends an amount: the plan and interval come in, the price comes from OUR plan table.
// The webhook is the only thing that changes a family's plan after a payment, and it only believes a request signed with the endpoint secret.
const isPlan = (v: unknown): v is PlanId => typeof v === 'string' && (PLAN_IDS as readonly string[]).includes(v);
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const baseUrl = (c: any) => (process.env.THIKRA_PUBLIC_URL?.replace(/\/+$/, '')) || `${c.req.header('x-forwarded-proto') ?? 'https'}://${c.req.header('x-forwarded-host') ?? c.req.header('host')}`;
const stripeFail = (c: any, e: unknown) => { if (e instanceof StripeError) return c.json({ error: e.code === 'payments_off' ? 'payments_off' : 'payment_provider_error' }, e.status === 503 ? 503 : 502); throw e; };

// ---- the family's side ----------------------------------------------------------------------------------------------------------------
/** Start paying for a plan: returns Stripe's own checkout page address. Managers only. */
app.post('/api/circles/:id/checkout', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  if (!paymentsOn()) return c.json({ error: 'payments_off' }, 503);
  if (await limited(`checkout:${a.user.id}`, 10, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const b = await c.req.json().catch(() => ({}));
  const interval = b.interval === 'year' ? 'year' : b.interval === 'month' ? 'month' : null;
  if (!isPlan(b.plan) || b.plan === 'free' || !interval) return c.json({ error: 'invalid_value' }, 400);
  const sub = subscription(a.circleId);
  if (sub.plan === b.plan && sub.status === 'active' && one('SELECT stripe_subscription s FROM subscriptions WHERE circle_id = ?', a.circleId)?.s) return c.json({ error: 'already_subscribed' }, 409);
  const def = plans()[b.plan as PlanId];
  const amountCents = Math.round((interval === 'year' ? def.priceYearly : def.priceMonthly) * 100);
  if (!Number.isFinite(amountCents) || amountCents < 50) return c.json({ error: 'invalid_value' }, 400);
  const name = one('SELECT name FROM circles WHERE id = ?', a.circleId)?.name ?? 'Thekra';
  const base = baseUrl(c);
  try {
    // The Price the owner created in Stripe for this plan and interval, when there is one; otherwise an inline price from our own table.
    const s = await createCheckout({ circleId: a.circleId, plan: b.plan, interval, amountCents, currency: def.currency, productName: `Thekra ${b.plan}: ${String(name).slice(0, 60)}`, priceId: priceId(b.plan, interval), successUrl: `${base}/?paid=1#/circle/${a.circleId}/settings`, cancelUrl: `${base}/#/circle/${a.circleId}/settings` });
    return c.json({ url: s.url });
  } catch (e) { return stripeFail(c, e); }
});
/** Stripe's page to change the card or cancel. Managers of a family that pays through Stripe. */
app.post('/api/circles/:id/billing-portal', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  const customer = one('SELECT stripe_customer s FROM subscriptions WHERE circle_id = ?', a.circleId)?.s;
  if (!customer) return c.json({ error: 'not_found' }, 404);
  try { const s = await createPortal(customer, `${baseUrl(c)}/#/circle/${a.circleId}/settings`); return c.json({ url: s.url }); } catch (e) { return stripeFail(c, e); }
});

// ---- Stripe tells us (public, but only a signed request is believed) -------------------------------------------------------------
const circleOfSubscription = (id: unknown) => (id ? one('SELECT circle_id c FROM subscriptions WHERE stripe_subscription = ?', String(id))?.c as number | undefined : undefined);
function handle(ev: any) {
  const o = ev.data?.object ?? {};
  switch (ev.type) {
    case 'checkout.session.completed': {
      if (o.mode !== 'subscription') return;
      const circle = Number(o.metadata?.circle_id ?? o.client_reference_id), plan = o.metadata?.plan;
      if (!isPlan(plan) || plan === 'free' || !one('SELECT 1 FROM circles WHERE id = ? AND deleted_at IS NULL', circle)) return;
      // provisional last day (the invoice that follows sets the exact one)
      const end = new Date(Date.now() + (o.metadata?.interval === 'year' ? 367 : 33) * 86_400_000).toISOString().slice(0, 10);
      setSubscription(circle, plan, null, end, { customer: o.customer ?? null, subscription: o.subscription ?? null, provider: 'stripe' });
      return;
    }
    case 'invoice.paid': {
      const subId = o.subscription ?? o.parent?.subscription_details?.subscription;
      const meta = o.subscription_details?.metadata ?? o.parent?.subscription_details?.metadata ?? o.lines?.data?.[0]?.metadata ?? {};
      const circle = circleOfSubscription(subId) ?? (Number(meta.circle_id) || undefined);
      if (!circle || !one('SELECT 1 FROM circles WHERE id = ?', circle)) return;
      const cur = subscription(circle);
      const plan: PlanId = isPlan(meta.plan) && meta.plan !== 'free' ? meta.plan : cur.plan;
      if (plan === 'free') return;
      const endUnix = o.lines?.data?.[0]?.period?.end;
      const periodEnd = endUnix ? day(endUnix) : cur.periodEnd;
      const intent = o.payment_intent ?? o.payments?.data?.[0]?.payment?.payment_intent ?? null;
      run(`INSERT INTO payments (circle_id, status, amount_cents, currency, plan, stripe_invoice, stripe_payment_intent, period_end) VALUES (?, 'paid', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(stripe_invoice) DO UPDATE SET status = 'paid', amount_cents = excluded.amount_cents, stripe_payment_intent = excluded.stripe_payment_intent, period_end = excluded.period_end`,
        circle, Number(o.amount_paid ?? 0), String(o.currency ?? 'usd'), plan, String(o.id ?? ''), intent, periodEnd ?? null);
      setSubscription(circle, plan, null, periodEnd, { customer: o.customer ?? null, subscription: subId ?? null, provider: 'stripe' });
      return;
    }
    case 'invoice.payment_failed': {
      const subId = o.subscription ?? o.parent?.subscription_details?.subscription;
      const circle = circleOfSubscription(subId);
      run("INSERT OR IGNORE INTO payments (circle_id, status, amount_cents, currency, plan, stripe_invoice) VALUES (?, 'failed', ?, ?, ?, ?)", circle ?? null, Number(o.amount_due ?? 0), String(o.currency ?? 'usd'), circle ? subscription(circle).plan : null, String(o.id ?? ''));
      return;   // nothing else: if the renewal stays unpaid the last paid day passes, then 14 days of grace, then read-only. Nothing is deleted.
    }
    case 'customer.subscription.deleted': {
      const circle = circleOfSubscription(o.id);
      if (circle) run('UPDATE subscriptions SET stripe_subscription = NULL WHERE circle_id = ?', circle);   // service continues to the last paid day, then lapses
      return;
    }
    case 'charge.refunded':
      if (o.payment_intent) run("UPDATE payments SET status = 'refunded' WHERE stripe_payment_intent = ?", String(o.payment_intent));
      return;
  }
}
app.post('/api/stripe/webhook', async c => {
  const secret = webhookSecret();
  if (!secret) return c.json({ error: 'payments_off' }, 503);
  const raw = await c.req.text();
  const ev = verifyWebhook(raw, c.req.header('stripe-signature'), secret);
  if (!ev || typeof ev.id !== 'string' || typeof ev.type !== 'string') return c.json({ error: 'invalid_signature' }, 400);
  if (!Number(run('INSERT OR IGNORE INTO payment_events (id, type) VALUES (?, ?)', ev.id, ev.type).changes)) return c.json({ received: true, duplicate: true });
  try { handle(ev); } catch (e) { run('DELETE FROM payment_events WHERE id = ?', ev.id); console.error('[stripe webhook]', ev.type, e); return c.json({ error: 'server' }, 500); }   // not remembered, so Stripe's retry is processed
  return c.json({ received: true });
});

// ---- the owner's side -------------------------------------------------------------------------------------------------------------------
/**
 * Each plan and interval: the Price configured for it, and what Stripe itself says that Price costs. A Price that disagrees
 * with our plan table would charge one amount while the app displays another, so it is shown rather than left to be discovered
 * on someone's card statement. Stripe is asked only when a key and a Price exist, and a failure degrades to "unknown".
 */
async function priceReport() {
  const defs = plans();
  const out: Array<Record<string, unknown>> = [];
  for (const plan of PLAN_IDS) {
    if (plan === 'free') continue;
    for (const interval of ['month', 'year'] as const) {
      const id = priceId(plan, interval);
      const ours = Math.round((interval === 'year' ? defs[plan].priceYearly : defs[plan].priceMonthly) * 100);
      const row: Record<string, unknown> = { plan, interval, priceId: id, ourCents: ours, currency: defs[plan].currency };
      if (id && paymentsOn()) {
        try {
          const p: any = await retrievePrice(id);
          const cents = Number(p?.unit_amount);
          row.stripe = { cents, currency: String(p?.currency ?? '').toUpperCase(), interval: p?.recurring?.interval ?? null, active: p?.active !== false };
          row.agrees = cents === ours && String(p?.currency ?? '').toUpperCase() === defs[plan].currency.toUpperCase() && p?.recurring?.interval === interval && p?.active !== false;
        } catch { row.stripe = null; row.agrees = null; }
      }
      out.push(row);
    }
  }
  return out;
}

app.get('/api/admin/payments', requireAdmin('plans'), async c => c.json({
  mode: stripeMode(), keyConfigured: paymentsOn(), webhookConfigured: !!webhookSecret(),
  prices: await priceReport(),
  paid30: all("SELECT currency, SUM(amount_cents) cents, COUNT(*) n FROM payments WHERE status = 'paid' AND created_at >= datetime('now', '-30 days') GROUP BY currency").map(r => ({ currency: r.currency, amount: Number(r.cents) / 100, count: Number(r.n) })),
  failed7: Number(one("SELECT COUNT(*) n FROM payments WHERE status = 'failed' AND created_at >= datetime('now', '-7 days')")!.n),
  payments: all(`SELECT p.id, p.status, p.amount_cents AS cents, p.currency, p.plan, p.period_end AS periodEnd, p.created_at AS createdAt, p.circle_id AS circleId, c.name AS family, p.stripe_payment_intent IS NOT NULL AS refundable
                   FROM payments p LEFT JOIN circles c ON c.id = p.circle_id ORDER BY p.id DESC LIMIT 100`).map(r => ({ ...r, refundable: !!r.refundable && r.status === 'paid' })),
}));
/** Refund a payment in full and end the plan now (its last paid day becomes today: 14 days of grace, then read-only; nothing is deleted). */
app.post('/api/admin/payments/:id/refund', requireAdmin('plans'), async c => {
  const id = Number(c.req.param('id'));
  const p = one("SELECT id, circle_id, amount_cents, stripe_payment_intent FROM payments WHERE id = ? AND status = 'paid' AND stripe_payment_intent IS NOT NULL", id);
  if (!p) return c.json({ error: 'not_found' }, 404);
  try {
    await refundPayment(p.stripe_payment_intent);
    run("UPDATE payments SET status = 'refunded' WHERE id = ?", id);
    const sub = p.circle_id ? one('SELECT plan, stripe_subscription s FROM subscriptions WHERE circle_id = ?', p.circle_id) : undefined;
    if (sub?.s) { await cancelNow(sub.s).catch(() => undefined); run('UPDATE subscriptions SET stripe_subscription = NULL WHERE circle_id = ?', p.circle_id); }
    if (p.circle_id && sub && isPlan(sub.plan) && sub.plan !== 'free') setSubscription(p.circle_id, sub.plan, null, new Date().toISOString().slice(0, 10), { provider: 'stripe' });
  } catch (e) { return stripeFail(c, e); }
  audit(c, 'payment.refund', { type: 'payment', id }, { circle: p.circle_id, cents: p.amount_cents });
  return c.json({ ok: true });
});
/** Stop renewing a family's subscription at the end of the paid period. */
app.post('/api/admin/circles/:id/cancel-subscription', requireAdmin('plans'), async c => {
  const id = Number(c.req.param('id'));
  const s = one('SELECT stripe_subscription s FROM subscriptions WHERE circle_id = ?', id)?.s;
  if (!s) return c.json({ error: 'not_found' }, 404);
  try { await cancelAtPeriodEnd(s); } catch (e) { return stripeFail(c, e); }
  audit(c, 'subscription.cancel_at_period_end', { type: 'circle', id });
  return c.json({ ok: true });
});
