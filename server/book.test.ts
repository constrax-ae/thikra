// The yearly book: a printable page of the circle's year. What goes in matters as much as what stays out.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { run } = await import('./db.ts');

let n = 0;
async function login(name: string) {
  const phone = `+9665${String(5_000_000 + n++).padStart(8, '0')}`;
  const post = (p: string, b: unknown) => app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  return (await post('/api/auth/verify', { phone, code: devCode, name })).headers.get('set-cookie')!.split(';')[0];
}
const j = async (cookie: string, path: string, method = 'GET', body?: unknown) =>
  (await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
const book = (cookie: string, circle: number, q = '') => app.request(`/api/circles/${circle}/book${q}`, { headers: { cookie } });

test('the story has this year\'s events told as chapters, the departed and the born, and photos; not other years, not conflicts; and it is HTML-safe', async () => {
  const a = await login('الأب'), b = await login('الابن'), outsider = await login('غريب');
  const circle = (await j(a, '/api/circles', 'POST', { name: 'آل <b>الدوسري</b>' })).id as number;
  await j(b, '/api/circles/join', 'POST', { code: (await j(a, `/api/circles/${circle}`)).inviteCode });
  const add = (title: string, date: string, kind = 'event') =>
    run("INSERT INTO archive_entries (circle_id, title, summary, category, event_date, source, kind) VALUES (?, ?, ?, 'other', ?, 'manual', ?)", circle, title, `ملخص ${title}`, date, kind);
  add('تخرّج سارة', '2026-06-15');
  add('<script>alert(1)</script>', '2026-03-02');
  add('من العام الماضي', '2025-12-31');
  add('خلاف لا يُخلَّد', '2026-05-05', 'conflict');
  run("INSERT INTO persons (circle_id, name, relation, birth_date, death_date) VALUES (?, 'جدي أبو محمد', 'جدي', '1938-03-02', '2026-02-10')", circle);
  run("INSERT INTO persons (circle_id, name, relation, birth_date) VALUES (?, 'سلمى', 'حفيدة', '2026-08-01')", circle);
  for (let i = 0; i < 3; i++) await j(a, `/api/circles/${circle}/messages`, 'POST', { body: `m${i}` });
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(80).fill(2)])]), 'p.jpg'); fd.append('thumb', new Blob([]), 'n');
  await app.request(`/api/circles/${circle}/attachments`, { method: 'POST', headers: { cookie: a }, body: fd });

  const year = new Date().getFullYear();
  run("UPDATE messages SET created_at = ? WHERE circle_id = ?", '2026-04-04 10:00:00', circle); // put the activity inside 2026
  const res = await book(b, circle, '?year=2026&lang=ar');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.ok(res.headers.get('content-security-policy'), 'the site-wide security policy applies');
  const html = await res.text();
  assert.match(html, /تخرّج سارة/);
  assert.match(html, /2026/);
  assert.doesNotMatch(html, /من العام الماضي/, 'another year');
  assert.doesNotMatch(html, /خلاف لا يُخلَّد/, 'conflicts are never put in a book');
  assert.match(html, /ودّعنا هذا العام/);
  assert.match(html, /جدي أبو محمد/);
  assert.match(html, /وُلدوا هذا العام/);
  assert.match(html, /سلمى/);
  assert.match(html, /الفصل الأول/, 'the year is told as chapters');
  assert.match(html, /وفي .* من|وفي .*/, 'narrated, not listed');
  assert.match(html, /\/api\/media\/\d+/, 'photos are referenced from the circle\'s media (members only)');
  // nothing user-written is ever rendered as markup
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /آل <b>/);
  assert.match(html, /آل &lt;b&gt;الدوسري&lt;\/b&gt;/);
  assert.match(html, /<script src="\/book\.js"><\/script>/, 'only the one external script, never inline');
  // English edition, bad year, and access
  assert.match(await (await book(a, circle, '?year=2026&lang=en')).text(), /Our Family Story/);
  assert.equal((await book(a, circle, '?year=abc')).status, 400);
  assert.equal((await book(outsider, circle, '?year=2026')).status, 404, 'members only');
  assert.equal((await app.request(`/api/circles/${circle}/book`)).status, 401);
  void year;
});

