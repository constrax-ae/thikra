import type { Db } from '../db.ts';

/**
 * 0021: groups (step 2 of the chat features).
 *  - circles: description, photo (a media row of this chat), who may send (all | admins), who may edit name/photo/description (all | admins),
 *    and whether joining by the invite needs a manager's approval.
 *  - join_requests: people waiting for that approval.
 *  - message_mentions: who a message @mentions.
 *  - polls / poll_options / poll_votes: a poll hangs off an ordinary message (its body is the question).
 */
export function groups(db: Db) {
  for (const sql of [
    'ALTER TABLE circles ADD COLUMN description TEXT',
    'ALTER TABLE circles ADD COLUMN photo_media_id INTEGER',
    "ALTER TABLE circles ADD COLUMN send_policy TEXT NOT NULL DEFAULT 'all'",
    "ALTER TABLE circles ADD COLUMN edit_policy TEXT NOT NULL DEFAULT 'admins'",
    'ALTER TABLE circles ADD COLUMN join_approval INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS join_requests (
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (circle_id, user_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS message_mentions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (message_id, user_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS message_mentions_user ON message_mentions (user_id, message_id);
    CREATE TABLE IF NOT EXISTS polls (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      multiple INTEGER NOT NULL DEFAULT 0,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS poll_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
      pos INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS poll_options_message ON poll_options (message_id, pos);
    CREATE TABLE IF NOT EXISTS poll_votes (
      option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (option_id, user_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS poll_votes_message ON poll_votes (message_id, user_id);
  `);
}
