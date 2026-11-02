process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { app } = await import('./index.ts');

async function call(path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
  const res = await app.request(path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, json };
}

async function login(phone: string, name: string) {
  const { json } = await call('/api/auth/request', { body: { phone } });
  const { res } = await call('/api/auth/verify', { body: { phone, code: json.devCode, name } });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie')!.split(';')[0];
}

test('unauthenticated requests are rejected', async () => {
  assert.equal((await call('/api/circles')).res.status, 401);
});

test('wrong OTP code is rejected, new user needs a name', async () => {
  const { json } = await call('/api/auth/request', { body: { phone: '+966500000001' } });
  const bad = await call('/api/auth/verify', { body: { phone: '+966500000001', code: '000000', name: 'x' } });
  assert.equal(bad.res.status, 400);
  const noName = await call('/api/auth/verify', { body: { phone: '+966500000001', code: json.devCode } });
  assert.equal(noName.json.error, 'name_required');
});

test('full circle flow: agent off by default, notice on activation, archive, owner-only controls', async () => {
  const owner = await login('+966500000010', 'ناصر');
  const member = await login('+966500000011', 'سارة');
  const outsider = await login('+966500000012', 'غريب');

  const { json: created } = await call('/api/circles', { body: { name: 'عائلة الدوسري' }, cookie: owner });
  const id = created.id;
  const { json: detail } = await call(`/api/circles/${id}`, { cookie: owner });
  assert.ok(detail.inviteCode);
  assert.equal((await call('/api/circles/join', { body: { code: detail.inviteCode }, cookie: member })).res.status, 200);

  // Members never see the invite code; outsiders see nothing.
  assert.equal((await call(`/api/circles/${id}`, { cookie: member })).json.inviteCode, undefined);
  assert.equal((await call(`/api/circles/${id}`, { cookie: outsider })).res.status, 404);
  assert.equal((await call(`/api/circles/${id}/messages`, { cookie: outsider })).res.status, 404);

  const news = 'الحمدلله رزقنا بمولود جديد اسمه أحمد يوم الخميس، ألف مبروك لأخوي';
  await call(`/api/circles/${id}/messages`, { body: { body: news }, cookie: member });
  assert.equal((await call(`/api/circles/${id}/archive`, { cookie: owner })).json.length, 0, 'agent is off: nothing archived');

  assert.equal((await call(`/api/circles/${id}`, { method: 'PATCH', body: { agentActive: true }, cookie: member })).res.status, 403);
  await call(`/api/circles/${id}`, { method: 'PATCH', body: { agentActive: true, sensitivity: 'strict' }, cookie: owner });

  const msgs1 = (await call(`/api/circles/${id}/messages`, { cookie: member })).json;
  assert.ok(msgs1.some((m: any) => m.kind === 'system' && m.body.includes('"k":"agentOn"')), 'members are notified');
  assert.equal(msgs1.find((m: any) => m.body === news).archiveStatus, 'none', 'old messages are not analysed retroactively');

  const sent = await call(`/api/circles/${id}/messages`, { body: { body: news }, cookie: member });
  const archive = (await call(`/api/circles/${id}/archive`, { cookie: owner })).json;
  assert.equal(archive.length, 1);
  assert.equal(archive[0].category, 'birth');

  await call(`/api/circles/${id}/messages`, { body: { body: 'هلا' }, cookie: member });
  const hala = (await call(`/api/circles/${id}/messages`, { cookie: member })).json.at(-1);
  assert.equal(hala.archiveStatus, 'none', 'small talk is stopped at the AI gate and stays ordinary chat');
  const manual = await call(`/api/messages/${hala.id}/archive`, { method: 'POST', cookie: member });
  assert.equal(manual.json.archiveStatus, 'rejected', 'floor holds even for manual requests');

  assert.equal((await call(`/api/archive/${archive[0].id}`, { method: 'DELETE', cookie: member })).res.status, 403);
  assert.equal((await call(`/api/archive/${archive[0].id}`, { method: 'DELETE', cookie: owner })).res.status, 200);
  assert.equal((await call(`/api/circles/${id}/archive`, { cookie: owner })).json.length, 0);
  assert.ok(sent.res.status === 201);
});

test('only the platform admin can open admin routes, and they see no message text', async () => {
  const first = await call('/api/admin/stats', { cookie: await login('+966500000010', 'ناصر') });
  assert.equal(first.res.status, 200); // first registered user is admin
  const other = await call('/api/admin/stats', { cookie: await login('+966500000011', 'سارة') });
  assert.equal(other.res.status, 403);
  const circles = (await call('/api/admin/circles', { cookie: await login('+966500000010', 'ناصر') })).json;
  assert.ok(circles.every((c: any) => !('lastMessage' in c) && !('body' in c)));
});

