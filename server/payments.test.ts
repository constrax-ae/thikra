process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+971500330201';
process.env.THIKRA_PUBLIC_URL = 'https://thekra.example.test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-pay-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { one, run } = await import('./db.ts');
const { setStripeFetch, signForTest, formEncode } = await import('./lib/stripe.ts');
const { subscription } = await import('./billing.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
async function signUp(phone: string, name: string) {
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode as string;
  const v = await app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code, name }) });
  const cookie = v.headers.get('set-cookie')!.split(';')[0];
  return { cookie, id: (await call(cookie, '/api/me')).json.id as number };
}
const owner = await signUp('+971500330201', 'Owner');
const alice = await signUp('+971500330202', 'Alice');
const bob = await signUp('+971500330203', 'Bob');
const fam = (await call(alice.cookie, '/api/circles', { name: 'Alice family', kind: 'circle' })).json.id as number;
await call(bob.cookie, '/api/circles/join', { code: one('SELECT invite_code FROM circles WHERE id = ?', fam)!.invite_code });

let fam2 = 0;
let carolCookieValue = '';
const carolCookie = () => carolCookieValue;
const SECRET = 'whsec_testsecret';
const seen: Array<{ url: string; method: string; auth: string | null; body: string; idem: string | null }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: { id: 'cs_test_1', url: 'https://checkout.stripe.test/pay/cs_test_1' } };
setStripeFetch((async (url: any, init: any) => { seen.push({ url: String(url), method: init?.method, auth: init?.headers?.authorization ?? null, body: String(init?.body ?? ''), idem: init?.headers?.['idempotency-key'] ?? null }); return new Response(JSON.stringify(reply.body), { status: reply.status }); }) as typeof fetch);
const hook = async (event: unknown, opts: { sig?: string; t?: number } = {}) => {
  const raw = JSON.stringify(event);
  const res = await app.request('/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': opts.sig ?? signForTest(raw, SECRET, opts.t) }, body: raw });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
let n = 0;
const ev = (type: string, object: Record<string, unknown>) => ({ id: `evt_${++n}`, type, data: { object } });
const unix = (offsetDays: number) => Math.floor((Date.now() + offsetDays * 86_400_000) / 1000);
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

test('with no keys, payments are off and nothing leaks: plans say so, checkout and the webhook refuse', async () => {
  delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.equal((await call(alice.cookie, '/api/plans')).json.paymentsLive, false);
  assert.equal((await call(alice.cookie, `/api/circles/${fam}/checkout`, { plan: 'family', interval: 'month' })).json.error, 'payments_off');
  assert.equal((await hook(ev('invoice.paid', {}))).status, 503);
  process.env.STRIPE_SECRET_KEY = 'sk_test_abcdefghijklmnop'; process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const p = (await call(alice.cookie, '/api/plans')).json;
  assert.equal(p.paymentsLive, true); assert.equal(p.paymentsMode, 'test');
});

