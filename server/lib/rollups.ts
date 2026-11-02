import { all, one, run } from '../db.ts';
import { logError } from './jobs.ts';

// Numbers the admin screen shows are computed in the background and stored, so opening the screen costs a few rows, not a scan of millions (see scripts/scale-test.ts).
//  - daily_stats    one row per day for the last 30 days
//  - circle_usage   archived bytes per family
//  - totals / windows / orphans (people, messages…; weekly and monthly active people, retention; unreferenced files) kept in `settings` with the time they were computed
//
// SQLite here is synchronous: one long query freezes the whole server (chat included) while it runs. So:
//  - a SMALL database (no big table) computes inline, in microseconds, exactly as before;
//  - a BIG one never computes inside a request: a request gets the stored value (or empty) and the work runs in the background in CHUNKS (an id range at a time),
//    yielding to the event loop between chunks, so no single step holds the server for more than a moment.
const TTL = () => Number(process.env.THIKRA_ROLLUP_TTL_MS ?? 3_600_000);
const SMALL_LIMIT = () => Number(process.env.THIKRA_ROLLUP_SMALL_LIMIT ?? 200_000);
const CHUNK = () => Math.max(1, Number(process.env.THIKRA_ROLLUP_CHUNK ?? 100_000));
const dayStr = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const maxId = (table: string) => Number(one(`SELECT COALESCE(MAX(rowid), 0) n FROM ${table}`)!.n);
/** No table is big (the newest row ids are cheap to read): fine to compute inline. */
export const isSmall = () => maxId('messages') < SMALL_LIMIT() && maxId('users') < SMALL_LIMIT() && maxId('media') < SMALL_LIMIT() * 2;

const store = (key: string, v: unknown) => run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, JSON.stringify({ at: Date.now(), v }));
const readRow = (key: string): { at: number; v: any } | null => { try { const r = one('SELECT value FROM settings WHERE key = ?', key)?.value; return r ? JSON.parse(String(r)) : null; } catch { return null; } };
/** Stored value when fresh; otherwise recompute inline on a small database, or serve the old one (and refresh in the background) on a big one. */
function serve<T>(key: string, inline: () => T, empty: T): T {
  const row = readRow(key);
  if (row && Date.now() - row.at < TTL()) return row.v as T;
  if (isSmall()) { const v = inline(); store(key, v); return v; }
  kick();
  return row ? (row.v as T) : empty;
}
/** Forget what was computed: the next read computes again (used after a change that must show at once, and by tests). */
export const resetRollups = () => run("DELETE FROM settings WHERE key IN ('platform_totals', 'activity_windows', 'usage_at', 'orphans')");

const tick = () => new Promise<void>(r => setImmediate(r));
async function eachRange(from: number, max: number, step: number, fn: (a: number, b: number) => void) { for (let a = from; a <= max; a += step) { fn(a, a + step); await tick(); } }
const n = (sql: string, ...args: unknown[]) => Number(one(sql, ...args)!.n);

