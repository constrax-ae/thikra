import { createHmac, timingSafeEqual } from 'node:crypto';

// Stripe, without its SDK: four calls and a signature check, all plain HTTPS and HMAC. Card numbers never touch this server (Stripe's own page takes them).
// Keys live in Secrets: STRIPE_SECRET_KEY (sk_test_… or sk_live_…) and STRIPE_WEBHOOK_SECRET (whsec_…). THIKRA_PUBLIC_URL is the site's own address (for the return links).
const API = 'https://api.stripe.com/v1';
type Fetch = typeof fetch;
let doFetch: Fetch = (...a) => fetch(...a);
/** Tests replace the network call. */
export const setStripeFetch = (f: Fetch) => { doFetch = f; };
const key = () => process.env.STRIPE_SECRET_KEY ?? '';
export const paymentsOn = () => /^sk_(test|live)_[A-Za-z0-9]{10,}$/.test(key());
export const stripeMode = (): 'test' | 'live' => (key().startsWith('sk_live_') ? 'live' : 'test');
export const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET ?? '';
export class StripeError extends Error { constructor(public code: string, public status: number) { super(code); } }

/** Nested objects as Stripe's form encoding wants them: a[b][c]=1. */
export function formEncode(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v as Record<string, unknown>, name, out); else out.append(name, String(v));
  }
  return out;
}
async function call(method: 'POST' | 'GET' | 'DELETE', path: string, params: Record<string, unknown> = {}, idem?: string): Promise<any> {
  if (!paymentsOn()) throw new StripeError('payments_off', 503);
  const res = await doFetch(`${API}${path}`, {
    method, headers: { authorization: `Bearer ${key()}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) },
    body: method === 'POST' ? formEncode(params).toString() : undefined,
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('[stripe]', method, path, res.status, body?.error?.type, body?.error?.code); throw new StripeError(String(body?.error?.code ?? body?.error?.type ?? 'stripe_error'), res.status); }
  return body;
}

// ---- the Prices the owner created in Stripe ------------------------------------------------------------------------------
// A real Stripe setup has a Product per plan and a Price per interval, created once in the dashboard and named here:
//
//   STRIPE_PRICE_FAMILY_MONTH=price_…    STRIPE_PRICE_FAMILY_YEAR=price_…
//   STRIPE_PRICE_HERITAGE_MONTH=price_…  STRIPE_PRICE_HERITAGE_YEAR=price_…
//
// Why it matters: a Price is a lasting object, so Stripe's own dashboard reports revenue per plan, coupons and tax behaviour
// attach to it, and a customer's invoice names the plan instead of a bare amount. An inline price (price_data) can do none of
// that and cannot be reused or edited afterwards. Any plan without a Price configured still falls back to an inline one, so
// the app keeps working while the four Prices are being created.
export function priceId(plan: string, interval: 'month' | 'year'): string | null {
  const v = (process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`] ?? '').trim();
  return /^price_[A-Za-z0-9_]+$/.test(v) ? v : null;
}
/** What Stripe itself says a Price is, so a mismatch with our own plan table can be SEEN instead of charged silently. */
export const retrievePrice = (id: string) => call('GET', `/prices/${encodeURIComponent(id)}`);

/**
 * A subscription checkout. The amount NEVER comes from the browser: either Stripe's own Price (when the owner created one) or
 * our plan table. The family and plan ride in metadata, so the webhook knows whom a payment belongs to either way.
 */
export const createCheckout = (p: { circleId: number; plan: string; interval: 'month' | 'year'; amountCents: number; currency: string; productName: string; successUrl: string; cancelUrl: string; priceId?: string | null }) =>
  call('POST', '/checkout/sessions', {
    mode: 'subscription', success_url: p.successUrl, cancel_url: p.cancelUrl, client_reference_id: String(p.circleId),
    line_items: { 0: p.priceId
      ? { quantity: 1, price: p.priceId }
      : { quantity: 1, price_data: { currency: p.currency.toLowerCase(), unit_amount: p.amountCents, recurring: { interval: p.interval }, product_data: { name: p.productName } } } },
    metadata: { circle_id: p.circleId, plan: p.plan, interval: p.interval },
    subscription_data: { metadata: { circle_id: p.circleId, plan: p.plan, interval: p.interval } },
  }, `checkout-${p.circleId}-${p.plan}-${p.interval}-${Math.floor(Date.now() / 60_000)}`);
/** Stripe's own page where a customer changes the card or cancels (it must be switched on once in the Stripe dashboard: docs/PAYMENTS.md). */
export const createPortal = (customer: string, returnUrl: string) => call('POST', '/billing_portal/sessions', { customer, return_url: returnUrl });
export const refundPayment = (paymentIntent: string) => call('POST', '/refunds', { payment_intent: paymentIntent });
export const cancelAtPeriodEnd = (subscriptionId: string) => call('POST', `/subscriptions/${encodeURIComponent(subscriptionId)}`, { cancel_at_period_end: true });
export const cancelNow = (subscriptionId: string) => call('DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`);

/** Check Stripe-Signature (t=…,v1=…) over `${t}.${rawBody}` with the endpoint secret; reject anything older than five minutes. Returns the event, or null. */
export function verifyWebhook(raw: string, header: string | undefined, secret: string, now = Date.now()): any | null {
  if (!header || !secret) return null;
  const parts = Object.fromEntries(header.split(',').map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; })) as Record<string, string>;
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return null;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
  const sigs = header.split(',').filter(x => x.startsWith('v1=')).map(x => x.slice(3));
  const ok = sigs.some(s => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export const signForTest = (raw: string, secret: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