test('checkout: managers only, the price comes from our plan table (never the browser), Stripe is asked for a subscription for this family', async () => {
  assert.equal((await call(bob.cookie, `/api/circles/${fam}/checkout`, { plan: 'family', interval: 'month' })).status, 403, 'a plain member cannot pay for the family');
  assert.equal((await call(alice.cookie, `/api/circles/${fam}/checkout`, { plan: 'free', interval: 'month' })).status, 400);
  assert.equal((await call(alice.cookie, `/api/circles/${fam}/checkout`, { plan: 'family', interval: 'weekly' })).status, 400);
  seen.length = 0;
  const r = await call(alice.cookie, `/api/circles/${fam}/checkout`, { plan: 'family', interval: 'month', amount: 1, unit_amount: 1, price: 1 });
  assert.equal(r.status, 200); assert.equal(r.json.url, 'https://checkout.stripe.test/pay/cs_test_1');
  assert.equal(seen.length, 1);
  const q = new URLSearchParams(seen[0].body);
  assert.equal(seen[0].url, 'https://api.stripe.com/v1/checkout/sessions'); assert.equal(seen[0].auth, 'Bearer sk_test_abcdefghijklmnop');
  assert.equal(q.get('mode'), 'subscription');
  assert.equal(q.get('line_items[0][price_data][unit_amount]'), '199', '1.99 from the plan table, whatever the browser sent');
  assert.equal(q.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(q.get('metadata[circle_id]'), String(fam)); assert.equal(q.get('metadata[plan]'), 'family');
  assert.equal(q.get('subscription_data[metadata][circle_id]'), String(fam));
  assert.equal(q.get('success_url'), `https://thekra.example.test/?paid=1#/circle/${fam}/settings`);
  assert.ok(seen[0].idem, 'an idempotency key, so a double tap is one checkout');
  await call(alice.cookie, `/api/circles/${fam}/checkout`, { plan: 'heritage', interval: 'year' });
  assert.equal(new URLSearchParams(seen[1].body).get('line_items[0][price_data][unit_amount]'), '9999');
  // Stripe refuses: our answer is a plain error, no details
  reply = { status: 400, body: { error: { type: 'invalid_request_error', code: 'amount_too_small' } } };
  const bad = await call(alice.cookie, `/api/circles/${fam}/checkout`, { plan: 'family', interval: 'year' });
  assert.equal(bad.status, 502); assert.equal(bad.json.error, 'payment_provider_error');
  reply = { status: 200, body: { id: 'cs_test_1', url: 'https://checkout.stripe.test/pay/cs_test_1' } };
  assert.equal(formEncode({ a: { b: [1].length, c: { d: 'x' } } }).toString(), 'a%5Bb%5D=1&a%5Bc%5D%5Bd%5D=x');
});

test('the webhook only believes a signed, recent request; a repeated delivery changes nothing twice', async () => {
  const e = ev('checkout.session.completed', { mode: 'subscription', customer: 'cus_1', subscription: 'sub_1', client_reference_id: String(fam), metadata: { circle_id: String(fam), plan: 'family', interval: 'month' } });
  assert.equal((await hook(e, { sig: 't=1,v1=deadbeef' })).status, 400, 'forged signature');
  assert.equal((await hook(e, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400, 'a signature from an hour ago is a replay');
  assert.equal(subscription(fam).plan, 'free', 'nothing happened yet');
  assert.equal((await hook(e)).status, 200);
  const s = subscription(fam);
  assert.equal(s.plan, 'family'); assert.equal(s.status, 'active');
  assert.equal(one('SELECT stripe_customer c, stripe_subscription s, provider p FROM subscriptions WHERE circle_id = ?', fam)!.s, 'sub_1');
  run("UPDATE subscriptions SET plan = 'free' WHERE circle_id = ?", fam);
  assert.equal((await hook(e)).json.duplicate, true);
  assert.equal(subscription(fam).plan, 'free', 'the same event id is not applied twice');
  run("UPDATE subscriptions SET plan = 'family' WHERE circle_id = ?", fam);
});

test('invoices extend the plan to the exact last paid day and fill the ledger; failures, deletions and refunds are recorded; out-of-order events still land on the right family', async () => {
  const paid = ev('invoice.paid', { id: 'in_1', subscription: 'sub_1', customer: 'cus_1', amount_paid: 199, currency: 'usd', payment_intent: 'pi_1', lines: { data: [{ period: { end: unix(31) } }] }, subscription_details: { metadata: { circle_id: String(fam), plan: 'family' } } });
  assert.equal((await hook(paid)).status, 200);
  assert.equal(subscription(fam).periodEnd, day(31)); assert.equal(subscription(fam).status, 'active');
  const row = one("SELECT status, amount_cents, plan, stripe_payment_intent FROM payments WHERE stripe_invoice = 'in_1'")!;
  assert.deepEqual({ ...row }, { status: 'paid', amount_cents: 199, plan: 'family', stripe_payment_intent: 'pi_1' });
  // an invoice for a subscription we have never heard of, with the family in its metadata (arrives before checkout.session.completed)
  const carol = await signUp('+971500330204', 'Carol');
  carolCookieValue = carol.cookie;
  fam2 = (await call(carol.cookie, '/api/circles', { name: 'Second', kind: 'circle' })).json.id as number;
  assert.equal((await hook(ev('invoice.paid', { id: 'in_2', subscription: 'sub_2', customer: 'cus_2', amount_paid: 1999, currency: 'usd', payment_intent: 'pi_2', lines: { data: [{ period: { end: unix(365) }, metadata: { circle_id: String(fam2), plan: 'heritage' } }] } }))).status, 200);
  assert.equal(subscription(fam2).plan, 'heritage');
  assert.equal(one('SELECT stripe_subscription s FROM subscriptions WHERE circle_id = ?', fam2)!.s, 'sub_2');
  // a failed renewal is recorded and changes no plan
  await hook(ev('invoice.payment_failed', { id: 'in_3', subscription: 'sub_1', amount_due: 199, currency: 'usd' }));
  assert.equal(one("SELECT status FROM payments WHERE stripe_invoice = 'in_3'")!.status, 'failed');
  assert.equal(subscription(fam).plan, 'family');
  // cancelled: service continues to the last paid day
  await hook(ev('customer.subscription.deleted', { id: 'sub_1' }));
  assert.equal(one('SELECT stripe_subscription s FROM subscriptions WHERE circle_id = ?', fam)!.s, null);
  assert.equal(subscription(fam).plan, 'family'); assert.equal(subscription(fam).periodEnd, day(31));
  await hook(ev('charge.refunded', { payment_intent: 'pi_2' }));
  assert.equal(one("SELECT status FROM payments WHERE stripe_invoice = 'in_2'")!.status, 'refunded');
  // a renewal that is never paid: the last day passes, 14 days of grace, then read-only (nothing deleted)
  run("UPDATE subscriptions SET period_end = ? WHERE circle_id = ?", day(-3), fam); assert.equal(subscription(fam).status, 'grace');
  run("UPDATE subscriptions SET period_end = ? WHERE circle_id = ?", day(-20), fam); assert.equal(subscription(fam).status, 'readonly');
});

test('the owner sees the ledger and can refund (ending the plan now) or stop renewal; nobody else can; the portal needs a Stripe customer', async () => {
  assert.equal((await call(alice.cookie, '/api/admin/payments')).status, 403);
  const list = (await call(owner.cookie, '/api/admin/payments')).json;
  assert.equal(list.mode, 'test'); assert.equal(list.keyConfigured, true); assert.equal(list.webhookConfigured, true);
  assert.ok(list.payments.some((p: any) => p.family === 'Alice family' && p.cents === 199));
  assert.ok(!JSON.stringify(list).includes('sk_test_'), 'the key is never sent to the screen');
  const pid = list.payments.find((p: any) => p.status === 'paid' && p.refundable).id as number;
  assert.equal((await call(alice.cookie, `/api/admin/payments/${pid}/refund`, {})).status, 403);
  seen.length = 0; reply = { status: 200, body: { id: 're_1' } };
  run("UPDATE subscriptions SET stripe_subscription = 'sub_9', period_end = ? WHERE circle_id = ?", day(20), fam);
  assert.equal((await call(owner.cookie, `/api/admin/payments/${pid}/refund`, {})).status, 200);
  assert.equal(new URLSearchParams(seen[0].body).get('payment_intent'), 'pi_1');
  assert.ok(seen.some(s => s.method === 'DELETE' && s.url.endsWith('/subscriptions/sub_9')), 'the subscription is cancelled with the refund');
  assert.equal(one('SELECT status FROM payments WHERE id = ?', pid)!.status, 'refunded');
  assert.equal(subscription(fam).periodEnd, day(0), 'the plan ends today (then grace, then read-only)');
  assert.equal((await call(owner.cookie, `/api/admin/payments/${pid}/refund`, {})).status, 404, 'refunded once');
  assert.ok(Number(one("SELECT COUNT(*) n FROM admin_audit WHERE action = 'payment.refund'")!.n) >= 1);

  seen.length = 0;
  run("UPDATE subscriptions SET stripe_subscription = 'sub_77' WHERE circle_id = ?", fam2);
  assert.equal((await call(owner.cookie, `/api/admin/circles/${fam2}/cancel-subscription`, {})).status, 200);
  assert.equal(new URLSearchParams(seen[0].body).get('cancel_at_period_end'), 'true');
  assert.equal((await call(owner.cookie, `/api/admin/circles/${fam}/cancel-subscription`, {})).status, 404, 'no live subscription');

  // portal
  reply = { status: 200, body: { url: 'https://billing.stripe.test/p/1' } };
  assert.equal((await call(bob.cookie, `/api/circles/${fam2}/billing-portal`, {})).status, 404, 'not a member');
  assert.equal((await call(carolCookie(), `/api/circles/${fam2}/billing-portal`, {})).json.url, 'https://billing.stripe.test/p/1');
  assert.equal((await call(alice.cookie, `/api/circles/${fam}/billing-portal`, {})).status, 200, 'a family that paid has a customer');
  run('UPDATE subscriptions SET stripe_customer = NULL WHERE circle_id = ?', fam);
  assert.equal((await call(alice.cookie, `/api/circles/${fam}/billing-portal`, {})).status, 404, 'no customer, no portal');
});
