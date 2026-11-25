import { api } from './api';

/**
 * Sharing where I am, while it lasts.
 *
 * Only the LATEST point is ever sent, and only while Tamtim is open on this device — a web page cannot follow
 * someone in the background, and we do not pretend otherwise: the card shows when each point arrived, so a pin
 * that stopped moving is visibly a pin that stopped moving. It ends by itself at `until`, or when the person stops it.
 * Nothing about where they have been is kept anywhere: each point overwrites the one before it.
 */

export interface Share { mid: number; circleId: number; until: number }

const KEY = 'tamtim_live';
export const MIN_GAP_MS = 15_000;   // never more often than this, however fast the device reports
export const MOVED_M = 25;          // a reading that has not moved further than this is noise, not news
export const MAX_GAP_MS = 120_000;  // but say something at least this often, so others can see it is still running

export interface Storage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const store = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

/** Metres between two points (the usual spherical formula; good to a few metres at these distances). */
export function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface Last { at: number; lat: number; lng: number }
/** Whether this reading is worth sending: the first one always, then only if it moved or enough time has passed. */
export function shouldSend(last: Last | null, now: number, lat: number, lng: number): boolean {
  if (!last) return true;
  const since = now - last.at;
  if (since < MIN_GAP_MS) return false;
  return since >= MAX_GAP_MS || metres(last.lat, last.lng, lat, lng) >= MOVED_M;
}

/** The shares still running. One that has run out simply drops off; the server stops accepting points at the same moment. */
export const prune = (list: readonly Share[], now: number): Share[] => list.filter(s => s.until > now);

export function shares(storage: Storage | null = store(), now = Date.now()): Share[] {
  try {
    const raw = storage?.getItem(KEY);
    const list = raw ? JSON.parse(raw) as Share[] : [];
    return Array.isArray(list) ? prune(list.filter(s => Number.isInteger(s?.mid) && Number.isInteger(s?.circleId)), now) : [];
  } catch { return []; }
}
function write(list: Share[], storage: Storage | null = store()) {
  try { if (list.length) storage?.setItem(KEY, JSON.stringify(list)); else storage?.removeItem(KEY); } catch { /* private mode: it just will not resume after a refresh */ }
}
export function addShare(s: Share, storage: Storage | null = store(), now = Date.now()): Share[] {
  const list = [...shares(storage, now).filter(x => x.mid !== s.mid), s];
  write(list, storage);
  return list;
}
export function dropShare(mid: number, storage: Storage | null = store(), now = Date.now()): Share[] {
  const list = shares(storage, now).filter(x => x.mid !== mid);
  write(list, storage);
  return list;
}
export const isSharing = (mid: number, storage: Storage | null = store(), now = Date.now()) => shares(storage, now).some(s => s.mid === mid);

// ---- the watcher ---------------------------------------------------------------------------------
// One for the whole app: it starts when something is being shared and stops the moment nothing is.

let watch: number | null = null;
let last: Last | null = null;
const listeners = new Set<() => void>();
/** Told when a share starts or ends, so an open chat redraws its buttons. Returns the way to stop listening. */
export function onShareChange(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
const changed = () => { for (const fn of [...listeners]) fn(); };

function send(now: number, lat: number, lng: number, accuracy: number | null) {
  const running = shares();
  if (!running.length) { stopWatching(); return; }
  if (!shouldSend(last, now, lat, lng)) return;
  last = { at: now, lat, lng };
  for (const s of running) {
    api(`/messages/${s.mid}/live`, { method: 'PUT', body: { lat, lng, accuracy } })
      .catch(() => { dropShare(s.mid); changed(); });   // refused (it ended, or the message is gone): stop trying
  }
}

export function startWatching() {
  if (watch !== null || typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
  if (!shares().length) return;
  watch = navigator.geolocation.watchPosition(
    p => send(Date.now(), p.coords.latitude, p.coords.longitude, p.coords.accuracy ?? null),
    () => { /* a lost fix is not a reason to stop: the next one may come */ },
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 });
}
export function stopWatching() {
  if (watch !== null && typeof navigator !== 'undefined') navigator.geolocation.clearWatch(watch);
  watch = null; last = null;
}

/** Start sharing from a message that has just been sent. */
export function beginShare(mid: number, circleId: number, until: number) {
  addShare({ mid, circleId, until });
  last = null;
  startWatching();
  changed();
}

/** Stop sharing: the server is told first, so everyone's card says "stopped" even if this device goes away next. */
export async function stopSharing(mid: number) {
  try { await api(`/messages/${mid}/live/stop`, { body: {} }); } finally {
    dropShare(mid);
    if (!shares().length) stopWatching();
    changed();
  }
}

/** Called once when the app opens: anything still running carries on. */
export function resumeShares() { if (shares().length) startWatching(); }
