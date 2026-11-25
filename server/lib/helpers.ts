import { state } from '../state.ts';
import { suspension } from './admin.ts';
import { touchActivity } from './ops.ts';
import { maintenanceNow } from './announce.ts';
import { live } from '../live.ts';
import { type Context } from 'hono';
import { sha, type Env } from '../app.ts';
import { MSG_COLS } from './messages.ts';
import { recordMark } from './marks.ts';
import { mentionsOf, pollsOf } from './polls.ts';
import { cardsOf } from './cards.ts';
import { all, db, one, run, type Row } from '../db.ts';
import { getCookie } from 'hono/cookie';
import { normalize } from '../../core/agent.ts';
import { normalizePhone } from '../../core/phone.ts';
import { notifyMembers } from './push.ts';
import { publish } from '../live.ts';
import { EncryptedChat, isEncrypted } from './e2ee.ts';

// ---- helpers ---------------------------------------------------------------

export const normPhone = normalizePhone;
 // the same canonical form the client produces

/** Rate limiting goes through the shared-state port (server/state.ts): in memory for one process, Redis for many. True = over the limit. */
export const limited = (key: string, max: number, windowMs: number) => state.limiter.hit(key, max, windowMs);
/** A member's role in a circle, or nothing. A circle that is waiting to be erased (deleted but still restorable) has no members for access purposes. */
export function membership(circleId: number, userId: number) {
  return one('SELECT m.role FROM circle_members m JOIN circles c ON c.id = m.circle_id WHERE m.circle_id = ? AND m.user_id = ? AND c.deleted_at IS NULL', circleId, userId);
}
/** A frozen family (staff put it on hold) accepts nothing new; reading and exporting still work and nothing is deleted. */
export const isFrozen = (circleId: number) => !!one('SELECT 1 FROM circles WHERE id = ? AND frozen_at IS NOT NULL', circleId);
export const isManager = (role?: string) => role === 'owner' || role === 'admin';
/**
 * May this person post in this chat? In a group set to "only admins send", only the owner and admins may. This is THE check for every way
 * of posting (text, voice, attachments, forwards, polls); `insertMessage` also refuses, so a new route cannot forget it.
 */
export function mayPost(circleId: number, userId: number): boolean {
  const r = one('SELECT c.send_policy AS policy, m.role FROM circles c JOIN circle_members m ON m.circle_id = c.id AND m.user_id = ? WHERE c.id = ?', userId, circleId);
  return !!r && (r.policy !== 'admins' || isManager(r.role as string));
}
/** Thrown when a post is refused by the group's rules; the HTTP layer answers 403 with this code, the live gateway sends it as the error. */
export class PostRefused extends Error { code = 'admins_only'; constructor() { super('admins_only'); } }
/** Every member is also a "person" of the family, which outlives the account. */
export function ensurePerson(circleId: number, user: Row) {
  if (!one('SELECT 1 FROM persons WHERE circle_id = ? AND user_id = ?', circleId, user.id)) {
    run('INSERT INTO persons (circle_id, name, user_id) VALUES (?, ?, ?)', circleId, user.name, user.id);
  }
}
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
/** What search looks at: the text with Arabic spelling variants unified (so «أحمد» finds «احمد», ة finds ه…). */
export const searchable = (text: string) => normalize(text) || null;
/** Messages from before search existed get their search text once, in batches (this does not touch their revision). */
function backfillSearchText() {
  for (;;) {
    const rows = all("SELECT id, body, transcript FROM messages WHERE search_text IS NULL AND deleted_at IS NULL AND (body != '' OR transcript IS NOT NULL) LIMIT 2000");
    if (!rows.length) return;
    tx(() => { for (const r of rows) run('UPDATE messages SET search_text = ? WHERE id = ?', searchable(r.body || r.transcript || '') ?? '', r.id); });
  }
}
backfillSearchText();
interface NewMessage {
  circleId: number; userId: number | null; kind: 'text' | 'voice' | 'system'; body: string;
  clientMsgId?: string | null; replyTo?: number | null; forwardCount?: number; audioPath?: string; transcript?: string | null; archiveStatus?: string;
  /** The server itself delivers this on a person's behalf (a sealed letter opening): the group's "only admins send" does not apply. */
  delivered?: boolean;
  /** A photo, video or voice note each recipient can open one time. */
  viewOnce?: boolean;
  /** An end-to-end encrypted message: the server keeps the opaque bytes and a small plain header, never text. The only way to post into an encrypted chat. */
  enc?: { ciphertext: Uint8Array; kind: string; epoch: number; target?: number | null };
}
/**
 * The one way a message comes into existence. Assigns the circle's next `seq` (invariant I1) and makes a retry
 * with the same client_msg_id return the original instead of creating a second message (I2).
 */