// ---- conflict lifecycle -----------------------------------------------------------------

const TENSE = [
  'انت غلطان في كل شي وما تسمع لاحد ابدا يا اخي وهذا كلام معروف عنك',
  'كذاب والله ما قلت كذا ابدا وانت دايم تقلب الكلام علي في القروب',
  'اسكت وخلاص ما عاد ابغى اسمع منك شي في هذا الموضوع كله يا اخي',
  'قليل ادب ما تعرف تحترم احد في هالقروب ولا في غيره يا اخي',
  'ما تفهم ابدا ولا تحاول تفهم مهما شرحنا لك الموضوع يا اخي',
  'ابعد عني ولا تكلمني بعد اليوم على اي شي نهائيا يا اخي وانا اقول لك بصراحة',
];

async function conflictCircle(phones: [string, string, string, string]) {
  const [owner, a, b, d] = await Promise.all([
    login(phones[0], 'المالك'), login(phones[1], 'خالد'), login(phones[2], 'سعد'), login(phones[3], 'عبدالله'),
  ]);
  const { json: created } = await call('/api/circles', { body: { name: 'عائلة' }, cookie: owner });
  const id = created.id;
  const { json: detail } = await call(`/api/circles/${id}`, { cookie: owner });
  for (const c of [a, b, d]) await call('/api/circles/join', { body: { code: detail.inviteCode }, cookie: c });
  await call(`/api/circles/${id}`, { method: 'PATCH', body: { agentActive: true }, cookie: owner });
  for (const [i, line] of TENSE.entries()) await call(`/api/circles/${id}/messages`, { body: { body: line }, cookie: i % 2 === 0 ? a : b });
  return { id, owner, a, b, d };
}

test('a conflict is hidden for 24h from everyone but the owner and the two parties, then closed by a reconciliation', async () => {
  const { id, owner, a, b, d } = await conflictCircle(['+966500000020', '+966500000021', '+966500000022', '+966500000023']);

  assert.equal((await call(`/api/circles/${id}/archive`, { cookie: d })).json.length, 0, 'other members do not see it yet');
  for (const who of [owner, a, b]) {
    const rows = (await call(`/api/circles/${id}/archive`, { cookie: who })).json;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'conflict');
    assert.equal(rows[0].pending, true);
    assert.equal(rows[0].canAct, true);
    assert.equal(rows[0].summary, 'حدث خلاف بين خالد وسعد، وكان الجو متوتراً في القروب. نتمنى أن ينتهي وتعود المحبة.');
  }
  const chat = (await call(`/api/circles/${id}/messages`, { cookie: d })).json;
  assert.ok(!chat.some((m: any) => m.kind === 'system' && /خلاف/.test(m.body)), 'the agent never writes about it in the chat');

  await call(`/api/circles/${id}/messages`, { body: { body: 'سامحني يا اخوي ما كان قصدي ابدا' }, cookie: a });
  const after = (await call(`/api/circles/${id}/archive`, { cookie: d })).json;
  assert.equal(after.length, 1, 'visible to all once settled');
  assert.equal(after[0].title, 'خلاف ثم صلح');
  assert.match(after[0].summary, /عادت المياه إلى مجاريها/);
  assert.equal(after[0].pending, false);
  assert.equal((await call(`/api/circles/${id}/archive`, { cookie: owner })).json.length, 1, 'no second conflict is created');
});

test('the owner or a party can decline a conflict; an uninvolved member cannot', async () => {
  const { id, owner, a, d } = await conflictCircle(['+966500000030', '+966500000031', '+966500000032', '+966500000033']);
  const entry = (await call(`/api/circles/${id}/archive`, { cookie: owner })).json[0];
  assert.equal((await call(`/api/archive/${entry.id}/decline`, { method: 'POST', cookie: d })).res.status, 403);
  assert.equal((await call(`/api/archive/${entry.id}/decline`, { method: 'POST', cookie: a })).res.status, 200);
  for (const who of [owner, a, d]) assert.equal((await call(`/api/circles/${id}/archive`, { cookie: who })).json.length, 0);
});

