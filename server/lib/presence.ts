import { all, one, run } from '../db.ts';
import { live } from '../live.ts';

// ---- online and last seen ------------------------------------------------------------------
// "Online" = the app is on screen in at least one of the person's connections (the `visible` frame), not merely connected.
// "Last seen" = the moment the last such connection left. Counted on THIS node, like live connections (server/lib/sockets.ts):
// with several nodes a shared counter goes behind this module, and nothing outside it changes.
//
// Who may see it is decided here and only here. The rule (as in WhatsApp, with "my family" in place of "my contacts"):
//   - never across a block, in either direction;
//   - the person's own setting: everyone they share a chat with / only people in one of their family circles / nobody;
//   - reciprocal: someone who shows theirs to nobody sees nobody's;
//   - never to a stranger (no shared chat, or only a message request not yet accepted), so a user id cannot be probed.
// When someone STOPS being allowed (privacy tightened, a block) they are told to forget what they knew: `{ gone: true }`.

export const LAST_SEEN_PRIVACY = ['everyone', 'family', 'nobody'] as const;
export type LastSeenPrivacy = typeof LAST_SEEN_PRIVACY[number];
export const isLastSeenPrivacy = (x: unknown): x is LastSeenPrivacy => typeof x === 'string' && (LAST_SEEN_PRIVACY as readonly string[]).includes(x);

/** "Left" is announced only after this long, and not at all if the person is back before then: a glance at another app is not leaving. */
const GRACE_MS = Math.max(0, Number(process.env.THIKRA_PRESENCE_GRACE_MS ?? 4000) || 0);
const shown = new Set<number>();                                  // people currently announced as online
const leaving = new Map<number, ReturnType<typeof setTimeout>>(); // people who left the screen moments ago and may be right back
const utc = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

export function canSeePresence(viewerId: number, targetId: number): boolean {
  if (viewerId === targetId) return true;
  const r = one(
    `SELECT t.last_seen_privacy AS theirs, v.last_seen_privacy AS mine,
            EXISTS (SELECT 1 FROM blocks WHERE (user_id = v.id AND blocked_id = t.id) OR (user_id = t.id AND blocked_id = v.id)) AS blocked,
            (SELECT MAX(CASE WHEN c.kind = 'circle' THEN 2 ELSE 1 END)
               FROM circle_members a JOIN circle_members b ON b.circle_id = a.circle_id JOIN circles c ON c.id = a.circle_id AND c.deleted_at IS NULL
              WHERE a.user_id = v.id AND b.user_id = t.id AND a.request = 0 AND b.request = 0) AS shared   -- a message request not yet accepted shares nothing
       FROM users t, users v WHERE t.id = ? AND v.id = ?`, targetId, viewerId);
  if (!r || r.blocked || !r.shared) return false;
  if (r.mine === 'nobody' || r.theirs === 'nobody') return false;
  return r.theirs === 'family' ? r.shared === 2 : true;
}

/** Everyone who may see this person's presence right now (the people they share a chat with, filtered by the rule above). */
export function presenceViewers(userId: number): number[] {
  return all(
    `SELECT DISTINCT o.user_id AS id FROM circle_members mine JOIN circle_members o ON o.circle_id = mine.circle_id AND o.user_id != mine.user_id
       JOIN circles c ON c.id = mine.circle_id AND c.deleted_at IS NULL WHERE mine.user_id = ?`, userId)
    .map(r => r.id as number).filter(id => canSeePresence(id, userId));
}

export interface Presence { id: number; online: boolean; lastSeen: string | null }
/** What `viewerId` may know about these people. Someone they may not see is simply absent (not "offline", not null). */
export function presenceOf(viewerId: number, ids: number[]): Presence[] {
  const out: Presence[] = [];
  for (const id of [...new Set(ids)]) {
    if (!canSeePresence(viewerId, id)) continue;
    const row = one('SELECT last_seen_at FROM users WHERE id = ?', id);
    if (!row) continue;
    const online = shown.has(id);
    out.push({ id, online, lastSeen: online ? null : (row.last_seen_at as string | null) });
  }
  return out;
}

const tell = (userId: number, viewers: number[]) => {
  const online = shown.has(userId);
  const lastSeen = online ? null : ((one('SELECT last_seen_at FROM users WHERE id = ?', userId)?.last_seen_at as string | undefined) ?? null);
  live.publishTo(viewers, { t: 'presence', user: userId, online, last_seen: lastSeen });
};

/** These people may no longer see `userId` (privacy tightened, a block): their screens must drop what they showed. */
export function forgetPresence(userId: number, viewers: number[]) {
  live.publishTo(viewers.filter(v => v !== userId), { t: 'presence', user: userId, gone: true });
}
/**
 * The person's privacy setting changed. `before` = presenceViewers(userId) taken BEFORE the change.
 * Those who lost sight are told to forget; those who gained it are told the current state.
 */
export function presencePrivacyChanged(userId: number, before: number[]) {
  const after = presenceViewers(userId);
  const now = new Set(after), was = new Set(before);
  forgetPresence(userId, before.filter(v => !now.has(v)));
  tell(userId, after.filter(v => !was.has(v)));
}

// A person came on screen or left. Coming back within the grace time cancels the leaving: nothing is stored and nobody is told.
live.onVisibility((userId, online) => {
  const pending = leaving.get(userId);
  if (online) {
    if (pending) { clearTimeout(pending); leaving.delete(userId); }
    if (shown.has(userId)) return;
    shown.add(userId);
    return tell(userId, presenceViewers(userId));
  }
  if (!shown.has(userId) || pending) return;
  const leftAt = utc(new Date());
  const timer = setTimeout(() => {
    leaving.delete(userId);
    shown.delete(userId);
    run('UPDATE users SET last_seen_at = ? WHERE id = ?', leftAt, userId);
    tell(userId, presenceViewers(userId));
  }, GRACE_MS);
  timer.unref?.();
  leaving.set(userId, timer);
});
