import type { Db } from '../db.ts';

/**
 * 0016: staff security and people's rights over their data (ADMIN-PLAN slice 6).
 *  - admin_totp            an authenticator-app code (RFC 6238) a staff member can switch on; once on, admin actions need a code verified in the last 30 minutes.
 *  - sessions.*            when and from what a session was made (so staff sessions can be listed and ended), and until when it has passed the code check.
 *  - data_requests         a person asks the team for a copy of their data or for erasure; the law gives a deadline (30 days here), and the list shows what is late.
 */
export function security(db: Db) {
  for (const sql of ['ALTER TABLE sessions ADD COLUMN created_at TEXT', 'ALTER TABLE sessions ADD COLUMN user_agent TEXT', 'ALTER TABLE sessions ADD COLUMN admin_ok_until INTEGER']) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_totp (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      last_step INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS data_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('export','delete')),
      note TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','rejected')),
      due_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      handled_at TEXT,
      response TEXT
    );
    CREATE INDEX IF NOT EXISTS data_requests_status ON data_requests(status, due_at);
  `);
}
