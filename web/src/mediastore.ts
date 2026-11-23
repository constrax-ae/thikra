import type { JobStore, UploadJob } from './uploads';

// Where unsent media lives on this device (IndexedDB, which can hold files): the jobs of the media outbox, and the recording that
// is being made right now. It belongs to one person; signing out wipes it. If the browser has no such storage (some private
// modes), everything still works from memory until the tab closes.

/** A voice note that is being recorded, written here piece by piece so that a closed tab or a crash does not lose it. */
export interface RecDraft { circle: number; mime: string; ms: number; chunks: Blob[]; peaks: number[]; transcript: string; at: number }
export interface DraftStore { get(circle: number): Promise<RecDraft | null>; put(d: RecDraft): Promise<void>; remove(circle: number): Promise<void> }
export interface MediaStore { jobs: JobStore; drafts: DraftStore; wipe(): Promise<void> }

const wait = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function memory(): MediaStore {
  const jobs = new Map<string, UploadJob>(), drafts = new Map<number, RecDraft>();
  return {
    jobs: { all: async () => [...jobs.values()], put: async j => { jobs.set(j.cid, j); }, remove: async c => { jobs.delete(c); } },
    drafts: { get: async c => drafts.get(c) ?? null, put: async d => { drafts.set(d.circle, d); }, remove: async c => { drafts.delete(c); } },
    wipe: async () => { jobs.clear(); drafts.clear(); },
  };
}

export function openMediaStore(userId: number): MediaStore {
  const name = `thikra_media_${userId}`;
  const fallback = memory();
  let broken = typeof indexedDB === 'undefined';
  let opening: Promise<IDBDatabase> | null = null;
  const db = () => (opening ??= new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('jobs', { keyPath: 'cid' }); r.result.createObjectStore('drafts', { keyPath: 'circle' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
  }));
  // Every operation tries the real storage and falls back to memory for good only if the storage cannot be opened.
  async function use<T>(store: 'jobs' | 'drafts', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, or: () => Promise<T>): Promise<T> {
    if (broken) return or();
    let base: IDBDatabase;
    try { base = await db(); } catch { broken = true; return or(); }   // no storage at all (some private modes): memory for this visit
    // One operation that fails (the device is full) uses memory for that operation only: what is already in storage is still read and removed there.
    try { return await wait(fn(base.transaction(store, mode).objectStore(store))); }
    catch { return or(); }
  }
  return {
    jobs: {
      all: () => use<UploadJob[]>('jobs', 'readonly', s => s.getAll(), fallback.jobs.all),
      put: async j => { await use('jobs', 'readwrite', s => s.put(j), async () => { await fallback.jobs.put(j); return undefined as any; }); },
      remove: async c => { await use('jobs', 'readwrite', s => s.delete(c), async () => { await fallback.jobs.remove(c); return undefined as any; }); },
    },
    drafts: {
      get: async c => (await use<RecDraft | undefined>('drafts', 'readonly', s => s.get(c), async () => (await fallback.drafts.get(c)) ?? undefined)) ?? null,
      put: async d => { await use('drafts', 'readwrite', s => s.put(d), async () => { await fallback.drafts.put(d); return undefined as any; }); },
      remove: async c => { await use('drafts', 'readwrite', s => s.delete(c), async () => { await fallback.drafts.remove(c); return undefined as any; }); },
    },
    async wipe() {
      await fallback.wipe();
      if (typeof indexedDB === 'undefined') return;
      try { (await db()).close(); } catch { /* never opened */ }
      opening = null;
      await new Promise<void>(res => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
    },
  };
}