test('a conflict that stays calm for a week is closed as passed', async () => {
  const { id, d } = await conflictCircle(['+966500000040', '+966500000041', '+966500000042', '+966500000043']);
  const { db } = await import('./db.ts');
  db.prepare("UPDATE archive_entries SET created_at = datetime('now', '-8 days'), visible_after = datetime('now', '-7 days') WHERE circle_id = ?").run(id);
  const rows = (await call(`/api/circles/${id}/archive`, { cookie: d })).json;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'خلاف وتعدّى');
  assert.match(rows[0].summary, /تعدّت المشكلة/);
});

test('nothing from before the agent was switched on is analysed for moments', async () => {
  const [owner, a, b] = await Promise.all([login('+966500000050', 'م'), login('+966500000051', 'ب'), login('+966500000052', 'ج')]);
  const { json: created } = await call('/api/circles', { body: { name: 'قديمة' }, cookie: owner });
  const { json: detail } = await call(`/api/circles/${created.id}`, { cookie: owner });
  for (const c of [a, b]) await call('/api/circles/join', { body: { code: detail.inviteCode }, cookie: c });
  for (const [i, line] of TENSE.entries()) await call(`/api/circles/${created.id}/messages`, { body: { body: line }, cookie: i % 2 === 0 ? a : b });
  await call(`/api/circles/${created.id}`, { method: 'PATCH', body: { agentActive: true }, cookie: owner });
  await call(`/api/circles/${created.id}/messages`, { body: { body: 'صباح الخير' }, cookie: a });
  assert.equal((await call(`/api/circles/${created.id}/archive`, { cookie: owner })).json.length, 0);
});

// ---- roles, invites, ownership ------------------------------------------------------------

const meId = async (cookie: string) => (await call('/api/me', { cookie })).json.id as number;

test('roles, invite controls and ownership transfer', async () => {
  const [o, a1, a2, m, x] = await Promise.all([
    login('+966500000060', 'المؤسس'), login('+966500000061', 'مشرف١'), login('+966500000062', 'مشرف٢'),
    login('+966500000063', 'عضو'), login('+966500000064', 'غريب'),
  ]);
  const { json: created } = await call('/api/circles', { body: { name: 'عائلة' }, cookie: o });
  const id = created.id;
  const code = (await call(`/api/circles/${id}`, { cookie: o })).json.inviteCode as string;
  for (const c of [a1, a2, m]) await call('/api/circles/join', { body: { code }, cookie: c });
  const [a1Id, a2Id, mId] = await Promise.all([meId(a1), meId(a2), meId(m)]);

  // Plain members change nothing and cannot hand out roles.
  assert.equal((await call(`/api/circles/${id}`, { method: 'PATCH', body: { sensitivity: 'strict' }, cookie: m })).res.status, 403);
  assert.equal((await call(`/api/circles/${id}/members/${a2Id}`, { method: 'PATCH', body: { role: 'admin' }, cookie: m })).res.status, 403);

  // Only the owner promotes; an admin can then manage settings and sees the invite code.
  for (const uid of [a1Id, a2Id]) assert.equal((await call(`/api/circles/${id}/members/${uid}`, { method: 'PATCH', body: { role: 'admin' }, cookie: o })).res.status, 200);
  assert.equal((await call(`/api/circles/${id}/members/${a2Id}`, { method: 'PATCH', body: { role: 'member' }, cookie: a1 })).res.status, 403, 'an admin cannot demote');
  assert.equal((await call(`/api/circles/${id}`, { method: 'PATCH', body: { sensitivity: 'strict' }, cookie: a1 })).res.status, 200);
  assert.equal((await call(`/api/circles/${id}`, { cookie: a1 })).json.inviteCode, code);
  assert.equal((await call(`/api/circles/${id}`, { cookie: m })).json.inviteCode, undefined);

  // Invite policy: "any member" shows the code to plain members too.
  await call(`/api/circles/${id}`, { method: 'PATCH', body: { invitePolicy: 'members' }, cookie: a1 });
  assert.equal((await call(`/api/circles/${id}`, { cookie: m })).json.inviteCode, code);

  // Switching invites off blocks joining and hides the code; a regenerated code replaces the old one.
  await call(`/api/circles/${id}`, { method: 'PATCH', body: { inviteEnabled: false }, cookie: o });
  assert.equal((await call('/api/circles/join', { body: { code }, cookie: x })).res.status, 404);
  const off = (await call(`/api/circles/${id}`, { cookie: a1 })).json;
  assert.equal(off.inviteEnabled, false);
  assert.equal(off.inviteCode, undefined);
  await call(`/api/circles/${id}`, { method: 'PATCH', body: { inviteEnabled: true }, cookie: o });
  assert.equal((await call(`/api/circles/${id}/invite/regenerate`, { method: 'POST', body: {}, cookie: m })).res.status, 403);
  const fresh = (await call(`/api/circles/${id}/invite/regenerate`, { method: 'POST', body: {}, cookie: a1 })).json.inviteCode as string;
  assert.notEqual(fresh, code);
  assert.equal((await call('/api/circles/join', { body: { code }, cookie: x })).res.status, 404, 'the old code is dead');

  // Removal rules: an admin removes plain members but not another admin; the owner removes anyone but themselves.
  assert.equal((await call(`/api/circles/${id}/members/${a2Id}`, { method: 'DELETE', cookie: a1 })).res.status, 403);
  assert.equal((await call(`/api/circles/${id}/members/${mId}`, { method: 'DELETE', cookie: a1 })).res.status, 200);
  assert.equal((await call(`/api/circles/${id}/members/${a2Id}`, { method: 'DELETE', cookie: o })).res.status, 200);

  // Transfer: the new owner takes over, the old one stays as admin and can no longer hand things over.
  assert.equal((await call(`/api/circles/${id}/transfer`, { body: { userId: a1Id }, cookie: a1 })).res.status, 403);
  assert.equal((await call(`/api/circles/${id}/transfer`, { body: { userId: a1Id }, cookie: o })).res.status, 200);
  assert.equal((await call(`/api/circles/${id}`, { cookie: a1 })).json.role, 'owner');
  assert.equal((await call(`/api/circles/${id}`, { cookie: o })).json.role, 'admin');
  assert.equal((await call(`/api/circles/${id}/transfer`, { body: { userId: await meId(o) }, cookie: o })).res.status, 403);
  assert.equal((await call(`/api/circles/${id}/members/${a1Id}`, { method: 'DELETE', cookie: a1 })).res.status, 409, 'the owner cannot leave');
});

