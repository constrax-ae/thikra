// D-01/D-07 (web slice): images, video and documents in a message. The security rules matter most:
// what a file is comes from its bytes, risky types are never rendered, and only circle members can fetch anything.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const blobDir = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));
process.env.THIKRA_BLOBS = blobDir;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniff, sniffText, cleanName } from './sniff.ts';
const { app } = await import('./index.ts');

const pad = (head: number[], n = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(n, 7)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(300, 9)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 1)]);
const bytes = (b: Buffer) => new Uint8Array(b) as unknown as BlobPart;

let n = 0;
async function login(name: string) {
  const phone = `+9665${String(6_000_000 + n++).padStart(8, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  return { cookie: res.headers.get('set-cookie')!.split(';')[0] };
}
const json = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
type F = { name: string; data: Buffer; thumb?: Buffer; w?: number; h?: number };
async function upload(cookie: string, circle: number, files: F[], extra: Record<string, string> = {}) {
  const fd = new FormData();
  for (const f of files) {
    fd.append('file', new Blob([bytes(f.data)], { type: 'application/octet-stream' }), f.name);
    if (f.thumb) fd.append('thumb', new Blob([bytes(f.thumb)]), 't.jpg'); else fd.append('thumb', new Blob([]), 'none');
    if (f.w) fd.append('w', String(f.w)); if (f.h) fd.append('h', String(f.h));
  }
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const res = await app.request(`/api/circles/${circle}/attachments`, { method: 'POST', headers: { cookie }, body: fd });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}
async function pair() {
  const a = await login('A'), b = await login('B');
  const circle = (await json(a.cookie, '/api/circles', 'POST', { name: 'media' })).json.id as number;
  const code = (await json(a.cookie, `/api/circles/${circle}`)).json.inviteCode;
  await json(b.cookie, '/api/circles/join', 'POST', { code });
  return { a, b, circle };
}
const fetchMedia = (cookie: string, id: number, headers: Record<string, string> = {}) => app.request(`/api/media/${id}`, { headers: { cookie, ...headers } });
const messages = async (cookie: string, circle: number) => (await json(cookie, `/api/circles/${circle}/messages?after_seq=0`)).json as any[];

test('sniff: bytes decide, claimed names and types do not', () => {
  assert.equal(sniff(JPEG)?.mime, 'image/jpeg');
  assert.equal(sniff(PNG)?.mime, 'image/png');
  assert.equal(sniff(MP4)?.family, 'video');
  assert.equal(sniff(PDF)?.family, 'file');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null, 'SVG can run script: refused');
  assert.equal(sniff(Buffer.from('<!doctype html><script>alert(1)</script>')), null);
  assert.equal(sniff(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff')), null, 'a Windows executable');
  assert.equal(sniffText('notes.txt', Buffer.from('hello family')) ?.family, 'file');
  assert.equal(sniffText('notes.txt', Buffer.from('<html><body>x')), null, 'markup named .txt');
  assert.equal(sniffText('notes.txt', Buffer.from([0x68, 0x00, 0x69, 0x00])), null, 'binary named .txt');
  assert.equal(sniffText('x.bin', Buffer.from('plain')), null, 'unknown extension is not trusted');
  assert.equal(cleanName('../../etc/passwd'), 'passwd');
  assert.equal(cleanName('a"b<c>.pdf'), 'abc.pdf');
});

test('an image with a thumbnail and a caption: stored, delivered to the circle, served inline to members only', async () => {
  const { a, b, circle } = await pair();
  const up = await upload(a.cookie, circle, [{ name: 'photo.jpg', data: JPEG, thumb: PNG, w: 1200, h: 800 }], { caption: 'من الرحلة', client_msg_id: 'img1' });
  assert.equal(up.status, 201);
  const msg = (await messages(b.cookie, circle)).find(m => m.id === up.json.id);
  assert.equal(msg.body, 'من الرحلة');
  assert.equal(msg.attachments.length, 1);
  const at = msg.attachments[0];
  assert.deepEqual([at.kind, at.mime, at.name, at.w, at.h], ['image', 'image/jpeg', 'photo.jpg', 1200, 800]);
  assert.ok(at.thumb, 'has a thumbnail');
  const full = await fetchMedia(b.cookie, at.id);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/jpeg');
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  assert.match(full.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(Buffer.from(await full.arrayBuffer()).equals(JPEG), true, 'the bytes are returned unchanged');
  assert.equal((await fetchMedia(b.cookie, at.thumb)).headers.get('content-type'), 'image/png');
  const outsider = await login('X');
  assert.equal((await fetchMedia(outsider.cookie, at.id)).status, 404, 'a non-member gets nothing');
  assert.equal((await app.request(`/api/media/${at.id}`)).status, 401, 'and neither does an anonymous caller');
  // a retry of the same upload (same client_msg_id) creates no second message and stores nothing again
  const again = await upload(a.cookie, circle, [{ name: 'photo.jpg', data: JPEG }], { client_msg_id: 'img1' });
  assert.equal(again.status, 200);
  assert.equal(again.json.id, up.json.id);
  assert.equal((await messages(a.cookie, circle)).filter(m => m.attachments?.length).length, 1);
});

test('documents and video: documents are always a download; risky or fake files are refused', async () => {
  const { a, circle } = await pair();
  const doc = await upload(a.cookie, circle, [{ name: 'تقرير.pdf', data: PDF }, { name: 'notes.txt', data: Buffer.from('نص عادي') }, { name: 'clip.mp4', data: MP4 }]);
  assert.equal(doc.status, 201);
  const at = (await messages(a.cookie, circle)).find(m => m.id === doc.json.id).attachments;
  assert.deepEqual(at.map((x: any) => x.kind), ['file', 'file', 'video']);
  const pdf = await fetchMedia(a.cookie, at[0].id);
  assert.equal(pdf.headers.get('content-type'), 'application/octet-stream', 'never served as renderable');
  assert.match(pdf.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''/);
  assert.match(decodeURIComponent((pdf.headers.get('content-disposition') ?? '').split("''")[1]), /تقرير\.pdf/);
  assert.equal((await fetchMedia(a.cookie, at[2].id)).headers.get('content-type'), 'video/mp4');

  const refuse = async (f: F, why: string) => assert.equal((await upload(a.cookie, circle, [f])).status, 400, why);
  await refuse({ name: 'page.html', data: Buffer.from('<html><script>alert(1)</script>') }, 'html');
  await refuse({ name: 'x.svg', data: Buffer.from('<svg><script>alert(1)</script></svg>') }, 'svg');
  await refuse({ name: 'setup.exe', data: JPEG }, 'executable name even with image bytes');
  await refuse({ name: 'evil.jpg', data: Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff') }, 'executable bytes named .jpg');
  await refuse({ name: 'empty.jpg', data: Buffer.alloc(0) }, 'empty');
  await refuse({ name: 'x.jpg', data: JPEG, thumb: PDF }, 'a thumbnail that is not an image');
  // type comes from the bytes: PDF bytes named .jpg are stored as a PDF (a download), not as an image
  const sneaky = await upload(a.cookie, circle, [{ name: 'photo.jpg', data: PDF }]);
  assert.equal((await messages(a.cookie, circle)).find(m => m.id === sneaky.json.id).attachments[0].kind, 'file');
  // too many files
  const many = await upload(a.cookie, circle, Array.from({ length: 11 }, (_, i) => ({ name: `p${i}.jpg`, data: JPEG })));
  assert.equal(many.status, 400);
  // a refused upload leaves nothing behind: no message
  const before = (await messages(a.cookie, circle)).length;
  await refuse({ name: 'z.exe', data: JPEG }, 'again');
  assert.equal((await messages(a.cookie, circle)).length, before);
});

test('video supports Range: seeking and playing before the download finishes', async () => {
  const { a, circle } = await pair();
  const up = await upload(a.cookie, circle, [{ name: 'v.mp4', data: MP4 }]);
  const id = (await messages(a.cookie, circle)).find(m => m.id === up.json.id).attachments[0].id;
  const part = await fetchMedia(a.cookie, id, { range: 'bytes=4-11' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 4-11/${MP4.length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString('latin1'), 'ftypmp42');
  const tail = await fetchMedia(a.cookie, id, { range: 'bytes=-10' });
  assert.equal(Buffer.from(await tail.arrayBuffer()).length, 10);
  assert.equal((await fetchMedia(a.cookie, id, { range: `bytes=${MP4.length + 5}-` })).status, 416);
});

test('deleting for everyone erases the files from storage and the gallery; delete for me hides from my gallery only', async () => {
  const { a, b, circle } = await pair();
  const unique = pad([0xff, 0xd8, 0xff, 0xe0], 5000 + Math.floor(Math.random() * 1000));
  const up = await upload(a.cookie, circle, [{ name: 'p.jpg', data: unique, thumb: PNG }]);
  const countBlobs = () => { let c = 0; const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : c++; } }; walk(blobDir); return c; };
  const gallery = async (cookie: string) => (await json(cookie, `/api/circles/${circle}/media`)).json as any[];
  assert.equal((await gallery(b.cookie)).length, 1);
  assert.equal((await json(b.cookie, `/api/circles/${circle}/media?kind=video`)).json.length, 0);
  const id = (await gallery(a.cookie))[0].id;
  const blobsBefore = countBlobs();
  await json(b.cookie, `/api/messages/${up.json.id}/hide`, 'POST', {});
  assert.equal((await gallery(b.cookie)).length, 0, 'hidden for me');
  assert.equal((await gallery(a.cookie)).length, 1, 'still there for the sender');
  assert.equal((await json(a.cookie, `/api/messages/${up.json.id}`, 'DELETE')).status, 200);
  assert.equal((await gallery(a.cookie)).length, 0);
  assert.equal((await fetchMedia(a.cookie, id)).status, 404, 'the file is gone');
  assert.ok(countBlobs() < blobsBefore, 'its bytes are really removed from storage');
});

test('voice message: the recorder\'s length travels with it (the file itself often has no usable duration); bad lengths are ignored', async () => {
  const { a, b, circle } = await pair();
  const send = async (duration?: string) => {
    const fd = new FormData();
    fd.append('audio', new Blob([bytes(Buffer.alloc(500, 3))], { type: 'audio/webm' }), 'voice');
    if (duration) fd.append('duration', duration);
    const res = await app.request(`/api/circles/${circle}/voice`, { method: 'POST', headers: { cookie: a.cookie }, body: fd });
    return (await res.json() as any).id as number;
  };
  const ok = await send('12500'), absurd = await send('99999999'), none = await send();
  const list = await messages(b.cookie, circle);
  assert.equal(list.find(m => m.id === ok).audioMs, 12500);
  assert.equal(list.find(m => m.id === absurd).audioMs, null, 'over 15 minutes is not believed');
  assert.equal(list.find(m => m.id === none).audioMs, null);
});