// ---- one row per day --------------------------------------------------------------------------------------------------------------
export function rollupDay(day: string) {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const a = `${day} 00:00:00`, b = `${next} 00:00:00`;
  run('INSERT OR REPLACE INTO daily_stats (day, signups, active, messages, circles, reports, support) VALUES (?, ?, ?, ?, ?, ?, ?)', day,
    n('SELECT COUNT(*) n FROM users WHERE created_at >= ? AND created_at < ?', a, b),
    n('SELECT COUNT(*) n FROM activity WHERE day = ?', day),
    n("SELECT COUNT(*) n FROM messages WHERE kind != 'system' AND created_at >= ? AND created_at < ?", a, b),
    n("SELECT COUNT(*) n FROM circles WHERE kind != 'direct' AND created_at >= ? AND created_at < ?", a, b),
    n('SELECT COUNT(*) n FROM reports WHERE created_at >= ? AND created_at < ?', a, b),
    n('SELECT COUNT(*) n FROM support_cases WHERE created_at >= ? AND created_at < ?', a, b));
}
const missingDays = () => { const have = new Set(all('SELECT day FROM daily_stats').map(r => String(r.day))); const out: string[] = []; for (let i = 29; i >= 0; i--) { const d = dayStr(-i); if (i <= 1 || !have.has(d)) out.push(d); } return out; };
/** Today and yesterday are always recomputed; any of the last 30 days that has no row yet is filled (the first run backfills). */
export function refreshStats() {
  for (const d of missingDays()) rollupDay(d);
  run("DELETE FROM daily_stats WHERE day < date('now', '-60 days')");
}
async function refreshStatsChunked() { for (const d of missingDays()) { rollupDay(d); await tick(); } run("DELETE FROM daily_stats WHERE day < date('now', '-60 days')"); }
/** The last `days` days (a day with no row counts as zero). A stale "today" is rebuilt on the spot on a small database, in the background on a big one. */
export function statsSeries(days: number) {
  const today = one('SELECT at FROM daily_stats WHERE day = ?', dayStr());
  if (!today || Date.now() - Date.parse(String(today.at).replace(' ', 'T') + 'Z') > 600_000) { if (isSmall()) refreshStats(); else kick(); }
  const rows = new Map(all('SELECT * FROM daily_stats WHERE day >= ?', dayStr(-(days - 1))).map(r => [String(r.day), r]));
  const out: Array<{ d: string; signups: number; dau: number; messages: number; circles: number; reports: number; support: number }> = [];
  for (let i = days - 1; i >= 0; i--) { const d = dayStr(-i), r = rows.get(d); out.push({ d, signups: r?.signups ?? 0, dau: r?.active ?? 0, messages: r?.messages ?? 0, circles: r?.circles ?? 0, reports: r?.reports ?? 0, support: r?.support ?? 0 }); }
  return out;
}

// ---- families' archive size ---------------------------------------------------------------------------------------------------------
const USAGE_SQL = 'INSERT INTO circle_usage (circle_id, archived_bytes) SELECT circle_id, SUM(size) FROM (SELECT DISTINCT circle_id, blob_hash, size FROM media WHERE archived = 1';
/** Rebuild the archived bytes of every family in one pass (distinct files only), inside one transaction. */
export function refreshUsage() {
  run('BEGIN');
  try { run('DELETE FROM circle_usage'); run(`${USAGE_SQL}) GROUP BY circle_id`); run('COMMIT'); } catch (e) { run('ROLLBACK'); throw e; }
  store('usage_at', true);
}
async function refreshUsageChunked() {
  await eachRange(0, maxId('circles'), Math.max(1, Math.floor(CHUNK() / 20)), (a, b) => {
    run('BEGIN');
    try { run('DELETE FROM circle_usage WHERE circle_id >= ? AND circle_id < ?', a, b); run(`${USAGE_SQL} AND circle_id >= ? AND circle_id < ?) GROUP BY circle_id`, a, b); run('COMMIT'); } catch (e) { run('ROLLBACK'); throw e; }
  });
  store('usage_at', true);
}
/** Families by archive size, biggest first (from the rollup; never a scan of every media row). */
export function usageTop(limit: number): Array<{ id: number; used: number }> {
  serve('usage_at', () => { refreshUsage(); return true; }, true);
  return all('SELECT circle_id AS id, archived_bytes AS used FROM circle_usage ORDER BY archived_bytes DESC LIMIT ?', limit).map(r => ({ id: Number(r.id), used: Number(r.used) }));
}

