// Sealed messages v2, the owner's requirements (2026-10-19): text, voice or video; opened automatically to the whole family; nobody can
// delete them; kept in the family archive; several per person for different dates and events. Plus the safeguards for event and death triggers.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-s2-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app, releaseDueSealed } = await import('./index.ts');
await (await import('./lib/ops.ts')).setFlag('sealed_after_death', true);   // these tests cover the after-death letters, which are off by default
const { run, one, all } = await import('./db.ts');
const { createBackup } = await import('./backup.ts');

let n = 0;
async function login(name: string) {
  const phone = `+9665${String(2_500_000 + n++).padStart(8, '0')}`;
  const post = (p: string, b: unknown) => app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, id: (await (await app.request('/api/me', { headers: { cookie } })).json() as any).id as number };
}
const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
async function family(extra = 0, agent = true) {
  const dad = await login('ناصر الدوسري'), mom = await login('سلمى'), son = await login('خالد'), aunt = await login('هند');
  const circle = (await call(dad.cookie, '/api/circles', 'POST', { name: 'العائلة' })).json.id as number;
  const code = (await call(dad.cookie, `/api/circles/${circle}`)).json.inviteCode;
  const more: Array<{ cookie: string; id: number }> = [];
  for (let i = 0; i < extra; i++) more.push(await login(`قريب${i}`));
  for (const u of [mom, son, aunt, ...more]) await call(u.cookie, '/api/circles/join', 'POST', { code });
  if (agent) await call(dad.cookie, `/api/circles/${circle}`, 'PATCH', { agentActive: true });
  return { dad, mom, son, aunt, more, circle };
}
const future = (ms = 1e7) => new Date(Date.now() + ms).toISOString();
const makeDue = (id: number) => run("UPDATE sealed_messages SET unlock_at = datetime('now', '-1 minute') WHERE id = ?", id);
const messages = async (u: { cookie: string }, circle: number) => (await call(u.cookie, `/api/circles/${circle}/messages?after_seq=0`)).json as any[];
async function sealFile(u: { cookie: string }, circle: number, file: { data: Uint8Array; type: string; name: string }, fields: Record<string, string>) {
  const fd = new FormData();
  fd.append('file', new Blob([file.data as unknown as BlobPart], { type: file.type }), file.name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await app.request(`/api/circles/${circle}/sealed`, { method: 'POST', headers: { cookie: u.cookie }, body: fd });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}
const VOICE = new Uint8Array(Array.from({ length: 400 }, (_, i) => (i * 7) % 251));
const MP4 = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from('ftypmp42'), ...new Array(300).fill(5)]);

test('a voice letter and a video letter open to the whole family, playable by everyone, kept in the archive', async () => {
  const { dad, mom, son, circle } = await family();
  const v = await sealFile(dad, circle, { data: VOICE, type: 'audio/webm', name: 'voice' }, { trigger: 'date', unlockAt: future(), occasion: 'عيد ميلادك', duration: '9000', body: 'اسمعها يا بنيّ' });
  const vid = await sealFile(dad, circle, { data: MP4, type: 'video/mp4', name: 'wish.mp4' }, { trigger: 'date', unlockAt: future(2e7), body: 'رسالة مصوّرة' });
  assert.equal(v.status, 201); assert.equal(vid.status, 201);
  // nothing visible before the time
  assert.ok(!(await messages(son, circle)).some(m => m.sealedOn));
  makeDue(v.json.id); makeDue(vid.json.id);
  assert.equal(await releaseDueSealed(), 2);

  const all_ = await messages(mom, circle);
  const voice = all_.find(m => m.kind === 'voice' && m.sealedOn);
  const video = all_.find(m => m.attachments?.some((a: any) => a.kind === 'video'));
  assert.ok(voice && video, 'both opened for everyone in the circle');
  assert.equal(voice.audioMs, 9000);
  assert.equal(voice.transcript, 'اسمعها يا بنيّ', 'the written note shows under the recording');
  const audio = await app.request(`/api/messages/${voice.id}/audio`, { headers: { cookie: son.cookie } });
  assert.equal(audio.status, 200);
  assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [...VOICE], 'the family hears the original recording');
  const media = await app.request(`/api/media/${video.attachments[0].id}`, { headers: { cookie: son.cookie } });
  assert.equal(media.headers.get('content-type'), 'video/mp4');
  assert.equal(video.body, 'رسالة مصوّرة');

  // saved in the family archive, with the occasion in the title, visible to every member
  const archive = (await call(son.cookie, `/api/circles/${circle}/archive`)).json as any[];
  const entry = archive.find(e => e.title.includes('عيد ميلادك'));
  assert.ok(entry, 'an archive entry was made');
  assert.match(entry.title, /ناصر الدوسري/);
  assert.equal(archive.filter(e => e.title.includes('رسالة مختومة')).length, 2);
});

