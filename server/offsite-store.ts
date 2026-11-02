import { createHash } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// A copy of the family's data OFF the server's own disk. A published Replit app keeps its files on a disk that a republish or a move to another
// machine can replace; this keeps a snapshot somewhere that survives (Replit App Storage, or any folder, e.g. a mounted drive).
// This file has no dependency on the database, so the database module can use it to restore BEFORE it opens.
//
//   THIKRA_OFFSITE=off          never
//   THIKRA_OFFSITE=replit       Replit App Storage (the app's default bucket)
//   THIKRA_OFFSITE=dir:/path    a folder (also what the tests use)
//   unset                       on a published Replit deployment: Replit App Storage; anywhere else: off.
//                               The editor workspace never uploads, so it can never mix its test data into the live copy.

export interface Offsite {
  put(name: string, data: Buffer): Promise<void>;
  get(name: string): Promise<Buffer | null>;
  list(prefix: string): Promise<string[]>;
  delete(name: string): Promise<void>;
}
export const status: { kind: string; ready: boolean; lastSnapshotAt: string | null; lastStamp: string | null; lastError: string | null; restoredAt: string | null } =
  { kind: 'off', ready: false, lastSnapshotAt: null, lastStamp: null, lastError: null, restoredAt: null };

export function folderOffsite(dir: string): Offsite {
  const path = (name: string) => join(dir, ...name.split('/').filter(x => x && x !== '..'));
  return {
    async put(name, data) { const p = path(name); await mkdir(dirname(p), { recursive: true }); await writeFile(p, data); },
    async get(name) { try { return await readFile(path(name)); } catch { return null; } },
    async list(prefix) {
      const out: string[] = [];
      const walk = async (rel: string) => {
        let entries; try { entries = await readdir(join(dir, rel), { withFileTypes: true }); } catch { return; }
        for (const e of entries) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) await walk(r); else if (r.startsWith(prefix)) out.push(r); }
      };
      await walk('');
      return out;
    },
    async delete(name) { await rm(path(name), { force: true }); },
  };
}

async function replitOffsite(): Promise<Offsite> {
  const { Client } = await import('@replit/object-storage');
  const c = new Client();
  const probe = await c.list({ maxResults: 1 });   // fails when the app has no bucket yet
  if (!probe.ok) throw new Error(`Replit App Storage is not set up for this app (${probe.error.message})`);
  return {
    async put(name, data) { const r = await c.uploadFromBytes(name, data, { compress: false }); if (!r.ok) throw new Error(r.error.message); },
    async get(name) { const r = await c.downloadAsBytes(name, { decompress: false }); return r.ok ? r.value[0] : null; },
    async list(prefix) { const r = await c.list({ prefix }); if (!r.ok) throw new Error(r.error.message); return r.value.map(o => o.name); },
    async delete(name) { await c.delete(name, { ignoreNotFound: true }); },
  };
}

let resolved: Promise<Offsite | null> | undefined;
/** The configured off-server store, or null (and `status.lastError` says why when it was wanted but failed). */
export function offsite(): Promise<Offsite | null> {
  return (resolved ??= (async () => {
    const mode = process.env.THIKRA_OFFSITE ?? (process.env.REPLIT_DEPLOYMENT ? 'replit' : 'off');
    status.kind = mode.startsWith('dir:') ? 'folder' : mode;
    try {
      if (mode === 'off') return null;
      const s = mode.startsWith('dir:') ? folderOffsite(mode.slice(4)) : mode === 'replit' ? await replitOffsite() : null;
      status.ready = !!s;
      return s;
    } catch (e) { status.lastError = e instanceof Error ? e.message : String(e); console.error('[offsite]', status.lastError); return null; }
  })());
}

export const MANIFEST = 'db/manifest.json';
export const DB_FILE = 'db/thikra.db.gz';
export const blobKey = (hash: string) => `blobs/${hash}`;
export interface Manifest { gate: string; at: string; users: number; messages: number; blobs: number }