// ---- totals ---------------------------------------------------------------------------------------------------------------------------
export interface Totals { users: number; circles: number; activeCircles: number; messages: number; archived: number; byCategory: Array<{ category: string; n: number }> }
const EMPTY_TOTALS: Totals = { users: 0, circles: 0, activeCircles: 0, messages: 0, archived: 0, byCategory: [] };
const computeTotals = (): Totals => ({
  users: n('SELECT COUNT(*) n FROM users'),
  circles: n('SELECT COUNT(*) n FROM circles WHERE deleted_at IS NULL'),
  activeCircles: n('SELECT COUNT(*) n FROM circles WHERE agent_active = 1'),
  messages: n("SELECT COUNT(*) n FROM messages WHERE kind != 'system'"),
  archived: n('SELECT COUNT(*) n FROM archive_entries WHERE deleted_at IS NULL'),
  byCategory: all("SELECT COALESCE(category, 'other') AS category, COUNT(*) AS n FROM archive_entries WHERE deleted_at IS NULL GROUP BY category").map(r => ({ category: String(r.category), n: Number(r.n) })),
});
/** Chunked and, for messages, incremental: only ids above the last counted one are counted again (a full recount once a week catches hard deletes). */
async function totalsChunked(): Promise<Totals> {
  const step = CHUNK(), t: Totals = { ...EMPTY_TOTALS, byCategory: [] };
  const sum = async (table: string, extra: string) => { let total = 0; await eachRange(0, maxId(table), step, (a, b) => { total += n(`SELECT COUNT(*) n FROM ${table} WHERE rowid >= ? AND rowid < ?${extra}`, a, b); }); return total; };
  t.users = await sum('users', '');
  t.circles = await sum('circles', ' AND deleted_at IS NULL');
  t.activeCircles = await sum('circles', ' AND agent_active = 1');
  t.archived = await sum('archive_entries', ' AND deleted_at IS NULL');
  const cats = new Map<string, number>();
  await eachRange(0, maxId('archive_entries'), step, (a, b) => { for (const r of all("SELECT COALESCE(category, 'other') AS category, COUNT(*) AS c FROM archive_entries WHERE deleted_at IS NULL AND rowid >= ? AND rowid < ? GROUP BY 1", a, b)) cats.set(String(r.category), (cats.get(String(r.category)) ?? 0) + Number(r.c)); });
  t.byCategory = [...cats].map(([category, c]) => ({ category, n: c }));
  const prev = readRow('messages_count')?.v as { lastId: number; count: number; fullAt: number } | undefined;
  const fresh = !prev || Date.now() - prev.fullAt > 7 * 86_400_000;
  let count = fresh ? 0 : prev!.count, last = fresh ? 0 : prev!.lastId;
  const top = maxId('messages');
  await eachRange(last + 1, top, step, (a, b) => { count += n("SELECT COUNT(*) n FROM messages WHERE kind != 'system' AND id >= ? AND id < ?", a, b); last = Math.min(top, b - 1); });
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'messages_count', JSON.stringify({ at: Date.now(), v: { lastId: last, count, fullAt: fresh ? Date.now() : prev!.fullAt } }));
  t.messages = count;
  return t;
}
export const totals = (): Totals => serve('platform_totals', computeTotals, EMPTY_TOTALS);

// ---- active people and retention -----------------------------------------------------------------------------------------------------
const retentionSql = (days: number, range: string) => `SELECT COUNT(*) AS cohort, COALESCE(SUM(EXISTS(SELECT 1 FROM activity a WHERE a.user_id = u.id AND a.day = date(u.created_at, '+${days} days'))), 0) AS kept
       FROM users u WHERE date(u.created_at) <= date('now', '-${days} days') AND date(u.created_at) >= date('now', '-${days + 29} days') AND date(u.created_at) >= COALESCE((SELECT MIN(day) FROM activity), '9999')${range}`;
