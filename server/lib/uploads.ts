import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { all, one, run, type Row } from '../db.ts';

// ---- resumable uploads -------------------------------------------------------------------------
// A big file arrives in pieces. Each piece says where it starts; the server appends it only if that is exactly where the file has
// got to, and always answers with how much it holds. After a dropped connection the device asks "how far did you get?" and goes on
// from there. NO message exists until every byte of every file has arrived, so a cancelled upload leaves nothing in the chat.
// The pieces wait on this server's own disk (one server today); anything not finished within a day is thrown away.

export const MAX_CHUNK = 8 * 1024 * 1024;
export const MAX_OPEN = 30;                       // unfinished uploads one person may have at a time
const STALE = "datetime('now', '-1 day')";
const ID_RE = /^[0-9a-f]{32}$/;
const root = () => join(process.env.THIKRA_BLOBS ?? 'data/blobs', '.uploads');
const pathFor = (id: string) => join(root(), id);
const locks = new Map<string, Promise<unknown>>();   // one writer per upload at a time
function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {}).finally(() => { if (locks.get(id) === tail) locks.delete(id); });
  locks.set(id, tail);
  return next;
}

export function openUpload(userId: number, circleId: number, name: string, size: number, checksum: string | null = null): string {
  const id = randomBytes(16).toString('hex');
  run('INSERT INTO uploads (id, user_id, circle_id, name, size, checksum) VALUES (?, ?, ?, ?, ?, ?)', id, userId, circleId, name, size, checksum);
  return id;
}
/** MED-05: a 64-character hex SHA-256, or nothing. Anything else is refused rather than silently ignored. */
export const cleanChecksum = (v: unknown): string | null | undefined =>
  v === undefined || v === null || v === '' ? null : (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : undefined);
export const openCount = (userId: number) => one(`SELECT COUNT(*) AS n FROM uploads WHERE user_id = ? AND created_at > ${STALE}`, userId)!.n as number;
/** An upload of this person's that has not expired. */
export const uploadOf = (id: unknown, userId: number): Row | undefined =>
  (typeof id === 'string' && ID_RE.test(id) ? one(`SELECT * FROM uploads WHERE id = ? AND user_id = ? AND created_at > ${STALE}`, id, userId) : undefined);

/** Add a piece. It is taken only if `offset` is exactly what the server holds; either way the answer is how much it holds now. */
export function appendUpload(up: Row, offset: number, piece: Buffer): Promise<{ ok: boolean; offset: number }> {
  return locked(up.id, async () => {
    const cur = one('SELECT received, size FROM uploads WHERE id = ?', up.id);
    if (!cur) return { ok: false, offset: 0 };
    if (offset !== cur.received || piece.length === 0 || cur.received + piece.length > cur.size) return { ok: false, offset: cur.received };
    await mkdir(root(), { recursive: true });
    // The file and the row can disagree after a crash between the two writes: the smaller of the two is the truth.
    const onDisk = await stat(pathFor(up.id)).then(s => s.size, () => 0);
    if (onDisk > cur.received) await truncate(pathFor(up.id), cur.received);
    else if (onDisk < cur.received) { run('UPDATE uploads SET received = ? WHERE id = ?', onDisk, up.id); return { ok: false, offset: onDisk }; }
    await appendFile(pathFor(up.id), piece);
    run('UPDATE uploads SET received = ? WHERE id = ?', cur.received + piece.length, up.id);
    return { ok: true, offset: cur.received + piece.length };
  });
}
/** The whole file, once every byte has arrived; null before that. */
export async function readUpload(up: Row): Promise<Buffer | null> {
  const cur = one('SELECT received, size FROM uploads WHERE id = ?', up.id);
  if (!cur || cur.received !== cur.size) return null;
  const buf = await readFile(pathFor(up.id)).catch(() => null);
  return buf && buf.length === cur.size ? buf : null;
}
export async function dropUpload(id: string) {
  if (!ID_RE.test(id)) return;
  // Behind any piece that is being written right now, so that the piece cannot bring the file back after it is deleted.
  await locked(id, async () => {
    run('DELETE FROM uploads WHERE id = ?', id);
    await rm(pathFor(id), { force: true });
  });
}
/** Throw away what was never finished. */
export async function purgeStaleUploads(): Promise<number> {
  const old = all(`SELECT id FROM uploads WHERE created_at <= ${STALE}`);
  for (const r of old) await dropUpload(r.id as string);
  return old.length;
}
