import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { audit, maskPhone, requireAdmin } from '../lib/admin.ts';
import { limited } from '../lib/helpers.ts';
import { pushToUser } from '../push.ts';
import { words } from '../lib/texts.ts';
import { TEMPLATES } from '../lib/support-templates.ts';

// Support: a person writes to the team; staff answer from the admin screen (owner, moderator and support roles). The person sees their own cases only.
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const MAX_OPEN = 3;

export { TEMPLATES };

// ---- the person's side ----------------------------------------------------------------------------------------------------
app.post('/api/support', async c => {
  const u = c.get('user');
  if (await limited(`support:${u.id}`, 5, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const b = await c.req.json().catch(() => ({}));
  const subject = clean(b.subject, 80), body = clean(b.body, 2000);
  if (!subject || !body) return c.json({ error: 'invalid_value' }, 400);
  if (Number(one("SELECT COUNT(*) AS n FROM support_cases WHERE user_id = ? AND status != 'closed'", u.id)!.n) >= MAX_OPEN) return c.json({ error: 'too_many_open' }, 409);
  const id = Number(run('INSERT INTO support_cases (user_id, subject) VALUES (?, ?)', u.id, subject).lastInsertRowid);
  run('INSERT INTO support_messages (case_id, from_staff, body) VALUES (?, 0, ?)', id, body);
  return c.json({ id }, 201);
});
const withMessages = (cases: Array<Record<string, any>>) => cases.map(k => ({ ...k, messages: all('SELECT from_staff AS fromStaff, body, created_at AS createdAt FROM support_messages WHERE case_id = ? ORDER BY id', k.id) }));
app.get('/api/support', c => c.json(withMessages(all('SELECT id, subject, status, created_at AS createdAt, updated_at AS updatedAt FROM support_cases WHERE user_id = ? ORDER BY id DESC LIMIT 20', c.get('user').id))));
app.post('/api/support/:id/reply', async c => {
  const u = c.get('user'), id = Number(c.req.param('id'));
  const k = one('SELECT id FROM support_cases WHERE id = ? AND user_id = ?', id, u.id);
  if (!k) return c.json({ error: 'not_found' }, 404);
  if (await limited(`support:${u.id}`, 20, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const body = clean((await c.req.json().catch(() => ({}))).body, 2000);
  if (!body) return c.json({ error: 'invalid_value' }, 400);
  run('INSERT INTO support_messages (case_id, from_staff, body) VALUES (?, 0, ?)', id, body);
  run("UPDATE support_cases SET status = 'open', updated_at = datetime('now') WHERE id = ?", id);   // writing again reopens it
  return c.json({ ok: true }, 201);
});

// ---- the team's side ------------------------------------------------------------------------------------------------------
app.get('/api/admin/support/templates', requireAdmin('support'), c => c.json(TEMPLATES));
app.get('/api/admin/support', requireAdmin('support'), c => {
  const status = c.req.query('status');
  const rows = all(
    `SELECT k.id, k.subject, k.status, k.created_at AS createdAt, k.updated_at AS updatedAt, u.name AS person, u.phone, u.lang,
            (SELECT COUNT(*) FROM support_messages m WHERE m.case_id = k.id) AS messages
       FROM support_cases k JOIN users u ON u.id = k.user_id
      ${status === 'open' || status === 'answered' || status === 'closed' ? 'WHERE k.status = ?' : ''} ORDER BY (k.status = 'open') DESC, k.updated_at DESC LIMIT 100`, ...(['open', 'answered', 'closed'].includes(String(status)) ? [status] : []));
  return c.json(rows.map(r => ({ ...r, phone: maskPhone(r.phone) })));
});
app.get('/api/admin/support/:id', requireAdmin('support'), c => {
  const id = Number(c.req.param('id'));
  const k = one('SELECT k.id, k.subject, k.status, k.created_at AS createdAt, u.name AS person, u.phone, u.lang FROM support_cases k JOIN users u ON u.id = k.user_id WHERE k.id = ?', id);
  if (!k) return c.json({ error: 'not_found' }, 404);
  audit(c, 'support.view', { type: 'support_case', id });   // reading someone's message is on the record
  return c.json({ ...k, phone: maskPhone(k.phone), messages: all('SELECT from_staff AS fromStaff, body, created_at AS createdAt FROM support_messages WHERE case_id = ? ORDER BY id LIMIT 500', id) });
});
app.post('/api/admin/support/:id/reply', requireAdmin('support'), async c => {
  const id = Number(c.req.param('id'));
  if (!one('SELECT 1 FROM support_cases WHERE id = ?', id)) return c.json({ error: 'not_found' }, 404);
  const body = clean((await c.req.json().catch(() => ({}))).body, 2000);
  if (!body) return c.json({ error: 'invalid_value' }, 400);
  run('INSERT INTO support_messages (case_id, from_staff, staff_id, body) VALUES (?, 1, ?, ?)', id, c.get('user').id, body);
  run("UPDATE support_cases SET status = 'answered', updated_at = datetime('now') WHERE id = ?", id);
  // tell the person on their devices (never the answer's text, only that there is one)
  const who = one('SELECT k.user_id AS id, u.lang FROM support_cases k JOIN users u ON u.id = k.user_id WHERE k.id = ?', id);
  if (who) pushToUser(who.id, { title: 'Thekra', body: words(who.lang).support, circle: 0, tag: `support-${id}`, url: '/#/you' }).catch(e => console.error('[push]', e));
  audit(c, 'support.reply', { type: 'support_case', id });   // the text itself is not copied into the audit log
  return c.json({ ok: true });
});
app.post('/api/admin/support/:id/close', requireAdmin('support'), c => {
  const id = Number(c.req.param('id'));
  if (!one('SELECT 1 FROM support_cases WHERE id = ?', id)) return c.json({ error: 'not_found' }, 404);
  run("UPDATE support_cases SET status = 'closed', updated_at = datetime('now') WHERE id = ?", id);
  audit(c, 'support.close', { type: 'support_case', id });
  return c.json({ ok: true });
});
