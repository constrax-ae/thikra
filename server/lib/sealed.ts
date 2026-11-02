import { flag } from './ops.ts';
import { MIN_MESSAGES, mentionsDeath, mentionsOccurrence, requiredMembers } from '../../core/sealed.ts';
import { all, one, run, type Row } from '../db.ts';
import { announce, insertMessage, membership, systemMessage } from './helpers.ts';
import { blockedInDirect } from './moments.ts';
import { directChat } from './circles.ts';
import { trackJob } from './jobs.ts';

// ---- sealed messages ----------------------------------------------------------------------------
// A letter to the family's future: text, a voice note, a video or a photo. When it opens it is posted to the whole circle, nobody can
// delete or edit it (not even its author or the owner), and it is kept in the family archive. A person may leave many, for different
// dates and events. Triggers: DATE (once or every year), EVENT (two other members confirm it happened), AFTER DEATH (two members
// confirm, then a waiting period in which the author, if alive, or a manager can stop it).

export const SEAL_MIN_MS = 5 * 60_000;
                 // at least five minutes ahead (a letter to the future, not a delayed send)
export const SEAL_MAX_MS = 50 * 365 * 24 * 3600_000;
   // at most fifty years
export const DEATH_WAIT_HOURS = Number(process.env.THIKRA_DEATH_WAIT_HOURS ?? 72);
export const MAX_SEALED_MEDIA = 64 * 1024 * 1024;
export const sqlUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
export const SEAL_AUDIO = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav']);
export const sealedRow = (r: Row) => ({
  id: r.id, circleId: r.circle_id, circleName: r.circleName, trigger: r.trigger, occasion: r.occasion, kind: r.kind, body: r.body, fileName: r.name,
  unlockAt: r.unlock_at, yearly: !!r.yearly, status: r.status, releaseAt: r.release_at, note: r.note, recipient: r.recipient ?? null, recipientId: r.recipient_id,
});
export const SEALED_SELECT = `SELECT s.*, ci.name AS circleName, u.name AS recipient FROM sealed_messages s JOIN circles ci ON ci.id = s.circle_id AND ci.deleted_at IS NULL LEFT JOIN users u ON u.id = s.recipient_id`;
/** Open an envelope now: post its content to the circle (or the one-to-one chat), protect it, archive it, and either finish it or schedule next year. */
export async function releaseOne(s: Row): Promise<boolean> {
  let target = s.circle_id as number;
  if (s.recipient_id) {
    if (!membership(s.circle_id, s.recipient_id)) { run("UPDATE sealed_messages SET status = 'stopped', note = 'recipient_left' WHERE id = ?", s.id); return false; }
    if (s.yearly && recipientDeceased(s.circle_id, s.recipient_id)) { run("UPDATE sealed_messages SET status = 'stopped', note = 'recipient_deceased' WHERE id = ?", s.id); return false; }
    target = directChat(s.author_id, s.recipient_id).id;
    if (blockedInDirect(target, s.author_id)) { run("UPDATE sealed_messages SET status = 'stopped', note = 'blocked' WHERE id = ?", s.id); return false; }
  } else if (s.trigger !== 'death' && !membership(s.circle_id, s.author_id)) { run("UPDATE sealed_messages SET status = 'stopped', note = 'author_left' WHERE id = ?", s.id); return false; }

  const sealedOn = String(s.sealed_on).slice(0, 10);
  const sent = s.kind === 'voice'
    ? insertMessage({ circleId: target, userId: s.author_id, kind: 'voice', body: '', audioPath: s.blob_hash, transcript: s.body || null }) // the written note shows under the recording
    : insertMessage({ circleId: target, userId: s.author_id, kind: 'text', body: s.body });
  run('UPDATE messages SET sealed_on = ? WHERE id = ?', sealedOn, sent.id);
  if (s.blob_hash) {
    run('INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, name, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      target, sent.id, s.author_id, s.blob_hash, s.kind === 'voice' ? 'audio' : s.kind, s.mime, one('SELECT size FROM blobs WHERE hash = ?', s.blob_hash)?.size ?? 0, s.name, s.duration_ms);
  }
  // Kept in the family archive for good: an entry nobody can remove (see DELETE /api/archive/:eid).
  if (!s.recipient_id) {
    const author = one('SELECT name FROM users WHERE id = ?', s.author_id)?.name ?? '';
    const what = s.kind === 'voice' ? '🎙 رسالة صوتية' : s.kind === 'video' ? '🎥 رسالة مصوّرة' : s.kind === 'image' ? '📷 صورة' : '';
    const title = s.occasion ? `${s.occasion}: رسالة مختومة من ${author}` : `رسالة مختومة من ${author}`;
    run("INSERT INTO archive_entries (circle_id, message_id, title, summary, category, event_date, source, protected) VALUES (?, ?, ?, ?, 'family_news', date('now'), 'auto', 1)",
      target, sent.id, title, `${what}${what && s.body ? ' — ' : ''}${String(s.body).slice(0, 600)} (خُتمت بتاريخ ${sealedOn})`.trim());
  }
  announce(target, sent.id);
  if (s.yearly && s.trigger === 'date') {
    const next = new Date(Date.parse(`${String(s.unlock_at).replace(' ', 'T')}Z`)); next.setUTCFullYear(next.getUTCFullYear() + 1);
    run("UPDATE sealed_messages SET unlock_at = ?, released_at = datetime('now') WHERE id = ?", sqlUtc(next.getTime()), s.id);
  } else run("UPDATE sealed_messages SET status = 'released', released_at = datetime('now'), body = '' WHERE id = ?", s.id);
  return true;
}
/** Make the death official in the family record (which also stops yearly letters addressed to that person). */
function recordDeath(circleId: number, userId: number) {
  const p = one('SELECT id, death_date FROM persons WHERE circle_id = ? AND user_id = ?', circleId, userId);
  if (p && !p.death_date) run("UPDATE persons SET death_date = date('now') WHERE id = ?", p.id);
}
/**
 * Open every envelope whose time has come: dated ones, and death ones whose waiting period ended. Returns how many opened.
 * A death letter is only opened if the confirmations are still standing (they are wiped by a veto).
 */
export async function releaseDueSealed(now = Date.now()): Promise<number> {
  const due = all(
    `SELECT * FROM sealed_messages WHERE (status = 'sealed' AND trigger = 'date' AND unlock_at <= ?) OR (status = 'waiting' AND release_at <= ?) ORDER BY COALESCE(unlock_at, release_at), id LIMIT 200`, sqlUtc(now), sqlUtc(now));
  let n = 0; const dead = new Set<string>();
  for (const s of due) {
    try {
      if (s.trigger === 'date' && s.recipient_id && s.yearly && recipientDeceased(s.circle_id, s.recipient_id)) { run("UPDATE sealed_messages SET status = 'stopped', note = 'recipient_deceased' WHERE id = ?", s.id); continue; }
      if (await releaseOne(s)) n++;
      if (s.trigger === 'death') dead.add(`${s.circle_id}:${s.author_id}`);
    } catch (e) { console.error('[sealed]', e); }
  }
  for (const k of dead) {
    const [circleId, userId] = k.split(':').map(Number);
    recordDeath(circleId, userId);
    run("DELETE FROM sealed_evidence WHERE scope = 'death' AND ref_id = ? AND circle_id = ?", userId, circleId);
    const who = one('SELECT name FROM users WHERE id = ?', userId)?.name ?? '';
    systemMessage(circleId, 'deathOpened', { who });
  }
  return n;
}
const sealedJob = trackJob('sealed.release', 30_000, releaseDueSealed);
sealedJob();
setInterval(sealedJob, 30_000).unref();
const EVIDENCE_WINDOW_DAYS = 30;
   // the messages that count must be recent, so unrelated mentions over the years never add up

/**
 * The agent's reading of the circle for sealed letters. A message that says the author died (or that the occasion happened) is kept as
 * evidence. When there are MORE THAN THREE such messages from at least three members (two if exactly three other members remain),
 * within the last 30 days, the letters start their three-day waiting period. If the agent never concludes, nothing ever opens; if it
 * concludes months or years later, it opens then.
 */
export function collectSealedEvidence(circleId: number, messageId: number, userId: number, text: string) {
  const circle = one('SELECT kind, agent_active FROM circles WHERE id = ?', circleId);
  if (!circle || circle.kind !== 'circle' || !circle.agent_active || !flag('agent_enabled')) return;   // the agent must be on in this circle (its disclosure was accepted)
  if (one('SELECT sealed_on FROM messages WHERE id = ?', messageId)?.sealed_on) return;
  const touched: Array<['death' | 'event', number]> = [];
  // someone dying: every author with letters waiting "after death" in this circle (except the writer of this message: the dead do not confirm)
  for (const { author_id } of all("SELECT DISTINCT author_id FROM sealed_messages WHERE circle_id = ? AND trigger = 'death' AND status = 'sealed' AND recipient_id IS NULL", circleId)) {
    if (author_id === userId) continue;
    const names = [one('SELECT name FROM users WHERE id = ?', author_id)?.name, ...all('SELECT name FROM persons WHERE circle_id = ? AND user_id = ?', circleId, author_id).map(p => p.name)].filter(Boolean) as string[];
    if (mentionsDeath(text, names)) { run("INSERT OR IGNORE INTO sealed_evidence (scope, ref_id, circle_id, message_id, member_id) VALUES ('death', ?, ?, ?, ?)", author_id, circleId, messageId, userId); touched.push(['death', author_id]); }
  }
  for (const s of all("SELECT id, author_id, occasion FROM sealed_messages WHERE circle_id = ? AND trigger = 'event' AND status = 'sealed' AND recipient_id IS NULL AND occasion IS NOT NULL", circleId)) {
    if (s.author_id === userId) continue;
    if (mentionsOccurrence(text, s.occasion)) { run("INSERT OR IGNORE INTO sealed_evidence (scope, ref_id, circle_id, message_id, member_id) VALUES ('event', ?, ?, ?, ?)", s.id, circleId, messageId, userId); touched.push(['event', s.id]); }
  }
  for (const [scope, ref] of touched) evaluateSealedEvidence(circleId, scope, ref);
}
/** How much evidence stands for this person's death / this occasion, and what the rules require for this circle. */
export function evidenceFor(circleId: number, scope: 'death' | 'event', ref: number) {
  const subject = scope === 'death' ? ref : (one('SELECT author_id FROM sealed_messages WHERE id = ?', ref)?.author_id as number | undefined) ?? 0;
  const rows = all(
    `SELECT e.member_id FROM sealed_evidence e JOIN messages m ON m.id = e.message_id
      WHERE e.scope = ? AND e.ref_id = ? AND e.circle_id = ? AND m.deleted_at IS NULL AND m.created_at >= datetime('now', '-${EVIDENCE_WINDOW_DAYS} days') AND e.member_id != ?`, scope, ref, circleId, subject);
  const others = one('SELECT COUNT(*) AS n FROM circle_members WHERE circle_id = ? AND user_id != ?', circleId, subject)!.n as number;
  return { messages: rows.length, members: new Set(rows.map(r => r.member_id)).size, needMessages: MIN_MESSAGES, needMembers: requiredMembers(others) };
}
function evaluateSealedEvidence(circleId: number, scope: 'death' | 'event', ref: number) {
  const ev = evidenceFor(circleId, scope, ref);
  if (ev.messages < ev.needMessages || ev.members < ev.needMembers) return;
  const hours = Math.max(0, Math.floor(DEATH_WAIT_HOURS));
  const r = scope === 'death'
    ? run(`UPDATE sealed_messages SET status = 'waiting', release_at = datetime('now', '+${hours} hours') WHERE circle_id = ? AND author_id = ? AND trigger = 'death' AND status = 'sealed' AND recipient_id IS NULL`, circleId, ref)
    : run(`UPDATE sealed_messages SET status = 'waiting', release_at = datetime('now', '+${hours} hours') WHERE id = ? AND status = 'sealed'`, ref);
  if (!Number(r.changes)) return;
  const wait = hours % 24 === 0 ? { n: hours / 24, u: 'd' } : { n: hours, u: 'h' };
  if (scope === 'death') {
    const who = one('SELECT name FROM users WHERE id = ?', ref)?.name ?? '';
    systemMessage(circleId, 'deathAgent', { who, ...wait });
  } else {
    const s = one('SELECT occasion, author_id FROM sealed_messages WHERE id = ?', ref)!;
    const who = one('SELECT name FROM users WHERE id = ?', s.author_id)?.name ?? '';
    systemMessage(circleId, 'eventAgent', { who, occasion: s.occasion, ...wait });
  }
}
/** Is this person marked as deceased in the family record of the circle? Then a recurring message to them stops (we freeze, never guess). */
function recipientDeceased(circleId: number, userId: number) {
  return !!one('SELECT 1 FROM persons WHERE circle_id = ? AND user_id = ? AND death_date IS NOT NULL AND death_date != \'\'', circleId, userId);
}
