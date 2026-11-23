import type { Db } from '../db.ts';

/**
 * 0020: chat basics.
 *  - last seen: when the person last had the app on screen, and who may see it (everyone they share a chat with / only family circles / nobody).
 *  - keep_archived: 1 = an archived chat stays archived when a message arrives (WhatsApp's default); 0 = a new message brings it back.
 *  - receipt_marks: WHEN a member's "delivered up to" (d) or "read up to" (r) mark reached a seq. The marks themselves stay on circle_members;
 *    these rows only add the time, which is what "message info" shows. A member's time for a message is their first row with seq >= the message's.
 */
export function chatBasics(db: Db) {
  for (const sql of [
    'ALTER TABLE users ADD COLUMN last_seen_at TEXT',
    "ALTER TABLE users ADD COLUMN last_seen_privacy TEXT NOT NULL DEFAULT 'everyone'",
    'ALTER TABLE users ADD COLUMN keep_archived INTEGER NOT NULL DEFAULT 1',
  ]) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS receipt_marks (
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('d','r')),
    seq INTEGER NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (circle_id, user_id, kind, seq)
  ) WITHOUT ROWID`);
}
