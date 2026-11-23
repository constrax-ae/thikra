import { app } from '../app.ts';
import { all, one, run } from '../db.ts';
import { fromB64 } from '../../core/e2ee.ts';
import { ENC_KINDS, MAX_CIPHERTEXT, headerProblem, isEncrypted, isWelcome, readBody } from '../lib/e2ee.ts';
import { announce, announceUpdate, circleAccess, insertMessage, isFrozen, limited, mayPost, membership, tx } from '../lib/helpers.ts';
import { blockedInDirect } from '../lib/moments.ts';
import { storeMentions } from '../lib/polls.ts';
import { EDIT_WINDOW_MS } from '../lib/receipts.ts';
import { toMs } from '../lib/deletes.ts';
import { MAX_FILES } from '../lib/attachments.ts';
import { dropUpload, readUpload, uploadOf } from '../lib/uploads.ts';
import { blobs } from '../storage.ts';
import { publish } from '../live.ts';
import { count } from '../metrics.ts';
import { toBase64 } from './keys.ts';

// ---- encrypted chats: delivery of opaque bytes (feature 26, part A) -------------------------------------------------------------------------
// What these routes may know: who, which chat, when, the kind marker, the key epoch, the message it answers, who is mentioned (ids), the size of the bytes.
// What they never see: any text, name, caption, card, waveform, thumbnail or file content. The messages themselves are MLS ciphertext made on the device.

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_HANDSHAKE = 512 * 1024;   // a commit or a welcome (grows with the number of devices in the chat)
const decode = (v: unknown, max: number): Uint8Array | 'big' | null => {
  if (typeof v !== 'string' || !v || v.length % 4 !== 0 || !B64.test(v)) return null;
  if (v.length > Math.ceil(max / 3) * 4) return 'big';
  const out = fromB64(v);
  return out.length > 0 && out.length <= max ? out : out.length > max ? 'big' : null;
};
const refuseUnlessEncrypted = (circleId: number) => isEncrypted(circleId);

// The state a device needs to decide what to do: which epoch the group is in, whether a new commit is required before anyone sends, and every member device with its identity key.
app.get('/api/circles/:id/e2ee', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!refuseUnlessEncrypted(a.circleId)) return c.json({ error: 'not_encrypted' }, 409);
  const s = one('SELECT e2ee_epoch AS epoch, e2ee_min_epoch AS minEpoch FROM circles WHERE id = ?', a.circleId)!;
  const devices = all(
    `SELECT d.user_id AS userId, d.id AS deviceId, d.identity_key AS identityKey, d.endorsement, (SELECT e.identity_key FROM e2ee_devices e WHERE e.id = d.endorsed_by) AS endorserKey
       FROM circle_members m JOIN e2ee_devices d ON d.user_id = m.user_id
      WHERE m.circle_id = ? AND d.revoked_at IS NULL AND d.identity_key IS NOT NULL ORDER BY d.id`, a.circleId);
  return c.json({ epoch: s.epoch, minEpoch: s.minEpoch, rekeyNeeded: s.minEpoch > s.epoch, devices: devices.map(d => ({ ...d, identityKey: toBase64(d.identityKey), endorsement: d.endorsement ?? null, endorserKey: d.endorserKey ? toBase64(d.endorserKey) : null })) });
});

