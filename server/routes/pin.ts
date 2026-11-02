import { ADMIN_PHONES, app, sha } from '../app.ts';
import { PIN_RE, PIN_RESET_MS, hashPin, startSession, dropTicket, ticketUser, tryPin } from '../lib/pin.ts';
import { checkOtp, issueOtp } from '../lib/auth.ts';
import { isLang } from '../lib/lang.ts';
import { deleteCookie, getCookie } from 'hono/cookie';
import { normPhone, requireAuth } from '../lib/helpers.ts';
import { one, run } from '../db.ts';
import { isBanned, suspension } from '../lib/admin.ts';

app.post('/api/auth/pin', async c => {
  const b = await c.req.json().catch(() => ({}));
  const userId = await ticketUser(b.ticket);
  if (!userId) return c.json({ error: 'code_expired' }, 400);
  const blocked = suspension(userId);
  if (blocked) return c.json({ error: 'suspended', until: blocked.until }, 403);
  const r = tryPin(userId, b.pin);
  if (!r.ok) return c.json({ error: r.error, ...(r.until ? { until: r.until } : {}), ...(r.left !== undefined ? { left: r.left } : {}) }, r.error === 'pin_locked' ? 429 : 400);
  await dropTicket(b.ticket);
  run('UPDATE users SET pin_reset_at = NULL WHERE id = ?', userId);
  startSession(c, userId);
  return c.json({ ok: true });
});
app.post('/api/auth/pin-forgot', async c => {
  const b = await c.req.json().catch(() => ({}));
  const userId = await ticketUser(b.ticket);
  if (!userId) return c.json({ error: 'code_expired' }, 400);
  const u = one('SELECT pin_reset_at FROM users WHERE id = ?', userId);
  const at = u?.pin_reset_at ?? Date.now() + PIN_RESET_MS;
  if (!u?.pin_reset_at) run('UPDATE users SET pin_reset_at = ? WHERE id = ?', at, userId);
  return c.json({ ok: true, resetAt: at });
});
app.post('/api/auth/logout', async c => {
  const token = getCookie(c, 'thikra_session');
  if (token) run('DELETE FROM sessions WHERE token = ?', sha(token));
  deleteCookie(c, 'thikra_session', { path: '/' });
  return c.json({ ok: true });
});
app.use('/api/*', async (c, next) => (c.req.path.startsWith('/api/auth/') || c.req.path === '/api/app-config' || c.req.path === '/api/stripe/webhook' ? next() : requireAuth(c, next)));
// Changing the number: the person keeps the account, the circles and the history; only the number that signs them in moves.
app.post('/api/me/phone/request', async c => {
  const body = await c.req.json().catch(() => ({}));
  const phone = normPhone(body.phone);
  if (!phone) return c.json({ error: 'invalid_phone' }, 400);
  if (phone === c.get('user').phone) return c.json({ error: 'same_phone' }, 400);
  if (isBanned(phone)) return c.json({ error: 'account_unavailable' }, 403);
  if (one('SELECT 1 FROM users WHERE phone = ?', phone)) return c.json({ error: 'phone_taken' }, 409);
  const r = await issueOtp(c, phone, body.lang);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true, ...(r.devCode ? { devCode: r.devCode } : {}) });
});
app.post('/api/me/phone/confirm', async c => {
  const body = await c.req.json().catch(() => ({}));
  const phone = normPhone(body.phone);
  if (!phone) return c.json({ error: 'invalid_phone' }, 400);
  if (one('SELECT 1 FROM users WHERE phone = ?', phone)) return c.json({ error: 'phone_taken' }, 409);
  const checked = checkOtp(phone, String(body.code ?? ''));
  if (checked !== 'ok') return c.json({ error: checked }, 400);
  const u = c.get('user');
  run('UPDATE users SET phone = ? WHERE id = ?', phone, u.id);
  if (ADMIN_PHONES.has(phone)) run("UPDATE users SET is_admin = 1, admin_role = COALESCE(admin_role, 'owner') WHERE id = ?", u.id);
  return c.json({ ok: true, phone });
});
app.post('/api/me/pin', async c => {
  const b = await c.req.json().catch(() => ({}));
  const u = c.get('user');
  if (typeof b.pin !== 'string' || !PIN_RE.test(b.pin)) return c.json({ error: 'invalid_pin' }, 400);
  const r = tryPin(u.id, b.current);   // changing an existing PIN needs the current one
  if (!r.ok) return c.json({ error: r.error, ...(r.until ? { until: r.until } : {}) }, r.error === 'pin_locked' ? 429 : 400);
  run('UPDATE users SET pin_hash = ?, pin_fails = 0, pin_locked_until = NULL, pin_reset_at = NULL WHERE id = ?', hashPin(b.pin), u.id);
  return c.json({ ok: true });
});
app.post('/api/me/pin/remove', async c => {
  const b = await c.req.json().catch(() => ({}));
  const u = c.get('user');
  const r = tryPin(u.id, b.pin);
  if (!r.ok) return c.json({ error: r.error, ...(r.until ? { until: r.until } : {}) }, r.error === 'pin_locked' ? 429 : 400);
  run('UPDATE users SET pin_hash = NULL, pin_fails = 0, pin_locked_until = NULL, pin_reset_at = NULL WHERE id = ?', u.id);
  return c.json({ ok: true });
});
app.get('/api/me', c => c.json(c.get('user')));
app.patch('/api/me', async c => {
  const b = await c.req.json().catch(() => ({}));
  const u = c.get('user');
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : u.name;
  const lang = isLang(b.lang) ? b.lang : u.lang;
  const receipts = typeof b.read_receipts === 'boolean' ? (b.read_receipts ? 1 : 0) : u.read_receipts;
  const preview = typeof b.push_preview === 'boolean' ? (b.push_preview ? 1 : 0) : u.push_preview;
  run('UPDATE users SET name = ?, lang = ?, read_receipts = ?, push_preview = ? WHERE id = ?', name, lang, receipts, preview, u.id);
  return c.json({ ...u, name, lang, read_receipts: receipts, push_preview: preview });
});
// Account deletion wipes the user's data (report §11, "right to be forgotten").
app.delete('/api/me', c => {
  const u = c.get('user');
  const owned = one('SELECT COUNT(*) n FROM circles WHERE owner_id = ?', u.id)!.n;
  if (owned > 0) return c.json({ error: 'owns_circles' }, 409);
  run('DELETE FROM persons WHERE user_id = ?', u.id);
  run('DELETE FROM users WHERE id = ?', u.id);
  deleteCookie(c, 'thikra_session', { path: '/' });
  return c.json({ ok: true });
});
