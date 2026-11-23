import { app } from '../app.ts';
import { presenceOf } from '../lib/presence.ts';

// ---- online and last seen --------------------------------------------------------------------

// Who of these people is online, and when the others were last seen. Only people you are allowed to see come back; the rest are absent.
// (Live changes arrive as `presence` frames on the socket; this is for opening a screen.)
app.get('/api/presence', c => {
  const raw = (c.req.query('ids') ?? '').split(',').filter(Boolean);
  if (raw.length > 200) return c.json({ error: 'too_many' }, 400);
  const ids = raw.map(Number).filter(n => Number.isInteger(n) && n > 0);
  return c.json(presenceOf(c.get('user').id, ids));
});