/** What changed since the last snapshot, as one string: the newest time of anything people did, and how many of each kind of thing exist. Equal means nothing to upload. */
export const GATE_SQL = `SELECT IFNULL((SELECT MAX(t) FROM (
  SELECT MAX(created_at) AS t FROM messages UNION ALL SELECT MAX(created_at) FROM users UNION ALL SELECT MAX(created_at) FROM circles
  UNION ALL SELECT MAX(created_at) FROM archive_entries UNION ALL SELECT MAX(created_at) FROM albums UNION ALL SELECT MAX(created_at) FROM support_messages)), '')
  || '#' || (SELECT COUNT(*) FROM messages) || ':' || (SELECT COUNT(*) FROM users) || ':' || (SELECT COUNT(*) FROM circles) || ':' || (SELECT COUNT(*) FROM media)
  || ':' || (SELECT COUNT(*) FROM album_items) || ':' || (SELECT COUNT(*) FROM archive_entries) || ':' || (SELECT COUNT(*) FROM persons) AS gate`;
/** Each snapshot writes its own time INSIDE the database before copying it. At start, a database whose time is older than the off-server copy is a stale one. */
export const EPOCH_KEY = 'offsite_epoch';

/**
 * At start, BEFORE the database opens: if the off-server copy holds newer data than the database file on this disk (a fresh disk, or a stale copy
 * brought by a republish), put the off-server copy in its place. The files (blobs) come back one by one, when they are first asked for.
 */
export async function restoreIfNewer(file: string, openDb: (path: string) => Promise<{ prepare(sql: string): { get(): any }; close?(): void }>): Promise<boolean> {
  if (file === ':memory:') return false;
  const store = await offsite();
  if (!store) return false;
  try {
    const raw = await store.get(MANIFEST);
    if (!raw) return false;
    const manifest: Manifest = JSON.parse(raw.toString('utf8'));
    let local = '';
    if (existsSync(file)) {
      let d: Awaited<ReturnType<typeof openDb>> | undefined;
      try { d = await openDb(file); local = String(d.prepare(`SELECT value FROM settings WHERE key = '${EPOCH_KEY}'`).get()?.value ?? ''); }
      catch { local = ''; }                       // no such table, an unreadable file: treat as "nothing here"
      finally { try { d?.close?.(); } catch { /* already closed */ } }   // the probe must never keep the file open
    }
    if (!(manifest.at > local)) return false;   // the copy is not newer than this disk: keep this disk (it may hold newer work)
    const gz = await store.get(DB_FILE);
    if (!gz) return false;
    const bytes = gunzipSync(gz);
    for (const ext of ['-wal', '-shm', '.lock', '.pid']) rmSync(file + ext, { recursive: true, force: true });
    writeFileSync(file, bytes);
    status.restoredAt = new Date().toISOString();
    console.log(`[offsite] restored the database from the off-server copy (newer: ${manifest.at} > ${local || 'nothing here'}; ${manifest.users} people, ${manifest.messages} messages)`);
    return true;
  } catch (e) { status.lastError = e instanceof Error ? e.message : String(e); console.error('[offsite] restore failed:', status.lastError); return false; }
}

/** Wrap the local blob store: a file missing on this disk is fetched from the off-server copy, kept locally, and served. */
export function withOffsite<T extends { get(hash: string): Promise<Buffer | null> }>(local: T): T {
  return {
    ...local,
    async get(hash: string) {
      const here = await local.get(hash);
      if (here) return here;
      const store = await offsite();
      if (!store || !/^[0-9a-f]{64}$/.test(hash)) return null;
      try {
        const data = await store.get(blobKey(hash));
        if (!data || createHash('sha256').update(data).digest('hex') !== hash) return null;   // never trust a copy that does not match its own name
        await (local as any).put(data);
        return data;
      } catch { return null; }
    },
  };
}
