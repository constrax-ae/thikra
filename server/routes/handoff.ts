import { randomBytes } from 'node:crypto';
import { app } from '../app.ts';
import { state } from '../state.ts';
import { circleAccess } from '../lib/helpers.ts';
import { startSession } from '../lib/pin.ts';

// Opening the family story from the phone app.
//
// The book is an ordinary web page (so the system browser can print it or save it as PDF),
// but the phone app keeps its session in its own secure storage, so the browser arrives with
// no session and was told "unauthorized". The app now asks for a one-time handoff link: the
// browser opens it, gets a session of its own for the same person, and lands on the book —
// the book's photos (separate protected requests) then load too.
//
// The link is single use, lives 60 seconds, is bound to the person who asked for it, and can
// only lead to the book of a circle that person belongs to.

const TTL_MS = 60_000;
const key = (t: string) => `book-handoff:${t}`;

app.post('/api/circles/:id/book-link', async c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({})) as { year?: unknown; lang?: unknown };
  const year = Number(b.year ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return c.json({ error: 'invalid_year' }, 400);
  const lang = typeof b.lang === 'string' && /^[a-z]{2,3}$/.test(b.lang) ? b.lang : '';
  const path = `/api/circles/${a.circleId}/book?year=${year}${lang ? `&lang=${lang}` : ''}`;
  const token = randomBytes(24).toString('hex');
  await state.kv.set(key(token), { userId: a.user.id, path }, TTL_MS);
  return c.json({ url: `/api/auth/handoff/${token}` });
});

app.get('/api/auth/handoff/:token', async c => {
  const token = c.req.param('token');
  if (!/^[a-f0-9]{48}$/.test(token)) return c.text('This link is not valid.', 400);
  const held = (await state.kv.get(key(token))) as { userId: number; path: string } | undefined;
  await state.kv.del(key(token));   // single use, whatever happens next
  if (!held || !/^\/api\/circles\/\d+\/book\?year=\d{4}(&lang=[a-z]{2,3})?$/.test(held.path)) {
    return c.html('<!doctype html><meta name="viewport" content="width=device-width"><p style="font-family:system-ui;padding:24px">This link has expired. Open the story again from the Thekra app.</p>', 410);
  }
  startSession(c, held.userId);
  return c.redirect(held.path, 302);
});
