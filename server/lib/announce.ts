import { all, one, run } from '../db.ts';
import { pushToUser } from '../push.ts';
import { isLang, textLang, type AnyLang } from './lang.ts';

// Telling people things: in-app announcements, push broadcasts, and the maintenance window. Audiences are chosen by language, country, plan and role, never by content.
export interface Audience { lang?: AnyLang; country?: string; plan?: 'free' | 'family' | 'heritage'; managersOnly?: boolean }
export const parseAudience = (raw: unknown): Audience => {
  let v: any = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch { v = {}; } }
  const a: Audience = {};
  if (isLang(v?.lang)) a.lang = v.lang;
  if (typeof v?.country === 'string' && /^\d{1,4}$/.test(v.country.replace(/\D/g, '')) && v.country.replace(/\D/g, '')) a.country = v.country.replace(/\D/g, '');
  if (v?.plan === 'free' || v?.plan === 'family' || v?.plan === 'heritage') a.plan = v.plan;
  if (v?.managersOnly === true) a.managersOnly = true;
  return a;
};
/** SQL for "who is in this audience": suspended people are never included. */
function where(a: Audience): { sql: string; args: unknown[] } {
  const parts = ['u.suspended_at IS NULL'], args: unknown[] = [];
  if (a.lang) { parts.push('u.lang = ?'); args.push(a.lang); }
  if (a.country) { parts.push('u.phone LIKE ?'); args.push(`+${a.country}%`); }
  if (a.managersOnly) parts.push("EXISTS (SELECT 1 FROM circle_members m WHERE m.user_id = u.id AND m.role IN ('owner','admin'))");
  if (a.plan === 'free') parts.push("NOT EXISTS (SELECT 1 FROM circle_members m JOIN subscriptions s ON s.circle_id = m.circle_id WHERE m.user_id = u.id AND m.role IN ('owner','admin') AND s.plan != 'free')");
  else if (a.plan) { parts.push("EXISTS (SELECT 1 FROM circle_members m JOIN subscriptions s ON s.circle_id = m.circle_id WHERE m.user_id = u.id AND m.role IN ('owner','admin') AND s.plan = ?)"); args.push(a.plan); }
  return { sql: parts.join(' AND '), args };
}
export const audienceCount = (a: Audience) => { const w = where(a); return Number(one(`SELECT COUNT(*) n FROM users u WHERE ${w.sql}`, ...w.args)!.n); };
/** One page of an audience, by id cursor (people with an id above `after`), so any size can be walked without loading it all. */
export const audienceAfter = (a: Audience, after: number, limit: number) => { const w = where(a); return all(`SELECT u.id, u.lang FROM users u WHERE u.id > ? AND ${w.sql} ORDER BY u.id LIMIT ?`, after, ...w.args, limit); };
export const inAudience = (userId: number, a: Audience) => { const w = where(a); return !!one(`SELECT 1 FROM users u WHERE u.id = ? AND ${w.sql}`, userId, ...w.args); };

/** The database's own time format (UTC, 'YYYY-MM-DD HH:MM:SS'), from anything Date understands. */
export const sqlTime = (v: unknown): string | null => { const t = Date.parse(String(v)); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 19).replace('T', ' ') : null; };

// ---- maintenance ----------------------------------------------------------------------------------------------------------------
export interface Maintenance { on: boolean; from: string | null; until: string | null; messageAr: string; messageEn: string }
export function maintenance(): Maintenance {
  let v: any = {};
  try { v = JSON.parse(String(one("SELECT value FROM settings WHERE key = 'maintenance'")?.value ?? '{}')); } catch { /* none */ }
  return { on: v.on === true, from: v.from ?? null, until: v.until ?? null, messageAr: String(v.messageAr ?? ''), messageEn: String(v.messageEn ?? '') };
}
export const setMaintenance = (m: Maintenance) => run("INSERT OR REPLACE INTO settings (key, value) VALUES ('maintenance', ?)", JSON.stringify(m));
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
/** Is the app read-only right now? An open window with no end lasts until it is switched off; with an end, it lifts itself. */
export function maintenanceActive(): boolean {
  const m = maintenance();
  if (!m.on) return false;
  const n = nowSql();
  return (!m.from || m.from <= n) && (!m.until || n < m.until);
}
let cache = { at: 0, v: false };
/** The same, cached for a few seconds, for the busy path (every write checks it). */
export const maintenanceNow = () => { if (Date.now() - cache.at > 3000) cache = { at: Date.now(), v: maintenanceActive() }; return cache.v; };
export const resetMaintenanceCache = () => { cache.at = 0; };

