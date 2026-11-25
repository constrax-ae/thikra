import { UNOPENED_DAYS } from '../lib/viewonce.ts';
import { bodyLimit } from 'hono/body-limit';
import { app } from '../app.ts';
import { all, one, run } from '../db.ts';
import { announceUpdate, circleAccess, isManager, limited, membership, systemMessage, circleChanged, tx } from '../lib/helpers.ts';
import { bumpRev } from '../lib/polls.ts';
import { directChat } from '../lib/circles.ts';
import { e2eeEnabled } from '../lib/e2ee.ts';
import { AUDIO_MIME, MAX_AUDIO, isFile } from '../lib/moments.ts';
import { transcriber } from '../lib/transcribe.ts';

// ---- 18. disappearing messages ---------------------------------------------------------------------
// A per-chat timer. It only decides when a NEW message goes (messages.expires_at, set when it is stored); the job in index.ts erases due messages.
export const TIMERS = [86400, 604800, 7776000];
app.put('/api/circles/:id/disappearing', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const chat = one('SELECT kind, disappear_seconds AS secs FROM circles WHERE id = ?', a.circleId)!;
  // The family circle keeps what the family wrote (the Memory); the timer is for private chats and ordinary groups.
  if (chat.kind === 'circle') return c.json({ error: 'not_in_circle' }, 409);
  // A private chat belongs to both people; in a group only the owner and admins decide.
  if (chat.kind !== 'direct' && !isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  const seconds = b.seconds === null || b.seconds === 0 ? null : TIMERS.includes(b.seconds) ? b.seconds as number : undefined;
  if (seconds === undefined) return c.json({ error: 'invalid_value' }, 400);
  if (seconds === (chat.secs ?? null)) return c.json({ ok: true });
  run('UPDATE circles SET disappear_seconds = ? WHERE id = ?', seconds, a.circleId);
  systemMessage(a.circleId, seconds ? 'disappearOn' : 'disappearOff', seconds ? { name: a.user.name, secs: seconds } : { name: a.user.name });
  circleChanged(a.circleId);
  return c.json({ ok: true });
});

// ---- 19. view once ---------------------------------------------------------------------------------
// The first call by a recipient opens it for them; the file is then served for a couple of minutes (lib/viewonce.ts). A second call is refused.
app.post('/api/messages/:mid/open', c => {
  const user = c.get('user');
  const m = one('SELECT id, circle_id, user_id, view_once, deleted_at FROM messages WHERE id = ?', Number(c.req.param('mid')));
  if (!m || !membership(m.circle_id, user.id) || !m.view_once || m.deleted_at) return c.json({ error: 'not_found' }, 404);
  if (m.user_id === user.id) return c.json({ error: 'view_once_closed' }, 403);
  // PRIV-04: nobody claimed it within the fortnight, so there is nothing left to claim.
  if (one(`SELECT 1 FROM messages WHERE id = ? AND created_at < datetime('now', '-${UNOPENED_DAYS} days')`, m.id)) return c.json({ error: 'view_once_gone' }, 410);
  if (!one('SELECT 1 FROM media WHERE message_id = ?', m.id)) return c.json({ error: 'already_opened' }, 410);   // the file is already gone
  const added = Number(run('INSERT OR IGNORE INTO view_once_opens (message_id, user_id) VALUES (?, ?)', m.id, user.id).changes) > 0;
  if (!added) return c.json({ error: 'already_opened' }, 410);
  bumpRev(m.id); announceUpdate(m.circle_id, m.id);   // the sender sees who has opened it
  return c.json({ ok: true });
});

// ---- 21. broadcast lists ---------------------------------------------------------------------------
// A person's own list of people. The server stores only who is on it. Sending is done by the sender's device, one ordinary private message
// into each person's own chat (so retries, blocks, "only admins send" and later encryption all behave as for any message).
const MAX_LISTS = 30, MAX_PEOPLE = 100;
/** Only people you already share a chat with can be on a list (a list must not be a way to probe user ids). */
const reachable = (me: number, ids: number[]) => ids.filter(id => id !== me && one(
  `SELECT 1 FROM circle_members a JOIN circle_members o ON o.circle_id = a.circle_id JOIN circles ci ON ci.id = a.circle_id
    WHERE a.user_id = ? AND o.user_id = ? AND ci.kind != 'direct' AND ci.deleted_at IS NULL LIMIT 1`, me, id));
const cleanMembers = (me: number, raw: unknown): number[] | null => {
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.map(Number))];
  if (!ids.length || ids.length > MAX_PEOPLE || ids.some(i => !Number.isInteger(i))) return null;
  return reachable(me, ids).length === ids.length ? ids : null;
};
const listOf = (id: number, me: number) => one('SELECT id, name FROM broadcast_lists WHERE id = ? AND owner_id = ?', id, me);
const membersOf = (id: number) => all('SELECT u.id, u.name FROM broadcast_members b JOIN users u ON u.id = b.user_id WHERE b.list_id = ? ORDER BY u.name', id);
app.get('/api/broadcast-lists', c => c.json(all(
  'SELECT l.id, l.name, (SELECT COUNT(*) FROM broadcast_members b WHERE b.list_id = l.id) AS count FROM broadcast_lists l WHERE l.owner_id = ? ORDER BY l.id', c.get('user').id)));
