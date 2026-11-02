import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { audit, requireAdmin } from '../lib/admin.ts';
import { audienceCount, cardsFor, maintenance, parseAudience, resetMaintenanceCache, setMaintenance, sqlTime } from '../lib/announce.ts';
import { pushToUser } from '../push.ts';
import { textLang } from '../lib/lang.ts';

// Announcements, push broadcasts and the maintenance window (ADMIN-PLAN slice 3). The owner writes; people receive in their own language.
const json = (c: { req: { json(): Promise<any> } }) => c.req.json().catch(() => ({}));
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---- what a person sees --------------------------------------------------------------------------------------------------------
app.get('/api/announcements', c => c.json(cardsFor(c.get('user').id)));
app.post('/api/announcements/:id/dismiss', async c => {
  const id = Number(c.req.param('id'));
  const a = one("SELECT id, level FROM announcements WHERE id = ? AND status = 'active'", id);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const b = await json(c);
  const accepted = b.accepted === true;
  if (a.level === 'consent' && !accepted) return c.json({ error: 'consent_required' }, 400);   // a notice that needs agreement cannot just be closed
  run('INSERT INTO announcement_acks (announcement_id, user_id, accepted) VALUES (?, ?, ?) ON CONFLICT(announcement_id, user_id) DO UPDATE SET accepted = excluded.accepted, at = datetime(\'now\')', id, c.get('user').id, accepted ? 1 : 0);
  return c.json({ ok: true });
});

// ---- announcements (owner) -----------------------------------------------------------------------------------------------------
app.get('/api/admin/announcements', requireAdmin('announce'), c => c.json(all(
  `SELECT a.id, a.title_ar AS titleAr, a.title_en AS titleEn, a.body_ar AS bodyAr, a.body_en AS bodyEn, a.level, a.audience, a.starts_at AS startsAt, a.ends_at AS endsAt, a.status,
          (SELECT COUNT(*) FROM announcement_acks k WHERE k.announcement_id = a.id) AS dismissed, (SELECT COUNT(*) FROM announcement_acks k WHERE k.announcement_id = a.id AND k.accepted = 1) AS accepted
     FROM announcements a ORDER BY a.id DESC LIMIT 50`).map(r => ({ ...r, audience: parseAudience(r.audience) }))));