// ---- storage and plan -----------------------------------------------------------------------

async function upload(circleId: number, cookie: string, bytes: Uint8Array, type = 'audio/webm') {
  const form = new FormData();
  form.append('audio', new File([bytes as BlobPart], 'v', { type }));
  const res = await app.request(`/api/circles/${circleId}/voice`, { method: 'POST', headers: { cookie }, body: form });
  return { res, json: await res.json().catch(() => null) };
}

test('voice lives in the blob store: stored once, counted once, heard only by members', async () => {
  const [o, m, x] = await Promise.all([login('+966500000070', 'م'), login('+966500000071', 'ب'), login('+966500000072', 'ج')]);
  const { json: created } = await call('/api/circles', { body: { name: 'صوت' }, cookie: o });
  const id = created.id;
  const code = (await call(`/api/circles/${id}`, { cookie: o })).json.inviteCode as string;
  await call('/api/circles/join', { body: { code }, cookie: m });

  const bytes = Uint8Array.from({ length: 2000 }, (_, i) => i % 251);
  const first = await upload(id, o, bytes, 'audio/webm;codecs=opus');
  const second = await upload(id, m, bytes);
  assert.equal(first.res.status, 201);
  assert.equal(second.res.status, 201);

  const bill = (await call(`/api/circles/${id}/billing`, { cookie: m })).json;
  assert.equal(bill.plan, 'free');
  assert.equal(bill.status, 'free');
  assert.equal(bill.sponsor, null);
  assert.equal(bill.chatBytes, 2000, 'the same clip sent twice is counted once');
  assert.equal(bill.archivedBytes, 0, 'chat media does not use the archive quota');
  assert.ok(bill.quotaBytes > 0);

  const heard = await app.request(`/api/messages/${first.json.id}/audio`, { headers: { cookie: m } });
  assert.equal(heard.status, 200);
  assert.equal(heard.headers.get('content-type'), 'audio/webm');
  assert.equal(heard.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await heard.arrayBuffer()), bytes);
  assert.equal((await app.request(`/api/messages/${first.json.id}/audio`, { headers: { cookie: x } })).status, 404);
  assert.equal((await call(`/api/circles/${id}/billing`, { cookie: x })).res.status, 404);

  assert.equal((await upload(id, o, bytes, 'text/html')).res.status, 400, 'only real audio types are accepted');
});