app.post('/api/broadcast-lists', async c => {
  const me = c.get('user').id;
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? '').trim().slice(0, 60);
  const members = cleanMembers(me, b.members);
  if (!name || !members) return c.json({ error: 'invalid_value' }, 400);
  if (one('SELECT COUNT(*) AS n FROM broadcast_lists WHERE owner_id = ?', me)!.n as number >= MAX_LISTS) return c.json({ error: 'too_many_lists' }, 409);
  const id = tx(() => {
    const id = Number(run('INSERT INTO broadcast_lists (owner_id, name) VALUES (?, ?)', me, name).lastInsertRowid);
    for (const u of members) run('INSERT INTO broadcast_members (list_id, user_id) VALUES (?, ?)', id, u);
    return id;
  });
  return c.json({ id }, 201);
});
app.get('/api/broadcast-lists/:id', c => {
  const l = listOf(Number(c.req.param('id')), c.get('user').id);
  return l ? c.json({ ...l, members: membersOf(l.id as number) }) : c.json({ error: 'not_found' }, 404);
});
app.patch('/api/broadcast-lists/:id', async c => {
  const me = c.get('user').id;
  const l = listOf(Number(c.req.param('id')), me);
  if (!l) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const name = b.name === undefined ? l.name : String(b.name).trim().slice(0, 60);
  const members = b.members === undefined ? null : cleanMembers(me, b.members);
  if (!name || (b.members !== undefined && !members)) return c.json({ error: 'invalid_value' }, 400);
  tx(() => {
    run('UPDATE broadcast_lists SET name = ? WHERE id = ?', name, l.id);
    if (members) { run('DELETE FROM broadcast_members WHERE list_id = ?', l.id); for (const u of members) run('INSERT INTO broadcast_members (list_id, user_id) VALUES (?, ?)', l.id, u); }
  });
  return c.json({ ok: true });
});
app.delete('/api/broadcast-lists/:id', c => {
  const l = listOf(Number(c.req.param('id')), c.get('user').id);
  if (!l) return c.json({ error: 'not_found' }, 404);
  run('DELETE FROM broadcast_lists WHERE id = ?', l.id);   // messages already sent stay where they are: they are ordinary private messages
  return c.json({ ok: true });
});
// The private chat of each person on the list (made if it does not exist yet). Someone who blocked you, or whom you blocked, is simply left out:
// the answer carries no count and no mark, so a block is not revealed.
app.post('/api/broadcast-lists/:id/chats', async c => {
  const me = c.get('user').id;
  const l = listOf(Number(c.req.param('id')), me);
  if (!l) return c.json({ error: 'not_found' }, 404);
  if (await limited(`bcast:${me}`, 30, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  // `encrypted: true`: the private chat of each person is their END-TO-END ENCRYPTED one (the existing one, or made now), and the device sends into it encrypted.
  // It is refused, not silently made plain, when this server has encryption off: a sender who asked for private must never get readable chats.
  const body = await c.req.json().catch(() => ({}));
  const encrypted = body?.encrypted === true;
  if (encrypted && !e2eeEnabled()) return c.json({ error: 'e2ee_unavailable' }, 409);
  const chats = membersOf(l.id as number)
    .filter(m => reachable(me, [m.id as number]).length === 1)   // someone you no longer share a group with is left out
    .filter(m => !one('SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)', me, m.id, m.id, me))
    .map(m => ({ userId: m.id as number, circleId: directChat(me, m.id as number, encrypted).id, encrypted }));
  return c.json({ chats });
});

// ---- 23. voice-to-text ----------------------------------------------------------------------------
app.get('/api/transcribe', c => c.json({ configured: !!transcriber() }));
app.post('/api/transcribe', bodyLimit({ maxSize: MAX_AUDIO + 64 * 1024, onError: c => c.json({ error: 'invalid_audio' }, 413) }), async c => {
  const t = transcriber();
  if (!t) return c.json({ error: 'transcribe_off' }, 503);
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.audio;
  const mime = isFile(file) ? file.type.split(';')[0].trim().toLowerCase() : '';
  if (!isFile(file) || file.size === 0 || file.size > MAX_AUDIO || !AUDIO_MIME.has(mime)) return c.json({ error: 'invalid_audio' }, 400);
  // The provider costs money and sees the audio: a few a day per person.
  if (await limited(`transcribe:${c.get('user').id}`, 10, 24 * 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const lang = typeof form?.lang === 'string' ? form.lang.slice(0, 3).toLowerCase() : undefined;
  try { return c.json({ text: await t.transcribe(Buffer.from(await file.arrayBuffer()), mime, lang) }); }
  catch (e) { console.error('[transcribe]', e instanceof Error ? e.message : e); return c.json({ error: 'transcribe_failed' }, 502); }
});
