import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { all, db, dbFile, one, run } from './db.ts';
import { blobs } from './storage.ts';
import { DB_FILE, EPOCH_KEY, GATE_SQL, MANIFEST, blobKey, offsite, status, type Manifest } from './offsite-store.ts';

// Keeps the off-server copy fresh (see offsite-store.ts for what it is and how it is restored).
// A snapshot is: every file the database mentions that is not there yet, then the database itself, then a small manifest naming the snapshot
// (written last, so a manifest always points at a complete snapshot). Nothing is uploaded when nothing changed since the last one.

let uploaded: Set<string> | null = null;
let running: Promise<boolean> | null = null;

async function snapshotOnce(force: boolean): Promise<boolean> {
  const store = await offsite();
  if (!store || dbFile === ':memory:') return false;
  try {
    const gate = String(one(GATE_SQL)?.gate ?? '');
    const hourOld = !status.lastSnapshotAt || Date.now() - Date.parse(status.lastSnapshotAt) > 3600_000;   // edits and reads change no count: take one at least hourly
    if (!force && !hourOld && gate === status.lastStamp) return false;
    // 1. files not uploaded yet (content-addressed: a hash is uploaded once, ever)
    if (!uploaded) uploaded = new Set((await store.list('blobs/')).map(n => n.slice('blobs/'.length)));
    let files = 0;
    for (const r of all('SELECT hash FROM blobs')) {
      const hash = String(r.hash);
      if (uploaded.has(hash)) continue;
      const data = await blobs.get(hash);
      if (!data) continue;
      await store.put(blobKey(hash), data); uploaded.add(hash); files++;
    }
    // 2. the database, as a consistent copy that carries its own snapshot time (how a stale file is recognised later)
    const at = new Date().toISOString();
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', EPOCH_KEY, at);
    const dir = mkdtempSync(join(tmpdir(), 'thikra-offsite-'));
    const tmp = join(dir, 'snapshot.db');
    try { db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); await store.put(DB_FILE, gzipSync(readFileSync(tmp))); }
    finally { rmSync(dir, { recursive: true, force: true }); }
    // 3. one dated copy a day, the last seven kept (a mistake noticed late can still be undone)
    const day = new Date().toISOString().slice(0, 10), dated = `db/daily/${day}.db.gz`;
    const have = await store.list('db/daily/');
    if (!have.includes(dated)) { const gz = await store.get(DB_FILE); if (gz) await store.put(dated, gz); }
    for (const old of (await store.list('db/daily/')).sort().slice(0, -7)) await store.delete(old);
    // 4. the manifest, last
    const manifest: Manifest = { gate, at, users: Number(one('SELECT COUNT(*) AS n FROM users')!.n), messages: Number(one('SELECT COUNT(*) AS n FROM messages')!.n), blobs: uploaded.size };
    await store.put(MANIFEST, Buffer.from(JSON.stringify(manifest)));
    status.lastStamp = gate; status.lastSnapshotAt = manifest.at; status.lastError = null;
    if (files) console.log(`[offsite] ${files} new file(s) copied off the server`);
    return true;
  } catch (e) { status.lastError = e instanceof Error ? e.message : String(e); console.error('[offsite] snapshot failed:', status.lastError); return false; }
}

/** One snapshot now (a second call while one is running waits for it). Returns true if something was uploaded. */
export function snapshotNow(force = false): Promise<boolean> {
  return (running ??= snapshotOnce(force).finally(() => { running = null; }));
}

/** Start the loop: a first snapshot shortly after start, then every THIKRA_OFFSITE_MINUTES (default 10), and a last one when the server is told to stop. */
export function startOffsite() {
  offsite().then(store => {
    if (!store) return;
    setTimeout(() => { snapshotNow(); }, 30_000).unref();
    setInterval(() => { snapshotNow(); }, Math.max(1, Number(process.env.THIKRA_OFFSITE_MINUTES ?? 10)) * 60_000).unref();
    const last = () => { Promise.race([snapshotNow(), new Promise(r => setTimeout(r, 8000))]).finally(() => process.exit(0)); };
    process.once('SIGTERM', last);
  });
}
