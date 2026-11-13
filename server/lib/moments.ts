import { flag } from './ops.ts';
import { detectMoment, isReconciliation, momentText, type ConflictStage } from '../../core/moments.ts';
import { MSG_COLS, analyze } from './messages.ts';
import { all, one, run, type Row } from '../db.ts';
import { announce, decorate, insertMessage, markDelivered } from './helpers.ts';
import { collectSealedEvidence } from './sealed.ts';
import { count, log, timed } from '../metrics.ts';
import { isReadOnly } from '../billing.ts';
import { today } from '../app.ts';

// ---- moments and conflicts ----------------------------------------------------------
// The agent never writes in the chat. Conflicts are recorded in the archive only, hidden for 24h
// (owner and the two parties can still see and decline them), and closed by a reconciliation or by time.

export const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
export const parseParties = (json: unknown): number[] => { try { return JSON.parse(String(json ?? '[]')); } catch { return []; } };
function partyNames(ids: number[]): string[] {
  return ids.map(id => one('SELECT name FROM users WHERE id = ?', id)?.name as string | undefined).filter((n): n is string => !!n);
}
export function setConflictStage(entry: Row, stage: ConflictStage) {
  const { title, text } = momentText('conflict', partyNames(parseParties(entry.parties)), !!entry.anonymous, stage);
  run("UPDATE archive_entries SET status = ?, title = ?, summary = ?, resolved_at = datetime('now'), visible_after = datetime('now') WHERE id = ?",
    stage, title, text, entry.id);
}
/** Open conflicts that stayed calm for a week are closed as "passed". */
export function settleConflicts(circleId: number) {
  for (const e of all(
    "SELECT * FROM archive_entries WHERE circle_id = ? AND kind = 'conflict' AND status = 'open' AND declined = 0 AND deleted_at IS NULL AND created_at <= datetime('now', '-7 days')",
    circleId)) setConflictStage(e, 'faded');
}
function reconcile(circleId: number, userId: number): boolean {
  const open = all("SELECT * FROM archive_entries WHERE circle_id = ? AND kind = 'conflict' AND status = 'open' AND declined = 0 AND deleted_at IS NULL", circleId)
    .filter(e => parseParties(e.parties).includes(userId));
  open.forEach(e => setConflictStage(e, 'resolved'));
  return open.length > 0;
}
function detectAndRecord(circleId: number) {
  const circle = one('SELECT agent_active, agent_from_id FROM circles WHERE id = ?', circleId)!;
  if (!circle.agent_active || !flag('agent_enabled') || isReadOnly(circleId)) return;
  const rows = all(
    `SELECT user_id AS userId, COALESCE(NULLIF(body, ''), transcript, '') AS text FROM messages
     WHERE circle_id = ? AND kind != 'system' AND user_id IS NOT NULL
       AND created_at >= datetime('now', '-20 minutes') AND id > ? ORDER BY id`,
    circleId, circle.agent_from_id ?? 0);
  const members = one('SELECT COUNT(*) n FROM circle_members WHERE circle_id = ?', circleId)!.n;
  const older = one(
    "SELECT COUNT(*) n FROM messages WHERE circle_id = ? AND kind != 'system' AND created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-20 minutes')",
    circleId)!.n;
  const moment = detectMoment(rows as any, { members, baselinePer15: older / (14 * 96) });
  if (!moment) return;

  const key = JSON.stringify([...moment.parties].sort((x, y) => x - y));
  const duplicate = moment.kind === 'conflict'
    ? one("SELECT 1 FROM archive_entries WHERE circle_id = ? AND kind = 'conflict' AND parties = ? AND created_at >= datetime('now', '-1 day')", circleId, key)
    : one("SELECT 1 FROM archive_entries WHERE circle_id = ? AND kind = ? AND created_at >= datetime('now', '-60 minutes')", circleId, moment.kind);
  if (duplicate) return;

  const { title, text } = momentText(moment.kind, partyNames(JSON.parse(key)), moment.anonymous);
  const conflict = moment.kind === 'conflict';
  run(`INSERT INTO archive_entries (circle_id, title, summary, category, event_date, source, kind, status, parties, anonymous, visible_after)
       VALUES (?, ?, ?, NULL, ?, 'auto', ?, ?, ?, ?, ?)`,
    circleId, title, text, today(), moment.kind, conflict ? 'open' : null, key, moment.anonymous ? 1 : 0,
    conflict ? sqlTime(Date.now() + 24 * 3600_000) : null);
}
export function afterMessage(circleId: number, userId: number, text: string, messageId?: number) {
  try {
    if (messageId) collectSealedEvidence(circleId, messageId, userId, text);
    settleConflicts(circleId);
    if (isReconciliation(text) && reconcile(circleId, userId)) return;
    detectAndRecord(circleId);
  } catch (e) {
    console.error('[moments]', e); // a failure here must never block sending a message
  }
}
/** In a one-to-one chat, true if either person has blocked the other. */
export function blockedInDirect(circleId: number, userId: number): boolean {
  const c = one('SELECT kind FROM circles WHERE id = ?', circleId);
  if (c?.kind !== 'direct') return false;
  return !!one(
    `SELECT 1 FROM circle_members o JOIN blocks b ON (b.user_id = o.user_id AND b.blocked_id = ?) OR (b.user_id = ? AND b.blocked_id = o.user_id)
      WHERE o.circle_id = ? AND o.user_id != ? LIMIT 1`, userId, userId, circleId, userId);
}
/** Shared by the HTTP route and the WebSocket gateway, so both behave identically. */
export function sendText(circleId: number, userId: number, body: string, clientMsgId: string | null, replyTo: number | null = null, forwardCount = 0) {
  if (blockedInDirect(circleId, userId)) throw Object.assign(new Error('blocked'), { code: 'blocked' });
  // A reply must quote a message of this same circle; anything else is silently sent as a plain message.
  if (replyTo !== null && !one('SELECT 1 FROM messages WHERE id = ? AND circle_id = ?', replyTo, circleId)) replyTo = null;
  const stored = timed('store_ms', () => insertMessage({ circleId, userId, kind: 'text', body, clientMsgId, replyTo, forwardCount }));
  const sent = stored.value;
  if (sent.duplicate) { count('send_duplicate'); return sent; }
  count('send_ok');
  // The sender has obviously seen their own chat up to here: moves their marks silently (no event, it would only be noise).
  run('UPDATE circle_members SET read_seq = MAX(read_seq, ?), delivered_seq = MAX(delivered_seq, ?) WHERE circle_id = ? AND user_id = ?', sent.seq, sent.seq, circleId, userId);
  // The trace of one message on the server: how long storing took and how long the push to everyone took.
  const fan = timed('fanout_ms', () => announce(circleId, sent.id));
  // Forwarded text is somebody else's words from elsewhere, and chain messages are noise: the archive agent never reads it.
  if (forwardCount === 0) { analyze(circleId, sent.id, body); afterMessage(circleId, userId, body, sent.id); }
  log('msg', { circle: circleId, seq: sent.seq, store_ms: Math.round(stored.ms * 10) / 10, fanout_ms: Math.round(fan.ms * 10) / 10, delivered_to: fan.value });
  return sent;
}
export const SYNC_PAGE = 200;
/**
 * Sync by seq (the protocol's range sync): the OLDEST SYNC_PAGE messages after `afterSeq`, ascending, so a client that
 * missed a lot fills its hole from the start and asks again from its new contiguous prefix. (Returning the latest page
 * instead would leave a hole at the start that the client could never close.)
 */