test('a lapsed subscription freezes the archive and deletes nothing', async () => {
  const [o, m] = await Promise.all([login('+966500000080', 'م'), login('+966500000081', 'ب')]);
  const { json: created } = await call('/api/circles', { body: { name: 'تجميد' }, cookie: o });
  const id = created.id;
  const code = (await call(`/api/circles/${id}`, { cookie: o })).json.inviteCode as string;
  await call('/api/circles/join', { body: { code }, cookie: m });
  await call(`/api/circles/${id}`, { method: 'PATCH', body: { agentActive: true, sensitivity: 'strict' }, cookie: o });

  const news = 'الحمدلله رزقنا بمولود جديد اسمه أحمد يوم الخميس، ألف مبروك لأخوي';
  await call(`/api/circles/${id}/messages`, { body: { body: news }, cookie: m });
  assert.equal((await call(`/api/circles/${id}/archive`, { cookie: o })).json.length, 1);

  const { db } = await import('./db.ts');
  db.prepare("INSERT INTO subscriptions (circle_id, plan, status) VALUES (?, 'family', 'readonly')").run(id);

  await call(`/api/circles/${id}/messages`, { body: { body: `${news} وبعدين` }, cookie: m });
  assert.equal((await call(`/api/circles/${id}/archive`, { cookie: o })).json.length, 1, 'nothing new is archived');
  const last = (await call(`/api/circles/${id}/messages`, { cookie: m })).json.at(-1);
  assert.equal((await call(`/api/messages/${last.id}/archive`, { method: 'POST', cookie: m })).res.status, 402);
  assert.equal((await call(`/api/circles/${id}/messages`, { body: { body: 'الشات يشتغل' }, cookie: m })).res.status, 201, 'chat keeps working');
  const bill = (await call(`/api/circles/${id}/billing`, { cookie: m })).json;
  assert.equal(bill.status, 'readonly');
  assert.equal(bill.plan, 'family');
});

// ---- persons -------------------------------------------------------------------------------------

test('every member is a person; managers add relatives who have died; members cannot', async () => {
  const [o, m] = await Promise.all([login('+966500000090', 'ناصر'), login('+966500000091', 'سارة')]);
  const { json: created } = await call('/api/circles', { body: { name: 'أشخاص' }, cookie: o });
  const id = created.id;
  const code = (await call(`/api/circles/${id}`, { cookie: o })).json.inviteCode as string;
  await call('/api/circles/join', { body: { code }, cookie: m });

  const initial = (await call(`/api/circles/${id}/persons`, { cookie: m })).json;
  assert.deepEqual(initial.map((p: any) => p.name), ['ناصر', 'سارة']);
  assert.ok(initial.every((p: any) => p.userId));

  const body = { name: 'الوالد', relation: 'أب', birthDate: '1950-05-01', deathDate: '2014-03-02' };
  assert.equal((await call(`/api/circles/${id}/persons`, { body, cookie: m })).res.status, 403);
  assert.equal((await call(`/api/circles/${id}/persons`, { body: { ...body, deathDate: '2014-13-45' }, cookie: o })).res.status, 400);
  const added = await call(`/api/circles/${id}/persons`, { body, cookie: o });
  assert.equal(added.res.status, 201);

  const father = (await call(`/api/circles/${id}/persons`, { cookie: m })).json.find((p: any) => p.name === 'الوالد');
  assert.equal(father.deathDate, '2014-03-02');
  assert.equal(father.userId, null, 'a person without an account is still a person');

  assert.equal((await call(`/api/persons/${added.json.id}`, { method: 'PATCH', body: { relation: 'الوالد رحمه الله' }, cookie: m })).res.status, 403);
  assert.equal((await call(`/api/persons/${added.json.id}`, { method: 'PATCH', body: { relation: 'الوالد رحمه الله' }, cookie: o })).res.status, 200);
  const updated = (await call(`/api/circles/${id}/persons`, { cookie: o })).json.find((p: any) => p.name === 'الوالد');
  assert.equal(updated.relation, 'الوالد رحمه الله');
  assert.equal(updated.deathDate, '2014-03-02', 'untouched fields stay');
});

// ---- import ----------------------------------------------------------------------------------

