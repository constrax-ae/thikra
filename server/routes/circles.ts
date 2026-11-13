import { MAX_PINNED, RESTORE_DAYS, directChat } from '../lib/circles.ts';
import { REGION, app } from '../app.ts';
import { all, one, run, type Row } from '../db.ts';
import { circleAccess, ensurePerson, isFrozen, isManager, limited, membership, normPhone, systemMessage, tx } from '../lib/helpers.ts';
import { randomBytes } from 'node:crypto';
import { toMs } from '../lib/deletes.ts';

 // like WhatsApp

/** The chat list: one row per conversation with what the list needs to draw it (preview, time, unread, your own pin/mute/…). */
app.get('/api/circles', c => {
  const u = c.get('user');
  const rows = all(
    `SELECT c.id, c.kind, CASE WHEN c.kind = 'direct' THEN (SELECT u.name FROM circle_members o JOIN users u ON u.id = o.user_id WHERE o.circle_id = c.id AND o.user_id != cm.user_id) ELSE c.name END AS name,
       c.sensitivity, c.agent_active AS agentActive, cm.role, c.created_at AS createdAt,
       (SELECT COUNT(*) FROM circle_members WHERE circle_id = c.id) AS members,
       (SELECT id FROM messages WHERE circle_id = c.id AND kind != 'system' ORDER BY id DESC LIMIT 1) AS lastId,
       (SELECT COUNT(*) FROM messages m WHERE m.circle_id = c.id AND m.seq > cm.read_seq AND m.kind != 'system' AND m.deleted_at IS NULL
          AND (m.user_id IS NULL OR m.user_id != cm.user_id)) AS unread,
       p.pinned_at AS pinnedAt, CASE WHEN p.muted = 1 AND (p.muted_until IS NULL OR p.muted_until > datetime('now')) THEN 1 ELSE 0 END AS muted, p.muted_until AS mutedUntil, COALESCE(p.archived, 0) AS archived,
       COALESCE(p.favourite, 0) AS favourite, COALESCE(p.marked_unread, 0) AS markedUnread
     FROM circles c JOIN circle_members cm ON cm.circle_id = c.id AND cm.user_id = ? AND c.deleted_at IS NULL
     LEFT JOIN chat_prefs p ON p.circle_id = c.id AND p.user_id = cm.user_id`, u.id);
  const out: Row[] = rows.map(r => {
    const m = r.lastId ? one(
      `SELECT m.body, m.transcript, m.kind, m.user_id, m.created_at, m.deleted_at IS NOT NULL AS deleted, us.name AS author,
              (SELECT a.kind FROM media a WHERE a.message_id = m.id AND a.kind IN ('image','video','file') ORDER BY a.id LIMIT 1) AS attachment
         FROM messages m LEFT JOIN users us ON us.id = m.user_id WHERE m.id = ?`, r.lastId) : undefined;
    const lastKind = !m ? null : m.deleted ? 'deleted' : m.attachment ?? (m.kind === 'voice' ? 'voice' : 'text');
    const { lastId, ...rest } = r;
    return {
      ...rest, pinned: !!r.pinnedAt, muted: !!r.muted, archived: !!r.archived, favourite: !!r.favourite, markedUnread: !!r.markedUnread,
      lastMessage: m && !m.deleted ? (m.body || m.transcript || null) : null,   // kept for older clients
      lastKind, lastText: m && !m.deleted ? (m.body || m.transcript || '') : '', lastAt: m?.created_at ?? r.createdAt,
      lastAuthor: m?.user_id && m.user_id !== u.id ? m.author : null, lastFromMe: !!m && m.user_id === u.id,
    };
  });
  // Pinned first (in the order pinned), then by latest activity.
  out.sort((x, y) => (x.pinned === y.pinned ? 0 : x.pinned ? -1 : 1) || (x.pinned && y.pinned ? String(x.pinnedAt).localeCompare(String(y.pinnedAt)) : 0)
    || String(y.lastAt).localeCompare(String(x.lastAt)) || y.id - x.id);
  return c.json(out);
});
// Your own settings for one chat. Any subset of fields; nothing here is visible to anyone else.
app.patch('/api/circles/:id/prefs', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  run('INSERT OR IGNORE INTO chat_prefs (user_id, circle_id) VALUES (?, ?)', a.user.id, a.circleId);
  const flag = (k: string) => typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : null;
  if (typeof b.pinned === 'boolean') {
    if (b.pinned) {
      const n = one('SELECT COUNT(*) AS n FROM chat_prefs WHERE user_id = ? AND pinned_at IS NOT NULL AND circle_id != ?', a.user.id, a.circleId)!.n as number;
      if (n >= MAX_PINNED) return c.json({ error: 'too_many_pinned' }, 409);
      run("UPDATE chat_prefs SET pinned_at = COALESCE(pinned_at, datetime('now')) WHERE user_id = ? AND circle_id = ?", a.user.id, a.circleId);
    } else run('UPDATE chat_prefs SET pinned_at = NULL WHERE user_id = ? AND circle_id = ?', a.user.id, a.circleId);
  }
  if (typeof b.muted === 'boolean') {
    // Mute for 8 hours, a week, or always (like WhatsApp). Unmuting clears it.
    const hours = b.muted && Number.isFinite(b.muteHours) && b.muteHours > 0 && b.muteHours <= 24 * 365 ? Math.floor(b.muteHours) : null;
    run(`UPDATE chat_prefs SET muted = ?, muted_until = ${hours ? `datetime('now', '+${hours} hours')` : 'NULL'} WHERE user_id = ? AND circle_id = ?`, b.muted ? 1 : 0, a.user.id, a.circleId);
  }
  for (const [key, col] of [['archived', 'archived'], ['favourite', 'favourite'], ['markedUnread', 'marked_unread']] as const) {
    const v = flag(key);
    if (v !== null) run(`UPDATE chat_prefs SET ${col} = ? WHERE user_id = ? AND circle_id = ?`, v, a.user.id, a.circleId);
  }
  return c.json({ ok: true });
});
app.post('/api/circles', async c => {
  const u = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? '').trim().slice(0, 60);
  if (!name) return c.json({ error: 'name_required' }, 400);
  const code = randomBytes(5).toString('hex');
  // A "circle" is the family space with the memory agent; a plain "group" is an ordinary group chat (no agent, no archive)
  // that can be turned into a circle later without losing a single message.
  const kind = b.kind === 'group' ? 'group' : 'circle';
  const r = run('INSERT INTO circles (name, owner_id, invite_code, kind, region) VALUES (?, ?, ?, ?, ?)', name, u.id, code, kind, REGION);
  const id = Number(r.lastInsertRowid);
  run("INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, 'owner')", id, u.id);
  ensurePerson(id, u);
  return c.json({ id }, 201);
});
// A one-to-one chat with a registered person, found by phone number. One per pair: asking again returns the same chat.
// (Like WhatsApp, this tells you whether a number is registered; it is rate-limited, and a client may later restrict it to contacts.)
app.post('/api/direct', async c => {
  const u = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  if (await limited(`direct:${u.id}`, 20, 10 * 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  let other: Row | undefined;
  if (b.userId !== undefined) {
    // From a member list: allowed only for someone who shares a circle or group with you (no phone number is exposed or needed).
    const uid = Number(b.userId);
    const shared = Number.isInteger(uid) && one(`SELECT 1 FROM circle_members a JOIN circle_members o ON o.circle_id = a.circle_id
      JOIN circles ci ON ci.id = a.circle_id WHERE a.user_id = ? AND o.user_id = ? AND ci.kind != 'direct' AND ci.deleted_at IS NULL LIMIT 1`, u.id, uid);
    other = shared ? one('SELECT id, name FROM users WHERE id = ?', uid) : undefined;
  } else {
    const phone = normPhone(String(b.phone ?? ''));
    if (!phone) return c.json({ error: 'invalid_phone' }, 400);
    other = one('SELECT id, name FROM users WHERE phone = ?', phone);
  }
  if (!other) return c.json({ error: 'user_not_found' }, 404);
  if (other.id === u.id) return c.json({ error: 'invalid_phone' }, 400);
  const chat = directChat(u.id, other.id);
  return c.json({ id: chat.id }, chat.created ? 201 : 200);
});
// Turn a plain group into a circle (the family space with the agent). Same chat, same messages, nothing is copied or lost.
app.post('/api/circles/:id/convert', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (a.role !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const k = one('SELECT kind FROM circles WHERE id = ?', a.circleId)!.kind;
  if (k !== 'group') return c.json({ error: 'not_a_group' }, 409);
  run("UPDATE circles SET kind = 'circle' WHERE id = ?", a.circleId);
  systemMessage(a.circleId, 'groupToCircle', { name: a.user.name });
  return c.json({ ok: true });
});
app.post('/api/circles/join', async c => {
  const u = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  if (await limited(`join:${u.id}`, 20, 10 * 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const circle = one('SELECT id, name FROM circles WHERE invite_code = ? AND invite_enabled = 1 AND deleted_at IS NULL', String(b.code ?? '').trim());
  if (!circle) return c.json({ error: 'invalid_invite' }, 404);
  if (isFrozen(circle.id)) return c.json({ error: 'circle_frozen' }, 423);
  if (!membership(circle.id, u.id)) {
    run("INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, 'member')", circle.id, u.id);
    ensurePerson(circle.id, u);
    systemMessage(circle.id, 'joined', { name: u.name });
  }
  return c.json({ id: circle.id });
});
app.get('/api/circles/:id', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const circle = one(
    `SELECT id, kind, CASE WHEN kind = 'direct' THEN (SELECT u.name FROM circle_members o JOIN users u ON u.id = o.user_id WHERE o.circle_id = circles.id AND o.user_id != ?) ELSE name END AS name, sensitivity, agent_active AS agentActive, owner_id AS ownerId, invite_code AS inviteCode,
       invite_policy AS invitePolicy, invite_enabled AS inviteEnabled, created_at AS createdAt, story_title AS storyTitle FROM circles WHERE id = ?`, a.user.id, a.circleId)!;
  const pref = one(`SELECT CASE WHEN muted = 1 AND (muted_until IS NULL OR muted_until > datetime('now')) THEN 1 ELSE 0 END AS muted, muted_until AS mutedUntil, favourite FROM chat_prefs WHERE user_id = ? AND circle_id = ?`, a.user.id, a.circleId);
  // deliveredSeq / readSeq are each member's "up to here" marks, the basis of the ticks. As in WhatsApp, read marks are
  // reciprocal: you see another member's only if both of you have read receipts on (your own are always yours).
  const mine = a.user.read_receipts === 1;
  const members = all(
    `SELECT u.id, u.name, cm.role, cm.delivered_seq AS deliveredSeq, cm.read_seq AS readSeq, u.read_receipts AS shares, u.avatar_at AS avatarAt
       FROM circle_members cm JOIN users u ON u.id = cm.user_id WHERE cm.circle_id = ? ORDER BY cm.joined_at`, a.circleId)
    .map(({ shares, ...m }) => ({ ...m, readSeq: m.id === a.user.id || (mine && shares === 1) ? m.readSeq : null }));
  // The invite code is shown to managers, or to every member if the circle lets anyone invite. Never when invites are off.
  const sees = circle.inviteEnabled && (isManager(a.role) || circle.invitePolicy === 'members');
  return c.json({ ...circle, inviteEnabled: !!circle.inviteEnabled, inviteCode: sees ? circle.inviteCode : undefined, role: a.role, members, muted: !!pref?.muted, mutedUntil: pref?.muted ? pref.mutedUntil ?? null : null, favourite: !!pref?.favourite,
    lastSeq: one('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE circle_id = ?', a.circleId)!.m });
});
app.patch('/api/circles/:id', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  const cur = one('SELECT name, sensitivity, agent_active, invite_policy, invite_enabled, kind FROM circles WHERE id = ?', a.circleId)!;
  if (cur.kind === 'direct') return c.json({ error: 'forbidden' }, 403); // a one-to-one chat has nothing to configure
  const sensitivity = ['strict', 'medium', 'lenient'].includes(b.sensitivity) ? b.sensitivity : cur.sensitivity;
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : cur.name;
  // The memory agent exists only in circles; a plain group never gets it.
  const agent = cur.kind !== 'circle' ? 0 : typeof b.agentActive === 'boolean' ? (b.agentActive ? 1 : 0) : cur.agent_active;
  const invitePolicy = b.invitePolicy === 'admins' || b.invitePolicy === 'members' ? b.invitePolicy : cur.invite_policy;
  const inviteEnabled = typeof b.inviteEnabled === 'boolean' ? (b.inviteEnabled ? 1 : 0) : cur.invite_enabled;
  // What the family calls its story. Empty clears it (the book then uses its default title).
  const storyTitle = typeof b.storyTitle === 'string' ? b.storyTitle.trim().slice(0, 80) || null : (one('SELECT story_title FROM circles WHERE id = ?', a.circleId)!.story_title ?? null);
  run('UPDATE circles SET name = ?, sensitivity = ?, agent_active = ?, invite_policy = ?, invite_enabled = ?, story_title = ? WHERE id = ?',
    name, sensitivity, agent, invitePolicy, inviteEnabled, storyTitle, a.circleId);
  // Members must be told when the agent starts/stops reading new messages (report §3.2).
  if (agent !== cur.agent_active) {
    const noticeId = systemMessage(a.circleId, agent ? 'agentOn' : 'agentOff', { name: a.user.name });
    // Nothing from before this notice is ever analysed, however recent it is.
    if (agent) run('UPDATE circles SET agent_from_id = ? WHERE id = ?', noticeId, a.circleId);
  }
  return c.json({ ok: true });
});
 // owner's decision (2026-10-19)

// Deleting a circle is not instant erasure: the owner types the circle's name to confirm, the circle disappears for everyone,
// and it can be restored for 90 days. Only then is it erased for good (purgeDeletedCircles). A family's memory is not lost by one tap.
app.delete('/api/circles/:id', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (a.role !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  const circle = one('SELECT name FROM circles WHERE id = ?', a.circleId)!;
  if (String(b.confirm ?? '').trim() !== circle.name) return c.json({ error: 'confirm_mismatch' }, 400);
  run("UPDATE circles SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?", a.user.id, a.circleId);
  return c.json({ ok: true, restorableDays: RESTORE_DAYS });
});
// The owner's circles that are waiting to be erased, with the days left to restore them.
app.get('/api/me/deleted-circles', c => {
  const u = c.get('user');
  return c.json(all(
    `SELECT id, name, kind, deleted_at AS deletedAt FROM circles WHERE owner_id = ? AND deleted_at IS NOT NULL
      AND deleted_at > datetime('now', '-${RESTORE_DAYS} days') ORDER BY deleted_at DESC`, u.id)
    .map(r => ({ ...r, daysLeft: Math.max(0, Math.ceil(RESTORE_DAYS - (Date.now() - toMs(r.deletedAt)) / 86_400_000)) })));
});
app.post('/api/circles/:id/restore', c => {
  const u = c.get('user');
  const id = Number(c.req.param('id'));
  const r = run(`UPDATE circles SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL
                   AND deleted_at > datetime('now', '-${RESTORE_DAYS} days')`, id, u.id);
  return Number(r.changes) ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
});
app.delete('/api/circles/:id/members/:uid', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const uid = Number(c.req.param('uid'));
  const target = membership(a.circleId, uid);
  if (!target) return c.json({ error: 'not_found' }, 404);
  if (target.role === 'owner') return c.json({ error: 'owner_cannot_leave' }, 409);
  if (uid !== a.user.id) {
    if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
    if (target.role === 'admin' && a.role !== 'owner') return c.json({ error: 'forbidden' }, 403);
  }
  run('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?', a.circleId, uid);
  return c.json({ ok: true });
});
app.patch('/api/circles/:id/members/:uid', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (a.role !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  if (b.role !== 'admin' && b.role !== 'member') return c.json({ error: 'invalid_role' }, 400);
  const target = membership(a.circleId, Number(c.req.param('uid')));
  if (!target) return c.json({ error: 'not_found' }, 404);
  if (target.role === 'owner') return c.json({ error: 'owner_role_fixed' }, 409);
  run('UPDATE circle_members SET role = ? WHERE circle_id = ? AND user_id = ?', b.role, a.circleId, Number(c.req.param('uid')));
  return c.json({ ok: true });
});
// Handing the circle over: the new owner takes the circle, the old owner stays on as an admin.
app.post('/api/circles/:id/transfer', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (a.role !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  const uid = Number(b.userId);
  if (!membership(a.circleId, uid) || uid === a.user.id) return c.json({ error: 'not_found' }, 404);
  tx(() => {
    run("UPDATE circle_members SET role = 'owner' WHERE circle_id = ? AND user_id = ?", a.circleId, uid);
    run("UPDATE circle_members SET role = 'admin' WHERE circle_id = ? AND user_id = ?", a.circleId, a.user.id);
    run('UPDATE circles SET owner_id = ? WHERE id = ?', uid, a.circleId);
  });
  return c.json({ ok: true });
});
app.post('/api/circles/:id/invite/regenerate', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  const code = randomBytes(5).toString('hex');
  run('UPDATE circles SET invite_code = ? WHERE id = ?', code, a.circleId);
  return c.json({ inviteCode: code });
});

/** The people you share a circle or a group with (never yourself), each with the one-to-one chat you already have with them, if any. The home list offers the rest as people to message. */
app.get('/api/people', c => {
  const me = c.get('user').id;
  const rows = all(
    `SELECT u.id, u.name, GROUP_CONCAT(DISTINCT ci.name) AS via
       FROM circle_members mine
       JOIN circles ci ON ci.id = mine.circle_id AND ci.kind != 'direct' AND ci.deleted_at IS NULL
       JOIN circle_members other ON other.circle_id = mine.circle_id AND other.user_id != mine.user_id
       JOIN users u ON u.id = other.user_id
      WHERE mine.user_id = ? AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?)
      GROUP BY u.id ORDER BY u.name LIMIT 300`, me, me);
  return c.json(rows.map(r => ({
    id: r.id, name: r.name, via: String(r.via ?? '').split(',').slice(0, 2).join('، '),
    chatId: one(`SELECT ci.id FROM circles ci JOIN circle_members a ON a.circle_id = ci.id AND a.user_id = ? JOIN circle_members b ON b.circle_id = ci.id AND b.user_id = ?
                  WHERE ci.kind = 'direct' AND ci.deleted_at IS NULL LIMIT 1`, me, r.id)?.id ?? null,
  })));
});
