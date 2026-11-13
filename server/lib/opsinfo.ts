import { statSync } from 'node:fs';
import { one, run, dbFile } from '../db.ts';
import { status as offsiteStatus } from '../offsite-store.ts';
import { sentTodayCount } from '../sms.ts';
import { smsInfo } from './auth.ts';
import { capacitySummary } from './capacity.ts';
import { paymentsOn, stripeMode, webhookSecret } from './stripe.ts';
import { errorsSince, jobStatus, recentErrors } from './jobs.ts';
import { readPending, lastRestore } from '../pending-restore.ts';
import { aiInfo, price as aiPrice } from './ai.ts';

// The state of the machine room, in one place: background jobs, errors, outside services, what the platform costs this month, and the app version rule.
const setting = (k: string) => { try { return JSON.parse(String(one('SELECT value FROM settings WHERE key = ?', k)?.value ?? '{}')); } catch { return {}; } };
const save = (k: string, v: unknown) => run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', k, JSON.stringify(v));
const num = (v: unknown, max: number, dflt = 0) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : dflt; };

export function providers() {
  const sms = smsInfo();
  return {
    sms: { provider: sms.provider, real: sms.provider !== 'console', usedToday: sentTodayCount(), dailyCap: sms.dailyCap },
    push: { devices: Number(one('SELECT COUNT(*) n FROM push_subscriptions')!.n) },
    ai: aiInfo(),
    offsite: { ...offsiteStatus },
    payments: { connected: paymentsOn(), mode: paymentsOn() ? stripeMode() : null, webhook: !!webhookSecret() },
    database: { megabytes: (() => { try { return Math.round(statSync(dbFile).size / 1048576 * 10) / 10; } catch { return null; } })(), sqlite: process.env.THIKRA_SQLITE === 'wasm' ? 'wasm' : 'native-or-wasm' },
  };
}

/** What the language model costs per million tokens, for the configured provider (see server/lib/ai.ts); the real bill is on the
 *  provider's page, this is only the guide for the budget. */
export const aiRates = () => aiPrice();
export const costSettings = () => { const c = setting('ops_costs'); return { hostingUSD: num(c.hostingUSD, 1e6), smsEachUSD: num(c.smsEachUSD, 10, 0.05), budgetUSD: num(c.budgetUSD, 1e7) }; };
export const saveCostSettings = (c: { hostingUSD: number; smsEachUSD: number; budgetUSD: number }) => save('ops_costs', c);
/** This month so far, in dollars: hosting (a flat number the owner enters), SMS sent × the price of one, and the storage estimate. Never exact: a guide for the budget. */
export function costs() {
  const c = costSettings();
  const smsMonth = Number(one("SELECT COUNT(*) n FROM sms_log WHERE status = 'sent' AND day >= date('now', 'start of month')")!.n);
  const storage = capacitySummary().estMonthlyCost;
  const smsCost = Math.round(smsMonth * c.smsEachUSD * 100) / 100;
  const ai = one("SELECT COUNT(*) calls, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM agent_usage WHERE at >= date('now', 'start of month')")!;
  const rate = aiRates();
  const aiCost = Math.round((Number(ai.i) * rate.in + Number(ai.o) * rate.out) / 1e6 * 100) / 100;
  const total = Math.round((c.hostingUSD + smsCost + storage + aiCost) * 100) / 100;
  return { ...c, smsMonth, smsCost, storageCost: storage, aiCalls: Number(ai.calls), aiCost, total, percentOfBudget: c.budgetUSD ? Math.round((total / c.budgetUSD) * 100) : null };
}

export const appConfig = () => { const a = setting('app_config'); return { minVersion: String(a.minVersion ?? ''), latestVersion: String(a.latestVersion ?? ''), messageAr: String(a.messageAr ?? ''), messageEn: String(a.messageEn ?? '') }; };
export const saveAppConfig = (a: ReturnType<typeof appConfig>) => save('app_config', a);

export function overview() {
  const jobs = jobStatus();
  return {
    jobs, errors: recentErrors(20), errors24h: errorsSince(24), errors1h: errorsSince(1), providers: providers(), costs: costs(), appConfig: appConfig(),
    restore: { pending: readPending(dbFile), last: lastRestore },
  };
}
