import type { Db } from '../db.ts';
import { baseline } from './0001_baseline.ts';
import { addRegion } from './0002_region.ts';
import { adminCore } from './0003_admin_core.ts';
import { reportActions } from './0004_report_actions.ts';
import { ops } from './0005_ops.ts';
import { albums } from './0006_albums.ts';
import { storagePlans } from './0007_storage_plans.ts';
import { story } from './0008_story.ts';
import { support } from './0009_support.ts';
import { opsAgent } from './0010_ops_agent.ts';
import { adminPeople } from './0011_admin_people.ts';
import { quotaAlerts } from './0012_quota_alerts.ts';
import { announce } from './0013_announce.ts';
import { opsErrors } from './0014_ops_errors.ts';
import { agentMemory } from './0015_agent_memory.ts';
import { security } from './0016_security.ts';
import { scale } from './0017_scale.ts';
import { broadcastCursor } from './0018_broadcast_cursor.ts';
import { payments } from './0019_payments.ts';
import { addUserEmail } from './0020_user_email.ts';
import { addUserAvatar } from './0021_user_avatar.ts';
import { chatBasics } from './0022_chat_basics.ts';
import { groups } from './0023_groups.ts';
import { media } from './0024_media.ts';
import { privacy } from './0025_privacy.ts';
import { e2ee } from './0026_e2ee.ts';
import { e2eeBackup } from './0027_e2ee_backup.ts';
import { e2eeLink } from './0028_e2ee_link.ts';
import { e2eeEndorse } from './0029_e2ee_endorse.ts';

/**
 * Numbered, ordered, applied once. Every schema change is a new entry here (a new file, a new number); an applied one is never edited.
 * `transactional: false` is only for the baseline, which manages its own transactions (it rebuilds a table with foreign keys off).
 */
export interface Migration { version: number; name: string; up(db: Db): void; transactional?: boolean }

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline', up: baseline, transactional: false },
  { version: 2, name: 'region', up: addRegion },
  { version: 3, name: 'admin_core', up: adminCore },
  { version: 4, name: 'report_actions', up: reportActions },
  { version: 5, name: 'ops', up: ops },
  { version: 6, name: 'albums', up: albums },
  { version: 7, name: 'storage_plans', up: storagePlans },
  { version: 8, name: 'story', up: story },
  { version: 9, name: 'support', up: support },
  { version: 10, name: 'ops_agent', up: opsAgent },
  { version: 11, name: 'admin_people', up: adminPeople },
  { version: 12, name: 'quota_alerts', up: quotaAlerts },
  { version: 13, name: 'announce', up: announce },
  { version: 14, name: 'ops_errors', up: opsErrors },
  { version: 15, name: 'agent_memory', up: agentMemory },
  { version: 16, name: 'security', up: security },
  { version: 17, name: 'scale', up: scale },
  { version: 18, name: 'broadcast_cursor', up: broadcastCursor },
  { version: 19, name: 'payments', up: payments },
  { version: 20, name: 'user_email', up: addUserEmail },
  { version: 21, name: 'user_avatar', up: addUserAvatar },
  { version: 22, name: 'chat_basics', up: chatBasics },
  { version: 23, name: 'groups', up: groups },
  { version: 24, name: 'media', up: media },
  { version: 25, name: 'privacy', up: privacy },
  { version: 26, name: 'e2ee', up: e2ee },
  { version: 27, name: 'e2ee_backup', up: e2eeBackup },
  { version: 28, name: 'e2ee_link', up: e2eeLink },
  { version: 29, name: 'e2ee_endorse', up: e2eeEndorse },
];

/** Bring a database to the latest version. Safe on a fresh file, on a database from before versioning (the baseline is idempotent), and when already current. Returns the versions applied now. */
export async function migrate(db: Db, migrations: Migration[] = MIGRATIONS): Promise<number[]> {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => Number(r.version)));
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    if (m.transactional === false) {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    } else {
      db.exec('BEGIN');
      try { m.up(db); db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw new Error(`migration ${m.version} (${m.name}) failed: ${e instanceof Error ? e.message : e}`); }
    }
    applied.push(m.version);
  }
  return applied;
}
