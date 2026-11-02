import { all, one } from '../db.ts';
import { quotaOf, subscription } from '../billing.ts';
import { costPerGB } from './capacity.ts';
import { scrub } from './scrub.ts';
import { textLang } from './lang.ts';
import { statsSeries } from './rollups.ts';
import { TEMPLATES } from './support-templates.ts';

// The agent's judgement, as plain rules you can read: what is unusual today, which report to look at first and what to do about it, what to answer a support case,
// and who is going to run out of space. No model is needed for any of it; the model, when present, reasons over these same results.
const GB = 1024 ** 3;
const round = (n: number) => Math.round(n * 100) / 100;
const hours = (ts: string) => Math.max(0, Math.round((Date.now() - Date.parse(ts.replace(' ', 'T') + 'Z')) / 3_600_000));

// ---- what is unusual today ------------------------------------------------------------------------------------------------------
// sign-ups, reports, support and messages come from the daily rollup (one row a day); the two small tables below are read directly
interface Series { code: string; ar: string; en: string; min: number; sql?: string; rollup?: 'signups' | 'reports' | 'support' | 'messages' }
const SERIES: Series[] = [
  { code: 'signups', ar: 'التسجيلات', en: 'Sign-ups', min: 10, rollup: 'signups' },
  { code: 'reports', ar: 'البلاغات', en: 'Reports', min: 3, rollup: 'reports' },
  { code: 'support', ar: 'رسائل الدعم', en: 'Support cases', min: 5, rollup: 'support' },
  { code: 'messages', ar: 'الرسائل', en: 'Messages', min: 200, rollup: 'messages' },
  { code: 'errors', ar: 'أخطاء الخادم', en: 'Server errors', min: 10, sql: "SELECT date(at) d, COUNT(*) n FROM ops_errors WHERE date(at) >= date('now','-14 days') GROUP BY d" },
  { code: 'sms_failed', ar: 'رسائل الرمز الفاشلة', en: 'Failed sign-in SMS', min: 5, sql: "SELECT day d, COUNT(*) n FROM sms_log WHERE status = 'failed' AND day >= date('now','-14 days') GROUP BY day" },
];
export interface Anomaly { code: string; ar: string; en: string; today: number; typical: number }
/** Today against the 14 days before it: unusual means at least `min` AND three standard deviations above the usual (never less than 1). One calm day is never an alarm. */
export function anomalies(): Anomaly[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: Anomaly[] = [];
  const rolled = statsSeries(15);
  for (const s of SERIES) {
    const by = s.rollup ? new Map(rolled.map(r => [r.d, r[s.rollup!]])) : new Map(all(s.sql!).map(r => [String(r.d), Number(r.n)]));
    const past: number[] = [];
    for (let i = 1; i <= 14; i++) past.push(by.get(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)) ?? 0);
    const mean = past.reduce((a, b) => a + b, 0) / past.length;
    const sd = Math.sqrt(past.reduce((a, b) => a + (b - mean) ** 2, 0) / past.length);
    const now = by.get(today) ?? 0;
    if (now >= s.min && now > mean + 3 * Math.max(sd, 1)) out.push({ code: s.code, ar: s.ar, en: s.en, today: now, typical: round(mean) });
  }
  return out;
}

// ---- which report first, and what to do ------------------------------------------------------------------------------------------
const REASON_WEIGHT: Record<string, number> = { illegal: 200, harassment: 60, abuse: 50, spam: 15, other: 10 };
export interface Triaged { reportId: number; reason: string; score: number; ageHours: number; reportedUserId: number | null; priorReports: number; why: string; suggestion: { kind: string; args: Record<string, unknown>; reason: string } | null }
/** Open reports, most pressing first. Score: how serious the reason, how long it waited, how many others reported the same person, how many people reported it. The suggestion is the mildest sensible step; illegal content is always for the owner to look at. */
export function triageReports(): Triaged[] {
  const rows = all("SELECT id, reason, created_at, reported_user_id AS uid FROM reports WHERE status != 'resolved' ORDER BY id DESC LIMIT 50");
  const out = rows.map(r => {
    const age = hours(r.created_at);
    const prior = r.uid ? Number(one('SELECT COUNT(*) n FROM reports WHERE reported_user_id = ? AND id != ?', r.uid, r.id)!.n) : 0;
    const reporters = r.uid ? Number(one('SELECT COUNT(DISTINCT reporter_id) n FROM reports WHERE reported_user_id = ?', r.uid)!.n) : 1;
    const score = Math.round((REASON_WEIGHT[r.reason] ?? 10) + Math.min(30, age / 2) + prior * 20 + Math.max(0, reporters - 1) * 10);
    let suggestion: Triaged['suggestion'] = null, why = `${r.reason}`;
    if (r.reason === 'illegal') { suggestion = { kind: 'report_action', args: { reportId: r.id, action: 'escalate', note: 'possible illegal content: owner review' }, reason: 'reported as illegal content' }; why = 'illegal: needs a person'; }
    else if (r.uid && prior >= 2 && (r.reason === 'abuse' || r.reason === 'harassment')) { suggestion = { kind: 'suspend_user', args: { userId: r.uid, days: 7, reason: `${prior + 1} reports against this person` }, reason: `${prior + 1} reports against the same person (${reporters} reporters)` }; why = `repeat: ${prior + 1} reports`; }
    else if (r.reason === 'other') { suggestion = null; why = 'unclear: read it'; }
    else suggestion = { kind: 'report_action', args: { reportId: r.id, action: 'warn', note: `first ${r.reason} report` }, reason: `${r.reason} report, first or second against this person` };
    return { reportId: r.id as number, reason: r.reason as string, score, ageHours: age, reportedUserId: (r.uid ?? null) as number | null, priorReports: prior, why, suggestion };
  });
  return out.sort((a, b) => b.score - a.score);
}

