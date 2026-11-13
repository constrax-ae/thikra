import type { Db } from '../db.ts';

/**
 * 0020: an optional email address on a person's account.
 *
 * The phone number stays the identity and the way in; this is a second way to reach someone
 * when a code cannot be delivered by SMS or WhatsApp, and nothing requires it. It is stored
 * lowercased and trimmed so a lookup does not depend on how it was typed.
 *
 * Deliberately not unique: two people in one family sharing a mailbox is ordinary, and a
 * unique index would reject the second of them for no good reason.
 */
export function addUserEmail(db: Db) {
  try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch { /* already there */ }
}
