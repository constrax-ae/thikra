// Your data in an open format: a zip of JSON and the original files, with nothing you could not see in the app.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
const { app } = await import('./index.ts');

let n = 0;
async function login(name: string) {
  const phone = `+9665${String(6_500_000 + n++).padStart(8, '0')}`;
  const post = (p: string, b: unknown) => app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  return (await post('/api/auth/verify', { phone, code: devCode, name })).headers.get('set-cookie')!.split(';')[0];
}
const j = async (cookie: string, path: string, method = 'GET', body?: unknown) =>
  (await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;

test('the export has what you could see and nothing else, with the real files, and needs no Thekra to read', async () => {
  const a = await login('سارة'), b = await login('خالد');
  const circle = (await j(a, '/api/circles', 'POST', { name: 'العائلة' })).id as number;
  await j(b, '/api/circles/join', 'POST', { code: (await j(a, `/api/circles/${circle}`)).inviteCode });
  const kept = (await j(a, `/api/circles/${circle}/messages`, 'POST', { body: 'رسالة باقية' })).id;
  const hiddenForB = (await j(a, `/api/circles/${circle}/messages`, 'POST', { body: 'سأخفيها عني' })).id;
  const erased = (await j(a, `/api/circles/${circle}/messages`, 'POST', { body: 'محذوفة للجميع' })).id;
  await j(b, `/api/messages/${hiddenForB}/hide`, 'POST', {});
  await j(a, `/api/messages/${erased}`, 'DELETE');
  await j(b, `/api/messages/${kept}/react`, 'POST', { emoji: '❤️' });
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(120).fill(9)]);
  const fd = new FormData(); fd.append('file', new Blob([photo]), 'رحلة.jpg'); fd.append('thumb', new Blob([]), 'n'); fd.append('caption', 'من الرحلة');
  await app.request(`/api/circles/${circle}/attachments`, { method: 'POST', headers: { cookie: a }, body: fd });
  const sealedAt = new Date(Date.now() + 86400_000).toISOString();
  await j(b, `/api/circles/${circle}/sealed`, 'POST', { body: 'رسالة مختومة منّي', unlockAt: sealedAt });

  const res = await app.request('/api/me/export', { headers: { cookie: b } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition') ?? '', /thikra-export-\d{4}-\d{2}-\d{2}\.zip/);
  const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const names = Object.keys(zip);
  assert.ok(names.includes('README.txt') && names.includes('profile.json'));
  const profile = JSON.parse(strFromU8(zip['profile.json']));
  assert.equal(profile.name, 'خالد');
  const msgFile = names.find(x => x.endsWith('messages.json'))!;
  const msgs = JSON.parse(strFromU8(zip[msgFile]));
  const bodies = msgs.map((m: any) => m.body);
  assert.ok(bodies.includes('رسالة باقية'));
  assert.ok(!bodies.includes('سأخفيها عني'), 'what B deleted for themselves is not in B\'s export');
  assert.ok(!bodies.includes('محذوفة للجميع'), 'and neither is what was deleted for everyone');
  assert.deepEqual(msgs.find((m: any) => m.body === 'رسالة باقية').reactions, ['خالد: ❤️']);
  const withFile = msgs.find((m: any) => m.files.length);
  assert.equal(withFile.body, 'من الرحلة');
  assert.deepEqual([...zip[withFile.files[0].path]], [...photo], 'the original file, byte for byte');
  assert.ok(names.some(x => x.endsWith('archive.json')) && names.some(x => x.endsWith('people.json')), 'a family circle also exports its archive and people');
  const sealed = JSON.parse(strFromU8(zip['sealed-messages-i-wrote.json']));
  assert.equal(sealed[0].body, 'رسالة مختومة منّي', 'your own unopened letters are yours to take');
  // not someone else's: A's export has no sealed file and includes A's hidden-for-B message (A did not hide it)
  const za = unzipSync(new Uint8Array(await (await app.request('/api/me/export', { headers: { cookie: a } })).arrayBuffer()));
  assert.ok(!('sealed-messages-i-wrote.json' in za));
  assert.ok(JSON.parse(strFromU8(za[Object.keys(za).find(x => x.endsWith('messages.json'))!])).some((m: any) => m.body === 'سأخفيها عني'));
  // rate limit and login
  assert.equal((await app.request('/api/me/export')).status, 401);
  for (let i = 0; i < 2; i++) await app.request('/api/me/export', { headers: { cookie: b } });
  assert.equal((await app.request('/api/me/export', { headers: { cookie: b } })).status, 429, 'at most 3 an hour');
});

test('the export also carries the family albums (with files), the story, and what you wrote to support', async () => {
  const { run } = await import('./db.ts');
  const a = await login('كاتبة'), b = await login('قارئ');
  const circle = (await j(a, '/api/circles', 'POST', { name: 'عائلة الألبوم' })).id as number;
  await j(b, '/api/circles/join', 'POST', { code: (await j(a, `/api/circles/${circle}`)).inviteCode });
  const album = (await j(a, `/api/circles/${circle}/albums`, 'POST', { title: 'ألبوم واتساب', source: 'whatsapp', from: '2024-01-01', to: '2024-12-31' })).id as number;
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...new Array(200).fill(7)]);
  const fd = new FormData(); fd.append('file', new File([jpeg], 'عشاء.jpg', { type: 'image/jpeg' })); fd.append('takenAt', '2024-07-05 19:00'); fd.append('sender', 'خالد');
  assert.equal((await app.request(`/api/albums/${album}/items`, { method: 'POST', headers: { cookie: a }, body: fd })).status, 201);
  run("INSERT INTO archive_entries (circle_id, title, summary, category, event_date, source, kind) VALUES (?, 'تخرّج خالد', 'تخرّج', 'graduation', '2024-07-05', 'manual', 'event')", circle);
  await j(b, '/api/support', 'POST', { subject: 'سؤال', body: 'نص طلبي' });

  const zipA = unzipSync(new Uint8Array(await (await app.request('/api/me/export', { headers: { cookie: a } })).arrayBuffer()));
  const names = Object.keys(zipA);
  const albumJson = names.find(x => x.endsWith('/album.json'));
  assert.ok(albumJson, 'the album is described');
  const described = JSON.parse(strFromU8(zipA[albumJson!]));
  assert.equal(described.title, 'ألبوم واتساب'); assert.equal(described.items.length, 1);
  assert.deepEqual([...zipA[described.items[0].path]].slice(0, 4), [0xff, 0xd8, 0xff, 0xe0], 'the real picture is in the zip');
  const story = names.find(x => /story-2024\.json$/.test(x));
  assert.ok(story, 'the story of the year is in the zip');
  assert.match(strFromU8(zipA[story!]), /تخرّج خالد/);
  assert.ok(!names.includes('support-messages-i-wrote.json'), 'a person who never wrote to support has none');

  const zipB = unzipSync(new Uint8Array(await (await app.request('/api/me/export', { headers: { cookie: b } })).arrayBuffer()));
  assert.match(strFromU8(zipB['support-messages-i-wrote.json']), /نص طلبي/);
});
