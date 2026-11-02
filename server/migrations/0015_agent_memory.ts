import type { Db } from '../db.ts';

/**
 * 0015: what the operations agent remembers (ADMIN-PLAN slice 5).
 *  - agent_briefs   the morning and evening summaries and the emergency alerts it wrote (the decision list as it was then), newest kept.
 *  - agent_usage    tokens used by each call to the language model, so the monthly cost of the AI is a number and not a surprise.
 */
export function agentMemory(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_briefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      kind TEXT NOT NULL CHECK (kind IN ('morning','evening','alert','manual')),
      items TEXT NOT NULL,
      pushed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS agent_briefs_at ON agent_briefs(at);
    CREATE TABLE IF NOT EXISTS agent_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS agent_usage_at ON agent_usage(at);
  `);
}
