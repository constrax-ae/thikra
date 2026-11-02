import type { Db } from '../db.ts';

/**
 * 0007: storage plans the owner can edit, extra space granted by hand, and families asking for more space (like "get more storage" in Google One).
 *  - subscriptions.bonus_bytes  extra space added on top of the plan, set by the owner from the admin screen.
 *  - storage_requests           one row per ask; the owner grants or declines it. Payments are not connected yet: the payment provider will later write `subscriptions` itself.
 * The prices and sizes of the plans live in the `settings` table (key `plans`), with defaults in code (server/billing.ts).
 */
export function storagePlans(db: Db) {
  try { db.exec('ALTER TABLE subscriptions ADD COLUMN bonus_bytes INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      plan TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','granted','declined')),
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS storage_requests_status ON storage_requests(status, id);
  `);
}
