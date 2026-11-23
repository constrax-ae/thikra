import { app } from '../app.ts';
import { limited } from '../lib/helpers.ts';
import { iceServers } from '../lib/calls.ts';

// ---- voice calls (trial): the list of STUN/TURN servers a call needs ---------------------------------
// Signalling itself is on the live socket (docs/LIVE-FRAMES.md). The TURN secret never leaves the server: only a username and credential valid for an hour.
app.get('/api/calls/ice', async c => {
  const u = c.get('user');
  if (await limited(`ice:${u.id}`, 30, 10 * 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  c.header('cache-control', 'no-store');
  return c.json(iceServers(u.id));
});
