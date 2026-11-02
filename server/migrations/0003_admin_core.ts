import type { Db } from '../db.ts';

/**
 * 0003: the admin core (LAUNCH-PLAN P4: A-02, A-03, A-04, A-08).
 *  - users.admin_role   'owner' | 'moderator' | 'support' (NULL = not staff). Anyone with a role also has is_admin = 1, so the old "is staff" checks keep working.
 *  - users.suspended_*  a suspended person cannot sign in or use a session until the suspension ends (suspended_until NULL = until lifted).
 *  - banned_phones      hashes of numbers that may not sign up or sign in again (platform ban).
 *  - admin_audit        who did what, when, to whom. APPEND-ONLY: triggers refuse any update or delete.
 */
export function adminCore(db: Db) {
  for (const sql of [
    'ALTER TABLE users ADD COLUMN admin_role TEXT',
    'ALTER TABLE users ADD COLUMN suspended_at TEXT',
    'ALTER TABLE users ADD COLUMN suspended_until TEXT',
    'ALTER TABLE users ADD COLUMN suspended_reason TEXT',
  ]) { try { db.exec(sql); } catch { /* already there */ } }
  db.exec("UPDATE users SET admin_role = 'owner' WHERE is_admin = 1 AND admin_role IS NULL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS banned_phones (
      phone_hash TEXT PRIMARY KEY,
      reason TEXT,
      banned_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      actor_role TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS admin_audit_time ON admin_audit(id DESC);
    CREATE TRIGGER IF NOT EXISTS admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END;
  `);
}
