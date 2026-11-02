// How the admin screen behaves with a lot of data. Seeds a throw-away database with N users and about 20×N messages (plus families, archive, media, reports, activity) using
// plain SQL, then times every list and number the admin screen asks for, as the owner, through the real HTTP handlers.
//   pnpm tsx scripts/scale-test.ts 100000        (100k people, ~2M messages: a few minutes to seed)
// It never touches data/: the database lives in a temp folder and is deleted at the end.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const N = Math.max(1000, Number(process.argv[2] ?? 20000));
const dir = mkdtempSync(join(tmpdir(), 'thikra-scale-'));
process.env.THIKRA_DB = join(dir, 'thikra.db');
process.env.THIKRA_BLOBS = join(dir, 'blobs');
process.env.THIKRA_BACKUPS = join(dir, 'backups');
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';
process.env.THIKRA_OFFSITE = 'off';
process.env.THIKRA_ADMIN_PHONES = '+971500000001';

const { app } = await import('../server/index.ts');
const { db, one, run } = await import('../server/db.ts');

const t0 = performance.now();
const ms = (t: number) => Math.round(performance.now() - t);
const seq = (n: number) => `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${n}) `;

console.log(`seeding ${N} people…`);
db.exec('BEGIN');
db.exec(`${seq(N)} INSERT INTO users (phone, name, lang, created_at) SELECT '+97150' || printf('%07d', i), 'User ' || i, CASE WHEN i % 5 = 0 THEN 'en' ELSE 'ar' END, datetime('now', '-' || (i % 400) || ' days') FROM s WHERE i > 1`);
db.exec('COMMIT');
const owner = one("SELECT id FROM users LIMIT 1") ?? undefined;
void owner;
const fams = Math.floor(N / 4);
db.exec('BEGIN');
db.exec(`${seq(fams)} INSERT INTO circles (name, owner_id, invite_code, kind, created_at) SELECT 'Family ' || i, 1 + (i % ${N - 1}), 'c' || i || 'x', 'circle', datetime('now', '-' || (i % 300) || ' days') FROM s`);
db.exec(`${seq(fams * 4)} INSERT OR IGNORE INTO circle_members (circle_id, user_id, role) SELECT 1 + (i % ${fams}), 1 + (i * 7 % ${N - 1}), 'member' FROM s`);
db.exec('COMMIT');
const msgs = N * 20;
db.exec('BEGIN');
db.exec(`${seq(msgs)} INSERT INTO messages (circle_id, user_id, kind, body, client_msg_id, created_at) SELECT 1 + (i % ${fams}), 1 + (i % ${N - 1}), 'text', 'm', NULL, datetime('now', '-' || (i % 30) || ' days', '-' || (i % 1440) || ' minutes') FROM s`);
db.exec('COMMIT');
db.exec('BEGIN');
db.exec(`${seq(fams)} INSERT OR IGNORE INTO activity (user_id, day) SELECT 1 + (i % ${N - 1}), date('now', '-' || (i % 30) || ' days') FROM s`);
db.exec(`${seq(Math.floor(N / 50))} INSERT INTO reports (reporter_id, reported_user_id, circle_id, reason, status, created_at) SELECT 1 + (i % ${N - 1}), 1 + ((i * 3) % ${N - 1}), 1 + (i % ${fams}), 'spam', CASE WHEN i % 3 = 0 THEN 'open' ELSE 'resolved' END, datetime('now', '-' || (i % 90) || ' days') FROM s`);
db.exec(`${seq(fams * 3)} INSERT OR IGNORE INTO blobs (hash, size) SELECT printf('%064x', i), 200000 + (i % 5000) * 100 FROM s`);
db.exec(`${seq(fams * 3)} INSERT INTO media (circle_id, uploader_id, blob_hash, kind, mime, size, archived, created_at) SELECT 1 + (i % ${fams}), 1 + (i % ${N - 1}), printf('%064x', i), 'image', 'image/jpeg', 200000 + (i % 5000) * 100, 1, datetime('now', '-' || (i % 20) || ' days') FROM s`);
db.exec('COMMIT');
console.log(`seeded in ${Math.round(ms(t0) / 1000)} s: ${one('SELECT COUNT(*) n FROM users')!.n} users, ${one('SELECT COUNT(*) n FROM circles')!.n} families, ${one('SELECT COUNT(*) n FROM messages')!.n} messages\n`);

// the owner (user 1) signs in the real way
const call = async (path: string, cookie?: string, body?: unknown) => { const r = await app.request(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.text(), cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
const code = JSON.parse((await call('/api/auth/request', undefined, { phone: '+971500000001' })).body).devCode;
const cookie = (await call('/api/auth/verify', undefined, { phone: '+971500000001', code, name: 'Owner' })).cookie!;
run("UPDATE users SET admin_role = 'owner', is_admin = 1 WHERE phone = '+971500000001'");

// how long the server was frozen at a stretch while all this ran (a timer that should tick every 10 ms)
let lag = 0, last = performance.now();
const timer = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - last - 10); last = now; }, 10);
const rows: Array<[string, number, number]> = [];
async function time(label: string, path: string) {
  const t = performance.now();
  const r = await call(path, cookie);
  const took = ms(t);
  rows.push([label, took, r.status]);
}
const first = async (label: string, path: string) => { await time(`${label} (first)`, path); await time(`${label} (again)`, path); };
await first('stats', '/api/admin/stats');
await first('analytics', '/api/admin/analytics');
await first('people list', '/api/admin/users');
await time('people search by name', '/api/admin/users?q=User%2099');
await time('people search by last digits', '/api/admin/users?q=0001234');
await time('people filter inactive 30 days', '/api/admin/users?filter=inactive30');
await first('families list', '/api/admin/families');
await time('families near the limit', '/api/admin/families?filter=near_quota');
await first('capacity', '/api/admin/capacity');
await first('storage (families by usage)', '/api/admin/storage');
await first('reports', '/api/admin/reports');
await first('circles (admin list)', '/api/admin/circles');
await first('agent digest', '/api/admin/agent/digest');
await time('audit export', '/api/admin/audit/export');

const { refreshAll } = await import('../server/lib/rollups.ts');
lag = 0; last = performance.now();
const t1 = performance.now(); await refreshAll(); console.log(`background rollups (chunked): ${Math.round((performance.now() - t1) / 1000)} s, longest freeze of the server while it ran: ${Math.round(lag)} ms`);
clearInterval(timer);
console.log('what the admin screen asks for'.padEnd(46) + 'ms'.padStart(8) + '  status');
for (const [l, t, s] of rows) console.log(l.padEnd(46) + String(t).padStart(8) + `  ${s}`);
// where the agent's daily list spends its time
const { anomalies, forecast, triageReports } = await import('../server/lib/insights.ts');
const { capacitySummary } = await import('../server/lib/capacity.ts');
const { overview } = await import('../server/lib/opsinfo.ts');
const { TOOLS } = await import('../server/lib/opsagent.ts');
console.log('\nthe agent\'s daily list, by part');
for (const [label, fn] of [['anomalies', anomalies], ['forecast', forecast], ['triage reports', triageReports], ['capacity summary', capacitySummary], ['operations overview', overview], ['open support', () => TOOLS.open_support.run()], ['families near quota', () => TOOLS.families_near_quota.run()]] as Array<[string, () => unknown]>) {
  const t = performance.now(); fn(); console.log(label.padEnd(46) + String(ms(t)).padStart(8));
}
rmSync(dir, { recursive: true, force: true });
process.exit(0);
