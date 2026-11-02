import type { Db } from '../db.ts';

/**
 * 0005: what running the service needs to see, without ever touching content (LAUNCH-PLAN A-07, A-09).
 *  - sms_log   one row per SMS event (sent, failed, blocked, capped, or verified) with the day and the country CALLING CODE only. Never the number.
 *  - activity  one row per person per day they used the app. Only the id and the day: enough for daily/weekly/monthly users and retention.
 */
export function ops(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      calling_code TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sent','failed','blocked','capped','verified')),
      provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS sms_log_day ON sms_log(day, calling_code, status);
    CREATE TABLE IF NOT EXISTS activity (
      user_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      PRIMARY KEY (user_id, day)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS activity_day ON activity(day);
  `);
}