test('the story: a title the family chooses, tone that follows the event, a model chapter only when allowed, and a person\'s edit is never overwritten', async () => {
  const { setAiFetch } = await import('./lib/story.ts');
  const a = await login('الراوي');
  const circle = (await j(a, '/api/circles', 'POST', { name: 'ناصر وديما' })).id as number;
  const add = (title: string, date: string, category: string | null, kind = 'event') =>
    run("INSERT INTO archive_entries (circle_id, title, summary, category, event_date, source, kind) VALUES (?, ?, ?, ?, ?, 'manual', ?)", circle, title, `تفاصيل ${title}`, category, date, kind);
  add('ولادة ليان', '2026-02-01', 'birth');
  add('وفاة الجد', '2026-02-20', 'passing');
  add('زواج أحمد', '2026-03-05', 'marriage');
  add('موقف الكبسة المحروقة', '2026-10-10', null, 'funny');
  const draft = await (await book(a, circle, '?year=2026&lang=ar')).text();
  assert.match(draft, /جاءت البشرى|أضاءت|حلّ في العائلة/, 'joy for a birth');
  assert.match(draft, /رحمه الله/, 'dignity and a prayer for a passing');
  assert.match(draft, /لكن الدنيا لا تصفو دائماً/, 'the tone shift is bridged: joy to sorrow');
  assert.match(draft, /وكأن الأيام أرادت أن تواسي القلوب/, 'and sorrow to joy');
  assert.match(draft, /ضحكت الدار|المواقف التي لن تُنسى/, 'humour for a funny moment');
  assert.match(draft, /الفصل الأول/); assert.match(draft, /الفصل الثاني/);
  assert.match(draft, /مسودة كتبتها القواعد/, 'a draft says it is a draft');

  assert.equal((await j(a, `/api/circles/${circle}`, 'PATCH', { storyTitle: 'قصة عائلتي (ناصر & ديما)' })).ok, true);
  const titled = await (await book(a, circle, '?year=2026&lang=ar')).text();
  assert.match(titled, /قصة عائلتي \(ناصر &amp; ديما\)/, 'the family\'s own title, escaped');

  // no model configured: asking changes nothing; with one (a fake network here) the chapters are written, but only for a circle that allowed the agent
  assert.deepEqual(await j(a, `/api/circles/${circle}/story`, 'POST', { year: 2026 }), { written: 0, model: false });
  process.env.THIKRA_AI_PROVIDER = 'anthropic'; process.env.ANTHROPIC_API_KEY = 'test-key';
  const calls: any[] = [];
  setAiFetch((async (_url: any, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ content: [{ text: '{"title":"حين ضحك البيت","paragraphs":["فقرة أدبية أولى.","فقرة ثانية."]}' }] }), { status: 200 }); }) as typeof fetch);
  assert.deepEqual(await j(a, `/api/circles/${circle}/story`, 'POST', { year: 2026 }), { written: 0, model: true }, 'the agent is not allowed in this circle: nothing is sent anywhere');
  assert.equal(calls.length, 0);
  run('UPDATE circles SET agent_active = 1 WHERE id = ?', circle);
  const wrote = await j(a, `/api/circles/${circle}/story`, 'POST', { year: 2026 });
  assert.equal(wrote.model, true); assert.ok(wrote.written >= 1);
  assert.match(calls[0].system, /لا تخترع/, 'the writer is told to use only the facts');
  assert.ok(JSON.stringify(calls[0].messages).includes('ولادة ليان'));
  const modelled = await (await book(a, circle, '?year=2026&lang=ar')).text();
  assert.match(modelled, /حين ضحك البيت/); assert.match(modelled, /فقرة أدبية أولى/);

  // a person's edit wins over the model, even on a forced rewrite
  assert.equal((await j(a, `/api/circles/${circle}/story/2026/1`, 'PUT', { title: 'عنواني', text: 'كلماتي أنا.' })).ok, true);
  await j(a, `/api/circles/${circle}/story`, 'POST', { year: 2026, force: true });
  const edited = await (await book(a, circle, '?year=2026&lang=ar')).text();
  assert.match(edited, /كلماتي أنا/); assert.match(edited, /عنواني/);
  assert.equal(edited.split('فقرة أدبية أولى').length - 1, 1, 'only the untouched chapter keeps the model\'s words');

  // the editor reads the same chapters, with who wrote each
  const listed = await j(a, `/api/circles/${circle}/story?year=2026&lang=ar`);
  assert.equal(listed.chapters[0].source, 'edited'); assert.equal(listed.chapters[0].text, 'كلماتي أنا.'); assert.equal(listed.chapters[1].source, 'model');
  assert.equal((await j(a, `/api/circles/${circle}/story?year=1`)).error, 'invalid_year');

  // a broken answer from the model falls back to the rules instead of breaking the book
  run('DELETE FROM story_chapters WHERE circle_id = ?', circle);
  setAiFetch((async () => new Response('not json', { status: 200 })) as typeof fetch);
  const bad = await j(a, `/api/circles/${circle}/story`, 'POST', { year: 2026 });
  assert.equal(bad.written, 0);
  assert.match(await (await book(a, circle, '?year=2026&lang=ar')).text(), /الفصل الأول/);
  delete process.env.THIKRA_AI_PROVIDER; delete process.env.ANTHROPIC_API_KEY;
});
