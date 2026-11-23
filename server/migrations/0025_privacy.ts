import type { Db } from '../db.ts';

/**
 * 0023: privacy and extras (step 4 of the chat features).
 *  - circles.disappear_seconds: the chat's timer (null = off). messages.expires_at: when THIS message goes (set when it is stored, from the timer then).
 *    messages.expired_at: it went by the timer (clients drop it instead of showing "deleted").
 *  - messages.view_once + view_once_opens: a photo, video or voice note that each recipient can open one time. opened_at starts a short window in which the file is served.
 *  - chat_prefs.locked: only a flag (the PIN stays on the device). chat_prefs.wallpaper: a built-in name or a #rrggbb colour, per person per chat.
 *  - broadcast_lists / broadcast_members: a person's own lists of people to send one message to (as separate private chats). The text never reaches the server.
 */
export function privacy(db: Db) {
  for (const sql of [
    'ALTER TABLE circles ADD COLUMN disappear_seconds INTEGER',
    'ALTER TABLE messages ADD COLUMN expires_at TEXT',
    'ALTER TABLE messages ADD COLUMN expired_at TEXT',
    'ALTER TABLE messages ADD COLUMN view_once INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE chat_prefs ADD COLUMN locked INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE chat_prefs ADD COLUMN wallpaper TEXT',
  ]) {
    try { db.exec(sql); } catch { /* already there */ }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS messages_expiry ON messages (expires_at) WHERE expires_at IS NOT NULL AND expired_at IS NULL AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS messages_view_once ON messages (created_at) WHERE view_once = 1;
    CREATE TABLE IF NOT EXISTS view_once_opens (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, user_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS broadcast_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS broadcast_lists_owner ON broadcast_lists (owner_id);
    CREATE TABLE IF NOT EXISTS broadcast_members (
      list_id INTEGER NOT NULL REFERENCES broadcast_lists(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (list_id, user_id)
    ) WITHOUT ROWID;
  `);
}
