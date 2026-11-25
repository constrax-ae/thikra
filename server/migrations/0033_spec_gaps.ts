import type { Db } from '../db.ts';

/**
 * 0033: the last of the chat specification's own columns.
 *  - chat_prefs.clear_through — CHAT-01 "clear history": the seq below which this person sees nothing in this chat.
 *    A cutoff, not a delete: nobody else's copy is touched, and messages after it keep arriving.
 *  - circle_members.joined_seq — GRP-02: where a member came in, so a group can keep its past to itself.
 *  - circles.history_policy — 'all' (the family memory, our default for a circle) or 'since_join' (the
 *    specification's default for an ordinary group).
 *  - circles.invite_expires_at — GRP-02 expiring invite links.
 *  - uploads.checksum — MED-05: the SHA-256 the sender declared, checked before the file is accepted.
 *  - sessions.last_seen_at — RT-03: when this signed-in device was last used, for the "where am I signed in" list.
 */
export function specGaps(db: Db) {
  const cols = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all().map(r => String(r.name));
  const prefs = cols('chat_prefs');
  if (!prefs.includes('clear_through')) db.exec('ALTER TABLE chat_prefs ADD COLUMN clear_through INTEGER NOT NULL DEFAULT 0');
  const members = cols('circle_members');
  if (!members.includes('joined_seq')) db.exec('ALTER TABLE circle_members ADD COLUMN joined_seq INTEGER NOT NULL DEFAULT 0');
  const circles = cols('circles');
  // Existing chats keep their whole history for everyone: a migration must never take away what people can already see.
  if (!circles.includes('history_policy')) db.exec("ALTER TABLE circles ADD COLUMN history_policy TEXT NOT NULL DEFAULT 'all'");
  if (!circles.includes('invite_expires_at')) db.exec('ALTER TABLE circles ADD COLUMN invite_expires_at TEXT');
  const uploads = cols('uploads');
  if (!uploads.includes('checksum')) db.exec('ALTER TABLE uploads ADD COLUMN checksum TEXT');
  // RT-03: "show device name, last activity and revoke option" — a session is what a device is, here.
  const sessions = cols('sessions');
  if (!sessions.includes('last_seen_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');
}