app.post('/api/admin/announcements', requireAdmin('announce'), async c => {
  const b = await json(c);
  const titleAr = text(b.titleAr, 120), titleEn = text(b.titleEn, 120), bodyAr = text(b.bodyAr, 600), bodyEn = text(b.bodyEn, 600);
  const level = b.level === 'warning' || b.level === 'consent' ? b.level : 'info';
  if (!(titleAr || bodyAr) || !(titleEn || bodyEn)) return c.json({ error: 'invalid_value' }, 400);   // both languages, so nobody gets a blank card
  const days = Math.min(Math.max(Math.floor(Number(b.days) || 7), 1), 90);
  const startsAt = b.startsAt ? sqlTime(b.startsAt) : new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (!startsAt) return c.json({ error: 'invalid_value' }, 400);
  const endsAt = new Date(Date.parse(startsAt.replace(' ', 'T') + 'Z') + days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  const audience = parseAudience(b.audience);
  const id = Number(run('INSERT INTO announcements (title_ar, title_en, body_ar, body_en, level, audience, starts_at, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    titleAr, titleEn, bodyAr, bodyEn, level, JSON.stringify(audience), startsAt, endsAt, c.get('user').id).lastInsertRowid);
  audit(c, 'announcement.create', { type: 'announcement', id }, { level, audience, days });
  return c.json({ id, audience: audienceCount(audience) }, 201);
});
app.post('/api/admin/announcements/:id/cancel', requireAdmin('announce'), c => {
  const id = Number(c.req.param('id'));
  if (!Number(run("UPDATE announcements SET status = 'cancelled' WHERE id = ? AND status = 'active'", id).changes)) return c.json({ error: 'not_found' }, 404);
  audit(c, 'announcement.cancel', { type: 'announcement', id });
  return c.json({ ok: true });
});

// ---- push broadcasts (owner) ---------------------------------------------------------------------------------------------------
/** How many people an audience reaches, before anything is sent. */
app.get('/api/admin/audience', requireAdmin('announce'), c => c.json({ count: audienceCount(parseAudience({ lang: c.req.query('lang'), country: c.req.query('country'), plan: c.req.query('plan'), managersOnly: c.req.query('managersOnly') === '1' })) }));
app.get('/api/admin/broadcasts', requireAdmin('announce'), c => c.json(all('SELECT id, body_ar AS bodyAr, body_en AS bodyEn, audience, scheduled_at AS scheduledAt, status, test, sent, skipped, done_at AS doneAt FROM broadcasts ORDER BY id DESC LIMIT 30').map(r => ({ ...r, audience: parseAudience(r.audience) }))));

/** `test: true` sends it only to the person asking, at once, so they see exactly what people will see. Otherwise it is queued for `at` (now when omitted). At most 3 real broadcasts a day. */
app.post('/api/admin/broadcasts', requireAdmin('announce'), async c => {
  const b = await json(c);
  const bodyAr = text(b.bodyAr, 180), bodyEn = text(b.bodyEn, 180);
  if (!bodyAr || !bodyEn) return c.json({ error: 'invalid_value' }, 400);
  const me = c.get('user');
  if (b.test === true) {
    const lang = textLang(me.lang) === 'en' ? bodyEn : bodyAr;
    const sent = await pushToUser(me.id, { title: 'Thekra', body: lang, circle: 0, tag: 'bc-test', url: '/#/' }).catch(() => 0);
    const id = Number(run("INSERT INTO broadcasts (body_ar, body_en, audience, scheduled_at, status, test, sent, skipped, created_by, done_at) VALUES (?, ?, '{}', datetime('now'), 'sent', 1, ?, ?, ?, datetime('now'))", bodyAr, bodyEn, sent > 0 ? 1 : 0, sent > 0 ? 0 : 1, me.id).lastInsertRowid);
    audit(c, 'broadcast.test', { type: 'broadcast', id });
    return c.json({ id, sent });
  }
  if (Number(one("SELECT COUNT(*) n FROM broadcasts WHERE test = 0 AND status != 'cancelled' AND created_at > datetime('now', '-1 day')")!.n) >= 3) return c.json({ error: 'too_many_requests' }, 429);
  const at = b.at ? sqlTime(b.at) : new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (!at) return c.json({ error: 'invalid_value' }, 400);
  const audience = parseAudience(b.audience);
  const id = Number(run('INSERT INTO broadcasts (body_ar, body_en, audience, scheduled_at, created_by) VALUES (?, ?, ?, ?, ?)', bodyAr, bodyEn, JSON.stringify(audience), at, me.id).lastInsertRowid);
  audit(c, 'broadcast.create', { type: 'broadcast', id }, { audience, at, reach: audienceCount(audience) });
  return c.json({ id, reach: audienceCount(audience) }, 201);
});
app.post('/api/admin/broadcasts/:id/cancel', requireAdmin('announce'), c => {
  const id = Number(c.req.param('id'));
  if (!Number(run("UPDATE broadcasts SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'", id).changes)) return c.json({ error: 'not_found' }, 404);
  audit(c, 'broadcast.cancel', { type: 'broadcast', id });
  return c.json({ ok: true });
});

// ---- maintenance (owner) -------------------------------------------------------------------------------------------------------
app.get('/api/admin/maintenance', requireAdmin('announce'), c => c.json(maintenance()));
/** Switch the app to read-only now (`on`, no dates), or for a window (`from`, `until`). Staff can still sign in and switch it off. */
app.post('/api/admin/maintenance', requireAdmin('announce'), async c => {
  const b = await json(c);
  if (typeof b.on !== 'boolean') return c.json({ error: 'invalid_value' }, 400);
  const from = b.from ? sqlTime(b.from) : null, until = b.until ? sqlTime(b.until) : null;
  if ((b.from && !from) || (b.until && !until) || (from && until && until <= from)) return c.json({ error: 'invalid_value' }, 400);
  const before = maintenance();
  setMaintenance({ on: b.on, from, until, messageAr: text(b.messageAr, 300), messageEn: text(b.messageEn, 300) });
  resetMaintenanceCache();
  audit(c, b.on ? 'maintenance.on' : 'maintenance.off', { type: 'maintenance', id: 'app' }, { from, until, was: before.on });
  return c.json({ ok: true });
});
