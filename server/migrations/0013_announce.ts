import type { Db } from '../db.ts';

/**
 * 0013: telling people things (ADMIN-PLAN slice 3).
 *  - announcements        a card inside the app for everyone or a slice (language, country, plan, managers), between two dates; level 'consent' needs an explicit "I agree".
 *  - announcement_acks    who dismissed or accepted which one (accepting is the record of consent to new terms).
 *  - broadcasts           a push notification to an audience, now or scheduled; the count that went out is kept.
 * Maintenance mode is a setting (`maintenance`), not a table.
 */
export function announce(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title_ar TEXT NOT NULL DEFAULT '', title_en TEXT NOT NULL DEFAULT '',
      body_ar TEXT NOT NULL DEFAULT '', body_en TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warning','consent')),
      audience TEXT NOT NULL DEFAULT '{}',
      starts_at TEXT NOT NULL DEFAULT (datetime('now')),
      ends_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS announcements_active ON announcements(status, ends_at);
    CREATE TABLE IF NOT EXISTS announcement_acks (
      announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      accepted INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (announcement_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body_ar TEXT NOT NULL, body_en TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT '{}',
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','sent','cancelled')),
      test INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      done_at TEXT
    );
    CREATE INDEX IF NOT EXISTS broadcasts_due ON broadcasts(status, scheduled_at);
  `);
}
