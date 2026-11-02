process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+971500220001';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-ins-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { one, run } = await import('./db.ts');
const { anomalies, triageReports, suggestSupport, forecast } = await import('./lib/insights.ts');
const { refreshStats } = await import('./lib/rollups.ts');
const { briefTick, listBriefs } = await import('./lib/briefs.ts');
const { setOpsFetch } = await import('./lib/opsagent.ts');
const { costs } = await import('./lib/opsinfo.ts');
const { setTransport, saveSubscription } = await import('./push.ts');
const { TEMPLATES } = await import('./routes/support.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
async function signUp(phone: string, name: string, lang?: string) {
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode as string;
  const v = await call(undefined, '/api/auth/verify', { phone, code, name });
  if (lang) run('UPDATE users SET lang = ? WHERE phone = ?', lang, phone);
  return { cookie: v.cookie!, id: (await call(v.cookie, '/api/me')).json.id as number };
}
const owner = await signUp('+971500220001', 'Owner', 'ar');
const sara = await signUp('+971500220002', 'Sara', 'ar');
const bob = await signUp('+971500220003', 'Bob', 'en');
const troll = await signUp('+971500220004', 'Troll', 'ar');
const fam = (await call(sara.cookie, '/api/circles', { name: 'Fam', kind: 'circle' })).json.id as number;
const GB = 1024 ** 3;

test('a calm day shows nothing unusual; a sign-up spike does', () => {
  assert.deepEqual(anomalies(), []);
  for (let i = 0; i < 12; i++) run("INSERT INTO users (phone, name) VALUES (?, 'bot')", `+9665009${String(i).padStart(5, '0')}`);
  refreshStats();   // the day's row is rebuilt in the background; here, at once
  const a = anomalies();
  assert.equal(a.length, 1); assert.equal(a[0].code, 'signups'); assert.ok(a[0].today >= 12);
});

test('reports are ranked by urgency with the mildest sensible suggestion, and illegal content is left to a person', async () => {
  const msg = (n: number) => Number(run("INSERT INTO messages (circle_id, user_id, kind, body, client_msg_id) VALUES (?, ?, 'text', 'x', ?)", fam, troll.id, `t${n}`).lastInsertRowid);
  const rep = (reporter: number, reason: string, m: number) => Number(run('INSERT INTO reports (reporter_id, reported_user_id, circle_id, message_id, reason) VALUES (?, ?, ?, ?, ?)', reporter, troll.id, fam, m, reason).lastInsertRowid);
  const spamId = rep(bob.id, 'spam', msg(1));
  const ab1 = rep(sara.id, 'abuse', msg(2)), ab2 = rep(bob.id, 'abuse', msg(3)), ab3 = rep(owner.id, 'harassment', msg(4));
  const illegal = Number(run("INSERT INTO reports (reporter_id, reported_user_id, circle_id, reason) VALUES (?, ?, ?, 'illegal')", sara.id, bob.id, fam).lastInsertRowid);
  const t = triageReports();
  assert.equal(t[0].reportId, illegal, 'illegal first');
  assert.equal(t.find(x => x.reportId === illegal)!.suggestion!.args.action, 'escalate');
  const repeat = t.find(x => x.reportId === ab3)!;
  assert.equal(repeat.suggestion!.kind, 'suspend_user');
  assert.equal(repeat.suggestion!.args.userId, troll.id);
  void ab1; void ab2; void spamId;

  const asked = (await call(owner.cookie, '/api/admin/agent/ask', { question: 'اقترح قرارات البلاغات' })).json;
  assert.ok(asked.proposals.length >= 3 && asked.proposals.length <= 5);
  const props = (await call(owner.cookie, '/api/admin/agent/proposals?status=pending')).json as any[];
  const warn = props.find(p => p.kind === 'report_action' && p.args.action === 'warn');
  assert.ok(warn, 'a warn proposal exists');
  assert.equal((await call(owner.cookie, `/api/admin/agent/proposals/${warn.id}/approve`, {})).status, 200);
  assert.equal(one('SELECT status FROM reports WHERE id = ?', warn.args.reportId)!.status, 'resolved', 'approving ran the real report action');
  const text = (await call(owner.cookie, '/api/admin/agent/ask', { question: 'فرز البلاغات' })).json.answer as string;
  assert.match(text, new RegExp(`#${illegal}`));
});

test('support: a known topic gets the ready answer in the person\'s language, an unknown one gets none, and the agent proposes the reply', async () => {
  const open = (uid: number, subject: string, body: string) => { const id = Number(run('INSERT INTO support_cases (user_id, subject) VALUES (?, ?)', uid, subject).lastInsertRowid); run('INSERT INTO support_messages (case_id, from_staff, body) VALUES (?, 0, ?)', id, body); return id; };
  const ar = open(sara.id, 'مشكلة', 'لم يصلني رمز التحقق على رقمي +971500220002');
  const en = open(bob.id, 'help', 'how do I change my number please');
  const none = open(bob.id, 'hello', 'thank you for the app');
  const a = suggestSupport(ar)!, b = suggestSupport(en)!;
  assert.equal(a.topic, 'code'); assert.equal(a.draft, TEMPLATES.find(t => t.id === 'code')!.ar);
  assert.ok(!a.excerpt.includes('971500220002'), 'numbers hidden');
  assert.equal(b.topic, 'number'); assert.equal(b.draft, TEMPLATES.find(t => t.id === 'number')!.en);
  assert.equal(suggestSupport(none)!.draft, null);
  assert.equal(suggestSupport(99999), null);
  const asked = (await call(owner.cookie, '/api/admin/agent/ask', { question: `رد على الدعم ${en}` })).json;
  assert.equal(asked.proposals.length, 1);
  assert.equal((await call(owner.cookie, `/api/admin/agent/proposals/${asked.proposals[0]}/approve`, {})).status, 200);
  assert.equal(one('SELECT body FROM support_messages WHERE case_id = ? AND from_staff = 1', en)!.body, b.draft);
});

test('forecast: a family adding space quickly is warned about before it is full', () => {
  const add = (h: string, size: number) => { run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', h, size); run("INSERT INTO media (circle_id, uploader_id, blob_hash, kind, mime, size, archived) VALUES (?, ?, ?, 'image', 'image/jpeg', ?, 1)", fam, sara.id, h, size); };
  add('f1', Math.round(3 * GB)); add('f2', Math.round(1.2 * GB));      // 4.2 of 5 GB, all added in the last 14 days
  const f = forecast();
  assert.equal(f.fullWithin30Days[0].id, fam);
  assert.ok(f.fullWithin30Days[0].daysToFull <= 30 && f.fullWithin30Days[0].perWeekGB > 1);
  assert.ok(f.platformGrowthGBPerMonth >= 4);
});

test('the agent writes its own summaries once a day and pushes to the owner only for NEW serious items', async () => {
  const pushes: string[] = [];
  setTransport(async (_s, payload) => { pushes.push(JSON.parse(payload).body); });
  saveSubscription(owner.id, { endpoint: 'https://push.example.test/owner', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } }, 'test');
  const at = (h: number) => new Date(`${new Date().toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:10:00Z`);
  const t1 = await briefTick(at(3));
  assert.ok(!t1.made.includes('morning'), 'the morning summary waits for its hour');
  assert.ok(t1.made.includes('alert'), 'but serious items are told at once (no backup, an old report…)');
  assert.equal(t1.pushed, 1); await new Promise(r => setTimeout(r, 30));
  assert.equal(pushes.length, 1); assert.match(pushes[0], /[\u0600-\u06FF]/, 'in the owner\'s language');
  const t2 = await briefTick(at(6));
  assert.deepEqual(t2.made, ['morning'], 'the morning summary, and no second alert for the same problems');
  const t3 = await briefTick(at(7));
  assert.deepEqual(t3.made, [], 'nothing new: no second summary, no nagging');
  const t4 = await briefTick(at(17));
  assert.ok(t4.made.includes('evening'));
  assert.equal(listBriefs().filter(b => b.kind === 'morning').length, 1);
  assert.equal((await call(owner.cookie, '/api/admin/agent/brief', {})).status, 201);
  assert.equal((await call(owner.cookie, '/api/admin/agent/briefs')).json.length >= 4, true);
  assert.equal((await call(sara.cookie, '/api/admin/agent/briefs')).status, 403);
});

test('the language model\'s tokens are counted and priced into the monthly cost', async () => {
  process.env.THIKRA_AI_PROVIDER = 'anthropic'; process.env.ANTHROPIC_API_KEY = 'k';
  setOpsFetch((async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2_000_000, output_tokens: 100_000 } }), { status: 200 })) as typeof fetch);
  const before = costs().aiCost;
  await call(owner.cookie, '/api/admin/agent/ask', { question: 'hello there' });
  const after = costs();
  assert.equal(after.aiCalls, 1);
  assert.equal(Math.round((after.aiCost - before) * 100) / 100, 7.5, '2M in × $3 + 0.1M out × $15');
  delete process.env.THIKRA_AI_PROVIDER; delete process.env.ANTHROPIC_API_KEY;
});