export function messagesSince(circleId: number, userId: number, afterSeq: number) {
  const rows = all(
    `SELECT ${MSG_COLS} FROM messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.circle_id = ? AND m.seq > ? AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
       ORDER BY m.seq LIMIT ${SYNC_PAGE}`, circleId, afterSeq, userId);
  if (rows.length) markDelivered(circleId, userId, rows[rows.length - 1].seq); // fetching is receiving
  return decorate(circleId, rows);
}
/**
 * Sync by revision: the oldest SYNC_PAGE messages that are new OR CHANGED since `afterRev`, ascending by rev.
 * This is what a returning device uses, so edits, reactions and deletions made while it was away reach it.
 * The caller advances its watermark only to the last rev of a reply it received (never from a push).
 */
export function messagesChanged(circleId: number, userId: number, afterRev: number) {
  const rows = all(
    `SELECT ${MSG_COLS} FROM messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.circle_id = ? AND m.rev > ? AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
       ORDER BY m.rev LIMIT ${SYNC_PAGE}`, circleId, afterRev, userId);
  if (rows.length) markDelivered(circleId, userId, Math.max(...rows.map(r => r.seq as number)));
  return decorate(circleId, rows);
}
/** Opening a chat: the latest page of messages after an id (0 = from the start of the chat view). */
export function messagesAfter(circleId: number, userId: number, afterId = 0) {
  const rows = all(
    `SELECT * FROM (SELECT ${MSG_COLS} FROM messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.circle_id = ? AND m.id > ? AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
       ORDER BY m.id DESC LIMIT ${SYNC_PAGE}) ORDER BY id`, circleId, afterId, userId);
  if (rows.length) markDelivered(circleId, userId, Math.max(...rows.map(r => r.seq as number)));
  return decorate(circleId, rows);
}
export const MAX_AUDIO = 5 * 1024 * 1024;
// Not `instanceof File`: the File class differs between Node versions.
export const isFile = (v: unknown): v is File =>
  typeof v === 'object' && v !== null && typeof (v as File).arrayBuffer === 'function' && typeof (v as File).size === 'number';
export const AUDIO_MIME = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav']);
/** Other names phones give the same formats: iOS labels its .m4a recordings "audio/x-m4a" (AAC in MP4), some Android builds "audio/aac" or "audio/x-wav". They are stored under the accepted name. */
export const AUDIO_ALIAS: Record<string, string> = { 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/aac': 'audio/mp4', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav' };
