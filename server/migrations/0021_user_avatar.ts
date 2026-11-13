import type { Db } from '../db.ts';

/**
 * 0021: a profile picture on a person's account.
 *
 * The picture is a blob like any other file (content-addressed, stored once); the user row holds its hash,
 * and `avatar_at` changes with every new picture so the apps can tell a fresh one from what they cached.
 * Nobody but the person sets it, and only people who share a circle with them can fetch it (routes/avatar.ts).
 */
export function addUserAvatar(db: Db) {
  try { db.exec('ALTER TABLE users ADD COLUMN avatar_hash TEXT'); } catch { /* already there */ }
  try { db.exec('ALTER TABLE users ADD COLUMN avatar_at TEXT'); } catch { /* already there */ }
}
