import { all, one, run } from '../db.ts';
import { app } from '../app.ts';
import { membership, tx } from '../lib/helpers.ts';

// ---- chat lists: the filters a person makes for themselves ------------------------------------
// "Siblings", "Work", "School run". A list is only a way of looking at your own chat list: it is private to the
// person who made it, nobody is told which list their chat is in, and deleting a list never touches a chat.

const MAX_LISTS = 20;        // more than this is a filing system, not a filter
const MAX_IN_LIST = 500;
const name = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

const listsOf = (userId: number) => {
  const lists = all('SELECT id, name FROM chat_lists WHERE user_id = ? ORDER BY sort, id', userId);
  if (!lists.length) return [];
  const items = all(`SELECT i.list_id AS listId, i.circle_id AS circleId FROM chat_list_items i
                      JOIN chat_lists l ON l.id = i.list_id
                      JOIN circle_members cm ON cm.circle_id = i.circle_id AND cm.user_id = l.user_id
                     WHERE l.user_id = ?`, userId);   // a chat they have left drops out of the list by itself
  return lists.map(l => ({ id: l.id as number, name: l.name as string, circleIds: items.filter(i => i.listId === l.id).map(i => i.circleId as number) }));
};

app.get('/api/lists', c => c.json(listsOf(c.get('user').id)));

app.post('/api/lists', async c => {
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const n = name(b.name);
  if (!n) return c.json({ error: 'name_required' }, 400);
  if ((one('SELECT COUNT(*) AS n FROM chat_lists WHERE user_id = ?', user.id)!.n as number) >= MAX_LISTS) return c.json({ error: 'too_many_lists' }, 409);
  const r = run('INSERT INTO chat_lists (user_id, name) VALUES (?, ?)', user.id, n);
  return c.json({ id: Number(r.lastInsertRowid), name: n, circleIds: [] }, 201);
});

/** Rename a list, or say which chats are in it. Chats the person is not in are simply left out. */
app.patch('/api/lists/:lid', async c => {
  const user = c.get('user');
  const list = one('SELECT id FROM chat_lists WHERE id = ? AND user_id = ?', Number(c.req.param('lid')), user.id);
  if (!list) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (b.name !== undefined) {
    const n = name(b.name);
    if (!n) return c.json({ error: 'name_required' }, 400);
    run('UPDATE chat_lists SET name = ? WHERE id = ?', n, list.id);
  }
  if (b.circleIds !== undefined) {
    if (!Array.isArray(b.circleIds) || b.circleIds.length > MAX_IN_LIST) return c.json({ error: 'invalid_value' }, 400);
    const mine = [...new Set(b.circleIds.filter((x: unknown) => Number.isInteger(x)) as number[])].filter(id => membership(id, user.id));
    tx(() => {
      run('DELETE FROM chat_list_items WHERE list_id = ?', list.id);
      for (const id of mine) run('INSERT OR IGNORE INTO chat_list_items (list_id, circle_id) VALUES (?, ?)', list.id, id);
    });
  }
  return c.json({ ok: true });
});

app.delete('/api/lists/:lid', c => {
  const user = c.get('user');
  const list = one('SELECT id FROM chat_lists WHERE id = ? AND user_id = ?', Number(c.req.param('lid')), user.id);
  if (!list) return c.json({ error: 'not_found' }, 404);
  tx(() => { run('DELETE FROM chat_list_items WHERE list_id = ?', list.id); run('DELETE FROM chat_lists WHERE id = ?', list.id); });
  return c.json({ ok: true });
});
