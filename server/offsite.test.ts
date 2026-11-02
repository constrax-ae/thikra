// The off-server copy, tested with REAL restarts: separate server processes, a wiped disk, a stale file brought back by a republish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'thikra-offsite-test-'));
const store = join(root, 'offsite'), data = join(root, 'data');
mkdirSync(data, { recursive: true });
const dbPath = join(data, 'thikra.db'), blobDir = join(data, 'blobs');
const idx = new URL('./index.ts', import.meta.url).pathname, off = new URL('./offsite.ts', import.meta.url).pathname;

/** Run a script as its own server process, on this disk and this off-server folder. */
function run(name: string, body: string): any {
  const file = join(root, `${name}.mjs`);
  writeFileSync(file, `
    const { app } = await import(${JSON.stringify(idx)});
    const { snapshotNow } = await import(${JSON.stringify(off)});
    const { one, all, run } = await import(${JSON.stringify(new URL('./db.ts', import.meta.url).pathname)});
    const { blobs } = await import(${JSON.stringify(new URL('./storage.ts', import.meta.url).pathname)});
    const req = async (cookie, path, body) => { const r = await app.request(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, headers: r.headers, json: await r.json().catch(() => ({})) }; };
    const login = async (phone, name) => { const a = await req(undefined, '/api/auth/request', { phone }); const v = await req(undefined, '/api/auth/verify', { phone, code: a.json.devCode, name }); return v.headers.get('set-cookie').split(';')[0]; };
    const out = await (async () => { ${body} })();
    console.log('RESULT' + JSON.stringify(out));
    process.exit(0);
  `);
  const r = spawnSync(process.execPath, ['--import', 'tsx', file], {
    cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, THIKRA_DB: dbPath, THIKRA_BLOBS: blobDir, THIKRA_BACKUPS: join(root, 'backups'), THIKRA_NO_LISTEN: '1', THIKRA_OFFSITE: `dir:${store}`, THIKRA_BACKUP: '0' },
  });
  const line = r.stdout.split('\n').find(l => l.startsWith('RESULT'));
  assert.ok(line, `no result from ${name}:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(6));
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const wipeDisk = () => { for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm', dbPath + '.lock', dbPath + '.pid', blobDir]) rmSync(p, { recursive: true, force: true }); };

test('off-server copy: a wiped disk gets the family back, files included; a stale file is replaced; a newer local file is never overwritten', async () => {
  // 1. a family writes a message and a photo, and a snapshot goes out
  const first = run('one', `
    const c = await login('+966500011111', 'سارة');
    const id = (await req(c, '/api/circles', { name: 'عائلتنا' })).json.id;
    await req(c, '/api/circles/' + id + '/messages', { body: 'رسالة باقية', client_msg_id: 'a1' });
    const fd = new FormData(); fd.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...new Array(300).fill(9)])], 'p.jpg', { type: 'image/jpeg' }));
    const up = await app.request('/api/circles/' + id + '/attachments', { method: 'POST', headers: { cookie: c }, body: fd });
    const media = one('SELECT blob_hash FROM media LIMIT 1');
    const sent = await snapshotNow(true);
    return { sent, upload: up.status, hash: media.blob_hash };
  `);
  assert.equal(first.sent, true); assert.equal(first.upload, 201);
  assert.ok(existsSync(join(store, 'db', 'manifest.json')) && existsSync(join(store, 'db', 'thikra.db.gz')), 'the snapshot is in the off-server folder');
  assert.ok(existsSync(join(store, 'blobs', first.hash)), 'and so is the photo');
  copyFileSync(dbPath, join(root, 'stale.db'));   // what a republish would bring back later

  // 2. the disk is wiped (a new machine): the next start restores the database, and the photo comes back when asked for
  wipeDisk();
  const second = run('two', `
    const n = { users: one('SELECT COUNT(*) n FROM users').n, messages: one("SELECT COUNT(*) n FROM messages WHERE body = 'رسالة باقية'").n };
    const photo = await blobs.get(${JSON.stringify(first.hash)});
    return { ...n, photoBytes: photo ? photo.length : 0 };
  `);
  assert.equal(second.users, 1, 'the person is back'); assert.equal(second.messages, 1, 'and the message');
  assert.ok(second.photoBytes > 300, 'and the photo, fetched on first use');

  // 3. more happens, then a STALE database file comes back over the live one (a republish): the newer off-server copy wins
  await wait(1200);
  const third = run('three', `
    const c = await login('+966500011111', 'سارة');
    const id = all('SELECT id FROM circles')[0].id;
    await req(c, '/api/circles/' + id + '/messages', { body: 'رسالة بعد الاستعادة', client_msg_id: 'a2' });
    return { sent: await snapshotNow(true), messages: one("SELECT COUNT(*) n FROM messages WHERE kind != 'system'").n };
  `);
  assert.equal(third.sent, true);
  for (const p of [dbPath + '-wal', dbPath + '-shm']) rmSync(p, { force: true });
  copyFileSync(join(root, 'stale.db'), dbPath);
  const fourth = run('four', `return { messages: one("SELECT COUNT(*) n FROM messages WHERE body = 'رسالة بعد الاستعادة'").n };`);
  assert.equal(fourth.messages, 1, 'the stale file was replaced by the newer copy');

  // 4. the live disk is NEWER than the off-server copy (no snapshot yet): it must not be rolled back
  await wait(1200);
  const fifth = run('five', `
    const c = await login('+966500011111', 'سارة');
    const id = all('SELECT id FROM circles')[0].id;
    await req(c, '/api/circles/' + id + '/messages', { body: 'لم تُرفع بعد', client_msg_id: 'a3' });
    return { here: one("SELECT COUNT(*) n FROM messages WHERE body = 'لم تُرفع بعد'").n };
  `);
  assert.equal(fifth.here, 1);
  const sixth = run('six', `return { still: one("SELECT COUNT(*) n FROM messages WHERE body = 'لم تُرفع بعد'").n };`);
  assert.equal(sixth.still, 1, 'newer local data is never overwritten by an older copy');
});
