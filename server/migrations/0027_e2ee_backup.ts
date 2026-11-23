import type { Db } from '../db.ts';

/**
 * 0025: the recovery backup of end-to-end encryption (part B, web). One row per person: an opaque blob the person's own device encrypted with a key made from their
 * recovery code. The server cannot read it and does not know the code; it only keeps it so a new device can fetch it. Lost code and lost devices mean lost history.
 */
export function e2eeBackup(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS e2ee_backups (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data BLOB NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}