// ---- what a person sees ---------------------------------------------------------------------------------------------------------
export interface Card { id: string; level: 'info' | 'warning' | 'consent' | 'maintenance'; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; until: string | null; upcoming?: boolean }
export function cardsFor(userId: number): Card[] {
  const out: Card[] = [];
  const m = maintenance(), n = nowSql();
  if (m.on && (!m.until || n < m.until)) {
    const live = !m.from || m.from <= n;
    out.push({ id: 'maintenance', level: 'maintenance', titleAr: live ? 'صيانة مؤقتة' : 'صيانة مجدولة', titleEn: live ? 'Maintenance' : 'Scheduled maintenance',
      bodyAr: m.messageAr || (live ? 'التطبيق للقراءة فقط الآن. سنعود قريباً.' : `ستكون ذكرى للقراءة فقط ابتداءً من ${String(m.from).slice(0, 16)} (UTC).`), bodyEn: m.messageEn || (live ? 'The app is read-only for now. We will be back soon.' : `Thekra will be read-only from ${String(m.from).slice(0, 16)} (UTC).`), until: m.until, upcoming: !live });
  }
  for (const a of all("SELECT * FROM announcements WHERE status = 'active' AND starts_at <= ? AND ends_at > ? AND id NOT IN (SELECT announcement_id FROM announcement_acks WHERE user_id = ?) ORDER BY id DESC LIMIT 5", n, n, userId)) {
    if (!inAudience(userId, parseAudience(a.audience))) continue;
    out.push({ id: String(a.id), level: a.level, titleAr: a.title_ar, titleEn: a.title_en, bodyAr: a.body_ar, bodyEn: a.body_en, until: a.ends_at });
  }
  return out;
}

// ---- push broadcasts ------------------------------------------------------------------------------------------------------------
/**
 * Send every broadcast that is due. The audience is walked page by page (by person id), and the broadcast records its cursor and counts after each page: a restart in the
 * middle resumes where it stopped (a send untouched for 10 minutes is picked up again) and nobody is skipped or told twice. People with no device count as skipped.
 */
export async function runBroadcasts(): Promise<number> {
  run("UPDATE broadcasts SET status = 'scheduled' WHERE status = 'sending' AND (touched_at IS NULL OR touched_at < datetime('now', '-10 minutes'))");
  const page = Math.max(1, Number(process.env.THIKRA_BROADCAST_PAGE ?? 500));
  let done = 0;
  for (const b of all("SELECT * FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY id LIMIT 5", nowSql())) {
    if (!Number(run("UPDATE broadcasts SET status = 'sending', touched_at = datetime('now') WHERE id = ? AND status = 'scheduled'", b.id).changes)) continue;   // another node took it
    const audience = parseAudience(b.audience);
    let cursor = Number(b.cursor), sent = Number(b.sent), skipped = Number(b.skipped);
    for (;;) {
      const users = audienceAfter(audience, cursor, page);
      if (!users.length) break;
      for (const u of users) {
        const n = await pushToUser(u.id, { title: 'Thekra', body: textLang(u.lang) === 'en' ? b.body_en : b.body_ar, circle: 0, tag: `bc-${b.id}`, url: '/#/' }).catch(() => 0);
        if (n > 0) sent++; else skipped++;
        cursor = u.id;
      }
      run("UPDATE broadcasts SET cursor = ?, sent = ?, skipped = ?, touched_at = datetime('now') WHERE id = ?", cursor, sent, skipped, b.id);
    }
    run("UPDATE broadcasts SET status = 'sent', sent = ?, skipped = ?, done_at = datetime('now') WHERE id = ?", sent, skipped, b.id);
    done++;
  }
  return done;
}
