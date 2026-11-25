import type { Db } from '../db.ts';

/**
 * 0030: message requests. A one-to-one chat started by someone you share no circle or group with
 * arrives as a request: `request` on YOUR membership row is 1 until you accept it (0), or 2 once you
 * decline it (the chat then stays out of your list; the sender is not told).
 */
export function messageRequests(db: Db) {
  const cols = db.prepare('PRAGMA table_info(circle_members)').all().map(r => String(r.name));
  if (!cols.includes('request')) db.exec('ALTER TABLE circle_members ADD COLUMN request INTEGER NOT NULL DEFAULT 0');
}