test('an opened sealed message: only its AUTHOR can delete it (if it opened by mistake); nobody else, nobody can edit it', async () => {
  const { dad, mom, son, circle } = await family();
  await call(dad.cookie, `/api/circles/${circle}/members/${mom.id}`, 'PATCH', { role: 'admin' });
  const make = async (text: string, occasion: string) => {
    const r = await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: text, unlockAt: future(), occasion });
    makeDue(r.json.id); await releaseDueSealed();
    return (await messages(son, circle)).find(m => m.sealedOn && m.body === text)!;
  };
  const kept = await make('خالدة في ذاكرتنا', 'وصيتي العاطفية');
  // not the admin, not another member
  for (const who of [mom, son]) {
    const r = await call(who.cookie, `/api/messages/${kept.id}`, 'DELETE');
    assert.deepEqual([r.status, r.json.error], [403, 'sealed_protected'], 'delete for everyone is refused for everybody but the author');
  }
  assert.equal((await call(dad.cookie, `/api/messages/${kept.id}`, 'PATCH', { body: 'تعديل' })).json.error, 'sealed_protected', 'nobody can edit it, not even the author');
  const entry = ((await call(dad.cookie, `/api/circles/${circle}/archive`)).json as any[]).find(e => e.title.includes('وصيتي العاطفية'))!;
  assert.equal(entry.protected, true);
  assert.equal((await call(mom.cookie, `/api/archive/${entry.id}`, 'DELETE')).json.error, 'sealed_protected', 'an admin cannot remove its archive entry');
  assert.ok((await messages(son, circle)).some(m => m.id === kept.id && !m.deleted));
  // hiding for yourself only removes it from YOUR screen
  await call(son.cookie, `/api/messages/${kept.id}/hide`, 'POST', {});
  assert.ok(!(await messages(son, circle)).some(m => m.id === kept.id));
  assert.ok((await messages(mom, circle)).some(m => m.id === kept.id));

  // opened by mistake: the author takes it back, at any time (even long after the 2-day window), and its archive entry goes with it
  const mistake = await make('فُتحت بالخطأ', 'خطأ');
  run("UPDATE messages SET created_at = datetime('now', '-400 days') WHERE id = ?", mistake.id);
  assert.equal((await call(dad.cookie, `/api/messages/${mistake.id}`, 'DELETE')).status, 200, 'the author may erase it, with no time limit');
  assert.ok(!(await messages(mom, circle)).some(m => m.id === mistake.id && !m.deleted), 'gone for everyone');
  assert.ok(!((await call(dad.cookie, `/api/circles/${circle}/archive`)).json as any[]).some(e => e.title.includes('خطأ')), 'and from the archive');
});

test('several letters for different dates and events from one person, each opens on its own', async () => {
  const { dad, son, circle } = await family();
  const a = await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'للتخرج', unlockAt: future(1e7), occasion: 'تخرجك' });
  const b = await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'للعيد', unlockAt: future(2e7), occasion: 'العيد', yearly: true });
  const c = await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'لزواجك', trigger: 'event', occasion: 'زواج الابن' });
  const mine = (await call(dad.cookie, `/api/circles/${circle}/sealed`)).json as any[];
  assert.deepEqual(mine.map(m => m.occasion), ['تخرجك', 'العيد', 'زواج الابن'], 'dated ones by date, then the event one');
  makeDue(a.json.id);
  assert.equal(await releaseDueSealed(), 1, 'only the due one opens');
  assert.deepEqual((await messages(son, circle)).filter(m => m.sealedOn).map(m => m.body), ['للتخرج']);
  void b; void c;
});

const say = (u: { cookie: string }, circle: number, body: string) => call(u.cookie, `/api/circles/${circle}/messages`, 'POST', { body });
const envelopes = async (u: { cookie: string }, circle: number) => (await call(u.cookie, `/api/circles/${circle}/sealed-envelopes`)).json;

