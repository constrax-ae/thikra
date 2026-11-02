process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const work = mkdtempSync(join(tmpdir(), 'thikra-albums-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { one, run } = await import('./db.ts');

type Res = { status: number; json: any; headers: Headers; bytes: Buffer };
const call = async (cookie: string | undefined, path: string, body?: unknown, method?: string, extra: Record<string, string> = {}): Promise<Res> => {
  const res = await app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json: any = {}; try { json = JSON.parse(bytes.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, json, headers: res.headers, bytes };
};
const upload = async (cookie: string, albumId: number, bytes: Buffer, name: string, fields: Record<string, string> = {}, thumb?: Buffer): Promise<Res> => {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(bytes)], name));
  if (thumb) fd.append('thumb', new File([new Uint8Array(thumb)], 'thumb.jpg'));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await app.request(`/api/albums/${albumId}/items`, { method: 'POST', headers: { cookie }, body: fd });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {}, headers: res.headers, bytes: Buffer.from(text) };
};
async function signUp(phone: string, name: string) {
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode;
  const v = await app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code, name }) });
  return v.headers.get('set-cookie')!.split(';')[0];
}
const jpeg = (n = 600) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]), randomBytes(n)]);
const ogg = (n = 400) => Buffer.concat([Buffer.from('OggS\0\x02', 'latin1'), randomBytes(n)]);
const mp4 = (n = 800) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), randomBytes(n)]);
const m4a = (n = 400) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A ', 'latin1'), randomBytes(n)]);

const owner = await signUp('+971500770001', 'Owner');
const member = await signUp('+971500770002', 'Member');
const outsider = await signUp('+971500770003', 'Outsider');
const circle = (await call(owner, '/api/circles', { name: 'Family', kind: 'circle' })).json.id as number;
const code = one('SELECT invite_code FROM circles WHERE id = ?', circle)!.invite_code;
await call(member, '/api/circles/join', { code });
const album = (await call(owner, `/api/circles/${circle}/albums`, { title: 'WhatsApp 2022-2024', source: 'whatsapp', from: '2022-01-01', to: '2024-12-31' })).json.id as number;

test('only a circle manager creates an album; members read, outsiders see nothing; a plain group cannot have one', async () => {
  assert.ok(album > 0);
  assert.equal((await call(member, `/api/circles/${circle}/albums`, { title: 'x' })).status, 403);
  assert.equal((await call(outsider, `/api/circles/${circle}/albums`, { title: 'x' })).status, 404);
  assert.equal((await call(owner, `/api/circles/${circle}/albums`, { title: '  ' })).json.error, 'name_required');
  const group = (await call(owner, '/api/circles', { name: 'Just a group', kind: 'group' })).json.id;
  assert.equal((await call(owner, `/api/circles/${group}/albums`, { title: 'x' })).json.error, 'not_a_circle');
  assert.equal((await call(member, `/api/circles/${circle}/albums`)).json.length, 1);
  assert.equal((await call(outsider, `/api/circles/${circle}/albums`)).status, 404);
  assert.equal((await upload(member, album, jpeg(), 'a.jpg', { takenAt: '2024-01-01 10:00' })).status, 403, 'members do not add files');
});

test('files are judged by their bytes: photos, voices and videos are kept, everything else is refused', async () => {
  const at = { takenAt: '2024-03-10 12:30', sender: 'Ahmad' };
  const photo = await upload(owner, album, jpeg(), 'IMG-20240310-WA0001.jpg', at, jpeg(80));
  assert.equal(photo.status, 201); assert.equal(photo.json.kind, 'image');
  assert.equal((await upload(owner, album, ogg(), 'PTT-20240310-WA0002.opus', at)).json.kind, 'voice');
  assert.equal((await upload(owner, album, m4a(), 'AUD-20240310-WA0003.m4a', at)).json.kind, 'voice', 'an audio MP4 is a voice, not a video');
  assert.equal((await upload(owner, album, mp4(), 'VID-20240310-WA0004.mp4', at)).json.kind, 'video');
  assert.equal((await upload(owner, album, Buffer.concat([Buffer.from('MZ'), randomBytes(200)]), 'virus.jpg', at)).status, 400, 'an executable named .jpg');
  assert.equal((await upload(owner, album, jpeg(), 'photo.exe', at)).status, 400);
  assert.equal((await upload(owner, album, Buffer.from('%PDF-1.4 hello world padding'), 'doc.pdf', at)).status, 400, 'documents are not album material');
  assert.equal((await upload(owner, album, jpeg(), 'x.jpg', { takenAt: 'yesterday' })).json.error, 'invalid_date');
  assert.equal((await upload(owner, album, jpeg(17 * 1024 * 1024), 'huge.jpg', at)).status, 413);
  // the same file again is a no-op, in any name
  const bytes = jpeg(); await upload(owner, album, bytes, 'one.jpg', at);
  assert.equal((await upload(owner, album, bytes, 'again.jpg', at)).json.duplicate, true);
  assert.equal(one('SELECT COUNT(*) n FROM album_items WHERE album_id = ?', album)!.n, 5);
});

