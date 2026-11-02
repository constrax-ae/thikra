// Backups that can be PROVEN. A family's memory must not depend on one disk, and a backup nobody has ever restored is only a hope,
// so every backup can be verified (hashes, SQLite integrity, every file present) and restored with one command.
//
//   snapshot  data/backups/<timestamp>/thikra.db + manifest.json      (a consistent copy of the database, taken while the app runs)
//   pool      data/backups/blob-pool/<xx>/<yy>/<hash>                 (every media file ever referenced; content-addressed, copied once)
//
// pnpm backup                     take a backup now
// pnpm backup:verify [snapshot]   check the newest (or a named) snapshot
// pnpm backup:restore <snapshot> <target-data-dir>

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { db, dbFile, open, all, one } from './db.ts';
import { stagePending } from './pending-restore.ts';

export const backupRoot = () => resolve(process.env.THIKRA_BACKUPS ?? join(dirname(dbFile), 'backups'));
const blobRoot = () => resolve(process.env.THIKRA_BLOBS ?? 'data/blobs');
const poolPath = (root: string, hash: string) => join(root, 'blob-pool', hash.slice(0, 2), hash.slice(2, 4), hash);
const livePath = (hash: string) => join(blobRoot(), hash.slice(0, 2), hash.slice(2, 4), hash);
const HASH_RE = /^[0-9a-f]{64}$/;

const sha256 = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const exists = (p: string) => access(p).then(() => true, () => false);

export interface Manifest {
  id: string; createdAt: string; dbSha256: string; dbBytes: number;
  counts: { users: number; circles: number; messages: number; media: number };
  blobs: Array<{ hash: string; size: number }>;
}
export interface Report { id: string; ok: boolean; problems: string[]; counts?: Manifest['counts']; blobs?: number }