test('import: managers add the ticked events with their real dates; duplicates and junk are skipped', async () => {
  const [o, m] = await Promise.all([login('+966500000100', 'م'), login('+966500000101', 'ب')]);
  const { json: created } = await call('/api/circles', { body: { name: 'استيراد' }, cookie: o });
  const id = created.id;
  const code = (await call(`/api/circles/${id}`, { cookie: o })).json.inviteCode as string;
  await call('/api/circles/join', { body: { code }, cookie: m });

  const entry = { date: '2019-03-02', title: 'ولادة أحمد', summary: 'خالد: الحمدلله رزقنا بمولود', category: 'birth' };
  assert.equal((await call(`/api/circles/${id}/import`, { body: { entries: [entry] }, cookie: m })).res.status, 403, 'plain members cannot import');
  assert.equal((await call(`/api/circles/${id}/import`, { body: { entries: [] }, cookie: o })).res.status, 400);
  assert.equal((await call(`/api/circles/${id}/import`, { body: { entries: Array(501).fill(entry) }, cookie: o })).res.status, 400);

  const first = await call(`/api/circles/${id}/import`, {
    body: { entries: [entry, { ...entry, summary: 'x', date: '2019-13-45' }, { title: 'بلا ملخص', date: '2019-01-01' }, { ...entry, summary: 'سارة: تخرجت', category: 'weird' }] },
    cookie: o,
  });
  assert.deepEqual(first.json, { added: 2, skipped: 2 });
  const again = await call(`/api/circles/${id}/import`, { body: { entries: [entry] }, cookie: o });
  assert.deepEqual(again.json, { added: 0, skipped: 1 }, 'importing the same file twice adds nothing');

  const rows = (await call(`/api/circles/${id}/archive`, { cookie: m })).json;
  assert.equal(rows.length, 2);
  const birth = rows.find((r: any) => r.category === 'birth');
  assert.equal(birth.eventDate, '2019-03-02', 'the event keeps its real date, not the import date');
  const notice = (await call(`/api/circles/${id}/messages`, { cookie: m })).json.find((x: any) => x.kind === 'system' && x.body.includes('"k":"imported"'));
  assert.ok(notice, 'members are told that history was imported');
  assert.equal(rows.find((r: any) => r.summary.includes('تخرجت')).category, null, 'an unknown category is dropped');
});

test('import is refused while the archive is read-only', async () => {
  const o = await login('+966500000110', 'م');
  const { json: created } = await call('/api/circles', { body: { name: 'قراءة' }, cookie: o });
  const { db } = await import('./db.ts');
  db.prepare("INSERT INTO subscriptions (circle_id, plan, status) VALUES (?, 'free', 'readonly')").run(created.id);
  const r = await call(`/api/circles/${created.id}/import`, { body: { entries: [{ date: '2019-03-02', title: 't', summary: 's' }] }, cookie: o });
  assert.equal(r.res.status, 402);
});

// ---- phone numbers ---------------------------------------------------------------------------

test('every way of writing the same number reaches the same account', async () => {
  await login('+966500000120', 'ناصر');
  for (const variant of ['+966 50 000 0120', '00966500000120', '966500000120', '+٩٦٦٥٠٠٠٠٠١٢٠']) {
    const r = await call('/api/auth/request', { body: { phone: variant } });
    assert.equal(r.res.status, 200, variant);
    assert.equal(r.json.newUser, false, `${variant} is the same person`);
  }
  assert.equal((await call('/api/auth/request', { body: { phone: '+966500000121' } })).json.newUser, true);
});

test('numbers that cannot exist are refused before any code is sent', async () => {
  for (const bad of ['123', 'abc', '', '+1']) {
    assert.equal((await call('/api/auth/request', { body: { phone: bad } })).res.status, 400, bad);
  }
});

test('foreign numbers are accepted and stored in international form', async () => {
  const cookie = await login('+44 7911 123456', 'Sam');
  assert.equal((await call('/api/me', { cookie })).json.phone, '+447911123456');
});

// ---- deleting messages and circles --------------------------------------------------------------------

async function deletionCircle(phones: [string, string, string]) {
  const [o, a, b] = await Promise.all([login(phones[0], 'المؤسس'), login(phones[1], 'أحمد'), login(phones[2], 'سارة')]);
  const { json: created } = await call('/api/circles', { body: { name: 'حذف' }, cookie: o });
  const id = created.id;
  const code = (await call(`/api/circles/${id}`, { cookie: o })).json.inviteCode as string;
  for (const c of [a, b]) await call('/api/circles/join', { body: { code }, cookie: c });
  return { id, o, a, b, ids: { a: await meId(a), b: await meId(b), o: await meId(o) } };
}
const send = async (circle: number, cookie: string, body: string) =>
  (await call(`/api/circles/${circle}/messages`, { body: { body }, cookie })).json.id as number;
const listOf = async (circle: number, cookie: string) => (await call(`/api/circles/${circle}/messages`, { cookie })).json as any[];