test('creating an event or after-death letter needs the agent on in a family circle', async () => {
  const { dad, circle } = await family(0, false);
  assert.equal((await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'x', trigger: 'event', occasion: 'م' })).json.error, 'agent_required');
  assert.equal((await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'x', trigger: 'death' })).json.error, 'agent_required');
  assert.equal((await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'x', trigger: 'event' })).json.error, 'occasion_required');
  assert.equal((await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'x', unlockAt: future() })).status, 201, 'a dated letter never needs the agent');
});

test('event: the agent concludes it from MORE THAN THREE messages by at least THREE members (many members), waits, then opens; the family sees the evidence but not the content', async () => {
  const { dad, mom, son, aunt, more, circle } = await family(2);   // 5 others besides the author: three members are required
  const s = await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'مبروك زواجك يا بنيّ', trigger: 'event', occasion: 'زواج خالد' });
  const env0 = await envelopes(son, circle);
  assert.deepEqual([env0.events[0].evidence.needMessages, env0.events[0].evidence.needMembers, env0.total], [4, 3, 1]);
  assert.ok(!JSON.stringify(env0).includes('زواج خالد'), 'no title: the family only sees that a letter exists');
  assert.ok(!JSON.stringify(env0).includes('مبروك زواجك'), 'the content is never in the envelope list');
  // noise that must NOT count: the author's own words, a wish for the future, an unrelated congratulation
  await say(dad, circle, 'مبروك زواج خالد');
  await say(mom, circle, 'عقبال زواج خالد إن شاء الله');
  await say(son, circle, 'مبروك التخرج لهند');
  assert.equal((await envelopes(son, circle)).events[0].evidence.messages, 0);
  // three messages from two members: not enough
  await say(mom, circle, 'ألف مبروك زواج خالد'); await say(son, circle, 'تم زواج خالد اليوم'); await say(mom, circle, 'مبروك لخالد بمناسبة زواجه');
  let ev = (await envelopes(son, circle)).events[0];
  assert.deepEqual([ev.evidence.messages, ev.evidence.members, ev.waiting], [3, 2, false]);
  await say(son, circle, 'مبروك زواج خالد يا رب يتمم عليكم بالخير');   // 4th message, still only 2 members
  ev = (await envelopes(son, circle)).events[0];
  assert.deepEqual([ev.evidence.messages, ev.evidence.members, ev.waiting], [4, 2, false], 'four messages from two members is not enough when three are required');
  await say(aunt, circle, 'ألف مبروك لخالد زواجه تم بحمد الله');       // the third member
  ev = (await envelopes(son, circle)).events[0];
  assert.equal(ev.waiting, true, 'now the agent is convinced: the countdown starts');
  assert.ok((await messages(son, circle)).some(m => m.body?.includes('"k":"eventAgent"') && m.body.includes('زواج خالد')), 'the family is told in the circle');
  assert.equal(await releaseDueSealed(), 0, 'nothing opens during the three days');
  assert.ok(Math.abs(Date.parse(ev.releaseAt.replace(' ', 'T') + 'Z') - (Date.now() + 72 * 3600_000)) < 5 * 60_000, 'three days');
  // the agent was wrong: the author stops it, evidence is wiped and must build up again
  assert.equal((await call(son.cookie, `/api/sealed/${s.json.id}/stop`, 'POST', {})).status, 403, 'a plain member cannot stop it');
  assert.equal((await call(dad.cookie, `/api/sealed/${s.json.id}/stop`, 'POST', {})).status, 200);
  assert.equal((await envelopes(son, circle)).events[0].evidence.messages, 0);
  for (const [u, t] of [[mom, 'مبروك زواج خالد'], [son, 'تم زواج خالد'], [aunt, 'ألف مبروك زواج خالد'], [more[0], 'مبروك على زواج خالد']] as const) await say(u, circle, t);
  assert.equal((await envelopes(son, circle)).events[0].waiting, true);
  run("UPDATE sealed_messages SET release_at = datetime('now', '-1 minute') WHERE status = 'waiting' AND circle_id = ?", circle);
  assert.equal(await releaseDueSealed(), 1);
  assert.ok((await messages(son, circle)).some(m => m.sealedOn && m.body === 'مبروك زواجك يا بنيّ'), 'opened for everyone after the wait');
});

