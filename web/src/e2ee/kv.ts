// Device storage for end-to-end encryption (step 6, part B). Everything an encrypted chat needs to keep on THIS device lives here: the device's identity key, the secret halves of its
// key packages, the state of every encrypted chat (MLS keys are used once, so the state must be saved after every encrypt, decrypt and commit), and the decrypted history.
//
// Three layers: a plain key-value interface; IndexedDB or memory behind it; and a sealing layer that encrypts every value with a NON-EXTRACTABLE WebCrypto key (kept in the same
// browser profile, but its bytes can never be read by script, so a copy of the database file alone is unreadable). Honest limit: code running inside the app's own page can still ask
// the browser to use that key, and anyone who controls the signed-in browser profile can open the app. The sealing protects the stored file, not a compromised device.

export interface Kv {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  del(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  /** Remove everything (signing out, deleting the account, or "forget this device"). */
  wipe(): Promise<void>;
  /** false when the browser gave no durable storage: everything is lost when the tab closes (the app says so). */
  durable: boolean;
}

export function memoryKv(): Kv {
  const m = new Map<string, Uint8Array>();
  return {
    durable: false,
    get: async k => m.get(k)?.slice(),
    set: async (k, v) => { m.set(k, v.slice()); },
    del: async k => { m.delete(k); },
    keys: async (p = '') => [...m.keys()].filter(k => k.startsWith(p)).sort(),
    wipe: async () => { m.clear(); },
  };
}

const wait = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** IndexedDB, one database per person on this browser. Falls back to memory (durable: false) when the browser has none. */
export function idbKv(name: string): Kv {
  if (typeof indexedDB === 'undefined') return memoryKv();
  let opening: Promise<IDBDatabase> | null = null;
  const db = () => (opening ??= new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('wrap'); };
    // Someone else (this very page after a restore, or another tab that forgets this device) wants to delete or upgrade the database: let go, or the delete waits for ever.
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); opening = null; }; res(r.result); }; r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
  }));
  const store = async (mode: IDBTransactionMode) => (await db()).transaction('kv', mode).objectStore('kv');
  return {
    durable: true,
    get: async k => { const v = await wait(await store('readonly').then(s => s.get(k))); return v ? new Uint8Array(v as ArrayBuffer) : undefined; },
    set: async (k, v) => { await wait((await store('readwrite')).put(v.slice().buffer, k)); },
    del: async k => { await wait((await store('readwrite')).delete(k)); },
    keys: async (p = '') => ((await wait((await store('readonly')).getAllKeys())) as string[]).filter(k => k.startsWith(p)).sort(),
    async wipe() {
      try { (await db()).close(); } catch { /* never opened */ }
      opening = null;
      await new Promise<void>(res => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
    },
  };
}

/** The sealing key is never extractable: script in the page can ask the browser to use it, but can never read its bytes. */
export const newWrapKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
/** The wrapping key: made once per browser profile, non-extractable, kept next to the data. Returns null when the browser cannot store a CryptoKey. */
export async function wrapKeyFor(name: string): Promise<CryptoKey | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('wrap'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const got = await wait(db.transaction('wrap', 'readonly').objectStore('wrap').get('k')) as CryptoKey | undefined;
    if (got) { db.close(); return got; }
    const key = await newWrapKey();
    await wait(db.transaction('wrap', 'readwrite').objectStore('wrap').put(key, 'k'));
    db.close();
    return key;
  } catch { return null; }
}

const enc = new TextEncoder();
/** Encrypt every value with `key` (AES-GCM, a fresh random IV each time, the storage key as authenticated data so a value cannot be moved to another key). */
export function sealedKv(inner: Kv, key: CryptoKey): Kv {
  return {
    ...inner,
    async set(k, v) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(k) }, key, v as BufferSource));
      const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
      await inner.set(k, out);
    },
    async get(k) {
      const raw = await inner.get(k);
      if (!raw) return undefined;
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(k) }, key, raw.slice(12) as BufferSource));
    },
  };
}

/** The store of one person on this browser: IndexedDB sealed with a non-extractable key when possible. */
export async function openDeviceKv(userId: number): Promise<Kv> {
  const name = `thikra_e2ee_${userId}`;
  const inner = idbKv(name);
  if (!inner.durable) return inner;
  return chooseKv(inner, await wrapKeyFor(name));
}
/**
 * Sealed storage, or none. When the browser cannot keep the sealing key, the secrets are NOT written to disk in clear (they used to be, silently): they live in memory for this visit only
 * (`durable: false`, which the app already tells the person) and the device is set up again next time.
 */
export const chooseKv = (inner: Kv, key: CryptoKey | null): Kv => (key ? sealedKv(inner, key) : memoryKv());

// ---- JSON and small helpers over bytes -----------------------------------------------------------------------------------------------------

const dec = new TextDecoder();
export const toBytes = (v: unknown) => enc.encode(JSON.stringify(v));
export async function getJson<T>(kv: Kv, key: string): Promise<T | undefined> {
  const b = await kv.get(key);
  if (!b) return undefined;
  try { return JSON.parse(dec.decode(b)) as T; } catch { return undefined; }
}
export const setJson = (kv: Kv, key: string, v: unknown) => kv.set(key, toBytes(v));

