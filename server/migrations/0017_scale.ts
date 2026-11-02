import type { Db } from '../db.ts';

/**
 * 0017: so the admin screen stays fast when the numbers get big (ADMIN-PLAN slice 7; measured with scripts/scale-test.ts).
 *  - indexes the admin queries lacked (who is in which family, by date, by report)
 *  - daily_stats    one row per day (sign-ups, active people, messages, families, reports, support cases): charts and "is today unusual" read these, not the big tables
 *  - circle_usage   archived bytes per family, refreshed every hour in the background: the capacity screens read this, not a scan of every media row
 */
export function scale(db: Db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS circle_members_user ON circle_members(user_id);
    CREATE INDEX IF NOT EXISTS users_created ON users(created_at);
    CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS media_created ON media(created_at);
    CREATE INDEX IF NOT EXISTS reports_status ON reports(status, id);
    CREATE INDEX IF NOT EXISTS reports_user ON reports(reported_user_id);
    CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at);
    CREATE INDEX IF NOT EXISTS circles_created ON circles(created_at);
    CREATE INDEX IF NOT EXISTS media_blob ON media(blob_hash);
    CREATE INDEX IF NOT EXISTS blobs_created ON blobs(created_at);
    CREATE TABLE IF NOT EXISTS daily_stats (
      day TEXT PRIMARY KEY,
      signups INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 0,
      messages INTEGER NOT NULL DEFAULT 0,
      circles INTEGER NOT NULL DEFAULT 0,
      reports INTEGER NOT NULL DEFAULT 0,
      support INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS circle_usage (
      circle_id INTEGER PRIMARY KEY,
      archived_bytes INTEGER NOT NULL DEFAULT 0
    );
  `);
}
