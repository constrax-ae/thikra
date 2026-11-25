import type { Db } from '../db.ts';

/**
 * 0034: `users.about` — AUTH-01's optional bio: one short line a person writes about themselves ("At work until 5").
 * People they share a chat with see it under their name; someone they have blocked does not. NULL means none.
 */
export function aboutLine(db: Db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(r => String(r.name));
  if (!cols.includes('about')) db.exec('ALTER TABLE users ADD COLUMN about TEXT');
}
