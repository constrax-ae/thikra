// M-01 / M-02: the three kinds of conversation. circle = family space with the agent; group = ordinary group; direct = one to one.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');

let n = 0;
const phones = new Map<string, string>();
async function login(name: string) {
  const phone = `+9665${String(9_000_000 + n++).padStart(8, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  phones.set(name, phone);
  return { cookie: res.headers.get('set-cookie')!.split(';')[0], phone };
}
const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};

test('direct chat: found by phone, one per pair, each side sees the OTHER person\'s name, nothing to configure, no invite', async () => {
  const a = await login('سارة'), b = await login('خالد'), c = await login('ثالث');
  assert.equal((await call(a.cookie, '/api/direct', 'POST', { phone: '+966599999999' })).status, 404, 'unknown number');
  assert.equal((await call(a.cookie, '/api/direct', 'POST', { phone: a.phone })).status, 400, 'not yourself');
  assert.equal((await call(a.cookie, '/api/direct', 'POST', { phone: 'abc' })).status, 400);
  const made = await call(a.cookie, '/api/direct', 'POST', { phone: b.phone });
  assert.equal(made.status, 201);
  const again = await call(b.cookie, '/api/direct', 'POST', { phone: a.phone }); // from the other side
  assert.equal(again.status, 200);
  assert.equal(again.json.id, made.json.id, 'one chat per pair, whoever starts it');

  const listA = (await call(a.cookie, '/api/circles')).json.find((x: any) => x.id === made.json.id);
  const listB = (await call(b.cookie, '/api/circles')).json.find((x: any) => x.id === made.json.id);
  assert.equal(listA.kind, 'direct');
  assert.equal(listA.name, 'خالد');
  assert.equal(listB.name, 'سارة');
  assert.equal((await call(a.cookie, `/api/circles/${made.json.id}`)).json.name, 'خالد');

  // chat works, the agent never does, nobody else can get in
  await call(a.cookie, `/api/circles/${made.json.id}/messages`, 'POST', { body: 'توفي جدي رحمه الله اليوم' });
  const msgs = (await call(b.cookie, `/api/circles/${made.json.id}/messages?after_seq=0`)).json;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].archiveStatus, 'none');
  assert.equal((await call(a.cookie, `/api/circles/${made.json.id}`, 'PATCH', { agentActive: true, name: 'x' })).status, 403);
  assert.equal((await call(c.cookie, `/api/circles/${made.json.id}/messages?after_seq=0`)).status, 404, 'a third person cannot read it');
  const code = (await call(a.cookie, `/api/circles/${made.json.id}`)).json.inviteCode;
  assert.equal((await call(c.cookie, '/api/circles/join', 'POST', { code: code ?? 'x' })).status, 404, 'a direct chat cannot be joined by invite');
  assert.equal((await call(a.cookie, `/api/circles/${made.json.id}/import`, 'POST', {})).status, 409);
});

test('plain group: ordinary chat with invite, no agent ever; owner can convert it to a circle and keep every message', async () => {
  const a = await login('أ'), b = await login('ب');
  const g = (await call(a.cookie, '/api/circles', 'POST', { name: 'شلة', kind: 'group' })).json.id;
  const detail = (await call(a.cookie, `/api/circles/${g}`)).json;
  assert.equal(detail.kind, 'group');
  await call(b.cookie, '/api/circles/join', 'POST', { code: detail.inviteCode });
  await call(a.cookie, `/api/circles/${g}`, 'PATCH', { agentActive: true });
  assert.equal((await call(a.cookie, `/api/circles/${g}`)).json.agentActive, 0, 'the agent cannot be switched on in a plain group');
  await call(b.cookie, `/api/circles/${g}/messages`, 'POST', { body: 'مرحبا' });
  assert.equal((await call(b.cookie, `/api/circles/${g}/convert`, 'POST', {})).status, 403, 'only the owner converts');
  const before = (await call(a.cookie, `/api/circles/${g}/messages?after_seq=0`)).json.map((m: any) => [m.seq, m.body]);
  assert.equal((await call(a.cookie, `/api/circles/${g}/convert`, 'POST', {})).status, 200);
  assert.equal((await call(a.cookie, `/api/circles/${g}`)).json.kind, 'circle');
  const after = (await call(a.cookie, `/api/circles/${g}/messages?after_seq=0`)).json;
  assert.deepEqual(after.slice(0, before.length).map((m: any) => [m.seq, m.body]), before, 'no message lost or changed by the conversion');
  assert.equal((await call(a.cookie, `/api/circles/${g}/convert`, 'POST', {})).status, 409, 'already a circle');
  // now the agent can be switched on
  await call(a.cookie, `/api/circles/${g}`, 'PATCH', { agentActive: true });
  assert.equal((await call(a.cookie, `/api/circles/${g}`)).json.agentActive, 1);
});

test('a circle stays the default kind, so everything that existed before is unchanged', async () => {
  const a = await login('قديم');
  const id = (await call(a.cookie, '/api/circles', 'POST', { name: 'عائلة' })).json.id;
  assert.equal((await call(a.cookie, `/api/circles/${id}`)).json.kind, 'circle');
  assert.equal((await call(a.cookie, '/api/circles')).json.find((x: any) => x.id === id).name, 'عائلة');
});

test('direct chat from a member list: only with someone who shares a circle with you (no phone number needed)', async () => {
  const a = await login('م1'), b = await login('م2'), stranger = await login('غريب');
  const circle = (await call(a.cookie, '/api/circles', 'POST', { name: 'عائلة' })).json;
  const code = (await call(a.cookie, `/api/circles/${circle.id}`)).json.inviteCode;
  await call(b.cookie, '/api/circles/join', 'POST', { code });
  const bId = (await call(a.cookie, `/api/circles/${circle.id}`)).json.members.find((m: any) => m.name === 'م2').id;
  const strangerId = (await call(stranger.cookie, '/api/circles', 'POST', { name: 'x' })).json && (await call(stranger.cookie, '/api/me')).json.id;
  const ok = await call(a.cookie, '/api/direct', 'POST', { userId: bId });
  assert.equal(ok.status, 201);
  assert.equal((await call(b.cookie, '/api/direct', 'POST', { phone: a.phone })).json.id, ok.json.id, 'same chat as by phone');
  assert.equal((await call(a.cookie, '/api/direct', 'POST', { userId: strangerId })).status, 404, 'no shared circle: not found');
  assert.equal((await call(a.cookie, '/api/direct', 'POST', { userId: 'abc' })).status, 404);
});

test('circle detail carries my own mute and favourite state (for the info screen), and a timed mute shows its end', async () => {
  const a = await login('كتم1');
  const id = (await call(a.cookie, '/api/circles', 'POST', { name: 'للكتم' })).json.id;
  const d0 = (await call(a.cookie, `/api/circles/${id}`)).json;
  assert.equal(d0.muted, false); assert.equal(d0.favourite, false); assert.ok(d0.createdAt);
  await call(a.cookie, `/api/circles/${id}/prefs`, 'PATCH', { muted: true, muteHours: 8 });
  const d1 = (await call(a.cookie, `/api/circles/${id}`)).json;
  assert.equal(d1.muted, true); assert.ok(d1.mutedUntil);
  await call(a.cookie, `/api/circles/${id}/prefs`, 'PATCH', { muted: true });
  assert.equal((await call(a.cookie, `/api/circles/${id}`)).json.mutedUntil, null, 'always');
  await call(a.cookie, `/api/circles/${id}/prefs`, 'PATCH', { muted: false, favourite: true });
  const d2 = (await call(a.cookie, `/api/circles/${id}`)).json;
  assert.equal(d2.muted, false); assert.equal(d2.favourite, true);
});

test('today in the family: birthdays of living people and archive events of this day in earlier years, nothing otherwise', async () => {
  const a = await login('اليوم');
  const id = (await call(a.cookie, '/api/circles', 'POST', { name: 'عائلة اليوم' })).json.id;
  assert.deepEqual((await call(a.cookie, `/api/circles/${id}/today`)).json.items, [], 'nothing to show, nothing shown');
  const now = new Date(), y = now.getUTCFullYear(), md = now.toISOString().slice(5, 10);
  await call(a.cookie, `/api/circles/${id}/persons`, 'POST', { name: 'جدّتي', birthDate: `${y - 70}-${md}` });
  await call(a.cookie, `/api/circles/${id}/persons`, 'POST', { name: 'جدّي الراحل', birthDate: `${y - 80}-${md}`, deathDate: `${y - 5}-01-01` });
  await call(a.cookie, `/api/circles/${id}/persons`, 'POST', { name: 'قريب', birthDate: `${y - 30}-01-01` });
  await call(a.cookie, `/api/circles/${id}/import`, 'POST', { entries: [{ date: `${y - 3}-${md}`, title: 'زواج العم', summary: 'حفل الزواج', category: 'marriage' }, { date: `${y}-${md}`, title: 'اليوم نفسه', summary: 'x', category: null }] });
  const items = (await call(a.cookie, `/api/circles/${id}/today`)).json.items;
  assert.deepEqual(items.map((i: any) => i.type + ':' + (i.name ?? i.title)), ['birthday:جدّتي', 'memory:زواج العم']);
  assert.equal(items[0].age, 70); assert.equal(items[1].years, 3);
  const other = await login('غريب2');
  assert.equal((await call(other.cookie, `/api/circles/${id}/today`)).status, 404, 'members only');
});

test('people: everyone you share a circle with (not yourself, not someone you blocked), with your existing chat if there is one', async () => {
  const a = await login('أنا'), b = await login('هي'), c2 = await login('هو');
  const id = (await call(a.cookie, '/api/circles', 'POST', { name: 'عائلتنا' })).json.id;
  const code = (await call(a.cookie, `/api/circles/${id}`)).json.inviteCode;
  await call(b.cookie, '/api/circles/join', 'POST', { code }); await call(c2.cookie, '/api/circles/join', 'POST', { code });
  const first = (await call(a.cookie, '/api/people')).json;
  assert.deepEqual(first.map((p: any) => p.name).sort(), ['هو', 'هي']);
  assert.ok(first.every((p: any) => p.chatId === null && p.via === 'عائلتنا'));
  const bId = first.find((p: any) => p.name === 'هي').id;
  const chat = (await call(a.cookie, '/api/direct', 'POST', { userId: bId })).json.id;
  assert.equal((await call(a.cookie, '/api/people')).json.find((p: any) => p.id === bId).chatId, chat, 'the existing chat is offered');
  await call(a.cookie, `/api/users/${bId}/block`, 'POST', { on: true });
  assert.deepEqual((await call(a.cookie, '/api/people')).json.map((p: any) => p.name), ['هو'], 'a blocked person is not offered');
  assert.equal((await call(await login('غريب').then(x => x.cookie), '/api/people')).json.length, 0, 'a stranger sees no one');
});
