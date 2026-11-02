import type { Db } from '../db.ts';

/**
 * 0001: the whole schema as it was before versioned migrations existed. It is written to be harmless on a database that
 * already has it (CREATE ... IF NOT EXISTS, ALTERs that ignore "duplicate column", idempotent back-fills), so a database
 * from any earlier release, including the real one on Replit, lands on exactly the same state as a fresh one.
 * NEVER edit this file again: every schema change from now on is a new numbered migration.
 */
export function baseline(db: Db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'ar',
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS otps (
    phone TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS circles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    sensitivity TEXT NOT NULL DEFAULT 'medium' CHECK (sensitivity IN ('strict','medium','lenient')),
    agent_active INTEGER NOT NULL DEFAULT 0,
    invite_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS circle_members (
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (circle_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text','voice','system')),
    body TEXT NOT NULL DEFAULT '',
    audio_path TEXT,
    transcript TEXT,
    archive_status TEXT NOT NULL DEFAULT 'none',
    score INTEGER,
    category TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS messages_circle ON messages(circle_id, id);
  CREATE TABLE IF NOT EXISTS archive_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT,
    event_date TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('auto','manual')),
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS archive_circle ON archive_entries(circle_id, event_date);
  
  -- "Delete for me": a message one member no longer wants to see. Everyone else still sees it.
  CREATE TABLE IF NOT EXISTS message_hidden (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, message_id)
  );
  
  -- Media. Files live in the blob store; these rows say who owns which blob and whether it is archived.
  CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    tier TEXT NOT NULL DEFAULT 'hot' CHECK (tier IN ('hot','cold')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    blob_hash TEXT NOT NULL REFERENCES blobs(hash),
    kind TEXT NOT NULL CHECK (kind IN ('audio','image','video','file','thumb')),
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    width INTEGER,
    height INTEGER,
    thumb_of INTEGER,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS media_circle ON media(circle_id, archived);
  
  -- One row per circle; absent means the free plan. Written only by the payment provider integration.
  CREATE TABLE IF NOT EXISTS subscriptions (
    circle_id INTEGER PRIMARY KEY REFERENCES circles(id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free','active','grace','readonly')),
    sponsor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    provider TEXT,
    provider_ref TEXT,
    period_end TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  
  -- A person is not an account: relatives who have died, or children without a phone, still belong to the family.
  CREATE TABLE IF NOT EXISTS persons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    relation TEXT,
    birth_date TEXT,
    death_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS persons_circle ON persons(circle_id);
  `);
  
  // Databases created before the "admin" role existed: rebuild circle_members with the wider CHECK.
  const memberSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'circle_members'").get() as { sql?: string } | undefined)?.sql ?? '';
  if (!memberSql.includes("'admin'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE circle_members RENAME TO circle_members_old;
      CREATE TABLE circle_members (
        circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
        joined_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (circle_id, user_id)
      );
      INSERT INTO circle_members (circle_id, user_id, role, joined_at) SELECT circle_id, user_id, role, joined_at FROM circle_members_old;
      DROP TABLE circle_members_old;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
  
  // Databases from before attachments existed: widen media.kind (file, thumb) and add name/size-of-picture/thumbnail link.
  const mediaSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media'").get() as { sql?: string } | undefined)?.sql ?? '';
  if (mediaSql && !mediaSql.includes("'thumb'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE media RENAME TO media_old;
      CREATE TABLE media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
        message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        blob_hash TEXT NOT NULL REFERENCES blobs(hash),
        kind TEXT NOT NULL CHECK (kind IN ('audio','image','video','file','thumb')),
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        name TEXT,
        width INTEGER,
        height INTEGER,
        thumb_of INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO media (id, circle_id, message_id, uploader_id, blob_hash, kind, mime, size, archived, created_at)
        SELECT id, circle_id, message_id, uploader_id, blob_hash, kind, mime, size, archived, created_at FROM media_old;
      DROP TABLE media_old;
      CREATE INDEX IF NOT EXISTS media_circle ON media(circle_id, archived);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
  
  // Columns added after the first release. Existing databases get them through ALTER;
  // a "duplicate column" error just means the column is already there.
  for (const stmt of [
    'ALTER TABLE circles ADD COLUMN agent_from_id INTEGER',
    'ALTER TABLE messages ADD COLUMN deleted_at TEXT',
    'ALTER TABLE messages ADD COLUMN deleted_by INTEGER',
    'ALTER TABLE messages ADD COLUMN seq INTEGER',
    'ALTER TABLE messages ADD COLUMN client_msg_id TEXT',
    'ALTER TABLE messages ADD COLUMN reply_to INTEGER',
    'ALTER TABLE messages ADD COLUMN rev INTEGER',
    'ALTER TABLE messages ADD COLUMN search_text TEXT',
    'ALTER TABLE messages ADD COLUMN sealed_on TEXT',
    'ALTER TABLE media ADD COLUMN duration_ms INTEGER',
    "ALTER TABLE circles ADD COLUMN kind TEXT NOT NULL DEFAULT 'circle'",
    'ALTER TABLE circles ADD COLUMN deleted_at TEXT',
    'ALTER TABLE circles ADD COLUMN deleted_by INTEGER',
    'ALTER TABLE messages ADD COLUMN forward_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE messages ADD COLUMN edited_at TEXT',
    'ALTER TABLE users ADD COLUMN read_receipts INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE users ADD COLUMN push_preview INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE users ADD COLUMN pin_hash TEXT',
    'ALTER TABLE users ADD COLUMN pin_fails INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN pin_locked_until INTEGER',
    'ALTER TABLE users ADD COLUMN pin_reset_at INTEGER',
    "ALTER TABLE circles ADD COLUMN invite_policy TEXT NOT NULL DEFAULT 'admins'",
    'ALTER TABLE circles ADD COLUMN invite_enabled INTEGER NOT NULL DEFAULT 1',
    "ALTER TABLE archive_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'event'",
    'ALTER TABLE archive_entries ADD COLUMN status TEXT',
    'ALTER TABLE archive_entries ADD COLUMN parties TEXT',
    'ALTER TABLE archive_entries ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE archive_entries ADD COLUMN visible_after TEXT',
    'ALTER TABLE archive_entries ADD COLUMN resolved_at TEXT',
    'ALTER TABLE archive_entries ADD COLUMN declined INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { db.exec(stmt); } catch { /* already applied */ }
  }
  
  // Read/delivered watermarks per member (one number each, like WhatsApp's "up to here"), and reactions.
  // Existing members start fully caught up, so an upgrade does not turn the whole history into "unread".
  let addedWatermarks = false;
  for (const stmt of ['ALTER TABLE circle_members ADD COLUMN delivered_seq INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE circle_members ADD COLUMN read_seq INTEGER NOT NULL DEFAULT 0']) {
    try { db.exec(stmt); addedWatermarks = true; } catch { /* already applied */ }
  }
  if (addedWatermarks) {
    db.exec('UPDATE circle_members SET delivered_seq = COALESCE((SELECT MAX(seq) FROM messages m WHERE m.circle_id = circle_members.circle_id), 0), read_seq = delivered_seq');
    db.exec('UPDATE circle_members SET read_seq = delivered_seq');
  }
  // Revision (rev): a second per-circle counter that moves whenever a message CHANGES (edit, reaction, delete, archive
  // status), not only when it is created. A client syncs by "everything with rev greater than the last one I have",
  // so edits and deletions made while it was offline reach it too (T-10). Triggers do the bumping, so no code path
  // that changes a message can forget to.
  db.exec(`UPDATE messages SET rev = seq WHERE rev IS NULL`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS messages_circle_rev ON messages(circle_id, rev)');
  // Server-wide settings (e.g. the push VAPID keys) and each person's push subscriptions (one per browser/device).
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    ua TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_ok_at TEXT
  )`);
  
  // Sealed messages (the heritage feature): written now (text, voice, video or photo), opened later, for the whole family circle (or one person).
  // Three triggers: a DATE (once or every year), an EVENT (opens when two other family members confirm it happened, e.g. a wedding),
  // or AFTER DEATH (two members confirm, then a waiting period in which the author, if alive, or a manager can stop it).
  // Once opened it is posted to everyone, can never be deleted or edited by anyone, and is kept in the family archive.
  // FIRST VERSION: the server holds the content until then (disclosed to the author); sharing the opening key among guardians comes later.
  const SEALED_SQL = `(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL DEFAULT 'date' CHECK (trigger IN ('date','event','death')),
    occasion TEXT,
    kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','voice','video','image')),
    body TEXT NOT NULL DEFAULT '',
    blob_hash TEXT,
    mime TEXT,
    name TEXT,
    duration_ms INTEGER,
    unlock_at TEXT,
    yearly INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'sealed' CHECK (status IN ('sealed','waiting','released','cancelled','stopped')),
    release_at TEXT,
    sealed_on TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT,
    note TEXT
  )`;
  const sealedOld = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sealed_messages'").get() as { sql?: string } | undefined)?.sql ?? '';
  if (sealedOld && !sealedOld.includes('trigger')) {
    db.exec(`
      ALTER TABLE sealed_messages RENAME TO sealed_messages_old;
      CREATE TABLE sealed_messages ${SEALED_SQL};
      INSERT INTO sealed_messages (id, circle_id, author_id, recipient_id, body, unlock_at, yearly, status, sealed_on, released_at, note)
        SELECT id, circle_id, author_id, recipient_id, body, unlock_at, yearly, status, sealed_on, released_at, note FROM sealed_messages_old;
      DROP TABLE sealed_messages_old;
    `);
  } else db.exec(`CREATE TABLE IF NOT EXISTS sealed_messages ${SEALED_SQL}`);
  db.exec('CREATE INDEX IF NOT EXISTS sealed_due ON sealed_messages(status, unlock_at)');
  db.exec('CREATE INDEX IF NOT EXISTS sealed_blob ON sealed_messages(blob_hash)');
  // Who confirmed an event ("scope" event, ref = the sealed message) or a death ("scope" death, ref = the person who died).
  db.exec(`CREATE TABLE IF NOT EXISTS sealed_confirmations (
    scope TEXT NOT NULL CHECK (scope IN ('event','death')),
    ref_id INTEGER NOT NULL,
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    confirmer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (scope, ref_id, circle_id, confirmer_id)
  )`);
  try { db.exec('ALTER TABLE archive_entries ADD COLUMN protected INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
  // What the agent has read in the circle that points to a death (scope 'death', ref = the person) or to an occasion happening (scope 'event',
  // ref = the sealed message). One row per message and member; the server weighs them (more than three messages from three members).
  db.exec(`CREATE TABLE IF NOT EXISTS sealed_evidence (
    scope TEXT NOT NULL CHECK (scope IN ('event','death')),
    ref_id INTEGER NOT NULL,
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (scope, ref_id, circle_id, message_id)
  )`);
  
  // Messages pinned to the top of a chat, visible to everyone in it, for 24 hours, 7 days or 30 days (up to 3 at a time, like WhatsApp).
  db.exec(`CREATE TABLE IF NOT EXISTS pinned_messages (
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (circle_id, message_id)
  )`);
  
  // Per-person settings for each chat (WhatsApp's pin, mute, archive, favourite, "mark as unread"). Stored on the server so they
  // follow the person to every device. Private: nobody else ever sees them.
  db.exec(`CREATE TABLE IF NOT EXISTS chat_prefs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    pinned_at TEXT,
    muted INTEGER NOT NULL DEFAULT 0,
    muted_until TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    favourite INTEGER NOT NULL DEFAULT 0,
    marked_unread INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, circle_id)
  )`);
  
  try { db.exec('ALTER TABLE chat_prefs ADD COLUMN muted_until TEXT'); } catch { /* already there */ } // databases created before timed mute
  
  // Blocking people, and reports of messages (a legal duty before launch: THREAT-MODEL "الإساءة والسلامة").
  db.exec(`CREATE TABLE IF NOT EXISTS blocks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, blocked_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reported_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    circle_id INTEGER REFERENCES circles(id) ON DELETE SET NULL,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    reason TEXT NOT NULL CHECK (reason IN ('spam','abuse','harassment','illegal','other')),
    note TEXT,
    snapshot TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    resolution TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  )`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS reports_once ON reports(reporter_id, message_id)');
  
  // Personal stars: private to the person who set them, so they never touch a message's revision.
  db.exec(`CREATE TABLE IF NOT EXISTS stars (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, message_id)
  )`);
  
  // Only changes to what a person sees bump the rev: maintaining the search column must not make every client re-sync.
  db.exec('DROP TRIGGER IF EXISTS messages_bump_rev');
  db.exec(`CREATE TRIGGER messages_bump_rev AFTER UPDATE OF body, transcript, audio_path, archive_status, score, category, reason, deleted_at, deleted_by, edited_at ON messages WHEN NEW.rev IS OLD.rev
    BEGIN UPDATE messages SET rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM messages WHERE circle_id = NEW.circle_id) WHERE id = NEW.id; END`);
  db.exec(`CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  )`);
  for (const [name, event, ref] of [['ins', 'INSERT', 'NEW'], ['upd', 'UPDATE', 'NEW'], ['del', 'DELETE', 'OLD']]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS reactions_bump_${name} AFTER ${event} ON reactions
      BEGIN UPDATE messages SET rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM messages m WHERE m.circle_id = messages.circle_id) WHERE id = ${ref}.message_id; END`);
  }
  
  // Per-conversation sequence (PROTOCOL invariant I1): gap-free, strictly increasing within a circle.
  // Old rows get theirs once, in id order. The unique index makes a retried send (same client_msg_id) a no-op.
  db.exec(`UPDATE messages SET seq = (SELECT COUNT(*) FROM messages o WHERE o.circle_id = messages.circle_id AND o.id <= messages.id) WHERE seq IS NULL`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS messages_circle_seq ON messages(circle_id, seq)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS messages_dedupe ON messages(circle_id, user_id, client_msg_id) WHERE client_msg_id IS NOT NULL');
}
