import type { Db } from '../db.ts';

/**
 * 0027: a device vouches for another device of the same person (end-to-end encryption, gaps step). `endorsement` is the older device's signature over the new device's name and
 * identity key, `endorsed_by` the older device. The server only stores them; everyone who trusts the older device checks the signature on their own device.
 */
export function e2eeEndorse(db: Db) {
  const cols = db.prepare('PRAGMA table_info(e2ee_devices)').all().map(r => String(r.name));
  for (const [name, type] of [['endorsement', 'TEXT'], ['endorsed_by', 'INTEGER']] as const) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE e2ee_devices ADD COLUMN ${name} ${type}`);
  }
}
