import { ADMIN_PHONES, PROD, REGION, app } from '../app.ts';
import { checkOtp, issueOtp } from '../lib/auth.ts';
import { normPhone } from '../lib/helpers.ts';
import { one, run } from '../db.ts';
import { isBanned, suspension } from '../lib/admin.ts';
import { flag } from '../lib/ops.ts';
import { pinTicket, startSession } from '../lib/pin.ts';
import { normLang } from '../lib/lang.ts';

app.post('/api/auth/request', async c => {
  const { phone: raw, lang: wanted } = await c.req.json().catch(() => ({}));
  const phone = normPhone(raw);
  if (!phone) return c.json({ error: 'invalid_phone' }, 400);
  if (isBanned(phone)) return c.json({ error: 'account_unavailable' }, 403);   // a banned number gets no SMS (and costs nothing)
  const known = !!one('SELECT 1 FROM users WHERE phone = ?', phone);
  if (!known && !flag('signups_open')) return c.json({ error: 'signups_closed' }, 403);   // before any SMS is paid for
  const r = await issueOtp(c, phone, wanted);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true, newUser: !known, ...(r.devCode ? { devCode: r.devCode } : {}) });
});
app.post('/api/auth/verify', async c => {
  const body = await c.req.json().catch(() => ({}));
  const phone = normPhone(body.phone);
  const code = String(body.code ?? '');
  if (!phone) return c.json({ error: 'invalid_phone' }, 400);
  if (isBanned(phone)) return c.json({ error: 'account_unavailable' }, 403);
  const checked = checkOtp(phone, code);
  if (checked !== 'ok') return c.json({ error: checked }, 400);

  let user = one('SELECT id, is_admin, pin_hash, pin_reset_at FROM users WHERE phone = ?', phone);
  if (!user) {
    if (!flag('signups_open')) return c.json({ error: 'signups_closed' }, 403);
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) return c.json({ error: 'name_required' }, 400);
    const first = ADMIN_PHONES.size === 0 && !PROD && !one('SELECT 1 FROM users LIMIT 1'); // dev-only bootstrap
    const admin = first || ADMIN_PHONES.has(phone);
    const lang = normLang(body.lang, 'ar');
    const r = run('INSERT INTO users (phone, name, lang, is_admin, admin_role, region) VALUES (?, ?, ?, ?, ?, ?)', phone, name, lang, admin ? 1 : 0, admin ? 'owner' : null, REGION);
    user = { id: Number(r.lastInsertRowid) };
  } else {
    if (ADMIN_PHONES.has(phone) && !user.is_admin) run("UPDATE users SET is_admin = 1, admin_role = COALESCE(admin_role, 'owner') WHERE id = ?", user.id); // promoted by configuration, not by being first
    const blocked = suspension(user.id);
    if (blocked) return c.json({ error: 'suspended', until: blocked.until }, 403);
    if (user.pin_hash) {
      // Two-step verification: the code alone is not enough. A forgotten PIN can be reset only after 7 days of waiting (the owner of the number can wait, a thief cannot easily).
      if (user.pin_reset_at && Date.now() >= user.pin_reset_at) run('UPDATE users SET pin_hash = NULL, pin_fails = 0, pin_locked_until = NULL, pin_reset_at = NULL WHERE id = ?', user.id);
      else return c.json({ ok: true, needPin: true, ticket: await pinTicket(user.id) });
    }
  }
  startSession(c, user.id);
  return c.json({ ok: true });
});
