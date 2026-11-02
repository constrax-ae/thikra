// Web Push (notifications when the app is closed). Standards-based (VAPID + RFC 8291 encryption): no account with Apple or Google is
// needed, the push service cannot read the payload, and it works for the web app on Android Chrome, desktop, and installed iOS web apps.
// The native app will use APNs/FCM later through the same `notify` decision logic.

import webpush from 'web-push';
import { one, run, all } from './db.ts';

export interface PushPayload { title: string; body: string; circle: number; tag: string; url?: string }
export type Transport = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<void>;

// VAPID keys identify this server to push services. Generated once and kept in the database so subscriptions survive restarts.
function vapid() {
  const get = (k: string) => one('SELECT value FROM settings WHERE key = ?', k)?.value as string | undefined;
  let pub = get('vapid_public'), priv = get('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey; priv = k.privateKey;
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'vapid_public', pub);
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'vapid_private', priv);
  }
  return { pub, priv };
}
export const vapidPublicKey = () => vapid().pub;

const defaultTransport: Transport = async (sub, payload) => {
  const { pub, priv } = vapid();
  await webpush.sendNotification(sub, payload, { vapidDetails: { subject: process.env.THIKRA_PUSH_SUBJECT ?? 'mailto:admin@thikra.invalid', publicKey: pub, privateKey: priv }, TTL: 60 * 60 * 24 });
};
let transport: Transport = defaultTransport;
/** Tests replace the network with a fake. */
export const setTransport = (t: Transport | null) => { transport = t ?? defaultTransport; };

export function saveSubscription(userId: number, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, ua: string) {
  run(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua`,
    userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, ua.slice(0, 200));
}
export const removeSubscription = (userId: number, endpoint: string) => run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, endpoint);

/** Send one notification to every device of a user. Dead subscriptions (gone/expired) are removed. Returns how many went out. */
export async function pushToUser(userId: number, payload: PushPayload): Promise<number> {
  let sent = 0;
  for (const s of all('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', userId)) {
    try {
      await transport({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      run("UPDATE push_subscriptions SET last_ok_at = datetime('now') WHERE endpoint = ?", s.endpoint);
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
      else console.error('[push]', e?.statusCode ?? e?.message);
    }
  }
  return sent;
}