// ---- what to answer a support case -------------------------------------------------------------------------------------------------
const TOPICS: Array<[string, RegExp]> = [
  ['code', /رمز التحقق|لم يصل|ما وصل|code|sms|not arrive|verification/i], ['pin', /سري|pin|نسيت/i],
  ['restore', /استرجع|استعاد|حذفت|محذوف|restore|deleted|recover/i], ['storage', /مساحة|تخزين|سعة|storage|space|full/i],
  ['number', /تغيير الرقم|غيّر رقم|غير رقم|رقم جديد|change.{0,12}number|new number|new phone/i],
];
export interface SupportSuggestion { caseId: number; topic: string | null; lang: 'ar' | 'en'; draft: string | null; excerpt: string }
/** A ready answer for the question that came up most, in the person's language, when the words fit a known topic. The excerpt (numbers hidden) is what the team would read anyway. */
export function suggestSupport(caseId: number): SupportSuggestion | null {
  const k = one('SELECT k.id, k.subject, u.lang FROM support_cases k JOIN users u ON u.id = k.user_id WHERE k.id = ?', caseId);
  if (!k) return null;
  const first = one('SELECT body FROM support_messages WHERE case_id = ? AND from_staff = 0 ORDER BY id LIMIT 1', caseId)?.body ?? '';
  const text = `${k.subject} ${first}`;
  const hit = TOPICS.find(([, re]) => re.test(text))?.[0] ?? null;
  const t = hit ? TEMPLATES.find(x => x.id === hit) : null;
  const lang = textLang(k.lang);
  return { caseId, topic: hit, lang, draft: t ? t[lang] : null, excerpt: scrub(`${k.subject}: ${first}`).slice(0, 300) };
}

// ---- who will run out of space, and what growth will cost --------------------------------------------------------------------------
export function forecast() {
  const fams = all("SELECT m.circle_id AS id, SUM(m.size) AS added FROM media m WHERE m.archived = 1 AND m.created_at >= datetime('now','-14 days') GROUP BY m.circle_id HAVING added > 0 ORDER BY added DESC LIMIT 200");
  const soon: Array<{ id: number; name: string; daysToFull: number; usedGB: number; quotaGB: number; perWeekGB: number }> = [];
  for (const f of fams) {
    const c = one("SELECT name FROM circles WHERE id = ? AND deleted_at IS NULL AND kind != 'direct'", f.id);
    if (!c) continue;
    const used = Number(one('SELECT COALESCE(SUM(size),0) n FROM (SELECT DISTINCT blob_hash, size FROM media WHERE circle_id = ? AND archived = 1)', f.id)!.n);
    const quota = quotaOf(subscription(f.id)), perDay = Number(f.added) / 14;
    const days = perDay > 0 ? Math.floor(Math.max(0, quota - used) / perDay) : null;
    if (days !== null && days <= 30) soon.push({ id: f.id, name: scrub(c.name), daysToFull: days, usedGB: round(used / GB), quotaGB: round(quota / GB), perWeekGB: round((perDay * 7) / GB) });
  }
  soon.sort((a, b) => a.daysToFull - b.daysToFull);
  const grew = Number(one("SELECT COALESCE(SUM(size),0) n FROM blobs WHERE created_at >= datetime('now','-30 days')")!.n);
  return { fullWithin30Days: soon.slice(0, 10), platformGrowthGBPerMonth: round(grew / GB), extraCostNextMonthUSD: round((grew / GB) * costPerGB()) };
}
