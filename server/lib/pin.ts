import { state } from '../state.ts';
import { type Context } from 'hono';
import { PROD, safeEq, sha } from '../app.ts';
import { one, run } from '../db.ts';
import { randomBytes, scryptSync } from 'node:crypto';
import { setCookie } from 'hono/cookie';

// ---- two-step verification (a 6-digit PIN after the SMS code) ------------------------------------------------------------
export const PIN_RE = /^\d{6}$/;
export const hashPin = (pin: string) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(pin, salt, 32).toString('hex')}`; };
const samePin = (pin: string, stored: string) => { const [salt, h] = stored.split(':'); return !!salt && !!h && safeEq(scryptSync(pin, salt, 32).toString('hex'), h); };
export const PIN_MAX_FAILS = 5, PIN_LOCK_MS = 15 * 60_000, PIN_RESET_MS = 7 * 86_400_000;
/** The short-lived ticket between "the SMS code was right" and "the PIN was right". Lives in the shared-state port (Redis when there are many nodes). */
export const pinTicket = async (userId: number) => { const t = randomBytes(24).toString('hex'); await state.kv.set(`pin-ticket:${t}`, userId, 5 * 60_000); return t; };
export const ticketUser = async (t: unknown) => (typeof t === 'string' ? (await state.kv.get(`pin-ticket:${t}`)) as number | undefined : undefined);
export const dropTicket = (t: unknown) => state.kv.del(`pin-ticket:${String(t)}`);
export function startSession(c: Context, userId: number) {
  const token = randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id, expires_at, created_at, user_agent) VALUES (?, ?, ?, datetime(\'now\'), ?)', sha(token), userId, Date.now() + 30 * 86400_000, (c.req.header('user-agent') ?? '').slice(0, 160) || null);
  setCookie(c, 'thikra_session', token, { httpOnly: true, sameSite: 'Lax', secure: PROD, path: '/', maxAge: 30 * 86400 });
}
/** Check a PIN with a lock after repeated mistakes. */
export function tryPin(userId: number, pin: unknown): { ok: true } | { ok: false; error: 'pin_locked' | 'wrong_pin'; until?: number; left?: number } {
  const u = one('SELECT pin_hash, pin_fails, pin_locked_until FROM users WHERE id = ?', userId);
  if (!u?.pin_hash) return { ok: true };
  if (u.pin_locked_until && u.pin_locked_until > Date.now()) return { ok: false, error: 'pin_locked', until: u.pin_locked_until };
  if (typeof pin === 'string' && PIN_RE.test(pin) && samePin(pin, u.pin_hash)) { run('UPDATE users SET pin_fails = 0, pin_locked_until = NULL WHERE id = ?', userId); return { ok: true }; }
  const fails = (u.pin_fails ?? 0) + 1;
  if (fails >= PIN_MAX_FAILS) { run('UPDATE users SET pin_fails = 0, pin_locked_until = ? WHERE id = ?', Date.now() + PIN_LOCK_MS, userId); return { ok: false, error: 'pin_locked', until: Date.now() + PIN_LOCK_MS }; }
  run('UPDATE users SET pin_fails = ? WHERE id = ?', fails, userId);
  return { ok: false, error: 'wrong_pin', left: PIN_MAX_FAILS - fails };
}
