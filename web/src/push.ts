// Notifications on this device: what to do at sign-in, at sign-out, and when a notification is tapped. The permission prompt and the
// first subscription stay in You.tsx (they need a tap). Everything here is quiet: a browser without push, or a failed call, changes nothing.
import { api } from './api';

const supported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window;
const current = async () => (await navigator.serviceWorker.ready).pushManager.getSubscription();

/** The route a notification asks for ("/#/circle/5", "/") as the part after "#" that the router reads ("/circle/5"). Anything else: null. */
export function hashFromPath(path: unknown): string | null {
  if (typeof path !== 'string' || !/^\/(?![\/\\])/.test(path)) return null;
  const i = path.indexOf('#');
  return i < 0 ? '/' : path.slice(i + 1) || '/';
}

/** After sign-in: if this browser already holds a subscription, tell the server it belongs to the person now signed in. */
export async function rebindPush() {
  if (!supported() || Notification.permission !== 'granted') return;
  try { const sub = await current(); if (sub) await api('/push/subscribe', { body: sub.toJSON() }); } catch { /* quiet */ }
}

/** Before sign-out (or deleting the account): stop notifications for this person on this device. */
export async function dropPush() {
  if (!supported()) return;
  try {
    const sub = await Promise.race([current(), new Promise<null>(r => setTimeout(() => r(null), 1500))]);
    if (!sub) return;
    await api('/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  } catch { /* quiet */ }
}
