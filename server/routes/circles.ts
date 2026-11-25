import { MAX_PINNED, RESTORE_DAYS, directChat } from '../lib/circles.ts';
import { REGION, app } from '../app.ts';
import { all, one, run, type Row } from '../db.ts';
import { circleAccess, circleChanged, ensurePerson, isFrozen, isManager, limited, membership, normPhone, systemMessage, tx } from '../lib/helpers.ts';
import { addMember, chatIsFull, tellManagers } from '../lib/groups.ts';
import { randomBytes } from 'node:crypto';
import { toMs } from '../lib/deletes.ts';
import { e2eeEnabled, isEncrypted, requireRekey } from '../lib/e2ee.ts';
import { evict, memberJoined } from '../live.ts';

/** A wallpaper is one of the built-in patterns, none, or a plain #rrggbb colour. Nothing else is ever stored (it ends up in a style). */
export const WALLPAPERS = ['none', 'dots', 'dusk', 'dunes', 'forest', 'rose'];
const isWallpaper = (v: unknown) => typeof v === 'string' && (WALLPAPERS.includes(v) || /^#[0-9a-f]{6}$/i.test(v));
 // like WhatsApp

/** The chat list: one row per conversation with what the list needs to draw it (preview, time, unread, your own pin/mute/…). */
app.get('/api/circles', c => {
  const u = c.get('user');
  const rows = all(
    `SELECT c.id, c.kind, CASE WHEN c.kind = 'direct' THEN (SELECT u.name FROM circle_members o JOIN users u ON u.id = o.user_id WHERE o.circle_id = c.id AND o.user_id != cm.user_id) ELSE c.name END AS name,
       c.encrypted, c.sensitivity, c.agent_active AS agentActive, cm.role, c.created_at AS createdAt, c.photo_media_id AS photo,
       CASE WHEN c.kind = 'direct' THEN (SELECT o.user_id FROM circle_members o WHERE o.circle_id = c.id AND o.user_id != cm.user_id) END AS peerId,
       CASE WHEN c.kind = 'direct' THEN (SELECT u.avatar_at FROM circle_members o JOIN users u ON u.id = o.user_id WHERE o.circle_id = c.id AND o.user_id != cm.user_id) END AS peerAvatarAt,
       (SELECT COUNT(*) FROM circle_members WHERE circle_id = c.id) AS members,
       (SELECT id FROM messages WHERE circle_id = c.id AND kind != 'system' AND expired_at IS NULL AND COALESCE(enc_kind, '') NOT IN ('edit', 'ctl')
          AND seq > MAX(COALESCE(p.clear_through, 0), CASE WHEN c.history_policy = 'since_join' THEN COALESCE(cm.joined_seq, 0) ELSE 0 END)
        ORDER BY id DESC LIMIT 1) AS lastId,
       (SELECT COUNT(*) FROM messages m WHERE m.circle_id = c.id AND m.seq > cm.read_seq AND m.kind != 'system' AND COALESCE(m.enc_kind, '') NOT IN ('edit', 'ctl') AND m.deleted_at IS NULL
          AND m.seq > MAX(COALESCE(p.clear_through, 0), CASE WHEN c.history_policy = 'since_join' THEN COALESCE(cm.joined_seq, 0) ELSE 0 END)
          AND (m.user_id IS NULL OR m.user_id != cm.user_id)) AS unread,
       p.pinned_at AS pinnedAt, CASE WHEN p.muted = 1 AND (p.muted_until IS NULL OR p.muted_until > datetime('now')) THEN 1 ELSE 0 END AS muted, p.muted_until AS mutedUntil, COALESCE(p.archived, 0) AS archived,
       cm.request AS request, COALESCE(p.favourite, 0) AS favourite, COALESCE(p.marked_unread, 0) AS markedUnread, COALESCE(p.locked, 0) AS locked, p.wallpaper, c.disappear_seconds AS disappearSeconds,
       EXISTS (SELECT 1 FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
                WHERE mm.user_id = cm.user_id AND m.circle_id = c.id AND m.seq > cm.read_seq AND m.deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = cm.user_id)) AS mentioned
     FROM circles c JOIN circle_members cm ON cm.circle_id = c.id AND cm.user_id = ? AND c.deleted_at IS NULL AND cm.request != 2   -- a declined request stays out of the list
     LEFT JOIN chat_prefs p ON p.circle_id = c.id AND p.user_id = cm.user_id`, u.id);
  const out: Row[] = rows.map(r => {
    const m = r.lastId ? one(
      `SELECT m.body, m.transcript, m.kind, m.enc_kind, m.user_id, m.created_at, m.deleted_at IS NOT NULL AS deleted, us.name AS author,
              (SELECT a.kind FROM media a WHERE a.message_id = m.id AND a.kind IN ('image','video','file') ORDER BY a.id LIMIT 1) AS attachment,
              (SELECT k.type FROM message_cards k WHERE k.message_id = m.id AND k.type != 'link') AS card
         FROM messages m LEFT JOIN users us ON us.id = m.user_id WHERE m.id = ?`, r.lastId) : undefined;
    // An encrypted chat shows no kind and no text: the server does not know them (the device remembers the last message it decrypted).
    const lastKind = !m ? null : m.deleted ? 'deleted' : r.encrypted ? 'encrypted' : m.card ?? m.attachment ?? (m.kind === 'voice' ? 'voice' : 'text');
    const { lastId, ...rest } = r;
    return {
      ...rest, request: r.request === 1, encrypted: !!r.encrypted, locked: !!r.locked, mentioned: !!r.mentioned, pinned: !!r.pinnedAt, muted: !!r.muted, archived: !!r.archived, favourite: !!r.favourite, markedUnread: !!r.markedUnread,
      // A locked chat shows nothing of what was said: no text, no kind (the person asked for it to stay out of sight).
      lastMessage: m && !m.deleted && !r.locked ? (m.body || m.transcript || null) : null,   // kept for older clients
      lastKind: r.locked ? null : lastKind, lastText: m && !m.deleted && !r.locked ? (m.body || m.transcript || '') : '', lastAt: m?.created_at ?? r.createdAt,
      lastAuthor: m?.user_id && m.user_id !== u.id && !r.locked ? m.author : null, lastFromMe: !!m && m.user_id === u.id,
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
  if (b.notify !== undefined) {
    // What this chat may interrupt you with. 'all' is the normal state and is stored as nothing at all.
    if (!['all', 'mentions', 'none'].includes(String(b.notify))) return c.json({ error: 'invalid_value' }, 400);
    run('UPDATE chat_prefs SET notify = ? WHERE user_id = ? AND circle_id = ?', b.notify === 'all' ? null : b.notify, a.user.id, a.circleId);
  }
  if (b.wallpaper !== undefined) {
    if (b.wallpaper !== null && !isWallpaper(b.wallpaper)) return c.json({ error: 'invalid_value' }, 400);
    run('UPDATE chat_prefs SET wallpaper = ? WHERE user_id = ? AND circle_id = ?', b.wallpaper, a.user.id, a.circleId);
  }
  for (const [key, col] of [['archived', 'archived'], ['favourite', 'favourite'], ['markedUnread', 'marked_unread'], ['locked', 'locked']] as const) {
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
  // Encrypted only at creation, only for an ordinary group, and only when the server has encryption turned on. A family circle stays readable by the server (the memory features need it).
  const encrypted = b.encrypted === true;
  if (encrypted && kind !== 'group') return c.json({ error: 'circle_not_encryptable' }, 409);
  if (encrypted && !e2eeEnabled()) return c.json({ error: 'e2ee_unavailable' }, 409);
  const r = run('INSERT INTO circles (name, owner_id, invite_code, kind, region, encrypted) VALUES (?, ?, ?, ?, ?, ?)', name, u.id, code, kind, REGION, encrypted ? 1 : 0);
  const id = Number(r.lastInsertRowid);
  run("INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, 'owner')", id, u.id);
  ensurePerson(id, u);
  memberJoined(id, [u.id]);
  return c.json({ id }, 201);
});
// A one-to-one chat with a registered person, found by phone number. One per pair: asking again returns the same chat.
// (Like WhatsApp, this tells you whether a number is registered; it is rate-limited, and a client may later restrict it to contacts.)
app.post('/api/direct', async c => {
  const u = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  if (await limited(`direct:${u.id}`, 20, 10 * 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const encrypted = b.encrypted === true;
  if (encrypted && !e2eeEnabled()) return c.json({ error: 'e2ee_unavailable' }, 409);
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
  const chat = directChat(u.id, other.id, encrypted);
  return c.json({ id: chat.id }, chat.created ? 201 : 200);
});
// Turn a plain group into a circle (the family space with the agent). Same chat, same messages, nothing is copied or lost.
app.post('/api/circles/:id/convert', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (a.role !== 'owner') return c.json({ error: 'forbidden' }, 403);
  if (isEncrypted(a.circleId)) return c.json({ error: 'encrypted_chat' }, 409);   // a chat's type is fixed at creation: an encrypted group never becomes a readable family circle (make a new one)
  const k = one('SELECT kind FROM circles WHERE id = ?', a.circleId)!.kind;
  if (k !== 'group') return c.json({ error: 'not_a_group' }, 409);
  run("UPDATE circles SET kind = 'circle', disappear_seconds = NULL WHERE id = ?", a.circleId);   // the family circle keeps what the family writes
  systemMessage(a.circleId, 'groupToCircle', { name: a.user.name });
  return c.json({ ok: true });
});
app.post('/api/circles/join', async c => {
  const u = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  if (await limited(`join:${u.id}`, 20, 10 * 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const circle = one('SELECT id, name, join_approval, invite_expires_at FROM circles WHERE invite_code = ? AND invite_enabled = 1 AND deleted_at IS NULL', String(b.code ?? '').trim());
  if (!circle) return c.json({ error: 'invalid_invite' }, 404);
  // An invite can be given a life: after it, the link is simply not a link any more (GRP-02). The code itself stays, so a manager can extend it.
  if (circle.invite_expires_at && one("SELECT datetime('now') > ? AS gone", circle.invite_expires_at)!.gone) return c.json({ error: 'invite_expired' }, 410);
  if (isFrozen(circle.id)) return c.json({ error: 'circle_frozen' }, 423);
  if (!membership(circle.id, u.id)) {
    // With approval on, the link only files a request: the person is told it was sent and learns nothing else about the group until a manager approves.
    if (circle.join_approval) {
      // Someone who keeps asking after being turned down gets the same answer but files nothing more (3 requests a day per group).
      const waiting = !!one('SELECT 1 FROM join_requests WHERE circle_id = ? AND user_id = ?', circle.id, u.id);
      if (!waiting && !(await limited(`joinreq:${circle.id}:${u.id}`, 3, 24 * 3600_000))) {
        run('INSERT OR IGNORE INTO join_requests (circle_id, user_id) VALUES (?, ?)', circle.id, u.id);
        tellManagers(circle.id);
      }
      return c.json({ pending: true }, 202);
    }
    if (chatIsFull(circle.id)) return c.json({ error: 'chat_full' }, 409);
    addMember(circle.id, u);
  }
  return c.json({ id: circle.id });
});
app.get('/api/circles/:id', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const circle = one(
    `SELECT id, kind, encrypted, e2ee_epoch AS e2eeEpoch, e2ee_min_epoch AS e2eeMinEpoch, CASE WHEN kind = 'direct' THEN (SELECT u.name FROM circle_members o JOIN users u ON u.id = o.user_id WHERE o.circle_id = circles.id AND o.user_id != ?) ELSE name END AS name, sensitivity, agent_active AS agentActive, owner_id AS ownerId, invite_code AS inviteCode,
       invite_policy AS invitePolicy, invite_enabled AS inviteEnabled, invite_expires_at AS inviteExpiresAt, history_policy AS historyPolicy, created_at AS createdAt, story_title AS storyTitle,
       description, photo_media_id AS photo, disappear_seconds AS disappearSeconds, send_policy AS sendPolicy, edit_policy AS editPolicy, join_approval AS joinApproval FROM circles WHERE id = ?`, a.user.id, a.circleId)!;
  const pref = one(`SELECT locked, wallpaper, notify, CASE WHEN muted = 1 AND (muted_until IS NULL OR muted_until > datetime('now')) THEN 1 ELSE 0 END AS muted, muted_until AS mutedUntil, favourite FROM chat_prefs WHERE user_id = ? AND circle_id = ?`, a.user.id, a.circleId);
  // deliveredSeq / readSeq are each member's "up to here" marks, the basis of the ticks. As in WhatsApp, read marks are
  // reciprocal: you see another member's only if both of you have read receipts on (your own are always yours).
  const mine = a.user.read_receipts === 1;
  const members = all(
    `SELECT u.id, u.name, cm.role, cm.delivered_seq AS deliveredSeq, cm.read_seq AS readSeq, u.read_receipts AS shares, u.avatar_at AS avatarAt,
            CASE WHEN EXISTS (SELECT 1 FROM blocks b WHERE b.user_id = u.id AND b.blocked_id = ?) THEN NULL ELSE u.about END AS about   -- someone who blocked you shows you no profile line
       FROM circle_members cm JOIN users u ON u.id = cm.user_id WHERE cm.circle_id = ? ORDER BY cm.joined_at`, a.user.id, a.circleId)
    .map(({ shares, ...m }) => ({ ...m, readSeq: m.id === a.user.id || (mine && shares === 1) ? m.readSeq : null }));
  // The invite code is shown to managers, or to every member if the circle lets anyone invite. Never when invites are off.
  const sees = circle.inviteEnabled && (isManager(a.role) || circle.invitePolicy === 'members');
  // How many people wait for approval: managers only.
  const joinRequests = isManager(a.role) ? one('SELECT COUNT(*) AS n FROM join_requests WHERE circle_id = ?', a.circleId)!.n as number : undefined;
  const request = (one('SELECT request FROM circle_members WHERE circle_id = ? AND user_id = ?', a.circleId, a.user.id)?.request ?? 0) === 1;   // a message request still waiting for your answer
  return c.json({ ...circle, request, encrypted: !!circle.encrypted, joinApproval: !!circle.joinApproval, joinRequests, inviteEnabled: !!circle.inviteEnabled, inviteCode: sees ? circle.inviteCode : undefined, role: a.role, members, muted: !!pref?.muted, mutedUntil: pref?.muted ? pref.mutedUntil ?? null : null, favourite: !!pref?.favourite, locked: !!pref?.locked, wallpaper: pref?.wallpaper ?? null, notify: (pref?.notify as string | null) ?? 'all',
    lastSeq: one('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE circle_id = ?', a.circleId)!.m });
});
app.patch('/api/circles/:id', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const cur = one('SELECT name, sensitivity, agent_active, invite_policy, invite_enabled, kind, story_title, description, send_policy, edit_policy, join_approval, history_policy FROM circles WHERE id = ?', a.circleId)!;
  if (cur.kind === 'direct') return c.json({ error: 'forbidden' }, 403); // a one-to-one chat has nothing to configure
  // Two kinds of change. The group's face (name, description) is for managers, or for every member when the group says so.
  // Everything else (who sends, who invites, approval, the agent…) is for managers only: sent by a member, it is ignored.
  const manager = isManager(a.role);
  if (!manager && cur.edit_policy !== 'all') return c.json({ error: 'forbidden' }, 403);
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : cur.name;
  const description = typeof b.description === 'string' ? b.description.trim().slice(0, 500) || null : (cur.description ?? null);
  const only = <T>(mine: T, theirs: T) => (manager ? mine : theirs);
  const sensitivity = only(['strict', 'medium', 'lenient'].includes(b.sensitivity) ? b.sensitivity : cur.sensitivity, cur.sensitivity);
  // The memory agent exists only in circles; a plain group never gets it.
  const agent = only(cur.kind !== 'circle' ? 0 : typeof b.agentActive === 'boolean' ? (b.agentActive ? 1 : 0) : cur.agent_active, cur.agent_active);
  const invitePolicy = only(b.invitePolicy === 'admins' || b.invitePolicy === 'members' ? b.invitePolicy : cur.invite_policy, cur.invite_policy);
  const inviteEnabled = only(typeof b.inviteEnabled === 'boolean' ? (b.inviteEnabled ? 1 : 0) : cur.invite_enabled, cur.invite_enabled);
  const sendPolicy = only(b.sendPolicy === 'all' || b.sendPolicy === 'admins' ? b.sendPolicy : cur.send_policy, cur.send_policy);
  const editPolicy = only(b.editPolicy === 'all' || b.editPolicy === 'admins' ? b.editPolicy : cur.edit_policy, cur.edit_policy);
  const joinApproval = only(typeof b.joinApproval === 'boolean' ? (b.joinApproval ? 1 : 0) : cur.join_approval, cur.join_approval);
  // What the family calls its story. Empty clears it (the book then uses its default title).
  const storyTitle = only(typeof b.storyTitle === 'string' ? b.storyTitle.trim().slice(0, 80) || null : (cur.story_title ?? null), cur.story_title ?? null);
  // What a NEW member may read: the whole chat, or only from the moment they joined (GRP-02). A family circle may not
  // hide its past — the past is what it is for — so the setting exists for ordinary groups only.
  const history = only(cur.kind === 'circle' ? 'all' : (b.historyPolicy === 'since_join' || b.historyPolicy === 'all' ? b.historyPolicy : cur.history_policy), cur.history_policy);
  run(`UPDATE circles SET name = ?, sensitivity = ?, agent_active = ?, invite_policy = ?, invite_enabled = ?, story_title = ?, description = ?, send_policy = ?, edit_policy = ?, join_approval = ?, history_policy = ? WHERE id = ?`,
    name, sensitivity, agent, invitePolicy, inviteEnabled, storyTitle, description, sendPolicy, editPolicy, joinApproval, history, a.circleId);
  // Members must be told when the agent starts/stops reading new messages (report §3.2).
  if (agent !== cur.agent_active) {
    const noticeId = systemMessage(a.circleId, agent ? 'agentOn' : 'agentOff', { name: a.user.name });
    // Nothing from before this notice is ever analysed, however recent it is.
    if (agent) run('UPDATE circles SET agent_from_id = ? WHERE id = ?', noticeId, a.circleId);
  }
  // The chat says who changed what, as in WhatsApp.
  if (name !== cur.name) systemMessage(a.circleId, 'nameChanged', { name: a.user.name, to: name });
  if (description !== (cur.description ?? null)) systemMessage(a.circleId, 'descChanged', { name: a.user.name });
  if (sendPolicy !== cur.send_policy) systemMessage(a.circleId, sendPolicy === 'admins' ? 'sendAdmins' : 'sendAll', { name: a.user.name });
  // Approval switched off: the link works by itself again, so nobody is left waiting for an answer that will not come.
  if (!joinApproval && cur.join_approval) run('DELETE FROM join_requests WHERE circle_id = ?', a.circleId);
  circleChanged(a.circleId);
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
  circleChanged(a.circleId);   // told BEFORE the row goes, so the person leaving hears it too and their screen closes the chat
  run('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?', a.circleId, uid);
  evict(a.circleId, uid);   // their open connections stop hearing this chat now, not at the next reconnect
  requireRekey(a.circleId, uid === a.user.id ? 'left' : 'removed', uid);   // an encrypted chat: nobody may send with the keys the person still holds
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
  circleChanged(a.circleId);   // what someone may do just changed (send in an admins-only group, edit, approve): open screens follow at once
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
  circleChanged(a.circleId);
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
    `SELECT u.id, u.name, u.avatar_at AS avatarAt, GROUP_CONCAT(DISTINCT ci.name) AS via
       FROM circle_members mine
       JOIN circles ci ON ci.id = mine.circle_id AND ci.kind != 'direct' AND ci.deleted_at IS NULL
       LEFT JOIN chat_prefs cp ON cp.circle_id = mine.circle_id AND cp.user_id = mine.user_id
       JOIN circle_members other ON other.circle_id = mine.circle_id AND other.user_id != mine.user_id
       JOIN users u ON u.id = other.user_id
      WHERE mine.user_id = ? AND COALESCE(cp.locked, 0) = 0 AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?)   -- a locked chat's name and members do not show up here
      GROUP BY u.id ORDER BY u.name LIMIT 300`, me, me);
  return c.json(rows.map(r => ({
    id: r.id, name: r.name, avatarAt: r.avatarAt ?? null, via: String(r.via ?? '').split(',').slice(0, 2).join('، '),
    chatId: one(`SELECT ci.id FROM circles ci JOIN circle_members a ON a.circle_id = ci.id AND a.user_id = ? JOIN circle_members b ON b.circle_id = ci.id AND b.user_id = ?
                  WHERE ci.kind = 'direct' AND ci.deleted_at IS NULL ORDER BY ci.encrypted DESC, ci.id LIMIT 1`, me, r.id)?.id ?? null,
  })));
});

/**
 * How long this invite link lives (GRP-02). `days` 1–365 sets it, `null` makes it permanent again. The code itself is
 * untouched, so extending a link people already have does not break it; `invite/regenerate` is still how you revoke one.
 */
app.put('/api/circles/:id/invite/expiry', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!isManager(a.role)) return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  if (b.days === null) {
    run('UPDATE circles SET invite_expires_at = NULL WHERE id = ?', a.circleId);
    return c.json({ inviteExpiresAt: null });
  }
  const days = Number(b.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) return c.json({ error: 'invalid_value' }, 400);
  run("UPDATE circles SET invite_expires_at = datetime('now', '+' || ? || ' days') WHERE id = ?", days, a.circleId);
  return c.json({ inviteExpiresAt: one('SELECT invite_expires_at AS t FROM circles WHERE id = ?', a.circleId)!.t });
});
