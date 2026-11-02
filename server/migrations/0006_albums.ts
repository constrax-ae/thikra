import type { Db } from '../db.ts';

/**
 * 0006: albums (the family's photos and voice recordings from an old chat, kept as an album instead of as thousands of chat messages).
 *  - albums       one per import: a title, where it came from, and the date range it covers.
 *  - album_items  one per file: points at a `media` row (so storage, quota and serving all work as for any attachment), and remembers
 *                 when it was sent in the original chat (taken_at, day, year) and who sent it (a name as written in the export, not an account).
 * An item is unique per album by its content (a re-run of the same import adds nothing twice).
 */
export function albums(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'whatsapp',
      range_from TEXT,
      range_to TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS albums_circle ON albums(circle_id);
    CREATE TABLE IF NOT EXISTS album_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      circle_id INTEGER NOT NULL,
      media_id INTEGER NOT NULL,
      blob_hash TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image','voice','video')),
      taken_at TEXT NOT NULL,
      day TEXT NOT NULL,
      year INTEGER NOT NULL,
      sender TEXT,
      UNIQUE (album_id, blob_hash)
    );
    CREATE INDEX IF NOT EXISTS album_items_year ON album_items(album_id, year, taken_at);
    CREATE INDEX IF NOT EXISTS album_items_day ON album_items(circle_id, day);
  `);
}
