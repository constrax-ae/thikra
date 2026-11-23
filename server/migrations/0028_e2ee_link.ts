import type { Db } from '../db.ts';

/**
 * 0026: linking a second device (end-to-end encryption hardening). A new device publishes a proof made from a secret code only it and the person know; the person's older
 * device checks the proof against the code the person types, so the server cannot make the old device approve a device it invented. The older device then hands the history
 * over as opaque, encrypted parts that only the new device (which holds the code) can open. The server reads none of it and deletes it when the device takes it, when the
 * device is retired, or with the account.
 */
export function e2eeLink(db: Db) {
  const cols = db.prepare('PRAGMA table_info(e2ee_devices)').all().map(r => String(r.name));
  for (const [name, type] of [['link_proof', 'TEXT'], ['link_pub', 'TEXT'], ['link_expires_at', 'INTEGER'], ['link_used_at', 'INTEGER'], ['link_peer', 'TEXT']] as const) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE e2ee_devices ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS e2ee_transfers (
    device_id INTEGER NOT NULL REFERENCES e2ee_devices(id) ON DELETE CASCADE,
    part INTEGER NOT NULL, last INTEGER NOT NULL DEFAULT 0, data BLOB NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (device_id, part)
  )`);
}