export function insertMessage(n: NewMessage): { id: number; seq: number; duplicate: boolean } {
  if (n.clientMsgId && n.userId) {
    const prev = one('SELECT id, seq FROM messages WHERE circle_id = ? AND user_id = ? AND client_msg_id = ?', n.circleId, n.userId, n.clientMsgId);
    if (prev) return { id: prev.id, seq: prev.seq, duplicate: true };
  }
  if (n.userId && n.kind !== 'system' && !n.delivered && !mayPost(n.circleId, n.userId)) throw new PostRefused();
  // THE backstop for encryption: a readable message cannot enter an encrypted chat by any route, present or future, and ciphertext cannot enter a readable one.
  const encrypted = n.kind !== 'system' && isEncrypted(n.circleId);
  if (encrypted && (!n.enc || n.body || n.transcript || n.audioPath)) throw new EncryptedChat();
  if (!encrypted && n.enc) throw new Error('not_encrypted');
  const r = run(
    `INSERT INTO messages (circle_id, user_id, kind, body, audio_path, transcript, archive_status, client_msg_id, reply_to, search_text, forward_count, expires_at, view_once, seq, rev, ciphertext, enc_kind, epoch, ctl_target)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT CASE WHEN ? NOT IN ('system', 'delivered') THEN datetime('now', '+' || disappear_seconds || ' seconds') END FROM circles WHERE id = ?), ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE circle_id = ?), (SELECT COALESCE(MAX(rev), 0) + 1 FROM messages WHERE circle_id = ?), ?, ?, ?, ?)`,
    n.circleId, n.userId, n.kind, n.body, n.audioPath ?? null, n.transcript ?? null, n.archiveStatus ?? 'none', n.clientMsgId ?? null, n.replyTo ?? null, searchable(n.body || n.transcript || ''), n.forwardCount ?? 0, n.delivered ? 'delivered' : n.kind, n.circleId, n.viewOnce ? 1 : 0, n.circleId, n.circleId,
    n.enc ? Buffer.from(n.enc.ciphertext) : null, n.enc?.kind ?? null, n.enc?.epoch ?? null, n.enc?.target ?? null);
  const id = Number(r.lastInsertRowid);
  return { id, seq: one('SELECT seq FROM messages WHERE id = ?', id)!.seq, duplicate: false };
}
/**
 * Add what a client needs to draw a message beyond its own row: the quoted message (reply) and the reactions.
 * Ticks are NOT here: they come from each member's watermarks (see markDelivered / markRead), as in WhatsApp's "up to here".
 */