test('items are listed by year and kind in order, paged, and served to members only (voices inline, with Range)', async () => {
  for (const [y, n] of [[2022, 2], [2023, 3]] as const) for (let i = 0; i < n; i++) await upload(owner, album, jpeg(), `IMG-${y}${i}.jpg`, { takenAt: `${y}-06-0${i + 1} 09:00` });
  const years = (await call(member, `/api/circles/${circle}/albums`)).json[0].years as any[];
  assert.deepEqual(years.map(y => y.year), [2024, 2023, 2022]);
  assert.equal(years.find(y => y.year === 2023).image, 3);
  assert.equal(years.find(y => y.year === 2024).voice, 2);
  const y23 = (await call(member, `/api/albums/${album}/items?year=2023&kind=image`)).json as any[];
  assert.deepEqual(y23.map(i => i.takenAt), ['2023-06-01 09:00', '2023-06-02 09:00', '2023-06-03 09:00']);
  const p1 = (await call(member, `/api/albums/${album}/items?limit=2`)).json as any[];
  const p2 = (await call(member, `/api/albums/${album}/items?limit=2&after=${p1[1].id}`)).json as any[];
  assert.equal(p1.length, 2); assert.ok(p2[0].id > p1[1].id);
  assert.equal((await call(outsider, `/api/albums/${album}/items`)).status, 404);

  const all2024 = (await call(member, `/api/albums/${album}/items?year=2024`)).json as any[];
  const photoItem = all2024.find(i => i.kind === 'image' && i.hasThumb), voiceItem = all2024.find(i => i.kind === 'voice');
  const f = await call(member, `/api/album-items/${photoItem.id}/file`);
  assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'image/jpeg');
  assert.equal((await call(member, `/api/album-items/${photoItem.id}/file?thumb=1`)).status, 200);
  const v = await call(member, `/api/album-items/${voiceItem.id}/file`, undefined, 'GET', { range: 'bytes=0-9' });
  assert.equal(v.status, 206); assert.match(v.headers.get('content-type') ?? '', /^audio\//); assert.equal(v.bytes.length, 10);
  assert.equal((await call(outsider, `/api/album-items/${photoItem.id}/file`)).status, 404);
  // album files are not chat media
  assert.equal(((await call(member, `/api/circles/${circle}/media`)).json as any[]).length, 0);
});

test('archive events show the album pictures and voices of their days (the day before and after too), pictures first', async () => {
  await call(owner, `/api/circles/${circle}/import`, { entries: [{ date: '2024-03-10', title: 'مولود جديد', summary: 'ولد أحمد', category: 'birth' }, { date: '2023-01-15', title: 'حدث بلا صور', summary: 'لا صور هنا', category: 'travel' }] });
  const arch = (await call(member, `/api/circles/${circle}/archive`)).json as any[];
  const birth = arch.find(e => e.title === 'مولود جديد');
  assert.ok(birth.media.length >= 3 && birth.media.length <= 6, 'the photo, the voices and the video of that day');
  assert.equal(birth.media[0].kind, 'image', 'pictures come first');
  assert.deepEqual(arch.find(e => e.title === 'حدث بلا صور').media, []);
  await upload(owner, album, jpeg(), 'IMG-near.jpg', { takenAt: '2024-03-11 08:00' });
  await upload(owner, album, jpeg(), 'IMG-far.jpg', { takenAt: '2024-03-13 08:00' });
  const after = ((await call(member, `/api/circles/${circle}/archive`)).json as any[]).find(e => e.title === 'مولود جديد').media.length;
  assert.ok(after >= birth.media.length, 'the next day counts');
  const far = ((await call(member, `/api/circles/${circle}/archive`)).json as any[]).find(e => e.title === 'مولود جديد').media;
  assert.ok(far.every((m: any) => one('SELECT day FROM album_items WHERE id = ?', m.id)!.day <= '2024-03-11'), 'two days away is not linked');
});

test('the family vault counts album files, and a full vault refuses more', async () => {
  const before = (await call(owner, `/api/circles/${circle}/billing`)).json.archivedBytes as number;
  assert.ok(before > 0, 'album files are archived media');
  run('INSERT OR IGNORE INTO blobs (hash, size) VALUES (?, ?)', 'f'.repeat(64), 5 * 1024 ** 3);
  run("INSERT INTO media (circle_id, message_id, uploader_id, blob_hash, kind, mime, size, archived, name) VALUES (?, NULL, NULL, ?, 'image', 'image/jpeg', ?, 1, 'huge')", circle, 'f'.repeat(64), 5 * 1024 ** 3);
  assert.equal((await upload(owner, album, jpeg(), 'one-more.jpg', { takenAt: '2024-05-01 10:00' })).json.error, 'storage_full');
  run("DELETE FROM media WHERE name = 'huge'"); run("DELETE FROM blobs WHERE hash = ?", 'f'.repeat(64));
});

test('removing an item or a whole album frees its files; only managers may', async () => {
  const items = (await call(owner, `/api/albums/${album}/items?limit=200`)).json as any[];
  assert.equal((await call(member, `/api/album-items/${items[0].id}`, undefined, 'DELETE')).status, 403);
  const blobsBefore = one('SELECT COUNT(*) n FROM blobs')!.n;
  assert.equal((await call(owner, `/api/album-items/${items[0].id}`, undefined, 'DELETE')).json.ok, true);
  assert.equal((await call(owner, `/api/albums/${album}/items?limit=200`)).json.length, items.length - 1);
  assert.ok(one('SELECT COUNT(*) n FROM blobs')!.n < blobsBefore, 'its file is gone from storage');
  assert.equal((await call(member, `/api/circles/${circle}/albums/${album}`, undefined, 'DELETE')).status, 403);
  const gone = (await call(owner, `/api/circles/${circle}/albums/${album}`, undefined, 'DELETE')).json;
  assert.equal(gone.removed, items.length - 1);
  assert.equal(one('SELECT COUNT(*) n FROM album_items')!.n, 0);
  assert.equal(one("SELECT COUNT(*) n FROM media WHERE message_id IS NULL")!.n, 0, 'no orphan media rows');
  assert.equal(one('SELECT COUNT(*) n FROM blobs')!.n, 0, 'and no orphan files');
});
