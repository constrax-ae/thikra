process.env.THIKRA_DEV = '1';   // these tests sign in with the on-screen code, which only exists in explicit development mode
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

test('searching every chat at once: only chats you are in, never a locked or encrypted one, and it says how many it could not read', async () => {
  const a = await login('A'), b = await login('B'), stranger = await login('S');
  const open = async (who: typeof a, name: string, body?: object) => (await call(who.cookie, '/api/circles', 'POST', { name, ...body })).json.id as number;
  const join = async (who: typeof a, circle: number) => {
    const code = (await call(a.cookie, `/api/circles/${circle}`)).json.inviteCode;
    await call(who.cookie, '/api/circles/join', 'POST', { code });
  };
  const send = async (who: typeof a, circle: number, body: string) => (await call(who.cookie, `/api/circles/${circle}/messages`, 'POST', { body })).json;
  const across = async (who: typeof a, q: string) => (await call(who.cookie, `/api/search?q=${encodeURIComponent(q)}`)).json;

  const family = await open(a, 'العائلة'); await join(b, family);
  const work = await open(a, 'العمل'); await join(b, work);
  const theirs = await open(stranger, 'ليست لك');
  await send(a, family, 'موعد الزيارة يوم الخميس');
  const atWork = await send(b, work, 'الزيارة الثانية للمصنع');
  await send(stranger, theirs, 'الزيارة سرية');

  const r = await across(a, 'الزياره');
  assert.equal(r.results.length, 2, 'both of my chats, and never the stranger\'s');
  assert.equal(r.results[0].id, atWork.id, 'newest first');
  assert.equal(r.results[0].circleId, work);
  assert.equal(r.results[0].circleName, 'العمل', 'each result says which chat it came from');
  assert.equal(r.results[0].author, 'B');
  assert.equal(r.skipped, 0);
  assert.deepEqual((await across(a, 'ا')).results, [], 'a one-letter query returns nothing');
  assert.equal((await across(stranger, 'الزياره')).results.length, 1, 'the stranger sees only their own');

  // A locked chat stays out of the results, and the answer admits it was not read.
  await call(a.cookie, `/api/circles/${work}/prefs`, 'PATCH', { locked: true });
  const locked = await across(a, 'الزياره');
  assert.deepEqual(locked.results.map((x: any) => x.circleId), [family], 'the locked chat is not searched');
  assert.equal(locked.skipped, 1, 'and the screen can say one chat was not looked inside');
  assert.equal((await across(b, 'الزياره')).results.length, 2, 'locking is mine alone: B still finds both');
  await call(a.cookie, `/api/circles/${work}/prefs`, 'PATCH', { locked: false });

  // An encrypted chat holds only ciphertext: the server cannot search it, and says so rather than implying "nothing".
  process.env.THIKRA_E2EE = '1';
  const made = await call(a.cookie, '/api/circles', 'POST', { name: 'سر', kind: 'group', encrypted: true });
  process.env.THIKRA_E2EE = '0';
  assert.equal(made.status, 201, 'encryption must be switched on for this test to mean anything');
  const secret = made.json.id as number;
  const enc = await across(a, 'الزياره');
  assert.equal(enc.skipped, 1);
  assert.ok(!enc.results.some((x: any) => x.circleId === secret));

  // Deleted for me: out of my results, still in B's.
  const mine = (await call(a.cookie, `/api/circles/${family}/messages?after=0`)).json.find((x: any) => x.body.includes('الخميس'));
  await call(a.cookie, `/api/messages/${mine.id}/hide`, 'POST', {});
  assert.deepEqual((await across(a, 'الزياره')).results.map((x: any) => x.circleId), [work]);
  assert.equal((await across(b, 'الزياره')).results.length, 2);
});

test('starred messages gathered from every chat, newest first, and each person sees only their own', async () => {
  const a = await login('A'), b = await login('B');
  const one = (await call(a.cookie, '/api/circles', 'POST', { name: 'أولى' })).json.id as number;
  const two = (await call(a.cookie, '/api/circles', 'POST', { name: 'ثانية' })).json.id as number;
  const code = (await call(a.cookie, `/api/circles/${one}`)).json.inviteCode;
  await call(b.cookie, '/api/circles/join', 'POST', { code });
  const m1 = (await call(a.cookie, `/api/circles/${one}/messages`, 'POST', { body: 'وصفة الكبسة' })).json;
  const m2 = (await call(a.cookie, `/api/circles/${two}/messages`, 'POST', { body: 'رقم السباك' })).json;
  const starred = async (who: typeof a) => (await call(who.cookie, '/api/starred')).json;

  assert.deepEqual((await starred(a)).results, [], 'nothing starred yet');
  await call(a.cookie, `/api/messages/${m1.id}/star`, 'POST', {});
  await call(a.cookie, `/api/messages/${m2.id}/star`, 'POST', {});
  await call(b.cookie, `/api/messages/${m1.id}/star`, 'POST', {});
  const mine = await starred(a);
  assert.deepEqual(mine.results.map((x: any) => x.id), [m2.id, m1.id], 'newest first, from both chats');
  assert.deepEqual(mine.results.map((x: any) => x.circleName), ['ثانية', 'أولى']);
  assert.deepEqual((await starred(b)).results.map((x: any) => x.id), [m1.id], 'a star is personal: B sees only the one they starred, in the chat they are in');
  await call(a.cookie, `/api/messages/${m1.id}/star`, 'POST', { on: false });
  assert.deepEqual((await starred(a)).results.map((x: any) => x.id), [m2.id]);
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
