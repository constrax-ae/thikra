import { blobs } from '../storage.ts';
import { all, one, run, type Row } from '../db.ts';
import { poke, tx } from './helpers.ts';

// ---- deleting messages ---------------------------------------------------------------------
// As in WhatsApp: "delete for me" hides it for you only; "delete for everyone" removes it for all and leaves
// a placeholder. The sender can do that for a limited time, a circle manager can do it at any time.
// Deleting for everyone really erases the content, the voice file, and the archive entry made from it.

// Delete for everyone: two days for an ordinary sender (as in WhatsApp's help center); circle owners and admins get a week, for their
// own messages and others' (owner's decision, 2026-10-19: family moderation, but not unlimited).
export const DELETE_WINDOW_MS = 48 * 3600_000;
export const MANAGER_DELETE_WINDOW_MS = 7 * 24 * 3600_000;
export const toMs = (s: string) => Date.parse(`${String(s).replace(' ', 'T')}Z`);
/** Removes a blob from storage once no media row refers to it any more (identical files are stored once). */
export async function dropBlobIfUnused(hash: string) {
  if (one('SELECT 1 FROM media WHERE blob_hash = ?', hash)) return;
  if (one('SELECT 1 FROM link_previews WHERE image_hash = ?', hash)) return;   // the stored preview of a link still shows this picture
  if (one("SELECT 1 FROM sealed_messages WHERE blob_hash = ? AND status IN ('sealed','waiting','stopped')", hash)) return; // a letter still waiting to open keeps its file
  if (one('SELECT 1 FROM users WHERE avatar_hash = ?', hash)) return;   // someone's profile picture (the same photo may also have been sent in a chat)
  run('DELETE FROM blobs WHERE hash = ?', hash);
  await blobs.delete(hash);
}

/** Erase a message's content for everyone, keeping the row as a tombstone: media, transcript, archive entry and search text go; the blobs are dropped when nothing else uses them; open chats are told to re-sync. Used by members deleting their own message and by moderation. */
export async function eraseMessage(m: Row, deletedBy: number | null, quiet = false) {
  const hashes = all('SELECT blob_hash FROM media WHERE message_id = ?', m.id).map(r => r.blob_hash as string);
  tx(() => {
    run('DELETE FROM media WHERE message_id = ?', m.id);
    run('DELETE FROM polls WHERE message_id = ?', m.id);              // its options and votes go with it (cascade)
    run('DELETE FROM message_mentions WHERE message_id = ?', m.id);
    run('DELETE FROM message_cards WHERE message_id = ?', m.id);
    run('DELETE FROM voice_plays WHERE message_id = ?', m.id);
    run("UPDATE messages SET ciphertext = NULL, ctl_target = NULL, body = '', transcript = NULL, audio_path = NULL, archive_status = 'none', score = NULL, category = NULL, reason = NULL, search_text = NULL, deleted_at = datetime('now'), deleted_by = ? WHERE id = ?", deletedBy, m.id);
    run("UPDATE archive_entries SET deleted_at = datetime('now') WHERE message_id = ? AND deleted_at IS NULL", m.id);
  });
  for (const h of hashes) await dropBlobIfUnused(h);
  if (!quiet) poke(m.circle_id);
}

/** Stored link previews are kept for a week. Older ones go, and a picture goes with its preview unless a message (or another preview) still shows it. Returns how many were removed. */
export async function purgeLinkPreviews(): Promise<number> {
  const old = all('SELECT url, image_hash FROM link_previews WHERE fetched_at < ?', Date.now() - 7 * 24 * 3600_000);
  for (const r of old) {
    run('DELETE FROM link_previews WHERE url = ?', r.url);
    if (r.image_hash) await dropBlobIfUnused(r.image_hash as string);
  }
  return old.length;
}

// ---- disappearing messages and view once -------------------------------------------------------
// Both work on ids, timestamps and blobs only: nothing here reads what a message says.

/** Messages whose time has come go for everyone, exactly like "delete for everyone" (content, files, blobs), and are marked as expired so screens drop them instead of showing "deleted". Returns how many. */
export async function purgeExpired(): Promise<number> {
  // A frozen family keeps everything (staff may need it); a family circle and an opened sealed letter keep what the family wrote.
  const due = all(`SELECT m.id, m.circle_id FROM messages m JOIN circles c ON c.id = m.circle_id WHERE m.expires_at IS NOT NULL AND m.expired_at IS NULL AND m.deleted_at IS NULL AND m.expires_at <= datetime('now')
    AND c.frozen_at IS NULL AND c.kind != 'circle' AND m.sealed_on IS NULL LIMIT 500`);
  const circles = new Set<number>();
  for (const m of due) {
    run("UPDATE messages SET expired_at = datetime('now') WHERE id = ?", m.id);
    await eraseMessage(m, null, true);
    circles.add(m.circle_id as number);
  }
  for (const id of circles) poke(id);   // one re-sync per chat, not one per message
  return due.length;
}
/** The file of a view-once message goes (everyone who could open it has, or it waited too long); the message stays, saying so. */
export async function eraseViewOnceFile(m: Row) {
  const hashes = all('SELECT blob_hash FROM media WHERE message_id = ?', m.id).map(r => r.blob_hash as string);
  tx(() => {
    run('DELETE FROM media WHERE message_id = ?', m.id);
    run('DELETE FROM voice_plays WHERE message_id = ?', m.id);
    run('UPDATE messages SET audio_path = NULL WHERE id = ?', m.id);
  });
  for (const h of hashes) await dropBlobIfUnused(h);
  poke(m.circle_id);
}
export const VIEW_ONCE_KEEP_DAYS = 14;
/** How long a file is served after a person opens it (long enough to load it, short enough that it cannot be kept by asking again). */
export const OPEN_WINDOW_S = 900;   // 15 minutes: a whole listening session (a voice note is at most 15 minutes), with the player's repeated range requests
/** View-once files go when every other member has opened them (once their loading window has passed) or when nobody opened them for two weeks. Returns how many messages. */
export async function purgeViewOnce(): Promise<number> {
  const old = all(`SELECT m.id, m.circle_id FROM messages m JOIN circles c ON c.id = m.circle_id WHERE m.view_once = 1 AND m.deleted_at IS NULL AND c.frozen_at IS NULL AND EXISTS (SELECT 1 FROM media d WHERE d.message_id = m.id)
    AND (m.created_at <= datetime('now', '-${VIEW_ONCE_KEEP_DAYS} days')
      OR (EXISTS (SELECT 1 FROM view_once_opens o WHERE o.message_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_id = m.circle_id AND cm.user_id != COALESCE(m.user_id, 0)
                            AND NOT EXISTS (SELECT 1 FROM view_once_opens o WHERE o.message_id = m.id AND o.user_id = cm.user_id))
          AND NOT EXISTS (SELECT 1 FROM view_once_opens o WHERE o.message_id = m.id AND o.opened_at > datetime('now', '-${OPEN_WINDOW_S} seconds'))))`);
  for (const m of old) await eraseViewOnceFile(m);
  return old.length;
}