export function decorate(circleId: number, rows: Row[]): Row[] {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id as number);
  const marks = ids.map(() => '?').join(',');
  const rx = all(`SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${marks})`, ...ids);
  const files = all(
    `SELECT m.id, m.message_id, m.kind, m.mime, m.name, m.size, m.width, m.height, (SELECT t.id FROM media t WHERE t.thumb_of = m.id) AS thumbId
       FROM media m WHERE m.message_id IN (${marks}) AND m.kind IN ('image','video','file') ORDER BY m.id`, ...ids);
  const audio = all(`SELECT message_id, duration_ms, waveform FROM media WHERE kind = 'audio' AND message_id IN (${marks})`, ...ids);
  const plays = audio.length ? all(`SELECT message_id, user_id FROM voice_plays WHERE message_id IN (${marks}) ORDER BY played_at, user_id`, ...ids) : [];
  const cards = cardsOf(ids);
  const onceIds = rows.filter(r => r.viewOnce).map(r => r.id as number);
  const opens = onceIds.length ? all(`SELECT message_id, user_id FROM view_once_opens WHERE message_id IN (${onceIds.map(() => '?').join(',')}) ORDER BY opened_at, user_id`, ...onceIds) : [];
  const mentions = mentionsOf(ids), polls = pollsOf(ids);
  const replyIds = [...new Set(rows.map(r => r.replyToId as number | null).filter((x): x is number => !!x))];
  const quoted = new Map<number, Row>();
  if (replyIds.length) {
    for (const q of all(
      `SELECT m.id, u.name AS author, m.kind, m.body, m.transcript, m.deleted_at IS NOT NULL AS deleted,
                (SELECT c.type FROM message_cards c WHERE c.message_id = m.id) AS card
         FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.circle_id = ? AND m.id IN (${replyIds.map(() => '?').join(',')})`, circleId, ...replyIds)) quoted.set(q.id, q);
  }
  return rows.map(({ ciphertext, encKind, epoch, target, ...r }) => {
    const q = r.replyToId ? quoted.get(r.replyToId) : undefined;
    return {
      ...r,
      // An encrypted message: the opaque bytes (base64) and the plain header. These keys exist ONLY on encrypted messages, so a family circle's messages are exactly as before.
      ...(encKind ? { encKind, epoch, ...(ciphertext ? { ciphertext: Buffer.from(ciphertext).toString('base64') } : {}), ...(target ? { target } : {}) } : {}),
      expired: !!r.expired,
      // View once: who has opened it. Nothing else about the file is shown (no name, no thumbnail), and a closed one never lists its file's details.
      viewOnce: r.viewOnce ? { openedBy: opens.filter(x => x.message_id === r.id).map(x => x.user_id as number) } : null,
      reactions: rx.filter(x => x.message_id === r.id).map(x => ({ u: x.user_id, e: x.emoji })),
      audioMs: audio.find(x => x.message_id === r.id)?.duration_ms ?? null,
      // A voice note: its shape as measured by the sender's device, and who has played it.
      waveform: r.deleted ? null : waveformOf(audio.find(x => x.message_id === r.id)?.waveform),
      playedBy: plays.filter(x => x.message_id === r.id).map(x => x.user_id as number),
      card: r.deleted ? null : cards.get(r.id as number) ?? null,
      mentions: mentions.get(r.id as number) ?? [],
      poll: r.deleted ? null : polls.get(r.id as number) ?? null,
      attachments: files.filter(f => f.message_id === r.id).map(f => r.viewOnce ? { id: f.id, kind: f.kind, mime: f.mime, name: null, size: f.size, w: f.width, h: f.height, thumb: null } : { id: f.id, kind: f.kind, mime: f.mime, name: f.name, size: f.size, w: f.width, h: f.height, thumb: f.thumbId }),
      replyTo: r.replyToId
        ? q ? { id: q.id, author: q.author, kind: q.kind, deleted: !!q.deleted, card: q.deleted ? null : q.card ?? null, text: q.deleted ? '' : String((q.kind === 'voice' ? q.transcript : q.body) ?? '').slice(0, 120) }
            : { id: r.replyToId, author: null, kind: 'text', deleted: true, text: '' }
        : null,
    };
  });
}
const waveformOf = (raw: unknown): number[] | null => { try { const v = JSON.parse(String(raw ?? 'null')); return Array.isArray(v) ? v : null; } catch { return null; } };
/** One member's "delivered up to here" moved forward. Everyone in the circle hears about it (the sender draws the second tick). */
export function markDelivered(circleId: number, userId: number, seq: number) {
  const r = run('UPDATE circle_members SET delivered_seq = ? WHERE circle_id = ? AND user_id = ? AND delivered_seq < ?', seq, circleId, userId, seq);
  if (Number(r.changes) === 0) return;
  recordMark(circleId, userId, 'd', seq);
  publish(circleId, { t: 'receipt', circle: circleId, user: userId, delivered_seq: seq });
}
/**
 * One member has read up to `seq` (and so has also had it delivered). The read mark is shared only if that member has
 * read receipts on; either way their own unread counter moves. Never goes backwards, never past the newest message.
 */
