import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { all, one, run } from '../db.ts';

// ---- feature flags (A-06) --------------------------------------------------------------------------------------------
/** Switches the owner can flip without a deploy. Every flag has a default in code, so a fresh database behaves sensibly; a value in the settings table overrides it. */
export const FLAGS = {
  signups_open: { default: true, description: 'New accounts may be created (turn off to stop sign-ups during an incident or an invite-only period).' },
  agent_enabled: { default: true, description: 'The memory agent runs at all (turn off to stop every circle\'s agent at once, for example when its cost or behaviour needs a pause).' },
  sealed_after_death: { default: false, description: 'Letters that open after the author\'s death (concluded by the agent). Off by default: Thekra offers only letters tied to an event and letters scheduled on dates. Letters already written keep working.' },
  sealed_enabled: { default: true, description: 'New sealed letters may be written (letters already sealed keep their schedule).' },
} as const;
export type FlagName = keyof typeof FLAGS;
export const isFlag = (n: string): n is FlagName => n in FLAGS;

let cache: { at: number; v: Map<string, string> } = { at: 0, v: new Map() };
const load = () => {
  if (Date.now() - cache.at > 3000) cache = { at: Date.now(), v: new Map(all("SELECT key, value FROM settings WHERE key LIKE 'flag:%'").map(r => [String(r.key).slice(5), String(r.value)])) };
  return cache.v;
};
/** Read a flag (cached for a few seconds, so it costs nothing on a busy path). */
export const flag = (name: FlagName): boolean => { const v = load().get(name); return v === undefined ? FLAGS[name].default : v === '1'; };
export function setFlag(name: FlagName, on: boolean) {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', `flag:${name}`, on ? '1' : '0');
  cache.at = 0;
}

// ---- SMS operations (A-09) --------------------------------------------------------------------------------------------
/** The country calling code of a number ('971'), never the number itself. */
export const callingCode = (phone: string) => parsePhoneNumberFromString(phone)?.countryCallingCode ?? 'unknown';
export type SmsStatus = 'sent' | 'failed' | 'blocked' | 'capped' | 'verified';
export function logSms(phone: string, status: SmsStatus, provider?: string) {
  try { run('INSERT INTO sms_log (day, calling_code, status, provider) VALUES (?, ?, ?, ?)', new Date().toISOString().slice(0, 10), callingCode(phone), status, provider ?? null); }
  catch { /* counting must never stop a sign-in */ }
}
/** Calling codes the owner blocked from the admin screen (on top of the THIKRA_SMS_ALLOWED_CODES list in the environment). */
export const blockedCodes = (): string[] => String(one("SELECT value FROM settings WHERE key = 'sms_blocked_codes'")?.value ?? '').split(',').map(x => x.trim()).filter(Boolean);
export const setBlockedCodes = (codes: string[]) => run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'sms_blocked_codes', codes.join(','));
export const isBlockedCode = (phone: string) => { const digits = phone.replace(/^\+/, ''); return blockedCodes().some(c => digits.startsWith(c)); };

// ---- usage (A-07) --------------------------------------------------------------------------------------------------------
const seen = new Map<number, string>();   // a per-process shortcut: at most one write per person per day per node
export function touchActivity(userId: number) {
  const day = new Date().toISOString().slice(0, 10);
  if (seen.get(userId) === day) return;
  seen.set(userId, day);
  if (seen.size > 50_000) seen.clear();
  try { run('INSERT OR IGNORE INTO activity (user_id, day) VALUES (?, ?)', userId, day); } catch { /* never block a request for a counter */ }
}