// A member's device posts a commit (a key change, in order, one per epoch) with the welcomes for devices it adds. Only the NEXT epoch is accepted, so two devices
// that act at the same moment cannot both win: the loser gets 409 with the current epoch, applies the winner's commit, and tries again.
app.post('/api/circles/:id/e2ee/commits', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!refuseUnlessEncrypted(a.circleId)) return c.json({ error: 'not_encrypted' }, 409);
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  if (await limited(`e2ee-commit:${a.user.id}`, 60, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const b = await readBody(c);
  const dev = Number.isInteger(b.device) && one('SELECT id FROM e2ee_devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL', b.device, a.user.id);
  if (!dev) return c.json({ error: 'forbidden' }, 403);
  const commit = decode(b.commit, MAX_HANDSHAKE);
  if (commit === 'big') return c.json({ error: 'too_large' }, 413);
  if (!commit || !Number.isInteger(b.epoch) || b.epoch < 1) return c.json({ error: 'invalid_value' }, 400);
  const now = one('SELECT e2ee_epoch AS e FROM circles WHERE id = ?', a.circleId)!.e as number;
  if (b.epoch !== now + 1) return c.json({ error: 'epoch_conflict', epoch: now }, 409);   // not the next epoch: someone else was first
  if (headerProblem(commit, a.circleId, b.epoch - 1, 'commit')) return c.json({ error: 'invalid_commit' }, 400);   // a commit of THIS chat, made in the epoch before the one it creates
  const welcomes: Array<{ device: number; data: Uint8Array }> = [];
  for (const w of Array.isArray(b.welcomes) ? b.welcomes.slice(0, 101) : []) {
    const data = decode(w?.welcome, MAX_HANDSHAKE);
    if (data === 'big') return c.json({ error: 'too_large' }, 413);
    // A welcome goes only to a live device of a CURRENT member of this chat.
    const target = Number.isInteger(w?.device) && one('SELECT d.id FROM e2ee_devices d JOIN circle_members m ON m.user_id = d.user_id AND m.circle_id = ? WHERE d.id = ? AND d.revoked_at IS NULL', a.circleId, w.device);
    if (!data || !target || !isWelcome(data)) return c.json({ error: 'invalid_welcome' }, 400);   // the bytes must be an MLS welcome
    welcomes.push({ device: w.device, data });
  }
  if (welcomes.length > 100) return c.json({ error: 'invalid_welcome' }, 400);
  const won = tx(() => {
    const r = run('UPDATE circles SET e2ee_epoch = ? WHERE id = ? AND e2ee_epoch = ?', b.epoch, a.circleId, b.epoch - 1);
    if (Number(r.changes) === 0) return false;
    run('INSERT INTO e2ee_commits (circle_id, epoch, user_id, device_id, data) VALUES (?, ?, ?, ?, ?)', a.circleId, b.epoch, a.user.id, dev.id, Buffer.from(commit));
    for (const w of welcomes) run('INSERT INTO e2ee_welcomes (circle_id, epoch, to_device_id, data) VALUES (?, ?, ?, ?)', a.circleId, b.epoch, w.device, Buffer.from(w.data));
    return true;
  });
  if (!won) return c.json({ error: 'epoch_conflict', epoch: one('SELECT e2ee_epoch AS e FROM circles WHERE id = ?', a.circleId)!.e }, 409);
  count('e2ee_commit');
  publish(a.circleId, { t: 'e2ee', circle: a.circleId, kind: 'commit', epoch: b.epoch, user: a.user.id });
  return c.json({ epoch: b.epoch }, 201);
});
// The commits after an epoch, in order, for a device that is catching up.
app.get('/api/circles/:id/e2ee/commits', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!refuseUnlessEncrypted(a.circleId)) return c.json({ error: 'not_encrypted' }, 409);
  const after = Math.max(0, Number(c.req.query('after')) || 0);
  return c.json(all('SELECT epoch, user_id AS userId, device_id AS device, data FROM e2ee_commits WHERE circle_id = ? AND epoch > ? ORDER BY epoch LIMIT 200', a.circleId, after)
    .map(r => ({ epoch: r.epoch, userId: r.userId, device: r.device, commit: toBase64(r.data) })));
});
// The welcomes waiting for one of MY devices in this chat, and the acknowledgement that deletes one (a welcome holds secrets for that device only; it is not kept once used).
app.get('/api/circles/:id/e2ee/welcomes', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!refuseUnlessEncrypted(a.circleId)) return c.json({ error: 'not_encrypted' }, 409);
  const dev = Number(c.req.query('device'));
  if (!Number.isInteger(dev) || !one('SELECT id FROM e2ee_devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL', dev, a.user.id)) return c.json({ error: 'forbidden' }, 403);
  return c.json(all('SELECT id, epoch, data FROM e2ee_welcomes WHERE circle_id = ? AND to_device_id = ? ORDER BY id', a.circleId, dev).map(r => ({ id: r.id, epoch: r.epoch, welcome: toBase64(r.data) })));
});
app.delete('/api/e2ee/welcomes/:wid', c => {
  run('DELETE FROM e2ee_welcomes WHERE id = ? AND to_device_id IN (SELECT id FROM e2ee_devices WHERE user_id = ?)', Number(c.req.param('wid')), c.get('user').id);
  return c.json({ ok: true });
});

