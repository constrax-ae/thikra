import type { Db } from '../db.ts';

/**
 * 0031: three things a person arranges for themselves.
 *
 *  - chat_prefs.notify: what this chat is allowed to interrupt you with — 'all' (the default, stored as NULL),
 *    'mentions' (only when someone writes your name) or 'none'. Mute is a timer; this is a standing rule, and
 *    unlike mute, 'none' silences mentions too.
 *  - chat_lists / chat_list_items: lists a person makes for themselves ("Siblings", "Work"), used as filters over
 *    their own chat list. They are private: nobody else is told which list a chat is in, or that a list exists.
 *  - message_cards gains the 'live' type (a live location). SQLite cannot widen a CHECK, so the table is rebuilt;
 *    nothing points at it, so copying the rows across is the whole of it.
 */
export function listsAndNotify(db: Db) {
  const cols = db.prepare('PRAGMA table_info(chat_prefs)').all().map(r => String(r.name));
  if (!cols.includes('notify')) db.exec('ALTER TABLE chat_prefs ADD COLUMN notify TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS chat_lists (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_lists_user ON chat_lists (user_id, sort, id)');
  db.exec(`CREATE TABLE IF NOT EXISTS chat_list_items (
    list_id INTEGER NOT NULL REFERENCES chat_lists(id) ON DELETE CASCADE,
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    PRIMARY KEY (list_id, circle_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_list_items_circle ON chat_list_items (circle_id)');

  const cardCheck = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_cards'").all()[0]?.sql ?? '');
  if (cardCheck && !cardCheck.includes("'live'")) {
    db.exec(`CREATE TABLE message_cards_new (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('link','gif','sticker','contact','location','live')),
      data TEXT NOT NULL
    )`);
    db.exec('INSERT INTO message_cards_new (message_id, type, data) SELECT message_id, type, data FROM message_cards');
    db.exec('DROP TABLE message_cards');
    db.exec('ALTER TABLE message_cards_new RENAME TO message_cards');
  }
}
