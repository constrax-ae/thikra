import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrations/index.ts';
import { restoreIfNewer } from './offsite-store.ts';
import { applyPendingRestore } from './pending-restore.ts';

/** The few SQLite calls the app uses. Both backends below satisfy it. */
export interface Statement {
  get(...args: any[]): Row | undefined;
  all(...args: any[]): Row[];
  run(...args: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close?(): void;
}

/** Integers can come back as BigInt from the WebAssembly build; JSON and the rest of the app expect numbers. */
const plain = (row: Row | null | undefined): Row | undefined =>
  row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])) : undefined;

/**
 * The WebAssembly build guards the file with a `<file>.lock` directory. If the process is killed (a crash, a power
 * cut, the host stopping the app), that directory stays behind and every later start fails with "database is locked":
 * the app would be down until someone deleted it by hand. We record our pid next to the file, and at start remove the
 * lock only when the pid that left it is no longer running. A live holder is never touched, so two servers still cannot
 * write the same file. (Found by the SIGKILL test, server/crash.test.ts.)
 */
function clearStaleLock(path: string) {
  const lock = `${path}.lock`, pidFile = `${path}.pid`;
  if (existsSync(lock)) {
    let alive = false;
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true; } // throws if no such process
    } catch (e: any) { alive = e?.code === 'EPERM'; } // EPERM: it exists but is not ours, so it is alive
    if (!alive) rmSync(lock, { recursive: true, force: true });
  }
  writeFileSync(pidFile, String(process.pid));
}

/**
 * Node's built-in SQLite when it exists (Node 22.13 or newer), otherwise a WebAssembly build of SQLite
 * that runs on older Node (for example Replit's Node 20) with no native compilation.
 * Set THIKRA_SQLITE=wasm to force the fallback.
 */
export async function open(path: string): Promise<Db> {
  if (process.env.THIKRA_SQLITE !== 'wasm') {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      return new DatabaseSync(path) as unknown as Db;
    } catch { /* this Node has no node:sqlite: use the fallback */ }
  }
  if (path !== ':memory:') clearStaleLock(path);
  const wasm: any = await import('node-sqlite3-wasm'); // CommonJS: the class is on the module or on `default`
  const raw = new (wasm.Database ?? wasm.default.Database)(path);
  return {
    exec: sql => raw.exec(sql),
    close: () => raw.close(),
    prepare: sql => ({
      get: (...a) => plain(raw.get(sql, a as any) as Row | null),
      all: (...a) => (raw.all(sql, a as any) as Row[]).map(r => plain(r)!),
      run: (...a) => raw.run(sql, a as any),
    }),
  };
}

const file = process.env.THIKRA_DB ?? 'data/thikra.db';
if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

export const dbFile = file;
// If the off-server copy has newer data than this disk (a republish or a new machine brought an old file), restore it before opening.
// A restore staged from the admin screen is applied first (it writes a fresh epoch, so the off-server copy cannot undo it).
await applyPendingRestore(file, open);
await restoreIfNewer(file, open);
export const db = await open(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

await migrate(db);

export type Row = Record<string, any>;
export const one = (sql: string, ...args: any[]) => db.prepare(sql).get(...args) as Row | undefined;
export const all = (sql: string, ...args: any[]) => db.prepare(sql).all(...args) as Row[];
export const run = (sql: string, ...args: any[]) => db.prepare(sql).run(...args);
