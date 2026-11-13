import { flag } from './ops.ts';
import { excerpt } from '../../core/excerpt.ts';
import { assess, normalize, type Sensitivity } from '../../core/agent.ts';
import { all, one, run } from '../db.ts';
import { gate } from '../../core/gate.ts';
import { isReadOnly } from '../billing.ts';
import { today } from '../app.ts';

// ---- messages -----------------------------------------------------------------

export const MSG_COLS = `m.id, m.seq, m.rev, m.user_id AS userId, u.name AS author, m.kind, m.body, m.transcript,
  m.audio_path IS NOT NULL AS hasAudio, m.archive_status AS archiveStatus, m.score, m.category, m.reason, m.created_at AS createdAt,
  m.deleted_at IS NOT NULL AS deleted, m.deleted_by AS deletedBy, m.reply_to AS replyToId, m.edited_at AS editedAt, m.forward_count AS forwardCount, m.sealed_on AS sealedOn`;
export function analyze(circleId: number, messageId: number, text: string, manual = false) {
  const circle = one('SELECT sensitivity, agent_active FROM circles WHERE id = ?', circleId)!;
  if (!circle.agent_active || !flag('agent_enabled') || isReadOnly(circleId)) return;
  const msg = one('SELECT m.*, u.name AS author FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?', messageId)!;

  // AI gate: only messages with a usable signal go further. A manual request skips the gate
  // (the engine's absolute floor still applies). Gated-out messages stay ordinary chat.
  if (!manual) {
    const recent = all(
      "SELECT COALESCE(NULLIF(body, ''), transcript) AS t FROM messages WHERE circle_id = ? AND kind != 'system' AND id < ? ORDER BY id DESC LIMIT 30",
      circleId, messageId).map(row => normalize(String(row.t ?? '')));
    const g = gate(text, { recent });
    if (!g.pass || !g.routes.includes('archive')) {
      run("UPDATE messages SET archive_status = 'none', score = NULL, category = NULL, reason = ? WHERE id = ?", `gate:${g.reason}`, messageId);
      return;
    }
  }

  const r = assess(text, circle.sensitivity as Sensitivity, manual);
  run('UPDATE messages SET archive_status = ?, score = ?, category = ?, reason = ? WHERE id = ?',
    r.verdict, r.score, r.category, r.reason, messageId);
  const existing = one('SELECT id FROM archive_entries WHERE message_id = ? AND deleted_at IS NULL', messageId);
  if (r.verdict === 'archived' && !existing) {
    const title = excerpt(text, 60);
    run('INSERT INTO archive_entries (circle_id, message_id, title, summary, category, event_date, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      circleId, messageId, title, `${msg.author}: ${excerpt(text, 400)}`, r.category, String(msg.created_at).slice(0, 10) || today(), manual ? 'manual' : 'auto');
  }
}