// An encrypted message. `ciphertext` is the MLS message (base64). `kind` is the marker the server needs to route (text, media, voice, card, edit). `epoch` is the key epoch it was made in.
// `uploads` are the finished resumable uploads (already ciphertext); `mentions` are user ids; `target` is the message an `edit` control message is about.
app.post('/api/circles/:id/e2ee/messages', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (!refuseUnlessEncrypted(a.circleId)) return c.json({ error: 'not_encrypted' }, 409);
  if (isFrozen(a.circleId)) return c.json({ error: 'circle_frozen' }, 423);
  if (blockedInDirect(a.circleId, a.user.id)) return c.json({ error: 'blocked' }, 403);
  if (!mayPost(a.circleId, a.user.id)) return c.json({ error: 'admins_only' }, 403);   // before anything is stored
  if (await limited(`e2ee-msg:${a.user.id}`, 120, 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  const b = await readBody(c);
  const cmid = typeof b.clientMsgId === 'string' && b.clientMsgId && b.clientMsgId.length <= 64 ? b.clientMsgId : null;
  const prev = cmid && one('SELECT id, seq FROM messages WHERE circle_id = ? AND user_id = ? AND client_msg_id = ?', a.circleId, a.user.id, cmid);
  if (prev) return c.json({ id: prev.id, seq: prev.seq }, 200);   // a retry of one already stored is never refused
  const ct = decode(b.ciphertext, MAX_CIPHERTEXT);
  if (ct === 'big') return c.json({ error: 'too_large', max: MAX_CIPHERTEXT }, 413);
  const kind = ENC_KINDS.find(k => k === b.kind);
  if (!ct || !kind || !Number.isInteger(b.epoch) || b.epoch < 0) return c.json({ error: 'invalid_value' }, 400);
  // Keys: never ahead of the group, never behind what a removal or a lost device requires.
  const s = one('SELECT e2ee_epoch AS epoch, e2ee_min_epoch AS minEpoch FROM circles WHERE id = ?', a.circleId)!;
  if (b.epoch > s.epoch) return c.json({ error: 'epoch_ahead', epoch: s.epoch }, 409);
  if (b.epoch < s.minEpoch) return c.json({ error: 'rekey_required', minEpoch: s.minEpoch, epoch: s.epoch }, 409);
  // The header must tell the truth: bytes that are not an MLS message of THIS chat made in the claimed epoch are refused (readable text, another chat's message, a lie that dodges the removal gate).
  if (headerProblem(ct, a.circleId, b.epoch, 'message')) return c.json({ error: 'invalid_ciphertext' }, 400);
  const replyRaw = Number(b.replyTo);
  const replyTo = Number.isInteger(replyRaw) && one('SELECT 1 FROM messages WHERE id = ? AND circle_id = ?', replyRaw, a.circleId) ? replyRaw : null;
  // An edit is a control message: it names the message it is about; only that message's sender, only a text/media message, only inside the edit window.
  let target: number | null = null;
  if (kind === 'edit') {
    const t = Number.isInteger(b.target) ? one('SELECT id, user_id, enc_kind, created_at, deleted_at FROM messages WHERE id = ? AND circle_id = ?', b.target, a.circleId) : undefined;
    if (!t || t.deleted_at || !['text', 'media'].includes(t.enc_kind)) return c.json({ error: 'not_found' }, 404);
    if (t.user_id !== a.user.id) return c.json({ error: 'forbidden' }, 403);
    if (Date.now() - toMs(t.created_at) > EDIT_WINDOW_MS) return c.json({ error: 'edit_window_closed' }, 403);
    target = t.id;
  }
  // The files: finished resumable uploads of this person in this chat, kept as opaque bytes. Nothing is sniffed or measured: that would need to read them.
  const ids: string[] = Array.isArray(b.uploads) ? b.uploads : [];
  if (ids.length && (!['media', 'voice'].includes(kind) || ids.length > MAX_FILES + 1)) return c.json({ error: 'invalid_attachment' }, 400);
  const files: Array<{ id: string; buf: Buffer }> = [];
  for (const id of ids) {
    const up = uploadOf(id, a.user.id);
    if (!up || up.circle_id !== a.circleId || files.some(f => f.id === up.id)) return c.json({ error: 'upload_not_found' }, 404);
    if (up.received !== up.size) return c.json({ error: 'upload_incomplete', offset: up.received }, 409);
    const buf = await readUpload(up);
    if (!buf) return c.json({ error: 'upload_not_found' }, 404);
    files.push({ id: up.id, buf });
  }
  const once = b.viewOnce === true && files.length > 0;
  const sent = insertMessage({ circleId: a.circleId, userId: a.user.id, kind: 'text', body: '', clientMsgId: cmid, replyTo, viewOnce: once, enc: { ciphertext: ct, kind, epoch: b.epoch, target } });
  if (sent.duplicate) { for (const f of files) await dropUpload(f.id); return c.json({ id: sent.id, seq: sent.seq }, 200); }
  for (const f of files) {
    const { hash, size } = await blobs.put(f.buf);
    run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', hash, size);
    run("INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size) VALUES (?, ?, ?, ?, 'file', 'application/octet-stream', ?)", a.circleId, sent.id, a.user.id, hash, size);
    await dropUpload(f.id);
  }
  storeMentions(a.circleId, sent.id, a.user.id, b.mentions);   // the device sends ids: the server must know whom to notify, and learns nothing else
  run('UPDATE circle_members SET read_seq = MAX(read_seq, ?), delivered_seq = MAX(delivered_seq, ?) WHERE circle_id = ? AND user_id = ?', sent.seq, sent.seq, a.circleId, a.user.id);
  if (target) { run("UPDATE messages SET edited_at = datetime('now') WHERE id = ?", target); announceUpdate(a.circleId, target); }
  count('e2ee_message');
  announce(a.circleId, sent.id);
  return c.json({ id: sent.id, seq: sent.seq }, 201);
});
void membership;
