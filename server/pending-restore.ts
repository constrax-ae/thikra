import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

// Restoring a backup over a running server is never done live. The admin screen STAGES it (verified copy of the database + a marker); the next start applies it,
// BEFORE the database opens: the current file is kept beside it (`thikra.db.before-restore-<time>`), the backup's database takes its place, any media missing
// from this disk are copied back from the backup pool, and a fresh epoch is written inside so the off-server copy cannot mistake the restored file for a stale one.
export interface Pending { id: string; at: string; by: string; dbSha256: string; blobs: Array<{ hash: string; size: number }> }
export const pendingDir = (dbFile: string) => join(dirname(resolve(dbFile)), 'restore-pending');
export const readPending = (dbFile: string): Pending | null => { try { return JSON.parse(readFileSync(join(pendingDir(dbFile), 'restore.json'), 'utf8')); } catch { return null; } };
export const cancelPending = (dbFile: string) => rmSync(pendingDir(dbFile), { recursive: true, force: true });
export function stagePending(dbFile: string, dbSource: string, p: Pending) {
  const dir = pendingDir(dbFile);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(dbSource, join(dir, 'thikra.db'));
  writeFileSync(join(dir, 'restore.json'), JSON.stringify(p, null, 2));
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export const lastRestore: { at: string | null; id: string | null; error: string | null } = { at: null, id: null, error: null };

export async function applyPendingRestore(file: string, open: (path: string) => Promise<{ exec(sql: string): void; prepare(sql: string): { run(...a: any[]): unknown }; close?(): void }>): Promise<boolean> {
  if (file === ':memory:') return false;
  const dir = pendingDir(file), marker = join(dir, 'restore.json');
  if (!existsSync(marker)) return false;
  try {
    const p: Pending = JSON.parse(readFileSync(marker, 'utf8'));
    const staged = join(dir, 'thikra.db');
    if (!existsSync(staged) || sha(staged) !== p.dbSha256) throw new Error('the staged database does not match its checksum: nothing was changed');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // The kept copy is the old database WITH its write-ahead log (recent committed work lives there until a checkpoint): the -wal and -shm files move along with it.
    if (existsSync(file)) { for (const ext of ['', '-wal', '-shm']) if (existsSync(file + ext)) renameSync(file + ext, `${file}.before-restore-${stamp}${ext}`); }
    for (const ext of ['.lock', '.pid']) rmSync(file + ext, { recursive: true, force: true });
    copyFileSync(staged, file);
    // media this disk lacks come back from the backup pool (content-addressed, so nothing is overwritten)
    const backups = resolve(process.env.THIKRA_BACKUPS ?? join(dirname(resolve(file)), 'backups')), blobs = resolve(process.env.THIKRA_BLOBS ?? 'data/blobs');
    let copied = 0;
    for (const b of p.blobs) {
      if (!/^[0-9a-f]{64}$/.test(b.hash)) continue;
      const dest = join(blobs, b.hash.slice(0, 2), b.hash.slice(2, 4), b.hash), from = join(backups, 'blob-pool', b.hash.slice(0, 2), b.hash.slice(2, 4), b.hash);
      if (existsSync(dest) || !existsSync(from)) continue;
      mkdirSync(dirname(dest), { recursive: true }); copyFileSync(from, dest); copied++;
    }
    // a new epoch inside the restored file: newer than the off-server copy, so the next snapshot replaces it with this data instead of the other way round
    const d = await open(file);
    try { d.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); d.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('offsite_epoch', new Date().toISOString()); }
    finally { try { d.close?.(); } catch { /* closed */ } }
    rmSync(dir, { recursive: true, force: true });
    lastRestore.at = new Date().toISOString(); lastRestore.id = p.id; lastRestore.error = null;
    console.log(`[restore] applied backup ${p.id}; the previous database was kept as ${file}.before-restore-${stamp}; ${copied} media file(s) copied back`);
    return true;
  } catch (e) {
    lastRestore.error = e instanceof Error ? e.message : String(e);
    console.error('[restore] not applied:', lastRestore.error);
    try { renameSync(marker, join(dir, 'restore.failed.json')); } catch { /* leave it */ }
    return false;
  }
}
