process.env.THIKRA_DEV = '1';   // these tests sign in with the on-screen code, which only exists in explicit development mode
// Feature 6: a long chat opens on its latest messages and older ones load in pages of 50 as the person scrolls up.
// What must hold: walking back never skips or repeats a message, new messages arriving meanwhile change nothing in the older pages,
// and a page never contains what this reader hid.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { app } = await import('./index.ts');
const { db, run, one } = await import('./db.ts');

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
};
let n = 0;
async function person(name: string) {
  const phone = `+96658${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(2, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, id: (await call(cookie, '/api/me')).json.id as number };
}

// A family chat with 10,000 messages, written straight into the table (sending them one by one would test sending, not paging).
const a = await person('ناصر'), b = await person('سارة');
const circle = (await call(a.cookie, '/api/circles', 'POST', { name: 'عائلة' })).json.id as number;
await call(b.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${circle}`)).json.inviteCode });
const start = one('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE circle_id = ?', circle)!.s as number;
const TOTAL = 10_000;
db.exec('BEGIN');
for (let i = 1; i <= TOTAL; i++) run("INSERT INTO messages (circle_id, user_id, kind, body, seq, rev) VALUES (?, ?, 'text', ?, ?, ?)", circle, i % 2 ? a.id : b.id, `رسالة ${i}`, start + i, start + i);
db.exec('COMMIT');
const top = start + TOTAL;
const page = (cookie: string, query: string) => call(cookie, `/api/circles/${circle}/messages?${query}`);

test('opening the chat with limit=50 gives the latest 50, oldest first', async () => {
  const r = await page(a.cookie, 'after=0&limit=50');
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 50);
  assert.deepEqual([r.json[0].seq, r.json[49].seq], [top - 49, top]);
  assert.equal((await page(a.cookie, 'after=0')).json.length, 200, 'without a limit an older client still gets its 200');
});

test('walking back with before_seq visits every message exactly once, in order, 50 at a time', async () => {
  const seen: number[] = [];
  let before = top + 1, pages = 0;
  for (;;) {
    const r = await page(a.cookie, `before_seq=${before}&limit=50`);
    assert.equal(r.status, 200);
    const seqs = (r.json as any[]).map(m => m.seq as number);
    if (!seqs.length) break;
    assert.ok(seqs.length <= 50);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'each page is oldest first');
    assert.ok(seqs[seqs.length - 1] < before, 'strictly older than what was asked');
    seen.unshift(...seqs);
    before = seqs[0];
    pages++;
  }
  assert.equal(seen.length, top, 'every message of the chat, the notices at its start included');
  assert.deepEqual(seen, Array.from({ length: top }, (_, i) => i + 1), 'no hole and no repeat');
  assert.equal(pages, Math.ceil(top / 50));
});

test('messages that arrive between two page requests do not shift the older pages', async () => {
  const first = (await page(a.cookie, `before_seq=${top + 1}&limit=50`)).json as any[];
  for (let i = 0; i < 3; i++) await call(b.cookie, `/api/circles/${circle}/messages`, 'POST', { body: `جديدة ${i}` });
  const second = (await page(a.cookie, `before_seq=${first[0].seq}&limit=50`)).json as any[];
  assert.equal(second[second.length - 1].seq, first[0].seq - 1, 'the next page ends exactly where the first began');
  assert.equal(second.length, 50);
});

test('a message this reader hid for themselves is not in their pages, and still is in the other person\'s', async () => {
  const target = one('SELECT id, seq FROM messages WHERE circle_id = ? AND seq = ?', circle, 5000)!;
  run('INSERT INTO message_hidden (user_id, message_id) VALUES (?, ?)', a.id, target.id);
  const mine = ((await page(a.cookie, 'before_seq=5026&limit=50')).json as any[]).map(m => m.seq);
  assert.ok(!mine.includes(5000));
  assert.equal(mine.length, 50, 'the page is still full: the next older message takes its place');
  assert.ok(((await page(b.cookie, 'before_seq=5026&limit=50')).json as any[]).some(m => m.seq === 5000));
});

test('the default page is 50; a silly limit is clamped; a bad before_seq is refused; a non-member sees nothing', async () => {
  assert.equal((await page(a.cookie, `before_seq=${top}`)).json.length, 50);
  assert.equal((await page(a.cookie, `before_seq=${top}&limit=9999`)).json.length, 200);
  assert.equal((await page(a.cookie, `before_seq=${top}&limit=0`)).json.length, 1);
  assert.equal((await page(a.cookie, `before_seq=${top}&limit=abc`)).json.length, 50);
  assert.equal((await page(a.cookie, 'before_seq=abc')).status, 400);
  assert.equal((await page(a.cookie, 'before_seq=-5')).status, 400);
  assert.deepEqual((await page(a.cookie, 'before_seq=1')).json, [], 'nothing is older than the first message');
  const stranger = await person('غريب');
  assert.equal((await page(stranger.cookie, `before_seq=${top}`)).status, 404);
});

test('reading an old page does not move "delivered" or "read" marks (only new messages do)', async () => {
  const before = one('SELECT delivered_seq AS d, read_seq AS r FROM circle_members WHERE circle_id = ? AND user_id = ?', circle, b.id)!;
  await page(b.cookie, 'before_seq=300&limit=50');
  assert.deepEqual({ ...one('SELECT delivered_seq AS d, read_seq AS r FROM circle_members WHERE circle_id = ? AND user_id = ?', circle, b.id)! }, { ...before });
});

test('one old page from a 10,000-message chat answers fast', async () => {
  const t = performance.now();
  for (let i = 0; i < 10; i++) await page(a.cookie, `before_seq=${5000 - i * 50}&limit=50`);
  const each = (performance.now() - t) / 10;
  assert.ok(each < 50, `a page took ${each.toFixed(1)} ms`);
});
