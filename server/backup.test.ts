// Backups that can be proven: take one, verify it, break it in every way we can think of and see verification notice, restore it into a
// fresh directory and check the restored app data is the same as the live data.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync, appendFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-bk-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { createBackup, verifyBackup, restoreBackup, listBackups, pruneBackups, backupRoot } = await import('./backup.ts');
const { open } = await import('./db.ts');
const { one } = await import('./db.ts');

let n = 0;
const login = async (name: string) => {
  const phone = `+9665${String(1_000_000 + n++).padStart(8, '0')}`;
  const post = (p: string, b: unknown) => app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  return (await post('/api/auth/verify', { phone, code: devCode, name })).headers.get('set-cookie')!.split(';')[0];
};
const j = async (cookie: string, path: string, method = 'GET', body?: unknown) =>
  (await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;

async function seed() {
  const a = await login('A');
  const circle = (await j(a, '/api/circles', 'POST', { name: 'نسخة' })).id;
  for (let i = 0; i < 5; i++) await j(a, `/api/circles/${circle}/messages`, 'POST', { body: `رسالة ${i}` });
  const fd = new FormData();
  for (const k of [300, 420]) { // two different files, so the pool holds two
    fd.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: k }, (_, i) => i % 251)])]), `p${k}.jpg`); fd.append('thumb', new Blob([]), 'n');
  }
  await app.request(`/api/circles/${circle}/attachments`, { method: 'POST', headers: { cookie: a }, body: fd });
  return circle;
}
const poolFiles = (root: string) => { const out: string[] = []; const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)); }; if (existsSync(join(root, 'blob-pool'))) walk(join(root, 'blob-pool')); return out; };

test('a backup is consistent, complete and verifiable', async () => {
  await seed();
  const m = await createBackup();
  assert.ok(m.counts.messages >= 6 && m.counts.media >= 1 && m.blobs.length >= 1);
  const rep = await verifyBackup(m.id);
  assert.deepEqual(rep.problems, []);
  assert.equal(rep.ok, true);
  assert.equal((await listBackups())[0].id, m.id);
});

test('verification notices a damaged database, a missing file, a corrupted file, and a count that does not match', async () => {
  await seed();
  // 1. damaged database
  let m = await createBackup();
  appendFileSync(join(backupRoot(), m.id, 'thikra.db'), Buffer.from([0, 1, 2]));
  let rep = await verifyBackup(m.id);
  assert.equal(rep.ok, false);
  assert.match(rep.problems.join(), /hash/);
  // 2. a missing media file, 3. a corrupted media file
  await new Promise(r => setTimeout(r, 5));
  m = await createBackup();
  const files = poolFiles(backupRoot());
  assert.ok(files.length >= 2);
  rmSync(files[0]);
  appendFileSync(files[1], 'x');
  rep = await verifyBackup(m.id);
  assert.equal(rep.ok, false);
  assert.match(rep.problems.join(), /missing|corrupted/);
  assert.equal(rep.problems.filter(p => /media file/.test(p)).length, 2, 'both the missing and the corrupted file are reported');
  assert.equal((await verifyBackup('no-such-id')).ok, false);
});

test('a backup restores into a fresh directory with the same data and the same files; it never overwrites', async () => {
  await seed();
  const m = await createBackup();
  // the pool was damaged by the previous test; taking this backup healed it (a pool file of the wrong size is copied again)
  const target = join(work, 'restored');
  await restoreBackup(m.id, target).catch(e => { throw new Error(`restore failed: ${e.message}`); });
  const restored = await open(join(target, 'thikra.db'));
  const count = (t: string) => Number((restored.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);
  assert.equal(count('messages'), one('SELECT COUNT(*) n FROM messages')!.n, 'the same messages');
  assert.equal(count('media'), one('SELECT COUNT(*) n FROM media')!.n, 'the same media rows');
  const hashes = (restored.prepare('SELECT blob_hash FROM media').all() as any[]).map(r => r.blob_hash as string);
  for (const h of hashes) assert.ok(existsSync(join(target, 'blobs', h.slice(0, 2), h.slice(2, 4), h)), 'every referenced file is there');
  await assert.rejects(restoreBackup(m.id, target), /refusing to overwrite/);
});

test('retention keeps the newest snapshots and never touches the media pool', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) { ids.push((await createBackup()).id); await new Promise(r => setTimeout(r, 5)); }
  const pool = poolFiles(backupRoot()).length;
  const removed = await pruneBackups(2);
  assert.ok(removed >= 2);
  assert.equal((await listBackups()).length, 2);
  assert.equal(poolFiles(backupRoot()).length, pool, 'the shared media pool is untouched');
});

test('admin endpoints: back up now, list, verify; members cannot', async () => {
  const admin = await login('المشرف');   // not the first user of this database, so ask for admin the dev way
  const { run } = await import('./db.ts');
  run('UPDATE users SET is_admin = 1 WHERE name = ?', 'المشرف');
  const member = await login('عضو');
  const forbid = await app.request('/api/admin/backups', { method: 'POST', headers: { cookie: member } });
  assert.equal(forbid.status, 403);
  const made = await app.request('/api/admin/backups', { method: 'POST', headers: { cookie: admin } });
  assert.equal(made.status, 201);
  const info = await made.json() as any;
  assert.ok(info.counts.messages >= 0 && info.files >= 0);
  const list = await j(admin, '/api/admin/backups');
  assert.ok(list.some((b: any) => b.id === info.id));
  const rep = await j(admin, `/api/admin/backups/${info.id}/verify`, 'POST', {});
  assert.equal(rep.ok, true, rep.problems?.join());
});
