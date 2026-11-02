// M-05 receipts, M-03 unread, M-06 typing, M-07 replies, M-08 reactions, M-10 edits: the behaviour around a message.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const { app, startServer } = await import('./index.ts');
const { run } = await import('./db.ts');
const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
after(() => { server.close(); server.closeAllConnections?.(); });

let counter = 0;
async function login(name: string) {
  const phone = `+9665${String(7_000_000 + counter++).padStart(8, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const me = await (await app.request('/api/me', { headers: { cookie } })).json() as any;
  return { cookie, id: me.id as number };
}
const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
async function connect(cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const next = async (pred: (f: any) => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    for (;;) { const f = frames.find(pred); if (f) return f; if (Date.now() > end) throw new Error('timed out; got ' + JSON.stringify(frames.slice(-6))); await new Promise(r => setTimeout(r, 20)); }
  };
  return { ws, frames, next, send: (o: unknown) => ws.send(JSON.stringify(o)) };
}
/** Three members: owner A, B and C. */
async function trio() {
  const a = await login('A'), b = await login('B'), c = await login('C');
  const { json: circle } = await call(a.cookie, '/api/circles', 'POST', { name: 'trio' });
  const { json: detail } = await call(a.cookie, `/api/circles/${circle.id}`);
  for (const u of [b, c]) await call(u.cookie, '/api/circles/join', 'POST', { code: detail.inviteCode });
  return { a, b, c, circle: circle.id as number };
}
const marks = async (cookie: string, circle: number) => {
  const { json } = await call(cookie, `/api/circles/${circle}`);
  return Object.fromEntries(json.members.map((m: any) => [m.name, { d: m.deliveredSeq, r: m.readSeq }]));
};

test('receipts: a connected member is marked delivered the moment the message reaches them; read comes from their read frame', async () => {
  const { a, b, c, circle } = await trio();
  const cb = await connect(b.cookie); // B is online, C is not
  const sent = await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'hello', client_msg_id: 'x1' });
  const seq = sent.json.seq;
  await cb.next(f => f.t === 'msg');
  let m = await marks(a.cookie, circle);
  assert.equal(m.B.d, seq, 'B (online) is delivered');
  assert.ok(m.C.d < seq, 'C (offline) is not');
  assert.ok(m.B.r < seq, 'nobody has read it yet');

  cb.send({ t: 'read', circle, seq });
  await cb.next(f => f.t === 'receipt' && f.read_seq === seq);
  m = await marks(a.cookie, circle);
  assert.equal(m.B.r, seq);

  // C comes back and fetches by seq: fetching counts as receiving.
  await call(c.cookie, `/api/circles/${circle}/messages?after_seq=0`);
  assert.equal((await marks(a.cookie, circle)).C.d, seq);
  cb.ws.close();
});

test('receipts never go backwards or beyond the newest message, and an outsider cannot set marks', async () => {
  const { a, b, circle } = await trio();
  for (let i = 0; i < 3; i++) await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: `m${i}` });
  const top = (await call(a.cookie, `/api/circles/${circle}`)).json.lastSeq;
  await call(b.cookie, `/api/circles/${circle}/read`, 'POST', { seq: 99999 });
  assert.equal((await marks(a.cookie, circle)).B.r, top, 'clamped to the newest message');
  await call(b.cookie, `/api/circles/${circle}/read`, 'POST', { seq: 1 });
  assert.equal((await marks(a.cookie, circle)).B.r, top, 'a smaller number does not move it back');
  const outsider = await login('X');
  assert.equal((await call(outsider.cookie, `/api/circles/${circle}/read`, 'POST', { seq: 1 })).status, 404);
});

test('read receipts are reciprocal: off means you neither share yours nor see others\'', async () => {
  const { a, b, c, circle } = await trio();
  await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'x' });
  const top = (await call(a.cookie, `/api/circles/${circle}`)).json.lastSeq;
  for (const u of [b, c]) await call(u.cookie, `/api/circles/${circle}/read`, 'POST', { seq: top });
  await call(b.cookie, '/api/me', 'PATCH', { read_receipts: false });
  const seenByA = await marks(a.cookie, circle);
  assert.equal(seenByA.C.r, top, 'C shares');
  assert.equal(seenByA.B.r, null, 'B turned receipts off, so A does not see B\'s mark');
  const seenByB = await marks(b.cookie, circle);
  assert.equal(seenByB.B.r, top, 'B still sees their own');
  assert.equal(seenByB.C.r, null, 'and, reciprocally, sees nobody else\'s');
});

test('unread counter: others\' messages after your read mark, never your own, drops to zero when you read', async () => {
  const { a, b, circle } = await trio();
  const unread = async (u: { cookie: string }) => (await call(u.cookie, '/api/circles')).json.find((x: any) => x.id === circle).unread;
  for (let i = 0; i < 4; i++) await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: `m${i}` });
  assert.equal(await unread(b), 4);
  assert.equal(await unread(a), 0, 'your own messages are never unread');
  const top = (await call(b.cookie, `/api/circles/${circle}`)).json.lastSeq;
  await call(b.cookie, `/api/circles/${circle}/read`, 'POST', { seq: top });
  assert.equal(await unread(b), 0);
});

test('reply: the quoted message travels with the reply; a quote from another circle is dropped; deleted originals show as deleted', async () => {
  const { a, b, circle } = await trio();
  const other = await trio();
  const orig = (await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'سؤال؟' })).json;
  const foreign = (await call(other.a.cookie, `/api/circles/${other.circle}/messages`, 'POST', { body: 'سر' })).json;
  const r1 = (await call(b.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'جواب', reply_to: orig.id })).json;
  const r2 = (await call(b.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'محاولة', reply_to: foreign.id })).json;
  const list = (await call(a.cookie, `/api/circles/${circle}/messages?after_seq=0`)).json;
  const reply = list.find((m: any) => m.id === r1.id);
  assert.equal(reply.replyTo.id, orig.id);
  assert.equal(reply.replyTo.text, 'سؤال؟');
  assert.equal(reply.replyTo.author, 'A');
  assert.equal(list.find((m: any) => m.id === r2.id).replyTo, null, 'cross-circle quote must not leak');
  await call(a.cookie, `/api/messages/${orig.id}`, 'DELETE');
  const after = (await call(a.cookie, `/api/circles/${circle}/messages?after_seq=0`)).json.find((m: any) => m.id === r1.id);
  assert.equal(after.replyTo.deleted, true);
  assert.equal(after.replyTo.text, '', 'the deleted text is gone from the quote too');
});

test('reactions: one per member, same emoji again removes, a different one replaces, invalid is refused, everyone is told', async () => {
  const { a, b, circle } = await trio();
  const msg = (await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'x' })).json;
  const cb = await connect(b.cookie);
  assert.equal((await call(b.cookie, `/api/messages/${msg.id}/react`, 'POST', { emoji: '👍' })).status, 200);
  const upd = await cb.next(f => f.t === 'update' && f.m.id === msg.id);
  assert.deepEqual(upd.m.reactions, [{ u: b.id, e: '👍' }]);
  await call(b.cookie, `/api/messages/${msg.id}/react`, 'POST', { emoji: '❤️' });
  await call(a.cookie, `/api/messages/${msg.id}/react`, 'POST', { emoji: '❤️' });
  let list = (await call(a.cookie, `/api/circles/${circle}/messages?after_seq=0`)).json.find((m: any) => m.id === msg.id);
  assert.deepEqual(list.reactions.map((r: any) => r.e).sort(), ['❤️', '❤️'], 'B replaced, A added: one each');
  await call(b.cookie, `/api/messages/${msg.id}/react`, 'POST', { emoji: '❤️' }); // same again = remove
  list = (await call(a.cookie, `/api/circles/${circle}/messages?after_seq=0`)).json.find((m: any) => m.id === msg.id);
  assert.equal(list.reactions.length, 1);
  assert.equal((await call(a.cookie, `/api/messages/${msg.id}/react`, 'POST', { emoji: '💣' })).status, 400);
  const outsider = await login('Y');
  assert.equal((await call(outsider.cookie, `/api/messages/${msg.id}/react`, 'POST', { emoji: '👍' })).status, 404);
  cb.ws.close();
});

test('edit: only the sender, only text, only within 15 minutes; shows as edited and is pushed to everyone', async () => {
  const { a, b, circle } = await trio();
  const msg = (await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'old' })).json;
  const cb = await connect(b.cookie);
  assert.equal((await call(b.cookie, `/api/messages/${msg.id}`, 'PATCH', { body: 'hijack' })).status, 403);
  assert.equal((await call(a.cookie, `/api/messages/${msg.id}`, 'PATCH', { body: '  ' })).status, 400);
  assert.equal((await call(a.cookie, `/api/messages/${msg.id}`, 'PATCH', { body: 'new' })).status, 200);
  const upd = await cb.next(f => f.t === 'update' && f.m.body === 'new');
  assert.ok(upd.m.editedAt, 'marked as edited');
  run("UPDATE messages SET created_at = datetime('now', '-16 minutes') WHERE id = ?", msg.id);
  assert.equal((await call(a.cookie, `/api/messages/${msg.id}`, 'PATCH', { body: 'too late' })).status, 403);
  cb.ws.close();
});

test('typing is relayed to the others (never back to the typist) and is not stored', async () => {
  const { a, b, circle } = await trio();
  const ca = await connect(a.cookie), cb = await connect(b.cookie);
  ca.send({ t: 'typing', circle, on: true });
  const f = await cb.next(x => x.t === 'typing');
  assert.equal(f.user, a.id);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(ca.frames.filter(x => x.t === 'typing').length, 0, 'the typist is not told about their own typing');
  ca.ws.close(); cb.ws.close();
});

test('T-10: edits, reactions and deletions made while a device was away reach it when it syncs by rev', async () => {
  const { a, b, circle } = await trio();
  const m1 = (await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'one' })).json;
  const m2 = (await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'two' })).json;
  const m3 = (await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'three' })).json;
  // B is up to date, then goes away.
  const first = (await call(b.cookie, `/api/circles/${circle}/messages?after_rev=0`)).json;
  const watermark = Math.max(...first.map((m: any) => m.rev));
  // While B is away: m1 edited, m2 reacted to, m3 deleted for everyone, and a brand-new message.
  await call(a.cookie, `/api/messages/${m1.id}`, 'PATCH', { body: 'one (fixed)' });
  await call(a.cookie, `/api/messages/${m2.id}/react`, 'POST', { emoji: '❤️' });
  await call(a.cookie, `/api/messages/${m3.id}`, 'DELETE');
  await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'four' });
  const delta = (await call(b.cookie, `/api/circles/${circle}/messages?after_rev=${watermark}`)).json;
  const byId = new Map(delta.map((m: any) => [m.id, m]));
  assert.equal((byId.get(m1.id) as any).body, 'one (fixed)');
  assert.ok((byId.get(m1.id) as any).editedAt);
  assert.deepEqual((byId.get(m2.id) as any).reactions, [{ u: a.id, e: '❤️' }]);
  assert.equal((byId.get(m3.id) as any).deleted, 1);
  assert.equal((byId.get(m3.id) as any).body, '');
  assert.ok([...byId.values()].some((m: any) => m.body === 'four'), 'the new message is in the same delta');
  // revs are strictly increasing in the reply, so the last one is a safe watermark
  const revs = delta.map((m: any) => m.rev);
  assert.deepEqual(revs, [...revs].sort((x: number, y: number) => x - y));
  // Nothing changed since: an empty reply.
  assert.deepEqual((await call(b.cookie, `/api/circles/${circle}/messages?after_rev=${revs.at(-1)}`)).json, []);
});

test('M-12 star: private to the person, per message, listed newest first, gone when the message is deleted', async () => {
  const { a, b, circle } = await trio();
  const m1 = (await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'one' })).json;
  const m2 = (await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'two' })).json;
  await call(b.cookie, `/api/messages/${m1.id}/star`, 'POST', {});
  await call(b.cookie, `/api/messages/${m2.id}/star`, 'POST', {});
  await call(b.cookie, `/api/messages/${m2.id}/star`, 'POST', {}); // twice is fine
  assert.deepEqual((await call(b.cookie, `/api/circles/${circle}/starred`)).json.map((m: any) => m.body), ['two', 'one']);
  assert.deepEqual((await call(a.cookie, `/api/circles/${circle}/starred`)).json, [], "A sees none of B's stars");
  await call(b.cookie, `/api/messages/${m1.id}/star`, 'POST', { on: false });
  assert.equal((await call(b.cookie, `/api/circles/${circle}/starred`)).json.length, 1);
  await call(a.cookie, `/api/messages/${m2.id}`, 'DELETE');
  assert.equal((await call(b.cookie, `/api/circles/${circle}/starred`)).json.length, 0);
  // starring never changes the message for anyone (no revision bump)
  const rev = () => (call(a.cookie, `/api/circles/${circle}/messages?after_rev=0`)).then(r => r.json.find((m: any) => m.id === m1.id).rev);
  const before = await rev();
  await call(b.cookie, `/api/messages/${m1.id}/star`, 'POST', {});
  assert.equal(await rev(), before);
});

test('M-11 forward: copies text to circles you belong to with a hop count; the archive agent never reads it; limits apply', async () => {
  const { a, b, circle } = await trio();
  const other = (await call(b.cookie, '/api/circles', 'POST', { name: 'ثانية' })).json.id as number;
  await call(b.cookie, `/api/circles/${other}`, 'PATCH', { agentActive: true });
  const src = (await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'توفي جدي رحمه الله اليوم' })).json;
  const res = await call(b.cookie, `/api/messages/${src.id}/forward`, 'POST', { circles: [other] });
  assert.equal(res.status, 200);
  const fwd = (await call(b.cookie, `/api/circles/${other}/messages?after_seq=0`)).json.find((m: any) => m.id === res.json.sent[0]);
  assert.equal(fwd.body, 'توفي جدي رحمه الله اليوم');
  assert.equal(fwd.forwardCount, 1);
  assert.equal(fwd.archiveStatus, 'none', 'forwarded text is never analysed for the archive, even a death notice');
  // hops accumulate
  const again = await call(b.cookie, `/api/messages/${fwd.id}/forward`, 'POST', { circles: [circle] });
  const hop2 = (await call(b.cookie, `/api/circles/${circle}/messages?after_seq=0`)).json.find((m: any) => m.id === again.json.sent[0]);
  assert.equal(hop2.forwardCount, 2);
  // targets must be circles you belong to, non-empty and at most five
  const outsider = await login('Z');
  const foreign = (await call(outsider.cookie, '/api/circles', 'POST', { name: 'غريبة' })).json.id;
  assert.equal((await call(b.cookie, `/api/messages/${src.id}/forward`, 'POST', { circles: [foreign] })).status, 404);
  assert.equal((await call(b.cookie, `/api/messages/${src.id}/forward`, 'POST', { circles: [] })).status, 400);
  assert.equal((await call(b.cookie, `/api/messages/${src.id}/forward`, 'POST', { circles: [1, 2, 3, 4, 5, 6] })).status, 400);
  // you cannot forward a message from a circle you are not in
  assert.equal((await call(outsider.cookie, `/api/messages/${src.id}/forward`, 'POST', { circles: [foreign] })).status, 404);
});

test('chat list: preview, kind, sender, time; pin/mute/archive/favourite are personal; pin limit; opening clears "mark as unread"', async () => {
  const { a, b, circle } = await trio();
  const second = (await call(a.cookie, '/api/circles', 'POST', { name: 'ثانية' })).json.id as number;
  await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: 'آخر رسالة هنا' });
  const list = async (u: { cookie: string }) => (await call(u.cookie, '/api/circles')).json as any[];
  const rowB = (await list(b)).find(x => x.id === circle);
  assert.deepEqual([rowB.lastKind, rowB.lastText, rowB.lastAuthor, rowB.lastFromMe, rowB.unread], ['text', 'آخر رسالة هنا', 'A', false, 1]);
  assert.equal((await list(a)).find(x => x.id === circle).lastFromMe, true);
  assert.ok(rowB.lastAt);

  // personal prefs: A pins/favourites/mutes; B sees none of it
  await call(a.cookie, `/api/circles/${second}/prefs`, 'PATCH', { pinned: true, favourite: true, muted: true });
  const ra = (await list(a)).find(x => x.id === second);
  assert.deepEqual([ra.pinned, ra.favourite, ra.muted, ra.archived], [true, true, true, false]);
  assert.equal((await list(a))[0].id, second, 'pinned sorts first even though the other chat is newer');
  assert.equal((await call(b.cookie, `/api/circles/${second}/prefs`, 'PATCH', { pinned: true })).status, 404, 'a non-member cannot touch it');
  // archive + mark unread
  await call(a.cookie, `/api/circles/${circle}/prefs`, 'PATCH', { archived: true, markedUnread: true });
  assert.deepEqual([(await list(a)).find(x => x.id === circle).archived, (await list(a)).find(x => x.id === circle).markedUnread], [true, true]);
  await call(a.cookie, `/api/circles/${circle}/read`, 'POST', { seq: 1 });
  assert.equal((await list(a)).find(x => x.id === circle).markedUnread, false, 'reading clears the manual unread flag');
  // at most 3 pinned
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) ids.push((await call(a.cookie, '/api/circles', 'POST', { name: `p${i}` })).json.id);
  assert.equal((await call(a.cookie, `/api/circles/${ids[0]}/prefs`, 'PATCH', { pinned: true })).status, 200);
  assert.equal((await call(a.cookie, `/api/circles/${ids[1]}/prefs`, 'PATCH', { pinned: true })).status, 200);
  assert.equal((await call(a.cookie, `/api/circles/${ids[2]}/prefs`, 'PATCH', { pinned: true })).json.error, 'too_many_pinned');
  // attachment and deleted previews
  const fd = new FormData(); fd.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(1)])]), 'p.jpg'); fd.append('thumb', new Blob([]), 'n');
  const up = await app.request(`/api/circles/${circle}/attachments`, { method: 'POST', headers: { cookie: a.cookie }, body: fd });
  assert.equal((await list(b)).find(x => x.id === circle).lastKind, 'image');
  await call(a.cookie, `/api/messages/${(await up.json() as any).id}`, 'DELETE');
  assert.equal((await list(b)).find(x => x.id === circle).lastKind, 'deleted');
});

test('M-12b pinned messages: any member pins for 24h/7d/30d, up to 3 (oldest makes room), everyone sees them, they expire and vanish with the message', async () => {
  const { a, b, circle } = await trio();
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) ids.push((await call(a.cookie, `/api/circles/${circle}/messages`, 'POST', { body: `m${i}` })).json.id);
  const cb = await connect(b.cookie);
  assert.equal((await call(b.cookie, `/api/messages/${ids[0]}/pin`, 'POST', { hours: 5 })).status, 400, 'only 24h, 7d or 30d');
  assert.equal((await call(b.cookie, `/api/messages/${ids[0]}/pin`, 'POST', { hours: 24 })).status, 200, 'a plain member may pin');
  await cb.next(f => f.t === 'pins');
  for (const i of [1, 2, 3]) { await call(a.cookie, `/api/messages/${ids[i]}/pin`, 'POST', { hours: 168 }); await new Promise(r => setTimeout(r, 15)); }
  const pins = (await call(a.cookie, `/api/circles/${circle}/pins`)).json;
  assert.deepEqual(pins.map((m: any) => m.body), ['m3', 'm2', 'm1'], 'newest first, and only 3: the oldest pin made room');
  // expiry
  run("UPDATE pinned_messages SET expires_at = datetime('now', '-1 minute') WHERE message_id = ?", ids[1]);
  assert.deepEqual((await call(b.cookie, `/api/circles/${circle}/pins`)).json.map((m: any) => m.body), ['m3', 'm2']);
  // unpin and deletion
  await call(b.cookie, `/api/messages/${ids[2]}/pin`, 'DELETE');
  assert.deepEqual((await call(a.cookie, `/api/circles/${circle}/pins`)).json.map((m: any) => m.body), ['m3']);
  await call(a.cookie, `/api/messages/${ids[3]}`, 'DELETE');
  assert.deepEqual((await call(a.cookie, `/api/circles/${circle}/pins`)).json, [], 'a message deleted for everyone leaves the pins');
  const outsider = await login('Q');
  assert.equal((await call(outsider.cookie, `/api/circles/${circle}/pins`)).status, 404);
  assert.equal((await call(outsider.cookie, `/api/messages/${ids[0]}/pin`, 'POST', { hours: 24 })).status, 404);
  cb.ws.close();
});

test('Memory tab: one timeline across your family circles, same visibility rules as each archive, nothing from groups, direct chats or deleted circles', async () => {
  const { a, b, circle } = await trio();
  const second = (await call(a.cookie, '/api/circles', 'POST', { name: 'عائلة الأم' })).json.id as number;
  const group = (await call(a.cookie, '/api/circles', 'POST', { name: 'شلة', kind: 'group' })).json.id as number;
  const add = (c: number, title: string, date: string) =>
    run("INSERT INTO archive_entries (circle_id, title, summary, category, event_date, source) VALUES (?, ?, 's', 'other', ?, 'manual')", c, title, date);
  add(circle, 'تخرّج سارة', '2026-06-01');
  add(second, 'زواج خالد', '2026-08-15');
  add(group, 'خارج الدوائر', '2026-09-01');
  add(circle, 'قديم', '2019-01-01');
  // a conflict entry still inside its 24h hiding period: only managers and its parties may see it
  run("INSERT INTO archive_entries (circle_id, title, summary, category, event_date, source, kind, status, visible_after, parties) VALUES (?, 'خلاف مخفي', 's', 'other', '2026-10-01', 'auto', 'conflict', 'open', datetime('now', '+1 day'), '[]')", circle);
  const mem = async (u: { cookie: string }) => (await call(u.cookie, '/api/me/memory')).json as any[];
  const a1 = await mem(a);
  assert.deepEqual(a1.map(e => e.title).filter(t => t !== 'خلاف مخفي'), ['زواج خالد', 'تخرّج سارة', 'قديم'], 'newest first, across both circles, and not the plain group');
  assert.ok(a1.every(e => e.circleName), 'each entry says which circle it belongs to');
  assert.deepEqual((await mem(b)).map(e => e.title), ['تخرّج سارة', 'قديم'], "B is only in the first circle, and the owner-only pending conflict is hidden from B");
  await call(a.cookie, `/api/circles/${second}`, 'DELETE', { confirm: 'عائلة الأم' });
  assert.ok(!(await mem(a)).some(e => e.title === 'زواج خالد'), 'a deleted circle leaves the timeline');
});
