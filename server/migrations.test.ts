process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_REGION = 'ME';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-mig-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { open, one } = await import('./db.ts');
const { migrate, MIGRATIONS } = await import('./migrations/index.ts');
const { baseline } = await import('./migrations/0001_baseline.ts');

const columns = (db: any, table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((r: any) => r.name as string);

test('a fresh database reaches the latest version, and migrating again changes nothing', async () => {
  const db = await open(':memory:');
  const applied = await migrate(db);
  assert.deepEqual(applied, MIGRATIONS.map(m => m.version));
  assert.ok(columns(db, 'users').includes('region') && columns(db, 'circles').includes('region'));
  assert.ok(columns(db, 'users').includes('pin_hash'), 'the baseline has the later columns too');
  assert.deepEqual(await migrate(db), [], 'nothing left to apply');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get()!.n, MIGRATIONS.length);
});

test('a database from before versioning (no schema_migrations) upgrades with its data intact', async () => {
  const db = await open(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  baseline(db);                                    // exactly what the last unversioned release had
  db.prepare('INSERT INTO users (phone, name) VALUES (?, ?)').run('+971500990001', 'Old user');
  db.prepare("INSERT INTO circles (name, owner_id, invite_code) VALUES ('Old family', 1, 'abc')").run();
  const applied = await migrate(db);               // first time the runner sees it
  assert.deepEqual(applied, MIGRATIONS.map(m => m.version));
  assert.equal(db.prepare('SELECT name FROM users WHERE id = 1').get()!.name, 'Old user');
  assert.equal(db.prepare('SELECT name, region FROM circles WHERE id = 1').get()!.region, null, 'existing rows start unassigned');
});

test('a database one version behind gets only the missing one', async () => {
  const db = await open(':memory:');
  await migrate(db, MIGRATIONS.filter(m => m.version === 1));
  db.prepare('INSERT INTO users (phone, name) VALUES (?, ?)').run('+971500990002', 'Before region');
  assert.ok(!columns(db, 'users').includes('region'));
  assert.deepEqual(await migrate(db), MIGRATIONS.filter(m => m.version > 1).map(m => m.version));
  assert.equal(db.prepare('SELECT name FROM users WHERE phone = ?').get('+971500990002')!.name, 'Before region');
});

test('a failing migration rolls back completely and is not recorded', async () => {
  const db = await open(':memory:');
  await migrate(db, MIGRATIONS.filter(m => m.version === 1));
  const bad = { version: 99, name: 'broken', up: (d: any) => { d.exec('CREATE TABLE half_done (x INTEGER)'); d.exec('THIS IS NOT SQL'); } };
  await assert.rejects(() => migrate(db, [...MIGRATIONS, bad]), /migration 99 \(broken\) failed/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'half_done'").get()!.n, 0, 'the half-made table is gone');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version = 99').get()!.n, 0);
});

test('THIKRA_REGION is stored on new people and new circles (and is only stored)', async () => {
  const { app } = await import('./index.ts');
  const call = async (cookie: string | undefined, path: string, body?: unknown) => {
    const res = await app.request(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const phone = '+971500990003';
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode;
  const cookie = (await call(undefined, '/api/auth/verify', { phone, code, name: 'Rima' })).cookie!;
  const c = await call(cookie, '/api/circles', { name: 'Family', kind: 'circle' });
  assert.equal(one('SELECT region FROM users WHERE phone = ?', phone)?.region, 'me');
  assert.equal(one('SELECT region FROM circles WHERE id = ?', c.json.id)?.region, 'me');
});
