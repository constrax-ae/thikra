import { REGION } from '../app.ts';
import { all, one, run } from '../db.ts';
import { dropBlobIfUnused } from './deletes.ts';
import { randomBytes } from 'node:crypto';
import { trackJob } from './jobs.ts';

// ---- circles ------------------------------------------------------------------

export const MAX_PINNED = 3;
/** The one-to-one chat of two people (one per pair, whoever asks), created if it does not exist yet. */
export function directChat(userId: number, otherId: number): { id: number; created: boolean } {
  const existing = one(
    `SELECT c.id FROM circles c
       JOIN circle_members a ON a.circle_id = c.id AND a.user_id = ?
       JOIN circle_members b ON b.circle_id = c.id AND b.user_id = ?
      WHERE c.kind = 'direct' AND c.deleted_at IS NULL LIMIT 1`, userId, otherId);
  if (existing) return { id: existing.id, created: false };
  const r = run("INSERT INTO circles (name, owner_id, invite_code, invite_enabled, kind, region) VALUES ('', ?, ?, 0, 'direct', ?)", userId, randomBytes(5).toString('hex'), REGION);
  const id = Number(r.lastInsertRowid);
  run("INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, 'owner')", id, userId);
  run("INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, 'member')", id, otherId);
  return { id, created: true };
}
// Removing a member: the owner can remove anyone, an admin only plain members, anyone can leave (except the owner).
export const RESTORE_DAYS = 90;
/** Really erases circles that stayed deleted for 90 days: rows (everything cascades) and the files nobody else uses. */
export async function purgeDeletedCircles(): Promise<number> {
  const old = all(`SELECT id FROM circles WHERE deleted_at IS NOT NULL AND deleted_at <= datetime('now', '-${RESTORE_DAYS} days')`);
  for (const { id } of old) {
    const hashes = [...all('SELECT DISTINCT blob_hash FROM media WHERE circle_id = ?', id), ...all('SELECT DISTINCT blob_hash FROM sealed_messages WHERE circle_id = ? AND blob_hash IS NOT NULL', id)].map(r => r.blob_hash as string);
    run('DELETE FROM circles WHERE id = ?', id);
    for (const h of hashes) await dropBlobIfUnused(h);
  }
  return old.length;
}
const purgeJob = trackJob('circles.purge', 6 * 3600_000, purgeDeletedCircles);
purgeJob();
setInterval(purgeJob, 6 * 3600_000).unref();
