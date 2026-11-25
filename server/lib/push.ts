import { all, one, type Row } from '../db.ts';
import { isVisible } from '../live.ts';
import { pushToUser } from '../push.ts';
import { cardWord, words as wordsFor, type CardWord } from './texts.ts';
import { cardTypeOf } from './cards.ts';
import { plainText } from '../../core/format.ts';
/**
 * Tell the circle's other members about a new message on their other devices. Skipped for: the sender, a muted chat,
 * a chat they set to stay quiet (chat_prefs.notify: 'mentions' or 'none'), and anyone who has the app on screen right
 * now. With "show previews" off the notification says only that something arrived.
 */
export function notifyMembers(circleId: number, row: Row) {
  if (row.kind === 'system' || row.encKind === 'edit' || row.encKind === 'ctl') return;   // a control message wakes nobody
  const circle = one('SELECT name, kind, encrypted FROM circles WHERE id = ?', circleId);
  if (!circle) return;
  const att = one("SELECT kind FROM media WHERE message_id = ? AND kind IN ('image','video','file') ORDER BY id LIMIT 1", row.id)?.kind as string | undefined;
  const cardType = cardTypeOf(row.id);
  const card = cardType && cardType !== 'link' ? cardType as CardWord : null;
  const recipients = all(
    `SELECT DISTINCT cm.user_id AS id, u.lang, (u.push_preview = 1 AND COALESCE(p.locked, 0) = 0) AS preview
       FROM circle_members cm JOIN users u ON u.id = cm.user_id JOIN push_subscriptions ps ON ps.user_id = cm.user_id
       LEFT JOIN chat_prefs p ON p.user_id = cm.user_id AND p.circle_id = cm.circle_id
      WHERE cm.circle_id = ? AND cm.user_id != ? AND cm.request = 0   -- a message request waits quietly until it is accepted
        AND COALESCE(p.notify, 'all') != 'none'                        -- this chat never interrupts this person, not even for a mention
        AND (COALESCE(p.notify, 'all') = 'all'
             OR EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = ? AND mm.user_id = cm.user_id))   -- 'mentions': only when their name is written
        AND (NOT (COALESCE(p.muted, 0) = 1 AND (p.muted_until IS NULL OR p.muted_until > datetime('now')))
             OR EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = ? AND mm.user_id = cm.user_id))   -- a mention is heard even in a muted chat
        -- someone you blocked never wakes your phone, not even from a group you share
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_id = cm.user_id AND b.blocked_id = ?)`,
    circleId, row.userId ?? 0, row.id, row.id, row.userId ?? 0);
  for (const r of recipients) {
    if (isVisible(r.id)) continue;
    const words = wordsFor(r.lang);
    if (circle.encrypted) {   // the server cannot read it: no text, no sender, no kind of file. The device decrypts and shows the real text when it wakes.
      pushToUser(r.id, { title: 'Tamtim', body: words.msg, circle: circleId, tag: `circle-${circleId}`, enc: 1 }).catch(e => console.error('[push]', e));
      continue;
    }
    const text = plainText(String(row.body || row.transcript || '')).slice(0, 90);   // *bold* reads as bold's words, without the stars
    const what = card ? cardWord(r.lang, card) : row.kind === 'voice' ? words.voice : att === 'image' ? words.photo : att === 'video' ? words.video : att ? words.file : text;
    // A view-once or disappearing message never puts its content in a notification: the text would outlive the message on the device.
    const hidden = !r.preview || row.viewOnce || row.expiresAt;
    const body = hidden ? words.msg : circle.kind === 'direct' ? what : `${row.author ?? ''}: ${what}${att && text && !card ? ' ' + text : ''}`;
    const title = hidden ? 'Tamtim' : circle.kind === 'direct' ? (row.author ?? 'Tamtim') : circle.name;
    pushToUser(r.id, { title, body, circle: circleId, tag: `circle-${circleId}` }).catch(e => console.error('[push]', e));
  }
}
