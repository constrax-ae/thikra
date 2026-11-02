import type { Db } from '../db.ts';

/**
 * 0002: where a person's and a circle's data lives (LAUNCH-PLAN D4). Stored from now so that data can be placed by region
 * later without rewriting every row; nothing reads it yet. NULL means "not assigned". Values are short region codes such as
 * 'me' (Middle East), 'eu', 'us', set from THIKRA_REGION when a row is created.
 */
export function addRegion(db: Db) {
  for (const sql of ['ALTER TABLE users ADD COLUMN region TEXT', 'ALTER TABLE circles ADD COLUMN region TEXT']) {
    try { db.exec(sql); } catch { /* already there */ }
  }
}
