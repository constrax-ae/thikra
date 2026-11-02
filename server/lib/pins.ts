import { MSG_COLS } from './messages.ts';
import { all } from '../db.ts';
import { decorate } from './helpers.ts';

// ---- pinned messages (M-12b) -------------------------------------------------------------------

export const PIN_HOURS = new Set([24, 168, 720]);
export const MAX_PINS = 3;
export const activePins = (circleId: number, userId: number) => decorate(circleId, all(
  `SELECT ${MSG_COLS}, pm.expires_at AS pinExpires FROM pinned_messages pm JOIN messages m ON m.id = pm.message_id LEFT JOIN users u ON u.id = m.user_id
    WHERE pm.circle_id = ? AND pm.expires_at > datetime('now') AND m.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
    ORDER BY pm.created_at DESC, pm.rowid DESC`, circleId, userId));
