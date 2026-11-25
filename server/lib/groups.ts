import { all, one, run, type Row } from '../db.ts';
import { live, memberJoined } from '../live.ts';
import { circleChanged, ensurePerson, systemMessage } from './helpers.ts';
import { memberAdded } from './e2ee.ts';

// ---- groups: joining ---------------------------------------------------------------------------

/** GRP-01: the specification's proposed ceiling for one chat. */
export const MAX_MEMBERS = 256;
/** Is there room for one more? (Checked before anyone is let in, by every path: invite link, approval, direct add.) */
export const chatIsFull = (circleId: number) =>
  Number(one('SELECT COUNT(*) AS n FROM circle_members WHERE circle_id = ?', circleId)!.n) >= MAX_MEMBERS;

/**
 * Put a person into a chat as an ordinary member, with the notice everyone sees. (The one way a member is added by
 * invite or approval.) `joined_seq` records where they came in, so a group whose history policy is 'since_join'
 * can keep what was said before them to itself (GRP-02).
 */
export function addMember(circleId: number, user: Row) {
  const seq = Number(one('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE circle_id = ?', circleId)!.s) || 0;
  run("INSERT OR IGNORE INTO circle_members (circle_id, user_id, role, joined_seq) VALUES (?, ?, 'member', ?)", circleId, user.id, seq);
  run('DELETE FROM join_requests WHERE circle_id = ? AND user_id = ?', circleId, user.id);
  ensurePerson(circleId, user);
  memberJoined(circleId, [user.id as number]);
  systemMessage(circleId, 'joined', { name: user.name });
  circleChanged(circleId);
  memberAdded(circleId, user.id as number);   // an encrypted chat: a device of the group must add this person's devices
}

/** The owner and admins of a chat. */
export const managersOf = (circleId: number): number[] =>
  all("SELECT user_id AS id FROM circle_members WHERE circle_id = ? AND role IN ('owner','admin')", circleId).map(r => r.id as number);

/** The list of people waiting for approval changed: only the managers are told (an ordinary member never learns who asked). */
export const tellManagers = (circleId: number) => live.publishTo(managersOf(circleId), { t: 'join_requests', circle: circleId });
