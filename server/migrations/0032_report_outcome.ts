import type { Db } from '../db.ts';

/**
 * 0032: `reports.told_at` — when the person who filed the report was told the team had decided it.
 * It is a column rather than a flag so a later look can say WHEN they were told, and so the same
 * report is never announced to them twice if a moderator changes their mind and acts again.
 */
export function reportOutcome(db: Db) {
  const cols = db.prepare('PRAGMA table_info(reports)').all().map(r => String(r.name));
  if (!cols.includes('told_at')) db.exec('ALTER TABLE reports ADD COLUMN told_at TEXT');
}