test('delete for everyone: the sender can, other members cannot, a manager can; content is erased and shown as a placeholder', async () => {
  const { id, o, a, b, ids } = await deletionCircle(['+966500000130', '+966500000131', '+966500000132']);
  const mine = await send(id, a, 'رسالة خاصة بي');
  const theirs = await send(id, b, 'رسالة سارة');

  assert.equal((await call(`/api/messages/${mine}`, { method: 'DELETE', cookie: b })).res.status, 403, 'not your message');
  assert.equal((await call(`/api/messages/${mine}`, { method: 'DELETE', cookie: a })).res.status, 200);
  const seen = (await listOf(id, b)).find(m => m.id === mine);
  assert.equal(seen.deleted, 1);
  assert.equal(seen.body, '', 'the text is gone, not just hidden');
  assert.equal(seen.deletedBy, ids.a);
  assert.equal((await call(`/api/messages/${mine}`, { method: 'DELETE', cookie: a })).res.status, 404, 'already deleted');

  assert.equal((await call(`/api/messages/${theirs}`, { method: 'DELETE', cookie: o })).res.status, 200, 'the owner moderates');
  assert.equal((await listOf(id, a)).find(m => m.id === theirs).deletedBy, ids.o, 'shown as deleted by a manager');

  const system = (await listOf(id, o)).find(m => m.kind === 'system');
  assert.equal((await call(`/api/messages/${system.id}`, { method: 'DELETE', cookie: o })).res.status, 404, 'system notices stay');
});

test('delete for me hides it for you only', async () => {
  const { id, a, b } = await deletionCircle(['+966500000133', '+966500000134', '+966500000135']);
  const m = await send(id, a, 'للجميع إلا سارة');
  assert.equal((await call(`/api/messages/${m}/hide`, { method: 'POST', body: {}, cookie: b })).res.status, 200);
  assert.ok(!(await listOf(id, b)).some(x => x.id === m), 'gone for the one who deleted it');
  assert.ok((await listOf(id, a)).some(x => x.id === m && !x.deleted), 'still there for everyone else');
});

test('delete for everyone: two days for a sender, a week for a manager, then nobody', async () => {
  const { id, o, a } = await deletionCircle(['+966500000136', '+966500000137', '+966500000138']);
  const m = await send(id, a, 'قديمة');
  const { db } = await import('./db.ts');
  db.prepare("UPDATE messages SET created_at = datetime('now', '-49 hours') WHERE id = ?").run(m);
  const late = await call(`/api/messages/${m}`, { method: 'DELETE', cookie: a });
  assert.equal(late.res.status, 403, 'a sender is out of time after two days');
  assert.equal(late.json.error, 'delete_window_closed');
  db.prepare("UPDATE messages SET created_at = datetime('now', '-6 days') WHERE id = ?").run(m);
  const okInWeek = await call(`/api/messages/${m}`, { method: 'DELETE', cookie: o });
  assert.equal(okInWeek.res.status, 200, 'the owner still can at six days');
  const m2 = await send(id, a, 'أقدم من أسبوع');
  db.prepare("UPDATE messages SET created_at = datetime('now', '-8 days') WHERE id = ?").run(m2);
  const tooOld = await call(`/api/messages/${m2}`, { method: 'DELETE', cookie: o });
  assert.equal(tooOld.res.status, 403, 'not even the owner after a week');
  assert.equal(tooOld.json.error, 'delete_window_closed');
});

test('deleting a message also removes the archive entry made from it', async () => {
  const { id, o, a } = await deletionCircle(['+966500000139', '+966500000140', '+966500000141']);
  await call(`/api/circles/${id}`, { method: 'PATCH', body: { agentActive: true, sensitivity: 'strict' }, cookie: o });
  const m = await send(id, a, 'الحمدلله رزقنا بمولود جديد اسمه أحمد يوم الخميس، ألف مبروك لأخوي');
  assert.equal((await call(`/api/circles/${id}/archive`, { cookie: o })).json.length, 1);
  await call(`/api/messages/${m}`, { method: 'DELETE', cookie: a });
  assert.equal((await call(`/api/circles/${id}/archive`, { cookie: o })).json.length, 0, 'taking your words back takes them out of the archive');
});

