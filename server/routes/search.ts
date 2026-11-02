import { MSG_COLS } from '../lib/messages.ts';
import { all } from '../db.ts';
import { app } from '../app.ts';
import { circleAccess, decorate } from '../lib/helpers.ts';
import { normalize } from '../../core/agent.ts';
import { observe } from '../metrics.ts';

// ---- search ---------------------------------------------------------------------------------

// Search inside one circle, newest first. Arabic-aware (diacritics, alef/ya/ta-marbuta/hamza variants, Arabic-Indic digits),
// case-insensitive for Latin, hides what you deleted for yourself, never returns deleted messages.
app.get('/api/circles/:id/search', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const q = normalize(String(c.req.query('q') ?? '')).slice(0, 100);
  if (q.length < 2) return c.json([]);
  const like = `%${q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
  const t = performance.now();
  const rows = all(
    `SELECT ${MSG_COLS} FROM messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.circle_id = ? AND m.search_text LIKE ? ESCAPE '\\' AND m.deleted_at IS NULL AND m.kind != 'system'
         AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
       ORDER BY m.seq DESC LIMIT 50`, a.circleId, like, a.user.id);
  observe('search_ms', performance.now() - t);
  return c.json(decorate(a.circleId, rows));
});
