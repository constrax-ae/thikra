import { all } from '../db.ts';
import { app } from '../app.ts';
import { circleAccess } from '../lib/helpers.ts';

// "Today in the family": what deserves a line at the top of the chat today. Nothing to show means nothing is shown (no empty strip).
//  - memory:   an event documented in the archive on this day of an earlier year
//  - birthday: a living person of the family record whose birthday is today
// It never reads chat messages: only the archive and the family record the family itself wrote.
app.get('/api/circles/:id/today', c => {
  const a = circleAccess(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const day = new Date().toISOString().slice(0, 10), md = day.slice(5), year = Number(day.slice(0, 4));
  const memories = all(
    `SELECT id, title, event_date AS eventDate FROM archive_entries
      WHERE circle_id = ? AND deleted_at IS NULL AND substr(event_date, 6, 5) = ? AND CAST(substr(event_date, 1, 4) AS INTEGER) < ?
      ORDER BY event_date DESC LIMIT 3`, a.circleId, md, year)
    .map(r => ({ type: 'memory' as const, id: r.id, title: r.title, years: year - Number(String(r.eventDate).slice(0, 4)) }));
  const birthdays = all(
    `SELECT id, name, birth_date AS birthDate FROM persons
      WHERE circle_id = ? AND death_date IS NULL AND birth_date IS NOT NULL AND substr(birth_date, 6, 5) = ?
      ORDER BY name LIMIT 5`, a.circleId, md)
    .map(r => ({ type: 'birthday' as const, id: r.id, name: r.name, age: year - Number(String(r.birthDate).slice(0, 4)) }));
  return c.json({ day, items: [...birthdays, ...memories] });
});