test('open chats learn about deletions through the deletions feed', async () => {
  const { id, a, b, ids } = await deletionCircle(['+966500000142', '+966500000143', '+966500000144']);
  const m = await send(id, a, 'ستُحذف');
  const start = (await call(`/api/circles/${id}/deletions`, { cookie: b })).json;
  assert.deepEqual(start.items, []);
  assert.match(start.now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  await call(`/api/messages/${m}`, { method: 'DELETE', cookie: a });
  const feed = (await call(`/api/circles/${id}/deletions?since=${encodeURIComponent(start.now)}`, { cookie: b })).json;
  assert.deepEqual(feed.items, [{ id: m, by: ids.a }]);
  assert.equal((await call(`/api/circles/${id}/deletions`, { cookie: await login('+966500000149', 'غريب') })).res.status, 404);
});

test('a voice message is erased with its file, but a file shared by two messages stays until both are gone', async () => {
  const { id, a, b } = await deletionCircle(['+966500000145', '+966500000146', '+966500000147']);
  const { db } = await import('./db.ts');
  const bytes = Uint8Array.from({ length: 1500 }, (_, i) => (i * 7) % 253);
  const first = (await upload(id, a, bytes)).json.id as number;
  const second = (await upload(id, b, bytes)).json.id as number;
  const blobCount = () => (db.prepare('SELECT COUNT(*) n FROM blobs').get() as any).n as number;
  const before = blobCount();

  await call(`/api/messages/${first}`, { method: 'DELETE', cookie: a });
  assert.equal(blobCount(), before, 'the other message still needs the file');
  assert.equal((await app.request(`/api/messages/${second}/audio`, { headers: { cookie: b } })).status, 200);
  assert.equal((await app.request(`/api/messages/${first}/audio`, { headers: { cookie: a } })).status, 404);

  await call(`/api/messages/${second}`, { method: 'DELETE', cookie: b });
  assert.equal(blobCount(), before - 1, 'now nothing refers to it, so it is erased');
  assert.equal((await app.request(`/api/messages/${second}/audio`, { headers: { cookie: b } })).status, 404);
});

test('deleting a circle: only the owner, only by typing its name; it can be restored for 90 days, then everything goes', async () => {
  const { id, o, a } = await deletionCircle(['+966500000150', '+966500000151', '+966500000152']);
  const { db } = await import('./db.ts');
  const { purgeDeletedCircles } = await import('./index.ts');
  await upload(id, a, Uint8Array.from({ length: 900 }, (_, i) => (i * 11) % 251));
  await send(id, a, 'ستذهب مع الدائرة');

  assert.equal((await call(`/api/circles/${id}`, { method: 'DELETE', body: { confirm: 'حذف' }, cookie: a })).res.status, 403);
  assert.equal((await call(`/api/circles/${id}`, { method: 'DELETE', body: { confirm: 'اسم آخر' }, cookie: o })).res.status, 400);
  assert.equal((await call(`/api/circles/${id}`, { cookie: o })).res.status, 200, 'a wrong name deletes nothing');

  const del = await call(`/api/circles/${id}`, { method: 'DELETE', body: { confirm: 'حذف' }, cookie: o });
  assert.equal(del.res.status, 200);
  assert.equal(del.json.restorableDays, 90);
  assert.equal((await call(`/api/circles/${id}`, { cookie: o })).res.status, 404, 'gone for the owner');
  assert.equal((await call(`/api/circles/${id}`, { cookie: a })).res.status, 404, 'gone for members');
  assert.ok(!(await call('/api/circles', { cookie: o })).json.some((c: any) => c.id === id));
  assert.equal((await call(`/api/circles/${id}/messages`, { cookie: a })).res.status, 404, 'its messages are unreachable');

  // restorable: only by the owner, with the days left shown; nothing was lost
  const waiting = (await call('/api/me/deleted-circles', { cookie: o })).json;
  assert.deepEqual([waiting.length, waiting[0].id, waiting[0].daysLeft], [1, id, 90]);
  assert.equal((await call(`/api/circles/${id}/restore`, { method: 'POST', body: {}, cookie: a })).res.status, 404, 'a member cannot restore');
  assert.equal((await call(`/api/circles/${id}/restore`, { method: 'POST', body: {}, cookie: o })).res.status, 200);
  assert.equal((await call(`/api/circles/${id}`, { cookie: a })).res.status, 200, 'members are back in');
  assert.ok((await listOf(id, a)).some(m => m.body === 'ستذهب مع الدائرة'), 'every message is intact');

  // deleted again and left alone for over 90 days: now it is really erased, files included
  await call(`/api/circles/${id}`, { method: 'DELETE', body: { confirm: 'حذف' }, cookie: o });
  assert.equal(await purgeDeletedCircles(), 0, 'not yet: only 90 days old circles are erased');
  db.prepare("UPDATE circles SET deleted_at = datetime('now', '-91 days') WHERE id = ?").run(id);
  assert.equal((await call(`/api/circles/${id}/restore`, { method: 'POST', body: {}, cookie: o })).res.status, 404, 'too late to restore');
  assert.equal(await purgeDeletedCircles(), 1);
  const left = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE circle_id = ?`).get(id) as any).n;
  for (const t of ['messages', 'media', 'archive_entries', 'persons', 'circle_members']) assert.equal(left(t), 0, t);
});
