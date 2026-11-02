import { all, one, run } from '../db.ts';

// What runs in the background, and what went wrong. Every periodic job goes through trackJob, so the admin screen can say "the backup has not run for three days"
// instead of the owner finding out when it is needed.
interface Job { name: string; everyMs: number; startedAt: number; lastRunAt: number | null; lastOkAt: number | null; lastError: string | null; runs: number; fails: number }
const jobs = new Map<string, Job>();

/** Long digit runs (phone numbers, codes) never reach the log. */
const clean = (s: unknown) => String(s ?? '').replace(/\+?\d[\d\s-]{5,}\d/g, '[number]').replace(/\s+/g, ' ').slice(0, 300);
let sinceTrim = 0;
export function logError(kind: string, route: string | null, message: unknown) {
  try {
    run('INSERT INTO ops_errors (kind, route, message) VALUES (?, ?, ?)', kind, route, clean(message));
    if (++sinceTrim >= 50) { sinceTrim = 0; run('DELETE FROM ops_errors WHERE id <= (SELECT MAX(id) FROM ops_errors) - 500'); }
  } catch { /* the log must never break the thing it logs */ }
}

/** Wrap a periodic job: it records when it ran, whether it worked, and the error if not. The wrapper never throws (a failing job must not stop the timer). */
export function trackJob(name: string, everyMs: number, fn: () => unknown): () => Promise<void> {
  const job: Job = jobs.get(name) ?? { name, everyMs, startedAt: Date.now(), lastRunAt: null, lastOkAt: null, lastError: null, runs: 0, fails: 0 };
  jobs.set(name, job);
  return async () => {
    job.lastRunAt = Date.now(); job.runs++;
    try { await fn(); job.lastOkAt = Date.now(); job.lastError = null; }
    catch (e) { job.fails++; job.lastError = clean(e instanceof Error ? e.message : e); logError('job', name, job.lastError); console.error(`[${name}]`, e); }
  };
}
/** A job is overdue when it has not run for two and a half of its intervals (counted from start if it never ran), or its last run failed. */
export function jobStatus() {
  const now = Date.now();
  return [...jobs.values()].map(j => {
    const ref = j.lastRunAt ?? j.startedAt;
    return { name: j.name, everyMinutes: Math.round(j.everyMs / 60_000 * 10) / 10, lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null, lastOkAt: j.lastOkAt ? new Date(j.lastOkAt).toISOString() : null, lastError: j.lastError, runs: j.runs, fails: j.fails,
      overdue: now - ref > j.everyMs * 2.5, failing: !!j.lastError };
  });
}
export const recentErrors = (limit = 20) => all('SELECT id, at, kind, route, message FROM ops_errors ORDER BY id DESC LIMIT ?', limit);
export const errorsSince = (hours: number) => Number(one("SELECT COUNT(*) n FROM ops_errors WHERE at > datetime('now', ?)", `-${hours} hours`)!.n);
