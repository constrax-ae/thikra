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
  if (one("SELECT 1 FROM sealed_messages WHERE blob_hash = ? AND status IN ('sealed','waiting','stopped')", hash)) return; // a letter still waiting to open keeps its file
  run('DELETE FROM blobs WHERE hash = ?', hash);
  await blobs.delete(hash);
}

/** Erase a message's content for everyone, keeping the row as a tombstone: media, transcript, archive entry and search text go; the blobs are dropped when nothing else uses them; open chats are told to re-sync. Used by members deleting their own message and by moderation. */
export async function eraseMessage(m: Row, deletedBy: number | null) {
  const hashes = all('SELECT blob_hash FROM media WHERE message_id = ?', m.id).map(r => r.blob_hash as string);
  tx(() => {
    run('DELETE FROM media WHERE message_id = ?', m.id);
    run("UPDATE messages SET body = '', transcript = NULL, audio_path = NULL, archive_status = 'none', score = NULL, category = NULL, reason = NULL, search_text = NULL, deleted_at = datetime('now'), deleted_by = ? WHERE id = ?", deletedBy, m.id);
    run("UPDATE archive_entries SET deleted_at = datetime('now') WHERE message_id = ? AND deleted_at IS NULL", m.id);
  });
  for (const h of hashes) await dropBlobIfUnused(h);
  poke(m.circle_id);
}
