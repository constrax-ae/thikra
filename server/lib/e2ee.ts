import { all, one, run } from '../db.ts';
import { describeMessage } from '../../core/e2ee.ts';
import { publish } from '../live.ts';

// ---- end-to-end encryption: the rules the rest of the server asks about (feature 26) ------------------------------------------------------
// The server is only a delivery service for encrypted chats: it routes and orders opaque bytes. It never reads, derives from or searches their text.
// Design: docs/superpowers/specs/2026-11-19-encryption-design.md.

/** Part A is built but the app screens (part B) are not: until a server turns this on (THIKRA_E2EE=1) nothing can be created encrypted and nothing changes for anyone. */
export const e2eeEnabled = () => process.env.THIKRA_E2EE === '1';
/** Is this chat end-to-end encrypted? (A private chat or an ordinary group, chosen at creation. A family circle never is.) */
export const isEncrypted = (circleId: number): boolean => one('SELECT encrypted FROM circles WHERE id = ?', circleId)?.encrypted === 1;
/** Thrown when something tries to put readable text into an encrypted chat. The HTTP layer answers 409, the live gateway sends it as the error. */
export class EncryptedChat extends Error { code = 'encrypted_chat'; constructor() { super('encrypted_chat'); } }
/** The largest message the server will carry as ciphertext (text, a card, a waveform, a thumbnail key... the files themselves go through the upload routes). */
export const MAX_CIPHERTEXT = 64 * 1024;
/** `edit` changes one message (the server checks the target); `ctl` is any other control message (a reaction, a poll vote): opaque to the server, never unread, never a notification, never the chat's last message. */
export const ENC_KINDS = ['text', 'media', 'voice', 'card', 'edit', 'ctl'] as const;
export type EncKind = typeof ENC_KINDS[number];
/** A message's name for a device inside the protocol. */
export const identityName = (userId: number, deviceId: number) => `u${userId}.d${deviceId}`;

/**
 * Someone left or was removed, or a device was revoked: nobody may send with the old keys any more. The next message must carry an epoch at least one higher
 * than the group has reached, which only a new commit can give. Every device of the chat is told, and the first one to react makes the commit.
 */
export function requireRekey(circleId: number, reason: 'removed' | 'left' | 'device_revoked', userId?: number) {
  const r = run('UPDATE circles SET e2ee_min_epoch = MAX(e2ee_min_epoch, e2ee_epoch + 1) WHERE id = ? AND encrypted = 1', circleId);
  if (Number(r.changes) === 0) return;
  const minEpoch = one('SELECT e2ee_min_epoch AS m FROM circles WHERE id = ?', circleId)!.m as number;
  publish(circleId, { t: 'e2ee', circle: circleId, kind: 'rekey', reason, user: userId ?? null, minEpoch });
}
/** A person's account is going away: every encrypted chat they are in must change keys before anyone sends again. */
export function rekeyAllFor(userId: number) {
  for (const r of all('SELECT c.id FROM circles c JOIN circle_members m ON m.circle_id = c.id AND m.user_id = ? WHERE c.encrypted = 1', userId)) requireRekey(r.id as number, 'removed', userId);
}
/** A person joined an encrypted chat: an existing device must add theirs (a commit with a welcome). They read nothing from before. */
export function memberAdded(circleId: number, userId: number) {
  if (!isEncrypted(circleId)) return;
  publish(circleId, { t: 'e2ee', circle: circleId, kind: 'add', user: userId });
}

/** Hand-over pieces nobody took (the new device closed, the person gave up) are not kept: an hour is more than a hand-over needs. Returns how many were removed. */
export function purgeStaleTransfers(): number {
  const n = Number(run("DELETE FROM e2ee_transfers WHERE created_at < datetime('now', '-1 hour')").changes);
  // a pairing that was used and never finished is over too (a new one can be made)
  run("UPDATE e2ee_devices SET link_proof = NULL, link_pub = NULL, link_expires_at = NULL, link_used_at = NULL, link_peer = NULL WHERE link_used_at IS NOT NULL AND link_used_at < CAST(strftime('%s', 'now', '-1 hour') AS INTEGER) AND NOT EXISTS (SELECT 1 FROM e2ee_transfers t WHERE t.device_id = e2ee_devices.id)");
  return n;
}

/**
 * The server cannot read an MLS message, but it can see its plain header (RFC 9420: group, epoch, content type, authenticated data) and refuse bytes that are not what they claim to be.
 * Without this check a client could store ANYTHING in the ciphertext column (readable text, another chat's messages, an old commit replayed to stall everyone) and the server would
 * carry it. `kind`: a chat message (application content, made in `epoch`) or a commit (made in `epoch`, moving the chat to the next one). Returns why it is refused, or null.
 */
export function headerProblem(bytes: Uint8Array, circleId: number, epoch: number, kind: 'message' | 'commit'): string | null {
  const h = describeMessage(bytes);
  if (!h || h.wireformat !== 'mls_private_message') return 'not_mls';
  const p = h as Extract<ReturnType<typeof describeMessage>, { groupId: string }>;
  if (p.groupId !== `c${circleId}`) return 'wrong_group';
  if (p.epoch !== epoch) return 'wrong_epoch';
  if (p.contentType !== (kind === 'message' ? 'application' : 'commit')) return 'wrong_content';
  if (p.authenticatedDataLength !== 0) return 'cleartext_data';
  return null;
}
export const isWelcome = (bytes: Uint8Array) => describeMessage(bytes)?.wireformat === 'mls_welcome';

/** A request body as an object: `null`, a number, a list or broken JSON all become `{}` (a body of `null` used to crash the route with a 500). */
export async function readBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, any>> {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, any> : {};
}
