import type { Db } from '../db.ts';

/** 0018: a broadcast remembers how far it got (the last person id it reached) and when it last moved, so a restart in the middle resumes instead of stopping or repeating. */
export function broadcastCursor(db: Db) {
  for (const sql of ['ALTER TABLE broadcasts ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE broadcasts ADD COLUMN touched_at TEXT']) {
    try { db.exec(sql); } catch { /* already there */ }
  }
}