test('with exactly three other members two are enough; old evidence and the agent being off do not count', async () => {
  const { dad, mom, son, aunt, circle } = await family();   // three others
  await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'للتخرج', trigger: 'event', occasion: 'تخرج سارة' });
  const e = (await envelopes(son, circle)).events[0].evidence;
  assert.deepEqual([e.needMessages, e.needMembers], [4, 2]);
  // evidence older than 30 days is ignored
  const old = (await say(mom, circle, 'مبروك تخرج سارة')).json.id;
  run("UPDATE messages SET created_at = datetime('now', '-45 days') WHERE id = ?", old);
  assert.equal((await envelopes(son, circle)).events[0].evidence.messages, 0);
  for (const [u, t] of [[mom, 'مبروك تخرج سارة'], [son, 'تم تخرج سارة اليوم'], [mom, 'ألف مبروك تخرج سارة'], [son, 'مبروك لسارة بمناسبة تخرجها']] as const) await say(u, circle, t);
  assert.equal((await envelopes(son, circle)).events[0].waiting, true, 'four messages from two of the three others');
  // the agent off: nothing is collected
  const other = await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'ثانية', trigger: 'event', occasion: 'عيد ميلاد هند' });
  await call(dad.cookie, `/api/circles/${circle}`, 'PATCH', { agentActive: false });
  for (const [u, t] of [[mom, 'مبروك عيد ميلاد هند'], [son, 'مبروك عيد ميلاد هند'], [aunt, 'مبروك عيد ميلاد هند'], [mom, 'تم عيد ميلاد هند']] as const) await say(u, circle, t);
  assert.equal(one("SELECT COUNT(*) AS n FROM sealed_evidence WHERE scope = 'event' AND ref_id = ?", other.json.id)!.n, 0, 'with the agent off, nobody reads the circle');
});

test('after death: the agent concludes it from the family\'s messages (not from relatives\', rumours or the person themself), waits three days, opens everything, and does so whenever it finally concludes', async () => {
  const { dad, mom, son, aunt, circle } = await family();          // three others: two members are enough
  await call(dad.cookie, `/api/circles/${circle}/members/${mom.id}`, 'PATCH', { role: 'admin' });
  await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'إن قرأتم هذا فقد رحلت', trigger: 'death' });
  await call(dad.cookie, `/api/circles/${circle}/sealed`, 'POST', { body: 'سامحوني', trigger: 'death' });
  const env = await envelopes(son, circle);
  assert.deepEqual([env.deaths[0].author, env.deaths[0].count, env.deaths[0].evidence.needMembers], ['ناصر الدوسري', 2, 2]);
  assert.ok(!JSON.stringify(env).includes('سامحوني'));
  // these must not count: about his father, a rumour, a wish, his own message, and unrelated sad news
  await say(mom, circle, 'توفي والد ناصر الدوسري أمس');
  await say(son, circle, 'سمعت أن ناصر الدوسري توفي لكنها إشاعة');
  await say(aunt, circle, 'الله يطيل عمر ناصر الدوسري حفظه الله');
  await say(dad, circle, 'توفي ناصر الدوسري');
  await say(son, circle, 'توفي جارنا أبو سعد رحمه الله');
  assert.equal((await envelopes(son, circle)).deaths[0].evidence.messages, 0);
  // a long time passes (the letters were sealed two years ago); the family eventually writes the news: four messages, two members
  run("UPDATE sealed_messages SET sealed_on = datetime('now', '-730 days')");
  for (const [u, t] of [[mom, 'إنا لله وإنا إليه راجعون، توفي ناصر الدوسري'], [son, 'البقاء لله، ناصر الدوسري رحمه الله'], [mom, 'عظم الله أجركم في ناصر الدوسري'], [son, 'انتقل ناصر الدوسري إلى رحمة الله']] as const) await say(u, circle, t);
  const d = (await envelopes(son, circle)).deaths[0];
  assert.equal(d.waiting, true);
  assert.ok((await messages(son, circle)).some(m => m.body?.includes('"k":"deathAgent"')));
  assert.equal(await releaseDueSealed(), 0, 'nothing opens during the three days');
  // a manager is not convinced: stops it; the person (alive) could too
  assert.equal((await call(son.cookie, `/api/circles/${circle}/sealed/death/${dad.id}/stop`, 'POST', {})).status, 403);
  assert.equal((await call(mom.cookie, `/api/circles/${circle}/sealed/death/${dad.id}/stop`, 'POST', {})).status, 200);
  assert.equal((await envelopes(son, circle)).deaths[0].evidence.messages, 0, 'the evidence must build up again');
  // confirmed again later: waits, and when the three days pass everything opens and the record shows the death
  for (const [u, t] of [[mom, 'توفي ناصر الدوسري رحمه الله'], [aunt, 'البقاء لله على ناصر الدوسري'], [mom, 'الله يرحم ناصر الدوسري'], [aunt, 'عظم الله أجركم في ناصر الدوسري']] as const) await say(u, circle, t);
  assert.equal((await envelopes(son, circle)).deaths[0].waiting, true);
  run("UPDATE sealed_messages SET release_at = datetime('now', '-1 minute') WHERE status = 'waiting' AND circle_id = ?", circle);
  assert.equal(await releaseDueSealed(), 2, 'both letters open together');
  const opened = (await messages(son, circle)).filter(m => m.sealedOn).map(m => m.body).sort();
  assert.deepEqual(opened, ['إن قرأتم هذا فقد رحلت', 'سامحوني'].sort());
  assert.ok(one('SELECT death_date FROM persons WHERE circle_id = ? AND user_id = ?', circle, dad.id)!.death_date, 'the family record now shows the death');
  assert.equal(await releaseDueSealed(), 0, 'and they do not open twice');
});

