import type { Db } from '../db.ts';

/**
 * 0008: the yearly book becomes the family's STORY.
 *  - circles.story_title   what the family calls its story ("قصة عائلتي (ناصر & ديما)"); empty means a default title.
 *  - story_chapters        a chapter written by the story writer (a language model, when the owner has configured one) or edited by the family. A row is kept only
 *                          when it was written by the model or edited by a person; chapters written by the built-in rules are cheap and are made again on every read.
 */
export function story(db: Db) {
  try { db.exec('ALTER TABLE circles ADD COLUMN story_title TEXT'); } catch { /* already there */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_chapters (
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      lang TEXT NOT NULL,
      idx INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('model','edited')),
      facts_hash TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (circle_id, year, lang, idx)
    );
  `);
}
