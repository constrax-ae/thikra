import { type Context } from 'hono';
import { ADMIN_PHONES, PROD, safeEq, sha } from '../app.ts';
import { logSms, isBlockedCode } from './ops.ts';
import { SmsError, allowedCountry, otpText, providerFromEnv, takeDailyBudget, type SmsProvider } from '../sms.ts';
import { count } from '../metrics.ts';
import { getConnInfo } from '@hono/node-server/conninfo';
import { limited } from './helpers.ts';
import { one, run } from '../db.ts';
import { randomInt } from 'node:crypto';
import { normLang } from './lang.ts';

// ---- auth (phone + OTP; SMS provider is simulated) ---------------------------

let sms: SmsProvider = providerFromEnv();
/** Tests swap the provider for a fake. */
export const setSmsProvider = (p: SmsProvider | null) => { sms = p ?? providerFromEnv(); };
const ALLOWED_CODES = (process.env.THIKRA_SMS_ALLOWED_CODES ?? '').split(',').map(x => x.trim()).filter(Boolean);
const SMS_DAILY_CAP = Number(process.env.THIKRA_SMS_DAILY_CAP ?? 2000);
// Behind a proxy (Replit, a load balancer) the caller's address is the first x-forwarded-for entry; set THIKRA_TRUST_PROXY=1 only there.
// Without a proxy it is the socket's own address. If neither is known (as in tests) there is no IP limit rather than one shared by everybody.
export const callerIp = (c: Context): string | undefined => {
  if (process.env.THIKRA_TRUST_PROXY === '1') return c.req.header('x-forwarded-for')?.split(',')[0].trim() || undefined;
  try { return getConnInfo(c).remote.address || undefined; } catch { return undefined; }
};
/**
 * A public DEMO: with THIKRA_DEMO_MODE=1 the sign-in code is shown on screen, but ONLY for the fake numbers `pnpm demo` creates.
 * Any other number on a public server gets a real SMS or nothing, so nobody can sign in as a real person by typing their number.
 */
const DEMO_PHONES = new Set(['+966500000001', '+966500000002', '+966500000003', '+966500000004', '+966500000005']);
const demoLogin = (phone: string) => process.env.THIKRA_DEMO_MODE === '1' && DEMO_PHONES.has(phone);
type OtpResult = { ok: true; devCode?: string } | { ok: false; status: 400 | 403 | 429 | 502 | 503; error: string };
/** Create a code for a number and send it: the limits, the SMS budget and the provider are the same for sign-in and for changing a number. */
export async function issueOtp(c: Context, phone: string, wanted: unknown): Promise<OtpResult> {
  if (await limited(`otp:${phone}`, 5, 10 * 60_000)) return { ok: false, status: 429, error: 'too_many_requests' };
  const ip = callerIp(c);
  if (ip && await limited(`otp-ip:${ip}`, 30, 3600_000)) return { ok: false, status: 429, error: 'too_many_requests' };
  const code = String(randomInt(100000, 1000000));
  // A country the owner blocked from the admin screen gets no code, in any mode.
  if (isBlockedCode(phone)) { logSms(phone, 'blocked', sms.name); return { ok: false, status: 403, error: 'sms_blocked' }; }
  // Production never reveals the code; it is only sent by SMS. Refuse early when the number may not receive one (cost protection).
  const real = (PROD && !demoLogin(phone)) || sms.name !== 'console';   // production never reveals a code, except the fake demo numbers in demo mode
  if (real) {
    if (!allowedCountry(phone, ALLOWED_CODES)) { logSms(phone, 'blocked', sms.name); return { ok: false, status: 403, error: 'sms_blocked' }; }
    if (!takeDailyBudget(SMS_DAILY_CAP)) { console.error('[sms] daily cap reached'); logSms(phone, 'capped', sms.name); return { ok: false, status: 503, error: 'sms_unavailable' }; }
  }
  run(
    'INSERT INTO otps (phone, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0) ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0',
    phone, sha(code), Date.now() + 5 * 60_000,
  );
  if (real) {
    try { await sms.send(phone, otpText(code, normLang(wanted, 'ar'))); count('sms_sent'); logSms(phone, 'sent', sms.name); }
    catch (e) {
      run('DELETE FROM otps WHERE phone = ?', phone); // no valid code exists that nobody received
      count('sms_failed'); logSms(phone, 'failed', sms.name); console.error('[sms]', e instanceof Error ? e.message : e);
      return { ok: false, status: 502, error: e instanceof SmsError ? e.code : 'sms_failed' };
    }
    return { ok: true };
  }
  logSms(phone, 'sent', sms.name);
  console.log(`[otp] ${phone} -> ${code}`);   // development only
  return { ok: true, devCode: code };
}
/** Check and spend a code; the same attempt limit everywhere. */
export function checkOtp(phone: string, code: string): 'ok' | 'code_expired' | 'wrong_code' {
  const otp = one('SELECT * FROM otps WHERE phone = ?', phone);
  if (!otp || otp.expires_at < Date.now() || otp.attempts >= 5) return 'code_expired';
  run('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?', phone);
  // Stop-gap until a real SMS provider exists: an admin's own fixed code from the secrets, only after a code was requested and with the same 5-attempt limit.
  const ownerCode = process.env.THIKRA_OWNER_CODE ?? '';
  const ownerOk = ownerCode.length >= 6 && ADMIN_PHONES.has(phone) && safeEq(sha(ownerCode), sha(code));
  if (!ownerOk && !safeEq(otp.code_hash, sha(code))) return 'wrong_code';
  run('DELETE FROM otps WHERE phone = ?', phone);
  logSms(phone, 'verified');
  return 'ok';
}

/** What the admin screen shows about the SMS setup (no secrets). */
export const smsInfo = () => ({ provider: sms.name, dailyCap: SMS_DAILY_CAP, allowedCodes: ALLOWED_CODES });
