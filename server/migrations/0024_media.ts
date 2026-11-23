import type { Db } from '../db.ts';

/**
 * 0022: media and sharing (step 3 of the chat features).
 *  - media.waveform: the shape of a voice note, measured on the sender's device (up to 64 bars, 0-100).
 *  - voice_plays: who has played a voice note.
 *  - message_cards: what hangs off an ordinary message to make it a link preview, GIF, sticker, contact or location (one envelope for all).
 *  - uploads: files that are arriving in pieces (resumable uploads); the bytes wait on disk until the message is made.
 *  - link_previews: what the server found at a link, kept for a week, so the same link is not fetched again for every person.
 */
export function media(db: Db) {
  try { db.exec('ALTER TABLE media ADD COLUMN waveform TEXT'); } catch { /* already there */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_plays (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      played_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, user_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS message_cards (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('link','gif','sticker','contact','location')),
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      received INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS uploads_user ON uploads (user_id);
    CREATE TABLE IF NOT EXISTS link_previews (
      url TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      site TEXT,
      image_hash TEXT,
      image_mime TEXT,
      fetched_at INTEGER NOT NULL
    ) WITHOUT ROWID;
  `);
}
