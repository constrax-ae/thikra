import type { Db } from '../db.ts';

/**
 * 0024: end-to-end encryption, part A (step 6, feature 26). Design: docs/superpowers/specs/2026-11-19-encryption-design.md; protocol and library: ...-encryption-plan.md.
 *  - circles.encrypted: 1 for a private chat or an ordinary group made encrypted. Set once at creation, no route changes it. A family circle is never encrypted.
 *    circles.e2ee_epoch: the key epoch the group has reached (the number of accepted commits). e2ee_min_epoch: the lowest epoch a message may carry; raised when
 *    someone leaves or a device is revoked, so nobody sends with keys a removed person still holds.
 *  - messages.ciphertext / enc_kind / epoch / ctl_target: what the server keeps of an encrypted message. The bytes are opaque (an MLS message); enc_kind is the kind
 *    marker (text, media, voice, card, edit), epoch is the plain header, ctl_target is the message an `edit` control message is about. body stays '' for these.
 *  - e2ee_devices: one row per device (a phone, a laptop). Its id is part of its name inside the protocol (u<user>.d<device>). identity_key is its public signing key.
 *  - e2ee_key_packages: a device's published one-time public keys; a person starting a chat takes one per device. One row per device may be the "last resort" kept for when
 *    the rest run out (it is never consumed).
 *  - e2ee_commits: the group's key changes in order (opaque bytes), one per epoch. e2ee_welcomes: what a newly added device needs to join (opaque bytes), kept until it acknowledges.
 *  - reports.unverified: the text of a report on an encrypted chat is whatever the reporting device chose to send; the server cannot check it.
 */
export function e2ee(db: Db) {
  for (const sql of [
    'ALTER TABLE circles ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE circles ADD COLUMN e2ee_epoch INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE circles ADD COLUMN e2ee_min_epoch INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE messages ADD COLUMN ciphertext BLOB',
    'ALTER TABLE messages ADD COLUMN enc_kind TEXT',
    'ALTER TABLE messages ADD COLUMN epoch INTEGER',
    'ALTER TABLE messages ADD COLUMN ctl_target INTEGER',
    'ALTER TABLE reports ADD COLUMN unverified INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS e2ee_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT,
      identity_key BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS e2ee_devices_user ON e2ee_devices (user_id) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS e2ee_key_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL REFERENCES e2ee_devices(id) ON DELETE CASCADE,
      data BLOB NOT NULL,
      last_resort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS e2ee_key_packages_device ON e2ee_key_packages (device_id, last_resort);
    CREATE TABLE IF NOT EXISTS e2ee_commits (
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      epoch INTEGER NOT NULL,
      user_id INTEGER,       -- no foreign key on purpose: deleting an account or a device must never cut a hole in the chain of commits other devices replay
      device_id INTEGER,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (circle_id, epoch)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS e2ee_welcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      epoch INTEGER NOT NULL,
      to_device_id INTEGER NOT NULL REFERENCES e2ee_devices(id) ON DELETE CASCADE,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS e2ee_welcomes_device ON e2ee_welcomes (to_device_id, circle_id);
  `);
}