export async function createBackup(): Promise<Manifest> {
  const root = backupRoot();
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const dbOut = join(dir, 'thikra.db');
  // VACUUM INTO writes a consistent snapshot of the live database without stopping the app.
  db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);

  const refs = all("SELECT DISTINCT b.hash, b.size FROM blobs b WHERE EXISTS (SELECT 1 FROM media m WHERE m.blob_hash = b.hash) OR EXISTS (SELECT 1 FROM sealed_messages s WHERE s.blob_hash = b.hash AND s.status IN ('sealed','waiting'))");
  for (const { hash, size } of refs) {
    if (!HASH_RE.test(hash)) continue;
    const dest = poolPath(root, hash);
    // content-addressed: the same bytes are copied once. A pool file of the wrong size is damaged, so it is copied again (self-healing).
    if ((await stat(dest).catch(() => null))?.size === size) continue;
    const src = livePath(hash);
    if (!(await exists(src))) continue;     // reported by verify as missing, never invented
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
  const manifest: Manifest = {
    id, createdAt: new Date().toISOString(), dbSha256: await sha256(dbOut), dbBytes: (await stat(dbOut)).size,
    counts: {
      users: one('SELECT COUNT(*) n FROM users')!.n, circles: one('SELECT COUNT(*) n FROM circles')!.n,
      messages: one('SELECT COUNT(*) n FROM messages')!.n, media: one('SELECT COUNT(*) n FROM media')!.n,
    },
    blobs: refs.map(r => ({ hash: r.hash as string, size: r.size as number })),
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function listBackups(): Promise<Manifest[]> {
  const root = backupRoot();
  const out: Manifest[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    try { out.push(JSON.parse(await readFile(join(root, name, 'manifest.json'), 'utf8'))); } catch { /* not a snapshot */ }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/** Everything a restore would rely on, checked: the database file, its integrity, its row counts, and every referenced file's bytes. */
export async function verifyBackup(id?: string): Promise<Report> {
  const root = backupRoot();
  const m = id ? (await listBackups()).find(x => x.id === id) : (await listBackups())[0];
  if (!m) return { id: id ?? '', ok: false, problems: ['no such backup'] };
  const problems: string[] = [];
  const dbPath = join(root, m.id, 'thikra.db');
  if (!(await exists(dbPath))) return { id: m.id, ok: false, problems: ['the database file is missing'] };
  if ((await sha256(dbPath)) !== m.dbSha256) problems.push('the database file does not match its recorded hash (corrupted or altered)');

  // Open the snapshot as its own database (a copy, so the snapshot itself is never touched) and ask SQLite to check it.
  const probe = join(root, `.verify-${process.pid}-${Date.now()}.db`);
  await copyFile(dbPath, probe);
  try {
    const snap = await open(probe);
    const check = snap.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]);
    if (check.length !== 1 || check[0] !== 'ok') problems.push(`SQLite integrity check failed: ${check.slice(0, 3).join('; ')}`);
    const n = (t: string) => Number((snap.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);
    const counts = { users: n('users'), circles: n('circles'), messages: n('messages'), media: n('media') };
    for (const k of Object.keys(counts) as Array<keyof typeof counts>) if (counts[k] !== m.counts[k]) problems.push(`${k}: the snapshot has ${counts[k]}, the manifest says ${m.counts[k]}`);
  } catch (e) { problems.push(`the snapshot cannot be opened: ${e instanceof Error ? e.message : e}`); }
  finally { await rm(probe, { force: true }); await rm(`${probe}-wal`, { force: true }); await rm(`${probe}-shm`, { force: true }); await rm(`${probe}.lock`, { recursive: true, force: true }); }

  let missing = 0, corrupt = 0;
  for (const b of m.blobs) {
    const p = poolPath(root, b.hash);
    if (!(await exists(p))) { missing++; continue; }
    if ((await sha256(p)) !== b.hash) corrupt++;
  }
  if (missing) problems.push(`${missing} media file(s) are missing from the backup`);
  if (corrupt) problems.push(`${corrupt} media file(s) are corrupted in the backup`);
  return { id: m.id, ok: problems.length === 0, problems, counts: m.counts, blobs: m.blobs.length };
}

/** Put a snapshot into an empty data directory (database + media), ready to start the app on. Refuses to overwrite. */
export async function restoreBackup(id: string, targetDataDir: string): Promise<void> {
  const root = backupRoot();
  const m = (await listBackups()).find(x => x.id === id);
  if (!m) throw new Error('no such backup');
  const rep = await verifyBackup(id);
  if (!rep.ok) throw new Error(`refusing to restore a backup that fails verification: ${rep.problems.join('; ')}`);
  const target = resolve(targetDataDir);
  if (await exists(join(target, 'thikra.db'))) throw new Error(`${target}/thikra.db already exists: refusing to overwrite`);
  await mkdir(join(target, 'blobs'), { recursive: true });
  await copyFile(join(root, m.id, 'thikra.db'), join(target, 'thikra.db'));
  for (const b of m.blobs) {
    const dest = join(target, 'blobs', b.hash.slice(0, 2), b.hash.slice(2, 4), b.hash);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(poolPath(root, b.hash), dest);
  }
}

/** Keep the newest `keep` snapshots. The shared pool is never pruned here (it is the only copy of old media). */
export async function pruneBackups(keep = 7): Promise<number> {
  const all_ = await listBackups();
  for (const m of all_.slice(keep)) await rm(join(backupRoot(), m.id), { recursive: true, force: true });
  return Math.max(0, all_.length - keep);
}

/** Stage a restore for the next start (see pending-restore.ts). The backup must pass verification; nothing is touched until the server restarts. */
export async function stageRestore(id: string, by: string): Promise<{ ok: boolean; problems: string[] }> {
  const m = (await listBackups()).find(x => x.id === id);
  if (!m) return { ok: false, problems: ['no such backup'] };
  const rep = await verifyBackup(id);
  if (!rep.ok) return { ok: false, problems: rep.problems };
  stagePending(dbFile, join(backupRoot(), m.id, 'thikra.db'), { id: m.id, at: new Date().toISOString(), by, dbSha256: m.dbSha256, blobs: m.blobs });
  return { ok: true, problems: [] };
}
