// M-14: search inside a circle. Correctness first (Arabic spelling variants, privacy), then the speed target:
// MASTER-PLAN §6 says a result in under 300 ms at 100,000 messages.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { app } = await import('./index.ts');
const { run, db } = await import('./db.ts');
const { normalize } = await import('../core/agent.ts');

let counter = 0;
async function login(name: string) {
  const phone = `+9665${String(8_000_000 + counter++).padStart(8, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, id: (await (await app.request('/api/me', { headers: { cookie } })).json() as any).id as number };
}
const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
const search = async (cookie: string, circle: number, q: string) => (await call(cookie, `/api/circles/${circle}/search?q=${encodeURIComponent(q)}`)).json as any[];

test('search is Arabic-aware and respects privacy and deletion', async () => {
  const a = await login('A'), b = await login('B');
  const circle = (await call(a.cookie, '/api/circles', 'POST', { name: 'بحث' })).json.id;
  const code = (await call(a.cookie, `/api/circles/${circle}`)).json.inviteCode;
  await call(b.cookie, '/api/circles/join', 'POST', { code });
  const send = async (who: typeof a, body: string) => (await call(who.cookie, `/api/circles/${circle}/messages`, 'POST', { body })).json;
  const m1 = await send(a, 'زيارة أحمد إلى المزرعة يوم الجمعة');
  await send(b, 'Photos from the Farm trip');
  await send(a, 'موعد الدواء الساعة ٧');
  const m4 = await send(b, 'نسبة 100% و snake_case');

  assert.equal((await search(a.cookie, circle, 'احمد')).length, 1, 'alef variants: احمد finds أحمد');
  assert.equal((await search(a.cookie, circle, 'المزرعه')).length, 1, 'ta marbuta: ه finds ة');
  assert.equal((await search(a.cookie, circle, 'farm')).length, 1, 'Latin is case-insensitive');
  assert.equal((await search(a.cookie, circle, 'الساعة 7')).length, 1, 'Arabic-Indic digits match Western digits');
  assert.equal((await search(a.cookie, circle, 'الدَواء')).length, 1, 'diacritics are ignored');
  assert.equal((await search(a.cookie, circle, '100%')).length, 1, '% is searched literally, not as a wildcard');
  assert.equal((await search(a.cookie, circle, 'snake_c')).length, 1, '_ is searched literally');
  assert.equal((await search(a.cookie, circle, 'x_')).length, 0, '_ is not a wildcard');
  assert.deepEqual(await search(a.cookie, circle, 'ا'), [], 'a one-letter query returns nothing');

  // Newest first, with the author attached.
  await send(b, 'المزرعة جميلة');
  const res = await search(a.cookie, circle, 'مزرعه');
  assert.equal(res.length, 2);
  assert.ok(res[0].seq > res[1].seq);
  assert.equal(res[0].author, 'B');

  // Deleted for me: hidden from my results only. Deleted for everyone: gone for all, and its text is erased from the index.
  await call(b.cookie, `/api/messages/${m1.id}/hide`, 'POST', {});
  assert.equal((await search(b.cookie, circle, 'احمد')).length, 0);
  assert.equal((await search(a.cookie, circle, 'احمد')).length, 1);
  await call(a.cookie, `/api/messages/${m1.id}`, 'DELETE');
  assert.equal((await search(a.cookie, circle, 'احمد')).length, 0, 'deleted for everyone is not searchable');
  // Edited text is searched, the old text is not.
  await call(b.cookie, `/api/messages/${m4.id}`, 'PATCH', { body: 'نص جديد تماماً' });
  assert.equal((await search(a.cookie, circle, 'جديد')).length, 1);
  assert.equal((await search(a.cookie, circle, 'snake')).length, 0);
  // An outsider cannot search someone else's circle.
  const outsider = await login('X');
  assert.equal((await call(outsider.cookie, `/api/circles/${circle}/search?q=farm`)).status, 404);
});

test('speed: under 300 ms in a circle of 100,000 messages (MASTER-PLAN §6)', async () => {
  const a = await login('Perf');
  const circle = (await call(a.cookie, '/api/circles', 'POST', { name: 'كبيرة' })).json.id as number;
  const words = ['العائلة', 'الجمعة', 'المزرعة', 'السفر', 'الغداء', 'المدرسة', 'الحفلة', 'photos', 'dinner', 'tomorrow', 'مبروك', 'الله', 'يعطيك', 'العافية', 'صباح', 'الخير'];
  const N = 100_000;
  db.exec('BEGIN');
  const ins = db.prepare("INSERT INTO messages (circle_id, user_id, kind, body, search_text, seq, rev) VALUES (?, ?, 'text', ?, ?, ?, ?)");
  for (let i = 1; i <= N; i++) {
    const body = `${words[i % 16]} ${words[(i * 7) % 16]} ${words[(i * 3) % 16]} رقم ${i}`;
    ins.run(circle, a.id, body, normalize(body), i, i);
  }
  db.exec('COMMIT');
  run("INSERT INTO messages (circle_id, user_id, kind, body, search_text, seq, rev) VALUES (?, ?, 'text', 'ابرة في كومة قش', ?, ?, ?)", circle, a.id, normalize('ابرة في كومة قش'), N + 1, N + 1);

  const timeIt = async (q: string) => { const t = performance.now(); const r = await search(a.cookie, circle, q); return { ms: performance.now() - t, n: r.length }; };
  await timeIt('warm');
  const rare = await timeIt('كومه قش');       // one hit in 100,000 (a full scan)
  const common = await timeIt('الجمعه');      // thousands of hits, capped at 50
  const miss = await timeIt('لا يوجد ابدا');  // none
  console.log(`  100k messages: rare ${rare.ms.toFixed(0)} ms (${rare.n} hit), common ${common.ms.toFixed(0)} ms (${common.n} hits), miss ${miss.ms.toFixed(0)} ms  [${process.env.THIKRA_SQLITE === 'wasm' ? 'wasm' : 'node:sqlite'}]`);
  assert.equal(rare.n, 1);
  assert.equal(common.n, 50);
  for (const r of [rare, common, miss]) assert.ok(r.ms < 300, `a search took ${r.ms.toFixed(0)} ms, the target is under 300`);
});