const rate = (cohort: number, kept: number) => ({ cohort, kept, rate: cohort ? Math.round((kept / cohort) * 1000) / 10 : null });
export interface Windows { wau: number; mau: number; trackingSince: string | null; retention: { d1: ReturnType<typeof rate>; d7: ReturnType<typeof rate>; d30: ReturnType<typeof rate> } }
const EMPTY_WINDOWS: Windows = { wau: 0, mau: 0, trackingSince: null, retention: { d1: rate(0, 0), d7: rate(0, 0), d30: rate(0, 0) } };
const computeWindows = (): Windows => {
  const ret = (d: number) => { const r = one(retentionSql(d, ''))!; return rate(Number(r.cohort), Number(r.kept)); };
  return {
    wau: n("SELECT COUNT(DISTINCT user_id) n FROM activity WHERE day >= date('now', '-6 days')"), mau: n("SELECT COUNT(DISTINCT user_id) n FROM activity WHERE day >= date('now', '-29 days')"),
    trackingSince: (one('SELECT MIN(day) d FROM activity')?.d ?? null) as string | null, retention: { d1: ret(1), d7: ret(7), d30: ret(30) },
  };
};
/** The same numbers, one range of people at a time (a person is in exactly one range, so the sums are exact). */
async function windowsChunked(): Promise<Windows> {
  const step = CHUNK(), top = maxId('users');
  let wau = 0, mau = 0;
  const cohort = { 1: [0, 0], 7: [0, 0], 30: [0, 0] } as Record<number, number[]>;
  await eachRange(0, top, step, (a, b) => {
    wau += n("SELECT COUNT(DISTINCT user_id) n FROM activity WHERE user_id >= ? AND user_id < ? AND day >= date('now', '-6 days')", a, b);
    mau += n("SELECT COUNT(DISTINCT user_id) n FROM activity WHERE user_id >= ? AND user_id < ? AND day >= date('now', '-29 days')", a, b);
    for (const d of [1, 7, 30]) { const r = one(retentionSql(d, ' AND u.id >= ? AND u.id < ?'), a, b)!; cohort[d][0] += Number(r.cohort); cohort[d][1] += Number(r.kept); }
  });
  return { wau, mau, trackingSince: (one('SELECT MIN(day) d FROM activity')?.d ?? null) as string | null, retention: { d1: rate(cohort[1][0], cohort[1][1]), d7: rate(cohort[7][0], cohort[7][1]), d30: rate(cohort[30][0], cohort[30][1]) } };
}
export const activityWindows = (): Windows => serve('activity_windows', computeWindows, EMPTY_WINDOWS);

// ---- files nothing points to ---------------------------------------------------------------------------------------------------------
const ORPHAN_SQL = (range: string) => `SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes FROM blobs b WHERE b.created_at < datetime('now', '-7 days')${range}
      AND NOT EXISTS (SELECT 1 FROM media m WHERE m.blob_hash = b.hash) AND NOT EXISTS (SELECT 1 FROM sealed_messages s WHERE s.blob_hash = b.hash)`;
const EMPTY_ORPHANS = { count: 0, bytes: 0 };
/** Files in the store that nothing points to (older than a week). A report only, so it is computed at most once an hour. */
export const orphansReport = (): { count: number; bytes: number } => serve('orphans', () => { const o = one(ORPHAN_SQL(''))!; return { count: Number(o.n), bytes: Number(o.bytes) }; }, EMPTY_ORPHANS);
async function orphansChunked() {
  let count = 0, bytes = 0;
  await eachRange(0, maxId('blobs'), CHUNK(), (a, b) => { const o = one(ORPHAN_SQL(' AND b.rowid >= ? AND b.rowid < ?'), a, b)!; count += Number(o.n); bytes += Number(o.bytes); });
  return { count, bytes };
}

// ---- the hourly job -------------------------------------------------------------------------------------------------------------------
let running: Promise<void> | null = null;
/** Recompute everything. Small database: all at once. Big one: in chunks that yield to the event loop between steps. One run at a time. */
export function refreshAll(): Promise<void> {
  if (running) return running;
  const job = (async () => {
    if (isSmall()) { refreshStats(); refreshUsage(); store('platform_totals', computeTotals()); store('activity_windows', computeWindows()); store('orphans', (() => { const o = one(ORPHAN_SQL(''))!; return { count: Number(o.n), bytes: Number(o.bytes) }; })()); return; }
    await refreshStatsChunked(); await refreshUsageChunked();
    store('platform_totals', await totalsChunked()); store('activity_windows', await windowsChunked()); store('orphans', await orphansChunked());
  })();
  // cleared only AFTER it is assigned: an all-synchronous run would otherwise finish before `running` is set and leave a finished promise there forever
  running = job;
  job.then(() => { if (running === job) running = null; }, () => { if (running === job) running = null; });
  return job;
}
function kick() { refreshAll().catch(e => logError('job', 'rollups', e instanceof Error ? e.message : e)); }
