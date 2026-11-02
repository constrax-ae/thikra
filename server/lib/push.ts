import { all, one, type Row } from '../db.ts';
import { isVisible } from '../live.ts';
import { pushToUser } from '../push.ts';
import { words as wordsFor } from './texts.ts';
/**
 * Tell the circle's other members about a new message on their other devices. Skipped for: the sender, a muted chat,
 * and anyone who has the app on screen right now. With "show previews" off the notification says only that something arrived.
 */
export function notifyMembers(circleId: number, row: Row) {
  if (row.kind === 'system') return;
  const circle = one('SELECT name, kind FROM circles WHERE id = ?', circleId);
  if (!circle) return;
  const att = one("SELECT kind FROM media WHERE message_id = ? AND kind IN ('image','video','file') ORDER BY id LIMIT 1", row.id)?.kind as string | undefined;
  const recipients = all(
    `SELECT DISTINCT cm.user_id AS id, u.lang, u.push_preview AS preview
       FROM circle_members cm JOIN users u ON u.id = cm.user_id JOIN push_subscriptions ps ON ps.user_id = cm.user_id
       LEFT JOIN chat_prefs p ON p.user_id = cm.user_id AND p.circle_id = cm.circle_id
      WHERE cm.circle_id = ? AND cm.user_id != ?
        AND NOT (COALESCE(p.muted, 0) = 1 AND (p.muted_until IS NULL OR p.muted_until > datetime('now')))`, circleId, row.userId ?? 0);
  for (const r of recipients) {
    if (isVisible(r.id)) continue;
    const words = wordsFor(r.lang);
    const text = String(row.body || row.transcript || '').slice(0, 90);
    const what = row.kind === 'voice' ? words.voice : att === 'image' ? words.photo : att === 'video' ? words.video : att ? words.file : text;
    const body = !r.preview ? words.msg : circle.kind === 'direct' ? what : `${row.author ?? ''}: ${what}${att && text ? ' ' + text : ''}`;
    const title = !r.preview ? 'Thekra' : circle.kind === 'direct' ? (row.author ?? 'Thekra') : circle.name;
    pushToUser(r.id, { title, body, circle: circleId, tag: `circle-${circleId}` }).catch(e => console.error('[push]', e));
  }
}
