import type { Db } from '../db.ts';

/**
 * 0010: the operations agent. It never changes anything by itself: it writes a PROPOSAL here and the owner approves or rejects it. Approving replays the real admin endpoint
 * with the approver's own session, so the same permission checks and audit rows apply. A proposal holds the action and a short reason, never message text or a full phone number.
 */
export function opsAgent(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      args TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'rules' CHECK (source IN ('rules','model')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','failed')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_at TEXT,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_proposals_status ON agent_proposals(status, id);
  `);
}