export function markRead(circleId: number, userId: number, seq: number) {
  // A message request you have not accepted tells its sender nothing: no blue ticks until you accept it.
  if (one('SELECT request FROM circle_members WHERE circle_id = ? AND user_id = ?', circleId, userId)?.request) return;
  const top = one('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE circle_id = ?', circleId)!.m as number;
  const to = Math.min(Math.max(0, Math.floor(seq) || 0), top);
  run('UPDATE chat_prefs SET marked_unread = 0 WHERE user_id = ? AND circle_id = ?', userId, circleId); // opening the chat clears "mark as unread"
  const had = (one('SELECT delivered_seq AS d FROM circle_members WHERE circle_id = ? AND user_id = ?', circleId, userId)?.d as number | undefined) ?? 0;
  const r = run('UPDATE circle_members SET read_seq = ?, delivered_seq = MAX(delivered_seq, ?) WHERE circle_id = ? AND user_id = ? AND read_seq < ?', to, to, circleId, userId, to);
  if (Number(r.changes) === 0) return;
  recordMark(circleId, userId, 'r', to);   // stored whether or not it is shared: sharing is decided when someone asks (it can change later)
  if (had < to) recordMark(circleId, userId, 'd', to);   // opening the chat is also the moment these messages reached this person's device
  const shares = one('SELECT read_receipts FROM users WHERE id = ?', userId)?.read_receipts === 1;
  publish(circleId, { t: 'receipt', circle: circleId, user: userId, delivered_seq: to, ...(shares ? { read_seq: to } : {}) });
}
/** Tell everyone connected to this circle about a new message; each user it reaches is marked delivered. */
export function announce(circleId: number, messageId: number): number {
  const row = one(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?`, messageId);
  if (!row) return 0;
  const [m] = decorate(circleId, [row]);
  // A message from a person brings the chat back out of the archive for the readers who asked for that (users.keep_archived = 0). Never for the sender.
  // (The inner query starts from this chat's members, not from every person on the platform.)
  if (row.userId) run(`UPDATE chat_prefs SET archived = 0 WHERE circle_id = ? AND archived = 1 AND user_id != ?
    AND user_id IN (SELECT cm.user_id FROM circle_members cm JOIN users u ON u.id = cm.user_id WHERE cm.circle_id = ? AND u.keep_archived = 0)`, circleId, row.userId, circleId);
  notifyMembers(circleId, row);
  return publish(circleId, { t: 'msg', circle: circleId, m }, uid => { if (uid !== row.userId) markDelivered(circleId, uid, row.seq); });
}
/** An existing message changed (edited, reacted to): push its new full state. */
export function announceUpdate(circleId: number, messageId: number) {
  const row = one(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?`, messageId);
  if (row) publish(circleId, { t: 'update', circle: circleId, m: decorate(circleId, [row])[0] });
}
/** An event from ANOTHER node reached one of our sockets: that person has the message, so it is "delivered" just as if the sender's node had reached them. */
live.onRemoteReached((circleId, event, userId) => {
  const e = event as { t?: string; m?: { userId?: number; seq?: number } };
  if (e?.t === 'msg' && e.m?.seq !== undefined && userId !== e.m.userId) markDelivered(circleId, userId, e.m.seq);
});
/** The chat itself changed (name, photo, description, a setting, its members): clients reload its details. */
export const circleChanged = (circleId: number) => publish(circleId, { t: 'circle', circle: circleId });
/** Something about existing messages changed (deleted, archived…): clients re-sync. */
export const poke = (circleId: number) => publish(circleId, { t: 'changed', circle: circleId });
/** A notice in the chat ("Sara joined"). It is stored as a code and its values, never as words, and every member's app writes it in their own language (older notices stored as Arabic words still show as they were). */
export type SystemNote = 'photoChanged' | 'photoRemoved' | 'descChanged' | 'nameChanged' | 'sendAdmins' | 'sendAll' | 'groupToCircle' | 'joined' | 'agentOn' | 'agentOff' | 'deathOpened' | 'deathAgent' | 'eventAgent' | 'imported' | 'eventStopped' | 'imFine' | 'deathStopped' | 'disappearOn' | 'disappearOff' | 'callMissed' | 'callDeclined' | 'callEnded';
export function systemMessage(circleId: number, key: SystemNote, args: Record<string, string | number> = {}): number {
  const { id } = insertMessage({ circleId, userId: null, kind: 'system', body: `sys:${JSON.stringify({ k: key, a: args })}` });
  announce(circleId, id);
  return id;
}
export const requireAuth = async (c: Context<Env>, next: () => Promise<void>) => {
  // The phone app also sends the session in its own header: iOS's media player and file
  // downloads replace a hand-set Cookie with the system's cookie store, but leave custom headers alone.
  // Either may be stale (iOS can swap in an old cookie from its own store), so a valid one of the two wins.
  const live = (t: string | undefined) => (t ? one('SELECT rowid AS sid, user_id, last_seen_at FROM sessions WHERE token = ? AND expires_at > ?', sha(t), Date.now()) : undefined);
  const token = getCookie(c, 'thikra_session') || c.req.header('x-thikra-session');
  const s = live(getCookie(c, 'thikra_session')) ?? live(c.req.header('x-thikra-session'));
  const user = s && one('SELECT id, phone, name, lang, is_admin, admin_role, read_receipts, push_preview, last_seen_privacy, keep_archived, email, about, (pin_hash IS NOT NULL) AS has_pin, avatar_at, created_at FROM users WHERE id = ?', s.user_id);
  if (!user) {
    // Uploads from the phone app carry the session by hand; say what arrived when they are refused.
    if (/\/(voice|attachments|sealed|audio|file)$|^\/api\/media\//.test(c.req.path)) console.warn(`[auth] ${c.req.method} ${c.req.path} refused: ${c.req.header('cookie') ? (token ? 'session cookie unknown or expired' : 'a Cookie header without the session') : 'no Cookie header'}`);
    return c.json({ error: 'unauthorized' }, 401);
  }
  // When this device was last used (RT-03). Written at most once every five minutes: a column, not a log, and not a write per request.
  if (!s.last_seen_at || Date.now() - Date.parse(`${String(s.last_seen_at).replace(' ', 'T')}Z`) > 5 * 60_000) {
    run("UPDATE sessions SET last_seen_at = datetime('now') WHERE rowid = ?", s.sid);
  }
  c.set('sessionId', Number(s.sid));
  const suspended = suspension(user.id);   // a suspended person's session stops working at once
  if (suspended) return c.json({ error: 'suspended', until: suspended.until }, 403);
  // Maintenance: the app is read-only (reading, support and dismissing a notice still work; admin works so staff can switch it off).
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && maintenanceNow() && !/^\/api\/(admin|support|announcements)/.test(c.req.path)) return c.json({ error: 'maintenance' }, 503);
  // A frozen family is read-only for EVERY write (not just sending): the one guard sits here so a new route cannot forget it. Personal, non-destructive actions stay open:
  // marking read, own preferences, reporting, starring and hiding for oneself.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && frozenWrite(c.req.path)) return c.json({ error: 'circle_frozen' }, 423);
  touchActivity(user.id);
  c.set('user', user);
  await next();
};
const FROZEN_OK = /\/(read|prefs|report|star|hide|played)$/;
/** Does this write touch a family that staff froze? Paths under /api/circles/:id and /api/messages/:mid (the message's own family). */
function frozenWrite(path: string): boolean {
  if (FROZEN_OK.test(path)) return false;
  const c = path.match(/^\/api\/circles\/(\d+)(?:\/|$)/);
  if (c) return isFrozen(Number(c[1]));
  const m = path.match(/^\/api\/messages\/(\d+)(?:\/|$)/);
  if (m) { const row = one('SELECT circle_id FROM messages WHERE id = ?', Number(m[1])); return !!row && isFrozen(row.circle_id); }
  return false;
}
export const circleAccess = (c: Context<Env>) => {
  const circleId = Number(c.req.param('id'));
  const user = c.get('user');
  const m = Number.isInteger(circleId) && membership(circleId, user.id);
  return m ? { circleId, role: m.role as string, user } : null;
};