test('cancelling erases the content; a waiting letter\'s file survives other messages being deleted; the backup includes it', async () => {
  const { dad, son, circle } = await family();
  const blobCount = () => { let c = 0; const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p) : c++; } }; try { walk(join(work, 'blobs')); } catch { /* none yet */ } return c; };
  const UNIQUE = new Uint8Array(Array.from({ length: 333 }, (_, i) => (i * 13 + 7) % 251)); // bytes no other test uses (blobs are shared by content)
  const s = await sealFile(dad, circle, { data: UNIQUE, type: 'audio/webm', name: 'voice' }, { trigger: 'event', occasion: 'مناسبة', duration: '5000' });
  const hash = one('SELECT blob_hash FROM sealed_messages WHERE id = ?', s.json.id)!.blob_hash as string;
  // the same bytes sent as an ordinary voice message, then deleted for everyone: the sealed letter must keep its file
  const fd = new FormData(); fd.append('audio', new Blob([UNIQUE as unknown as BlobPart], { type: 'audio/webm' }), 'v');
  const ordinary = (await (await app.request(`/api/circles/${circle}/voice`, { method: 'POST', headers: { cookie: dad.cookie }, body: fd })).json() as any).id;
  await call(dad.cookie, `/api/messages/${ordinary}`, 'DELETE');
  assert.ok(blobCount() >= 1);
  assert.ok(one('SELECT 1 FROM blobs WHERE hash = ?', hash), 'the waiting letter still has its file');
  const m = await createBackup();
  assert.ok(m.blobs.some(b => b.hash === hash), 'a backup includes files of letters that have not opened yet');
  // cancel: content gone
  assert.equal((await call(son.cookie, `/api/sealed/${s.json.id}`, 'DELETE')).status, 404, 'only the author');
  assert.equal((await call(dad.cookie, `/api/sealed/${s.json.id}`, 'DELETE')).status, 200);
  const row = one('SELECT status, body, blob_hash FROM sealed_messages WHERE id = ?', s.json.id)!;
  assert.deepEqual([row.status, row.body, row.blob_hash], ['cancelled', '', null]);
  assert.equal(one('SELECT 1 FROM blobs WHERE hash = ?', hash), undefined, 'and the file is erased from storage');
  void all;
});

test('only voice, video or photo files are accepted as letters (bytes decide), and size is limited', async () => {
  const { dad, circle } = await family();
  const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  assert.equal((await sealFile(dad, circle, { data: html, type: 'text/html', name: 'x.html' }, { trigger: 'date', unlockAt: future() })).status, 400);
  assert.equal((await sealFile(dad, circle, { data: new Uint8Array([1, 2, 3]), type: 'application/pdf', name: 'x.pdf' }, { trigger: 'date', unlockAt: future() })).status, 400, 'a document is not a letter');
  assert.equal((await sealFile(dad, circle, { data: MP4, type: 'video/mp4', name: 'v.mp4' }, { trigger: 'date', unlockAt: new Date(Date.now() + 1000).toISOString() })).json.error, 'invalid_date');
});
