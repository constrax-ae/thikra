import { REGION } from '../app.ts';
import { all, one, run } from '../db.ts';
import { dropBlobIfUnused } from './deletes.ts';
import { randomBytes } from 'node:crypto';
import { trackJob } from './jobs.ts';
import { memberJoined } from '../live.ts';

// ---- circles ------------------------------------------------------------------

export const MAX_PINNED = 3;
/** The one-to-one chat of two people (one per pair AND per kind: a readable one and an encrypted one are different chats, never converted into each other), created if it does not exist yet. */
/** Whether `userId` already knows `otherId` here: they share a circle or a group, or `userId` started or accepted a one-to-one chat with them. */
export function knownTo(userId: number, otherId: number): boolean {
  return !!one(`SELECT 1 FROM circle_members a JOIN circle_members o ON o.circle_id = a.circle_id JOIN circles ci ON ci.id = a.circle_id
                 WHERE a.user_id = ? AND o.user_id = ? AND ci.deleted_at IS NULL AND (ci.kind != 'direct' OR a.request = 0) LIMIT 1`, userId, otherId);
}
/**
 * The one-to-one chat of two people, created if there is none. When the one being written to does not know the
 * writer (no shared circle or group, no chat they ever accepted), it arrives as a message request: it waits outside
 * their chat list, wakes no phone, and sends no read receipt, until they accept it.
 */
export function directChat(userId: number, otherId: number, encrypted = false): { id: number; created: boolean } {
  const existing = one(
    `SELECT c.id FROM circles c
       JOIN circle_members a ON a.circle_id = c.id AND a.user_id = ?
       JOIN circle_members b ON b.circle_id = c.id AND b.user_id = ?
      WHERE c.kind = 'direct' AND c.encrypted = ? AND c.deleted_at IS NULL LIMIT 1`, userId, otherId, encrypted ? 1 : 0);
  if (existing) return { id: existing.id, created: false };
  const r = run("INSERT INTO circles (name, owner_id, invite_code, invite_enabled, kind, region, encrypted) VALUES ('', ?, ?, 0, 'direct', ?, ?)", userId, randomBytes(5).toString('hex'), REGION, encrypted ? 1 : 0);
  const id = Number(r.lastInsertRowid);
  run("INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, 'owner')", id, userId);
  run("INSERT INTO circle_members (circle_id, user_id, role, request) VALUES (?, ?, 'member', ?)", id, otherId, knownTo(otherId, userId) ? 0 : 1);
  memberJoined(id, [userId, otherId]);
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
