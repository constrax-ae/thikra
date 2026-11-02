// Jobs, the error log, costs, the app-version rule, and restoring a backup with a REAL restart (separate server processes on one disk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'thikra-room-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
const dbPath = join(data, 'thikra.db');
const dir = new URL('.', import.meta.url).pathname;

/** Run a script as its own server process on the shared disk. */
function run(name: string, body: string): any {
  const file = join(root, `${name}.mjs`);
  writeFileSync(file, `
    const { app } = await import(${JSON.stringify(dir + 'app.ts')});
    app.get('/api/auth/boom', () => { throw new Error('exploded for +971500000000'); });   // before the server's own catch-all routes
    await import(${JSON.stringify(dir + 'index.ts')});
    const { one, all, run } = await import(${JSON.stringify(dir + 'db.ts')});
    const { createBackup } = await import(${JSON.stringify(dir + 'backup.ts')});
    const { trackJob, jobStatus } = await import(${JSON.stringify(dir + 'lib/jobs.ts')});
    const req = async (cookie, path, body) => { const r = await app.request(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, headers: r.headers, json: await r.json().catch(() => ({})) }; };
    const login = async (phone, name) => { const a = await req(undefined, '/api/auth/request', { phone }); const v = await req(undefined, '/api/auth/verify', { phone, code: a.json.devCode, name }); return v.headers.get('set-cookie').split(';')[0]; };
    const out = await (async () => { ${body} })();
    console.log('RESULT' + JSON.stringify(out));
    process.exit(0);
  `);
  const r = spawnSync(process.execPath, ['--import', 'tsx', file], {
    cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, THIKRA_DB: dbPath, THIKRA_BLOBS: join(data, 'blobs'), THIKRA_BACKUPS: join(root, 'backups'), THIKRA_NO_LISTEN: '1', THIKRA_BACKUP: '0', THIKRA_OFFSITE: 'off', THIKRA_ADMIN_PHONES: '+971500330001' },
  });
  const line = r.stdout.split('\n').find(l => l.startsWith('RESULT'));
  assert.ok(line, `no result from ${name}:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(6));
}

test('the machine room: tracked jobs, a durable error log without phone numbers, costs against a budget, the app-version rule', () => {
  const r = run('room', `
    const owner = await login('+971500330001', 'Owner');
    const sara = await login('+971500330002', 'Sara');
    const boom = await req(sara, '/api/auth/boom');
    await trackJob('demo.job', 1000, () => { throw new Error('cannot reach +971 50 033 0002'); })();
    const first = (await req(owner, '/api/admin/ops')).json;
    const forbidden = (await req(sara, '/api/admin/ops')).status;
    await req(owner, '/api/admin/ops/costs', { hostingUSD: 20, smsEachUSD: 0.1, budgetUSD: 10 });
    const second = (await req(owner, '/api/admin/ops')).json;
    const digest = (await req(owner, '/api/admin/agent/digest')).json;
    const badCfg = (await req(owner, '/api/admin/ops/app-config', { minVersion: 'banana' })).status;
    const okCfg = (await req(owner, '/api/admin/ops/app-config', { minVersion: '1.2.0', latestVersion: '1.3.0', messageAr: 'حدّث', messageEn: 'Update' })).status;
    const pub = (await req(undefined, '/api/app-config')).json;
    return { boom: boom.status, boomBody: boom.json, first: { jobs: first.jobs.map(j => j.name), errors: first.errors, providers: first.providers }, forbidden, costs: second.costs, digest: digest.items.map(i => i.code), badCfg, okCfg, pub };
  `);
  assert.equal(r.boom, 500); assert.deepEqual(r.boomBody, { error: 'server' }, 'the caller never sees a stack');
  assert.ok(r.first.jobs.includes('sealed.release') && r.first.jobs.includes('circles.purge') && r.first.jobs.includes('demo.job'));
  const http = r.first.errors.find((e: any) => e.kind === 'http'), job = r.first.errors.find((e: any) => e.kind === 'job');
  assert.equal(http.route, '/api/auth/boom'); assert.match(http.message, /\[number\]/); assert.ok(!JSON.stringify(r.first.errors).includes('971500000000'), 'no phone number in the log');
  assert.match(job.message, /\[number\]/);
  assert.equal(r.first.providers.sms.real, false); assert.equal(r.first.providers.payments.connected, false);
  assert.equal(r.forbidden, 403);
  assert.equal(r.costs.hostingUSD, 20); assert.ok(r.costs.total >= 20); assert.ok(r.costs.percentOfBudget >= 200);
  assert.ok(r.digest.includes('budget') && r.digest.includes('jobs'), 'the daily list says the budget is blown and a job is failing');
  assert.equal(r.badCfg, 400); assert.equal(r.okCfg, 200);
  assert.deepEqual(r.pub, { minVersion: '1.2.0', latestVersion: '1.3.0', messageAr: 'حدّث', messageEn: 'Update' });
});

test('restore: staged from the admin screen, applied at the next start, the previous database kept, and later work is rolled back', () => {
  const a = run('before', `
    const owner = await login('+971500330001', 'Owner');
    const circle = (await req(owner, '/api/circles', { name: 'Fam', kind: 'circle' })).json.id;
    await req(owner, '/api/circles/' + circle + '/messages', { body: 'before the backup', client_msg_id: 'b1' });
    const m = await createBackup();
    await req(owner, '/api/circles/' + circle + '/messages', { body: 'after the backup', client_msg_id: 'b2' });
    const noConfirm = (await req(owner, '/api/admin/backups/' + m.id + '/restore', {})).status;
    const missing = (await req(owner, '/api/admin/backups/nope/restore', { confirm: 'RESTORE' })).status;
    const staged = await req(owner, '/api/admin/backups/' + m.id + '/restore', { confirm: 'RESTORE' });
    const ops = (await req(owner, '/api/admin/ops')).json;
    const digest = (await req(owner, '/api/admin/agent/digest')).json.items.map(i => i.code);
    return { id: m.id, noConfirm, missing, staged: staged.status, pending: ops.restore.pending?.id, digest, messages: all('SELECT body FROM messages WHERE kind != ?', 'system').map(r => r.body) };
  `);
  assert.equal(a.noConfirm, 400); assert.equal(a.missing, 409); assert.equal(a.staged, 200); assert.equal(a.pending, a.id);
  assert.ok(a.digest.includes('restore_pending'));
  assert.deepEqual(a.messages.sort(), ['after the backup', 'before the backup']);
  assert.ok(existsSync(join(data, 'restore-pending', 'restore.json')), 'staged on disk');

  // the restart: a new process, the same disk
  const b = run('after', `
    const messages = all('SELECT body FROM messages WHERE kind != ?', 'system').map(r => r.body);
    const epoch = one("SELECT value FROM settings WHERE key = 'offsite_epoch'")?.value ?? null;
    const owner = await login('+971500330001', 'Owner');
    const ops = (await req(owner, '/api/admin/ops')).json;
    return { messages, epoch, pending: ops.restore.pending, last: ops.restore.last };
  `);
  assert.deepEqual(b.messages, ['before the backup'], 'the work after the backup is gone: that is what a restore means');
  assert.ok(b.epoch && Date.parse(b.epoch) > 0, 'a fresh epoch, so the off-server copy cannot undo it');
  assert.equal(b.pending, null); assert.equal(b.last.id, a.id);
  assert.ok(readdirSync(data).some(f => f.startsWith('thikra.db.before-restore-')), 'the database from before the restore is kept');
  assert.ok(!existsSync(join(data, 'restore-pending')), 'the staging area is cleaned');
});

test('applying a restore keeps the old database together with its write-ahead log', async () => {
  const { applyPendingRestore, stagePending, readPending } = await import('./pending-restore.ts');
  const { createHash } = await import('node:crypto');
  const { writeFileSync: write, readFileSync: read, readdirSync: ls, existsSync: has } = await import('node:fs');
  const d = mkdtempSync(join(tmpdir(), 'thikra-wal-'));
  const file = join(d, 'thikra.db');
  write(file, 'OLD-MAIN'); write(file + '-wal', 'OLD-WAL'); write(file + '-shm', 'OLD-SHM');
  const source = join(d, 'backup.db'); write(source, 'RESTORED');
  stagePending(file, source, { id: 'b1', at: new Date().toISOString(), by: 'test', dbSha256: createHash('sha256').update('RESTORED').digest('hex'), blobs: [] });
  assert.equal(readPending(file)!.id, 'b1');
  const fake = async () => ({ exec() {}, prepare: () => ({ run: () => ({}) }), close() {} });
  assert.equal(await applyPendingRestore(file, fake as any), true);
  assert.equal(read(file, 'utf8'), 'RESTORED');
  const kept = ls(d).filter(f => f.startsWith('thikra.db.before-restore-'));
  const main = kept.find(f => !f.endsWith('-wal') && !f.endsWith('-shm'))!;
  assert.equal(read(join(d, main), 'utf8'), 'OLD-MAIN');
  assert.equal(read(join(d, main + '-wal'), 'utf8'), 'OLD-WAL', 'the log of the old database is kept with it');
  assert.ok(has(join(d, main + '-shm')));
  assert.ok(!has(file + '-wal'), 'and the restored database starts without the old log');
});
