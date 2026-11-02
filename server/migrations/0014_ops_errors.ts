import type { Db } from '../db.ts';

/**
 * 0014: a durable record of what went wrong (ADMIN-PLAN slice 4). Server errors and failed background jobs, newest 500 kept.
 * It holds the kind, the route PATTERN (never the URL) and a short message with long numbers hidden: no message text, no phone numbers.
 */
export function opsErrors(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      kind TEXT NOT NULL,
      route TEXT,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ops_errors_at ON ops_errors(at);
  `);
}
