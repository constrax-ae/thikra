import { app } from '../app.ts';
import { one } from '../db.ts';
import { removeSubscription, saveSubscription, vapidPublicKey } from '../push.ts';

// ---- notifications (Web Push) ---------------------------------------------------------------

app.get('/api/push/key', c => c.json({ key: vapidPublicKey() }));
app.post('/api/push/subscribe', async c => {
  const b = await c.req.json().catch(() => ({}));
  const ok = typeof b.endpoint === 'string' && /^https:\/\//.test(b.endpoint) && b.endpoint.length < 1000
    && typeof b.keys?.p256dh === 'string' && typeof b.keys?.auth === 'string';
  if (!ok) return c.json({ error: 'invalid_subscription' }, 400);
  saveSubscription(c.get('user').id, { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } }, c.req.header('user-agent') ?? '');
  return c.json({ ok: true });
});
app.delete('/api/push/subscribe', async c => {
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.endpoint === 'string') removeSubscription(c.get('user').id, b.endpoint);
  return c.json({ ok: true });
});
app.get('/api/push/status', c => c.json({ devices: one('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', c.get('user').id)!.n }));
