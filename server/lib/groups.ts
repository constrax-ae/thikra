import { all, run, type Row } from '../db.ts';
import { live, memberJoined } from '../live.ts';
import { circleChanged, ensurePerson, systemMessage } from './helpers.ts';
import { memberAdded } from './e2ee.ts';

// ---- groups: joining ---------------------------------------------------------------------------

/** Put a person into a chat as an ordinary member, with the notice everyone sees. (The one way a member is added by invite or approval.) */
export function addMember(circleId: number, user: Row) {
  run("INSERT OR IGNORE INTO circle_members (circle_id, user_id, role) VALUES (?, ?, 'member')", circleId, user.id);
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
