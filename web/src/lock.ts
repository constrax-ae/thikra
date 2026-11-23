/**
 * Chat lock, the device's half: a PIN chosen on THIS device. Only a salted PBKDF2 hash is kept (in this browser's storage); the digits and the hash never
 * reach the server, which only knows which chats are flagged as locked. It hides and gates the screen. It does not encrypt what the browser stores:
 * someone who can open this browser's developer tools can get past it, and the app says so.
 */
export interface LockStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const KEY = 'tamtim_lock';
const ITER = 150_000;
const RELOCK_MS = 60_000;
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b instanceof Uint8Array ? b : b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map(h => parseInt(h, 16)));
const PIN_OK = /^\d{4,10}$/;

interface Saved { salt: string; hash: string; fails: number; until: number }

async function derive(pin: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITER }, key, 256));
}

export function createLock(store: LockStore | null, now: () => number = Date.now) {
  let open = false, hiddenAt: number | null = null;
  const listeners = new Set<() => void>();
  const tell = () => listeners.forEach(f => f());
  const read = (): Saved | null => { try { const v = store?.getItem(KEY); return v ? JSON.parse(v) as Saved : null; } catch { return null; } };
  const write = (s: Saved | null) => { try { if (s) store?.setItem(KEY, JSON.stringify(s)); else store?.removeItem(KEY); } catch { /* not kept: the PIN lasts this visit only */ } };
  let memoryOnly: Saved | null = null;   // when storage is not available the PIN still works until the tab closes
  const get = () => read() ?? memoryOnly;
  const put = (s: Saved | null) => { memoryOnly = s; write(s); };
  return {
    hasPin: () => !!get(),
    isUnlocked: () => open,
    /** Choose (or change) the PIN. False if it is not 4 to 10 digits. Choosing it opens the locked chats for this visit. */
    async setPin(pin: string): Promise<boolean> {
      if (!PIN_OK.test(pin)) return false;
      const salt = crypto.getRandomValues(new Uint8Array(16));
      put({ salt: hex(salt), hash: await derive(pin, salt), fails: 0, until: 0 });
      open = true; tell(); return true;
    },
    /** Check the PIN. After 5 wrong tries (and then every 5th) the person waits 30 s, doubling, up to 15 minutes; the wait survives a reload. */
    async unlock(pin: string): Promise<{ ok: boolean; waitS?: number }> {
      const s = get();
      if (!s) return { ok: false };
      if (s.until > now()) return { ok: false, waitS: Math.ceil((s.until - now()) / 1000) };
      const good = PIN_OK.test(pin) && (await derive(pin, unhex(s.salt))) === s.hash;
      if (good) { put({ ...s, fails: 0, until: 0 }); open = true; tell(); return { ok: true }; }
      const fails = s.fails + 1;
      const until = fails % 5 === 0 ? now() + Math.min(900, 30 * 2 ** (fails / 5 - 1)) * 1000 : 0;
      put({ ...s, fails, until });
      return until ? { ok: false, waitS: Math.ceil((until - now()) / 1000) } : { ok: false };
    },
    lock() { if (open) { open = false; tell(); } },
    /** The page went to the background / came back: after a minute away it locks again. */
    hidden() { hiddenAt = now(); },
    visible() { if (hiddenAt !== null && now() - hiddenAt >= RELOCK_MS) this.lock(); hiddenAt = null; },
    /** Forget the PIN on this device (signing out does this). */
    clear() { put(null); if (open) open = false; tell(); },
    onChange(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; },
  };
}

let storage: LockStore | null = null;
try { storage = window.localStorage; } catch { /* private mode */ }
export const deviceLock = createLock(storage);
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => (document.hidden ? deviceLock.hidden() : deviceLock.visible()));
