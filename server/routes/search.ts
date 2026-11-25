import { MSG_COLS } from '../lib/messages.ts';
import { all, one } from '../db.ts';
import { app } from '../app.ts';
import { circleAccess, decorate } from '../lib/helpers.ts';
import { floorSeq } from '../lib/moments.ts';
import { normalize } from '../../core/agent.ts';
import { observe } from '../metrics.ts';
import { isEncrypted } from '../lib/e2ee.ts';

// ---- search ---------------------------------------------------------------------------------

// Search inside one circle, newest first. Arabic-aware (diacritics, alef/ya/ta-marbuta/hamza variants, Arabic-Indic digits),
// case-insensitive for Latin, hides what you deleted for yourself, never returns deleted messages.
app.get('/api/circles/:id/search', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (isEncrypted(a.circleId)) return c.json({ error: 'encrypted_chat' }, 409);   // the server cannot read it: the device searches its own history
  const q = normalize(String(c.req.query('q') ?? '')).slice(0, 100);
  if (q.length < 2) return c.json([]);
  const like = `%${q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
  const f = facetsOf(c);
  const t = performance.now();
  const rows = all(
    `SELECT ${MSG_COLS} FROM messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.circle_id = ? AND m.search_text LIKE ? ESCAPE '\\' AND m.deleted_at IS NULL AND m.kind != 'system' AND m.seq > ?
         AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?) ${f.sql}
       ORDER BY m.seq DESC LIMIT 50`, a.circleId, like, floorSeq(a.circleId, a.user.id), a.user.id, ...f.args);
  observe('search_ms', performance.now() - t);
  return c.json(decorate(a.circleId, rows));
});

// ---- across every chat -------------------------------------------------------------------------
// The same search, and your starred messages, over all your conversations at once: what WhatsApp's search box does.
// Three deliberate exclusions, the same for both:
//  - an ENCRYPTED chat: the server holds only ciphertext, so it cannot search or list it. Its own screen does that
//    on the device. Saying "no results" for it would be a lie, so the answer says which chats were left out.
//  - a LOCKED chat: it is kept out of the list and the filters for a reason; a search must not leak it back.
//  - a chat that is still a message request, and anything deleted, hidden for you, or already gone (disappearing).
const ACROSS = `m.id, m.seq, m.kind, m.body, m.transcript, m.created_at AS createdAt, m.user_id AS userId, u.name AS author,
  m.audio_path IS NOT NULL AS hasAudio, c.id AS circleId, c.kind AS circleKind,
  CASE WHEN c.kind = 'direct' THEN (SELECT o.name FROM circle_members om JOIN users o ON o.id = om.user_id WHERE om.circle_id = c.id AND om.user_id != cm.user_id) ELSE c.name END AS circleName,
  (SELECT a.kind FROM media a WHERE a.message_id = m.id AND a.kind IN ('image','video','file') ORDER BY a.id LIMIT 1) AS attachment`;
const FROM_ACROSS = `FROM messages m
  JOIN circles c ON c.id = m.circle_id AND c.deleted_at IS NULL AND c.encrypted = 0
  JOIN circle_members cm ON cm.circle_id = c.id AND cm.user_id = ? AND cm.request = 0
  LEFT JOIN chat_prefs p ON p.circle_id = c.id AND p.user_id = cm.user_id
  LEFT JOIN users u ON u.id = m.user_id
 WHERE m.deleted_at IS NULL AND m.expired_at IS NULL AND m.kind != 'system' AND m.view_once = 0 AND COALESCE(p.locked, 0) = 0
   AND m.seq > MAX(COALESCE(p.clear_through, 0), CASE WHEN c.history_policy = 'since_join' THEN COALESCE(cm.joined_seq, 0) ELSE 0 END)
   AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = cm.user_id)`;

/** How many of this person's chats this answer could not look inside, so the screen can say so instead of implying "nothing". */
const skippedChats = (userId: number) => one(
  `SELECT COUNT(*) AS n FROM circle_members cm JOIN circles c ON c.id = cm.circle_id AND c.deleted_at IS NULL
     LEFT JOIN chat_prefs p ON p.circle_id = c.id AND p.user_id = cm.user_id
    WHERE cm.user_id = ? AND cm.request = 0 AND (c.encrypted = 1 OR COALESCE(p.locked, 0) = 1)`, userId)!.n as number;


/**
 * CHAT-02 facets: narrow a search to a kind of thing, and to when it was said.
 *  kind = text | photo | video | file | voice | link   (anything else is ignored rather than refused)
 *  from / to = YYYY-MM-DD, inclusive, read as whole days.
 * They are SQL fragments, not interpolated values: the dates go in as parameters.
 */
function facetsOf(c: { req: { query(name: string): string | undefined } }): { sql: string; args: unknown[] } {
  const kind = c.req.query('kind') ?? '';
  const parts: string[] = [];
  const args: unknown[] = [];
  const hasMedia = (k: string) => `EXISTS (SELECT 1 FROM media a WHERE a.message_id = m.id AND a.kind = '${k}')`;
  if (kind === 'photo') parts.push(`AND ${hasMedia('image')}`);
  else if (kind === 'video') parts.push(`AND ${hasMedia('video')}`);
  else if (kind === 'file') parts.push(`AND ${hasMedia('file')}`);
  else if (kind === 'voice') parts.push("AND m.kind = 'voice'");
  else if (kind === 'link') parts.push("AND EXISTS (SELECT 1 FROM message_cards k WHERE k.message_id = m.id AND k.type = 'link')");
  else if (kind === 'text') parts.push("AND m.kind = 'text' AND NOT EXISTS (SELECT 1 FROM media a WHERE a.message_id = m.id)");
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = c.req.query('from') ?? '', to = c.req.query('to') ?? '';
  if (day.test(from)) { parts.push('AND m.created_at >= ?'); args.push(`${from} 00:00:00`); }
  if (day.test(to)) { parts.push('AND m.created_at <= ?'); args.push(`${to} 23:59:59`); }
  return { sql: parts.join(' '), args };
}

app.get('/api/search', c => {
  const u = c.get('user');
  const q = normalize(String(c.req.query('q') ?? '')).slice(0, 100);
  if (q.length < 2) return c.json({ results: [], skipped: 0 });
  const like = `%${q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
  const t = performance.now();
  const f = facetsOf(c);
  const results = all(`SELECT ${ACROSS} ${FROM_ACROSS} AND m.search_text LIKE ? ESCAPE '\\' ${f.sql} ORDER BY m.created_at DESC, m.id DESC LIMIT 50`, u.id, like, ...f.args);
  observe('search_ms', performance.now() - t);
  return c.json({ results, skipped: skippedChats(u.id) });
});

/** Everything you have starred, newest first, wherever you starred it. */
app.get('/api/starred', c => {
  const u = c.get('user');
  const results = all(
    `SELECT ${ACROSS} ${FROM_ACROSS} AND EXISTS (SELECT 1 FROM stars s WHERE s.message_id = m.id AND s.user_id = cm.user_id)
      ORDER BY m.created_at DESC, m.id DESC LIMIT 200`, u.id);
  return c.json({ results, skipped: skippedChats(u.id) });
});
