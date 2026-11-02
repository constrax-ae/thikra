import type { Db } from '../db.ts';

/**
 * 0011: running people and families from the admin screen (ADMIN-PLAN slice 1).
 *  - circles.frozen_at / frozen_reason   a frozen family is read-only: nothing new is written, nothing is deleted (an investigation or a dispute).
 *  - admin_notes                         a private note staff keep on a person or a family; never shown to the person.
 */
export function adminPeople(db: Db) {
  for (const sql of ['ALTER TABLE circles ADD COLUMN frozen_at TEXT', 'ALTER TABLE circles ADD COLUMN frozen_reason TEXT']) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL CHECK (target_type IN ('user','circle')),
      target_id INTEGER NOT NULL,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS admin_notes_target ON admin_notes(target_type, target_id, id);
  `);
}
