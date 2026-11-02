process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+971500990101';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-scale-t-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { all, one, run } = await import('./db.ts');
const { refreshAll, refreshStats, refreshUsage, resetRollups, statsSeries, totals, usageTop } = await import('./lib/rollups.ts');
const { usage } = await import('./billing.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), res, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
async function signUp(phone: string, name: string) {
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode as string;
  const v = await call(undefined, '/api/auth/verify', { phone, code, name });
  return { cookie: v.cookie!, id: (await call(v.cookie, '/api/me')).json.id as number };
}
const owner = await signUp('+971500990101', 'Owner');
const mod = await signUp('+971500990102', 'Moderator');
const alice = await signUp('+971500990103', '=Alice');
await call(owner.cookie, `/api/admin/users/${mod.id}/role`, { role: 'moderator' });
const fam = (await call(alice.cookie, '/api/circles', { name: 'Alice family', kind: 'circle' })).json.id as number;
const fam2 = (await call(alice.cookie, '/api/circles', { name: 'Second', kind: 'circle' })).json.id as number;

test('the daily rows match the live counts, fill 30 days, and the analytics screen reads them', async () => {
  refreshStats();
  assert.equal(Number(one('SELECT COUNT(*) n FROM daily_stats')!.n), 30);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(one('SELECT signups FROM daily_stats WHERE day = ?', today)!.signups, one("SELECT COUNT(*) n FROM users WHERE date(created_at) = ?", today)!.n);
  assert.ok(one('SELECT circles FROM daily_stats WHERE day = ?', today)!.circles >= 2);
  const series = statsSeries(30);
  assert.equal(series.length, 30); assert.equal(series[29].d, today);
  const a = (await call(owner.cookie, '/api/admin/analytics')).json;
  assert.equal(a.days.length, 30); assert.equal(a.days[29].signups, series[29].signups);
  assert.ok('wau' in a && 'mau' in a && 'retention' in a);
});

test('totals are stored and served from the store (an hourly job refreshes them); a family\'s archive size comes from its own rollup', async () => {
  resetRollups();
  const first = totals();
  run("INSERT INTO users (phone, name) VALUES ('+971500990199', 'late')");
  assert.equal(totals().users, first.users, 'served from the store');
  assert.equal((await call(owner.cookie, '/api/admin/stats')).json.users, first.users);
  await refreshAll();
  assert.equal(totals().users, first.users + 1, 'the hourly refresh brings it up to date');

  const put = (h: string, circle: number, size: number) => { run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', h, size); run("INSERT INTO media (circle_id, uploader_id, blob_hash, kind, mime, size, archived) VALUES (?, ?, ?, 'image', 'image/jpeg', ?, 1)", circle, alice.id, h, size); };
  put('s1', fam, 1000); put('s1', fam, 1000);          // the same file twice counts once
  put('s2', fam, 500); put('s3', fam2, 4000);
  refreshUsage();
  const top = usageTop(10);
  assert.deepEqual(top.map(t => t.id), [fam2, fam], 'biggest first');
  assert.equal(top.find(t => t.id === fam)!.used, usage(fam).archivedBytes, 'the rollup agrees with the live number');
  assert.equal(usage(fam).archivedBytes, 1500);
  const storage = (await call(owner.cookie, '/api/admin/storage')).json;
  assert.ok(storage.circles.some((c: any) => c.id === fam2 && c.usedBytes === 4000));
});

test('the admin circle list is paged by a cursor, and the people list shows when someone was last active', async () => {
  const page1 = (await call(owner.cookie, '/api/admin/circles')).json as any[];
  assert.ok(page1.length >= 2 && page1.length <= 100);
  const older = (await call(owner.cookie, `/api/admin/circles?before=${page1[0].id}`)).json as any[];
  assert.ok(older.every(c => c.id < page1[0].id));
  const people = (await call(owner.cookie, '/api/admin/users?limit=5')).json as any[];
  assert.ok(people.length <= 50 && people.every(p => 'lastActive' in p));
});

test('spreadsheets of families and people: owner only, numbers masked, formulas defused, and taking them is on record', async () => {
  const f = await app.request('/api/admin/export/families', { headers: { cookie: owner.cookie } });
  assert.equal(f.status, 200); assert.match(f.headers.get('content-type') ?? '', /text\/csv/);
  const fcsv = await f.text();
  assert.match(fcsv, /id,name,created,members,archived,plan,status,used_gb,quota_gb,percent,open_reports,frozen,last_activity/);
  assert.match(fcsv, /Alice family/);
  const p = await (await app.request('/api/admin/export/people', { headers: { cookie: owner.cookie } })).text();
  assert.ok(p.includes('"\'=Alice"'), 'a name that starts like a formula is defused');
  assert.ok(!p.includes('9715009901'), 'numbers are masked');
  assert.equal((await app.request('/api/admin/export/people', { headers: { cookie: mod.cookie } })).status, 403);
  assert.equal((await app.request('/api/admin/export/families', { headers: { cookie: mod.cookie } })).status, 403);
  assert.equal((await app.request('/api/admin/export/people', { headers: { cookie: alice.cookie } })).status, 403);
  assert.ok(Number(one("SELECT COUNT(*) n FROM admin_audit WHERE action IN ('export.people','export.families')")!.n) >= 2);
  void all;
});

test('on a big database nothing heavy runs inside a request: stored values are served, and the same numbers are built in chunks in the background', async () => {
  // make the data look "big" (the limit is read at call time) and the chunks tiny, so the chunked paths run on this small data
  const put = (h: string, circle: number, size: number) => { run('INSERT OR IGNORE INTO blobs (hash, size, created_at) VALUES (?, ?, datetime(\'now\', \'-30 days\'))', h, size); run("INSERT INTO media (circle_id, uploader_id, blob_hash, kind, mime, size, archived) VALUES (?, ?, ?, 'image', 'image/jpeg', ?, 1)", circle, alice.id, h, size); };
  put('b1', fam, 700); put('b2', fam2, 300);
  run("INSERT OR IGNORE INTO blobs (hash, size, created_at) VALUES ('orphan1', 99, datetime('now', '-30 days'))");
  for (let i = 0; i < 5; i++) run("INSERT INTO messages (circle_id, user_id, kind, body, client_msg_id) VALUES (?, ?, 'text', 'x', ?)", fam, alice.id, `chunk${i}`);
  await refreshAll();                                               // small mode: the exact inline numbers
  const exact = { totals: totals(), usage: usageTop(10), orphans: (await import('./lib/rollups.ts')).orphansReport(), windows: (await import('./lib/rollups.ts')).activityWindows() };

  process.env.THIKRA_ROLLUP_SMALL_LIMIT = '0'; process.env.THIKRA_ROLLUP_CHUNK = '3';
  resetRollups(); run('DELETE FROM circle_usage'); run("DELETE FROM settings WHERE key = 'messages_count'");
  assert.equal(totals().users, 0, 'big mode, nothing stored yet: a request gets an empty value and does not scan');
  await new Promise(r => setTimeout(r, 400));                       // the background refresh the request started
  await refreshAll();                                               // (and an explicit run, in case it was still going)
  assert.deepEqual(totals(), exact.totals, 'chunked totals equal the exact ones, messages included');
  assert.deepEqual(usageTop(10), exact.usage, 'chunked family sizes equal the exact ones');
  const roll = await import('./lib/rollups.ts');
  assert.deepEqual(roll.orphansReport(), exact.orphans);
  assert.deepEqual(roll.activityWindows(), exact.windows);
  // the incremental message count adds only what is new
  run("INSERT INTO messages (circle_id, user_id, kind, body, client_msg_id) VALUES (?, ?, 'text', 'x', 'chunk-new')", fam, alice.id);
  await refreshAll();
  assert.equal(totals().messages, exact.totals.messages + 1);
  delete process.env.THIKRA_ROLLUP_SMALL_LIMIT; delete process.env.THIKRA_ROLLUP_CHUNK;
});
