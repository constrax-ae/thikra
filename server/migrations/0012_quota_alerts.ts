import type { Db } from '../db.ts';

/**
 * 0012: warning managers before a family's space runs out (ADMIN-PLAN slice 2). One row per family holds the last level warned (0, 80, 95 or 100 percent),
 * so a manager is told once per level, and again only after the family dropped below it and climbed back.
 */
export function quotaAlerts(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_alerts (
      circle_id INTEGER PRIMARY KEY REFERENCES circles(id) ON DELETE CASCADE,
      level INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
