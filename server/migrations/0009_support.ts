import type { Db } from '../db.ts';

/**
 * 0009: support (LAUNCH-PLAN P4-8). A person writes to the team from the app; staff answer from the admin screen. Only what the person writes is stored, no message
 * content of their families. A case is open until staff close it; the person may write again and it reopens.
 */
export function support(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS support_cases_status ON support_cases(status, updated_at);
    CREATE INDEX IF NOT EXISTS support_cases_user ON support_cases(user_id, id);
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
      from_staff INTEGER NOT NULL DEFAULT 0,
      staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS support_messages_case ON support_messages(case_id, id);
  `);
}
