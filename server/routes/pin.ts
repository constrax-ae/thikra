import { dropBlobIfUnused } from '../lib/deletes.ts';
import { ADMIN_PHONES, app, sha } from '../app.ts';
import { isEmail, normalizeEmail } from '../../core/email.ts';
import { PIN_RE, PIN_RESET_MS, hashPin, startSession, dropTicket, ticketUser, tryPin } from '../lib/pin.ts';
import { checkOtp, issueOtp } from '../lib/auth.ts';
import { isLang } from '../lib/lang.ts';
import { deleteCookie, getCookie } from 'hono/cookie';
import { normPhone, requireAuth } from '../lib/helpers.ts';
import { isLastSeenPrivacy, presencePrivacyChanged, presenceViewers } from '../lib/presence.ts';
import { all, type Row, one, run } from '../db.ts';
import { isBanned, suspension } from '../lib/admin.ts';
import { rekeyAllFor } from '../lib/e2ee.ts';

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
/** The longest 'about' line, in characters as a person counts them (an emoji is one). */
export const ABOUT_MAX = 140;
app.get('/api/me', c => c.json(c.get('user')));
app.patch('/api/me', async c => {
  const b = await c.req.json().catch(() => ({}));
  const u = c.get('user');
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : u.name;
  const lang = isLang(b.lang) ? b.lang : u.lang;
  const receipts = typeof b.read_receipts === 'boolean' ? (b.read_receipts ? 1 : 0) : u.read_receipts;
  const preview = typeof b.push_preview === 'boolean' ? (b.push_preview ? 1 : 0) : u.push_preview;
  // An optional second way to reach someone. Sending an empty string clears it, which is how
  // a person removes an address they no longer want us to hold.
  let email = u.email ?? null;
  if (typeof b.email === 'string') {
    if (!isEmail(b.email)) return c.json({ error: 'bad_email' }, 400);
    email = normalizeEmail(b.email) || null;
  }
  // Who may see "online" and "last seen": everyone you share a chat with, only your family circles, or nobody. An unknown value changes nothing.
  const lastSeen = isLastSeenPrivacy(b.last_seen_privacy) ? b.last_seen_privacy : u.last_seen_privacy;
  // 1 (the default, as in WhatsApp): an archived chat stays archived when a message arrives. 0: a new message brings it back to the list.
  const keepArchived = typeof b.keep_archived === 'boolean' ? (b.keep_archived ? 1 : 0) : u.keep_archived;
  // AUTH-01's optional bio: one line, at most ABOUT_MAX characters. An empty string removes it.
  let about = (u.about as string | null | undefined) ?? null;
  if (typeof b.about === 'string') {
    const line = b.about.replace(/\s+/g, ' ').trim();
    if ([...line].length > ABOUT_MAX) return c.json({ error: 'too_long' }, 413);
    about = line || null;
  }
  const viewersBefore = lastSeen !== u.last_seen_privacy ? presenceViewers(u.id) : null;
  run('UPDATE users SET name = ?, lang = ?, read_receipts = ?, push_preview = ?, email = ?, last_seen_privacy = ?, keep_archived = ?, about = ? WHERE id = ?', name, lang, receipts, preview, email, lastSeen, keepArchived, about, u.id);
  if (viewersBefore) presencePrivacyChanged(u.id, viewersBefore);   // people who can no longer see you are told to forget you now
  return c.json({ ...u, name, lang, read_receipts: receipts, push_preview: preview, email, last_seen_privacy: lastSeen, keep_archived: keepArchived, about });
});
// Account deletion wipes the user's data (report §11, "right to be forgotten").
app.delete('/api/me', async c => {
  const u = c.get('user');
  const owned = one('SELECT COUNT(*) n FROM circles WHERE owner_id = ?', u.id)!.n;
  if (owned > 0) return c.json({ error: 'owns_circles' }, 409);
  const avatar = one('SELECT avatar_hash FROM users WHERE id = ?', u.id)?.avatar_hash as string | null;
  rekeyAllFor(u.id);
  run('DELETE FROM persons WHERE user_id = ?', u.id);
  run('DELETE FROM users WHERE id = ?', u.id);
  if (avatar) await dropBlobIfUnused(avatar);   // the profile picture goes with the account
  deleteCookie(c, 'thikra_session', { path: '/' });
  return c.json({ ok: true });
});

// ---- where you are signed in (RT-03) ----------------------------------------------------------
// A session IS a device here. The list shows what the browser said it is, when it was first used and when it was
// last used, and lets any of them be ended — including this one, which is simply signing out. No token, hashed or
// otherwise, ever leaves the server; the rowid is the handle.
app.get('/api/me/sessions', c => {
  const mine = c.get('sessionId');
  return c.json(all(
    `SELECT rowid AS id, user_agent AS userAgent, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt
       FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY (rowid = ?) DESC, COALESCE(last_seen_at, created_at) DESC`,
    c.get('user').id, Date.now(), mine).map((s: Row) => ({ ...s, current: s.id === mine })));
});
app.delete('/api/me/sessions/:id', c => {
  const id = Number(c.req.param('id'));
  const r = run('DELETE FROM sessions WHERE rowid = ? AND user_id = ?', id, c.get('user').id);
  if (!Number(r.changes)) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, signedOutHere: id === c.get('sessionId') });
});
/** Everything except the one asking: what you press when a device is lost. */
app.post('/api/me/sessions/revoke-others', c => {
  const r = run('DELETE FROM sessions WHERE user_id = ? AND rowid != ?', c.get('user').id, c.get('sessionId'));
  return c.json({ ended: Number(r.changes) });
});
