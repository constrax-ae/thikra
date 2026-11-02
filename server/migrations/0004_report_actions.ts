import type { Db } from '../db.ts';

/**
 * 0004: reports can be escalated and record what was done and by whom. The old table only allowed 'open' and 'resolved' in a CHECK
 * that SQLite cannot widen in place, so the table is rebuilt (rows kept, ids kept).
 */
export function reportActions(db: Db) {
  const cols = db.prepare('PRAGMA table_info(reports)').all().map(r => String(r.name));
  if (cols.includes('action')) return;   // already rebuilt
  db.exec(`
    CREATE TABLE reports_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reported_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      circle_id INTEGER REFERENCES circles(id) ON DELETE SET NULL,
      message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      reason TEXT NOT NULL CHECK (reason IN ('spam','abuse','harassment','illegal','other')),
      note TEXT,
      snapshot TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','escalated','resolved')),
      resolution TEXT,
      action TEXT,
      resolved_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    INSERT INTO reports_new (id, reporter_id, reported_user_id, circle_id, message_id, reason, note, snapshot, status, resolution, created_at, resolved_at)
      SELECT id, reporter_id, reported_user_id, circle_id, message_id, reason, note, snapshot, status, resolution, created_at, resolved_at FROM reports;
    DROP TABLE reports;
    ALTER TABLE reports_new RENAME TO reports;
    CREATE UNIQUE INDEX IF NOT EXISTS reports_once ON reports(reporter_id, message_id);
  `);
}
