import { all, one, run } from '../db.ts';

// ---- when a message reached each person ("message info") ------------------------------------
// Ticks come from each member's two marks on circle_members: "delivered up to seq" and "read up to seq". Those say WHETHER.
// receipt_marks adds WHEN: one row each time a mark moves forward. A member's time for a message is the time of their first
// row with seq >= the message's seq. A read that jumps over many messages is one row; a phone that is connected receives messages
// one at a time, so its delivered mark makes one row per message it receives live (no pruning yet: see BACKLOG).

/** A member's mark reached `seq` now. Call only when the mark really moved. */
export function recordMark(circleId: number, userId: number, kind: 'd' | 'r', seq: number) {
  run('INSERT OR IGNORE INTO receipt_marks (circle_id, user_id, kind, seq) VALUES (?, ?, ?, ?)', circleId, userId, kind, seq);
}

export interface InfoPerson { id: number; name: string; at: string | null }
export interface MessageInfo { readBy: InfoPerson[]; deliveredTo: InfoPerson[]; pending: Array<{ id: number; name: string }> }

/**
 * Who has read and who has received one message, for its author. Everyone in the chat except the author is in exactly one list.
 * Read is shown only when BOTH the author and that member share read receipts (the same reciprocal rule as the ticks);
 * otherwise a member who has read it is listed as "delivered", with the time it was delivered.
 * A mark that passed the message before times were stored gives `at: null`.
 */
export function messageInfo(message: { id: number; circle_id: number; user_id: number; seq: number }): MessageInfo {
  const authorShares = one('SELECT read_receipts FROM users WHERE id = ?', message.user_id)?.read_receipts === 1;
  // The first step of that member's mark that reached this message: a seek on the primary key (circle, user, kind, seq), never a scan.
  const when = (userId: number, kind: 'd' | 'r') =>
    (one('SELECT at FROM receipt_marks WHERE circle_id = ? AND user_id = ? AND kind = ? AND seq >= ? ORDER BY seq LIMIT 1', message.circle_id, userId, kind, message.seq)?.at as string | undefined) ?? null;
  const out: MessageInfo = { readBy: [], deliveredTo: [], pending: [] };
  for (const m of all(
    `SELECT u.id, u.name, u.read_receipts AS shares, cm.delivered_seq AS d, cm.read_seq AS r
       FROM circle_members cm JOIN users u ON u.id = cm.user_id WHERE cm.circle_id = ? AND cm.user_id != ? ORDER BY u.name`, message.circle_id, message.user_id)) {
    const id = m.id as number, name = m.name as string;
    if ((m.r as number) >= message.seq && authorShares && m.shares === 1) out.readBy.push({ id, name, at: when(id, 'r') });
    // Someone whose read is not shown is listed as delivered, with the DELIVERY time only. Their read row is never consulted here:
    // if no delivery time is known (delivered before times were stored) the time is simply absent.
    else if ((m.d as number) >= message.seq || (m.r as number) >= message.seq) out.deliveredTo.push({ id, name, at: when(id, 'd') });
    else out.pending.push({ id, name });
  }
  return out;
}
