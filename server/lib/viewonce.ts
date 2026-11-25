import { one } from '../db.ts';
import { OPEN_WINDOW_S } from './deletes.ts';

/**
 * May this person be given the file of this message right now? Null = yes (not a view-once message, or the person's own open is still inside its 15-minute window).
 * Otherwise the refusal to answer with. The sender never gets their own file back; a recipient gets it only after `POST /api/messages/:id/open`, and only for 15 minutes.
 */
export const UNOPENED_DAYS = 14;   // PRIV-04: an unopened view-once item is gone after this long, opened or not

export function viewOnceRefusal(messageId: number, userId: number): { status: 403 | 410; error: string } | null {
  const m = one(`SELECT view_once, user_id, created_at < datetime('now', '-${UNOPENED_DAYS} days') AS stale FROM messages WHERE id = ?`, messageId);
  if (!m?.view_once) return null;
  if (m.user_id === userId) return { status: 403, error: 'view_once_closed' };
  // Nobody opened it in two weeks: it is over, whoever asks. (A claim already made still has its own 15-minute window below.)
  if (m.stale && !one('SELECT 1 FROM view_once_opens WHERE message_id = ? AND user_id = ?', messageId, userId)) return { status: 410, error: 'view_once_gone' };
  const o = one(`SELECT opened_at > datetime('now', '-${OPEN_WINDOW_S} seconds') AS fresh FROM view_once_opens WHERE message_id = ? AND user_id = ?`, messageId, userId);
  if (!o) return { status: 403, error: 'view_once_closed' };
  return o.fresh ? null : { status: 410, error: 'view_once_gone' };
}
