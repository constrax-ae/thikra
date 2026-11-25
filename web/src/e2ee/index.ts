// The browser's one encryption engine for the signed-in person: storage in IndexedDB (sealed), locks shared by every tab, the app's API as the network, the live socket as the
// trigger to catch up. Everything the screens need from encryption comes from here. Nothing starts unless the server has encryption switched on (THIKRA_E2EE).

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { live } from '../live';
import { memoryKv, openDeviceKv } from './kv';
import { createE2ee, NetError, type E2ee, type Net } from './engine';

export type { E2ee };
export { E2eeError, NetError } from './engine';

const net: Net = {
  async json(method, path, body) {
    try { return await api(path, { method, body: body as any }); }
    catch (e) { if (e instanceof ApiError) throw new NetError(e.status, e.code, e.data); throw e; }
  },
  async bytes(path) {
    let res: Response;
    try { res = await fetch(`/api${path}`, { credentials: 'same-origin' }); } catch { throw new NetError(0, 'network'); }
    if (!res.ok) throw new NetError(res.status, 'generic');
    return new Uint8Array(await res.arrayBuffer());
  },
  async put(path, body) {
    let res: Response;
    try { res = await fetch(`/api${path}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: body as BodyInit, credentials: 'same-origin' }); } catch { throw new NetError(0, 'network'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new NetError(res.status, data.error ?? 'generic', data);
    return data;
  },
};
/** Web Locks: one tab at a time may move a chat's keys (two tabs share one stored state). */
const lock = <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks ? locks.request(name, fn) as Promise<T> : fn();
};

interface Running { userId: number; e2ee: E2ee; ready: Promise<boolean>; stop(): void }
let current: Running | null = null;
let enabled = false;
/** How often encrypted chats catch up when there is no live connection (see the timer in startE2ee). */
export const E2EE_POLL_MS = 20_000;
const listeners = new Set<() => void>();
const bump = () => listeners.forEach(l => { try { l(); } catch { /* a screen's mistake */ } });
const chatListeners = new Set<(circle: number | null) => void>();

let preview: () => boolean = () => true;
/** Start for this person (once). `showPreview` says whether notifications on this device may carry text. */
export function startE2ee(userId: number, showPreview: () => boolean = () => true): E2ee {
  preview = showPreview;
  if (current?.userId === userId) return current.e2ee;
  current?.stop();
  const label = (() => { const ua = navigator.userAgent; const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'; const o = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''; return `${b}${o ? ' · ' + o : ''}`; })();
  const e2ee = createE2ee(userId, {
    net, label, lock, autoBackup: true,
    kv: memoryKv(),   // replaced by the real storage as soon as it is open (useKv below)
    onChange: (c: number | null) => { bump(); chatListeners.forEach(l => l(c)); },
  });
  const ready = (async () => {
    const kv = await openDeviceKv(userId);
    e2ee.useKv(kv);
    const ok = await e2ee.ready().catch(() => false);
    enabled = ok; bump();
    if (ok) e2ee.syncAll().catch(() => undefined);
    return ok;
  })();
  const off = live.on(f => {
    if (!enabled) return;
    if (f.t === 'open') e2ee.syncAll().catch(() => undefined);
    else if (f.t === 'e2ee' && Number.isInteger(f.circle)) e2ee.sync(f.circle).catch(() => undefined);
  });
  // Without the live connection (a host whose proxy refuses WebSocket upgrades, as tamtim.com's does) no 'e2ee' frame ever
  // arrives, so someone who joins a group would wait until a member's app restarted to be added to its keys. Catch up on a
  // timer instead, and whenever the page comes back into view.
  let catching = false;
  const catchUp = () => {
    if (!enabled || live.connected || catching || document.hidden) return;
    catching = true;
    e2ee.syncAll().catch(() => undefined).finally(() => { catching = false; });
  };
  const poll = setInterval(catchUp, E2EE_POLL_MS);
  const onShow = () => { if (!document.hidden) catchUp(); };
  document.addEventListener('visibilitychange', onShow);
  // A notification asks an open page to read the newest message (the service worker holds no keys).
  const onSw = (ev: MessageEvent) => {
    const d = ev.data;
    if (!d || d.t !== 'decrypt' || !Number.isInteger(d.circle) || !ev.ports[0]) return;
    const port = ev.ports[0];
    (async () => {
      if (!enabled || !preview()) return port.postMessage(null);
      const p = await e2ee.preview(d.circle);
      port.postMessage(p && p.text ? { text: p.text, kind: p.kind } : null);
    })().catch(() => port.postMessage(null));
  };
  navigator.serviceWorker?.addEventListener('message', onSw);
  current = { userId, e2ee, ready, stop() { off(); clearInterval(poll); document.removeEventListener('visibilitychange', onShow); navigator.serviceWorker?.removeEventListener('message', onSw); if (current?.userId === userId) { current = null; enabled = false; bump(); } } };
  return e2ee;
}
/** Sign out: stop. The keys stay on this device (so signing in again keeps the chats); "forget this device" removes them. */
export function stopE2ee() { current?.stop(); }
/** Delete this device's encryption data (the person asked, or the account was deleted). */
export async function forgetDevice(userId: number) { current?.stop(); const kv = await openDeviceKv(userId); await kv.wipe(); }

export const getE2ee = (): E2ee | null => (enabled ? current?.e2ee ?? null : null);
export const e2eeEnabled = () => enabled;
/** Re-render when the engine becomes ready or something it keeps changed. */
export function useE2ee(): { on: boolean; e2ee: E2ee | null } {
  const [, tick] = useState(0);
  useEffect(() => { const l = () => tick(n => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return { on: enabled, e2ee: enabled ? current?.e2ee ?? null : null };
}
/** Call `fn` when the engine learns something about a chat (a chat joined, keys changed, a notice). */
export function onChatChange(fn: (circle: number | null) => void) { chatListeners.add(fn); return () => { chatListeners.delete(fn); }; }
/** Open (or create) a one-to-one chat: encrypted when this server has encryption on, then make sure its keys exist. */
export async function openDirect(body: { userId?: number; phone?: string }): Promise<{ id: number }> {
  const r = await api<{ id: number }>('/direct', { body: { ...body, ...(enabled ? { encrypted: true } : {}) } });
  if (enabled) getE2ee()?.startChat(r.id).catch(() => undefined);
  return r;
}

/** A new device that has a recovery code: drop the blank device made at start-up, load the saved state (the same device as before) and start again. Throws E2eeError. */
export async function restoreDevice(userId: number, code: string, showPreview?: () => boolean): Promise<void> {
  const blank = current?.e2ee;
  await blank?.ready();
  await blank?.checkRecovery(code);   // a wrong code or no backup must not cost this device its keys
  const blankId = blank?.deviceId;
  stopE2ee();
  await forgetDevice(userId);
  const kv = await openDeviceKv(userId);
  try { await createE2ee(userId, { net, kv }).restore(code); }
  catch (e) { await kv.wipe(); startE2ee(userId, showPreview); throw e; }
  if (blankId) await net.json('DELETE', `/keys/devices/${blankId}`).catch(() => undefined);   // the blank one is not wanted any more
  startE2ee(userId, showPreview);
}
