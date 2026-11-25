// Step 3 (media and sharing), features 13-17: voice notes, resumable uploads, link previews, GIFs and stickers, contact and location.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';
delete process.env.GIPHY_API_KEY;

import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const { app, startServer } = await import('./index.ts');
const { one, run } = await import('./db.ts');
const { isPublicAddress, cleanLink, parsePreview, fromOembed, safeGet, setPreviewFetcher, UnsafeLink } = await import('./lib/linkpreview.ts');
const { setGifProvider } = await import('./lib/gifs.ts');
const { purgeStaleUploads } = await import('./lib/uploads.ts');
const purgeLinkPreviews: () => Promise<number> = ((await import("./lib/deletes.ts")) as any).purgeLinkPreviews ?? (async () => -1);
const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
const opened: WebSocket[] = [];
const extra: http.Server[] = [];
after(() => { for (const w of opened) w.terminate(); for (const s of extra) s.close(); server.close(); server.closeAllConnections?.(); });

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
const form = async (cookie: string, path: string, fields: Array<[string, string | Blob, string?]>) => {
  const fd = new FormData();
  for (const [k, v, name] of fields) { if (v instanceof Blob) fd.append(k, v, name ?? 'f'); else fd.append(k, v); }
  const res = await app.request(path, { method: 'POST', headers: { cookie }, body: fd });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
const put = async (cookie: string, id: string, offset: number, bytes: Uint8Array) => {
  const res = await app.request(`/api/uploads/${id}?offset=${offset}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/octet-stream' }, body: new Blob([Buffer.from(bytes)]) });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF_BYTES = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const AUDIO = new Blob([Buffer.from('fake-audio-bytes-for-a-voice-note')], { type: 'audio/webm' });
let n = 0;
async function person(name: string) {
  const phone = `+96658${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(2, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, name, phone, id: (await call(cookie, '/api/me')).json.id as number };
}
type P = Awaited<ReturnType<typeof person>>;
async function group() {
  const owner = await person('ناصر'), member = await person('خالد');
  const id = (await call(owner.cookie, '/api/circles', 'POST', { name: 'العائلة', kind: 'group' })).json.id as number;
  const code = (await call(owner.cookie, `/api/circles/${id}`)).json.inviteCode as string;
  await call(member.cookie, '/api/circles/join', 'POST', { code });
  return { owner, member, id };
}
async function socket(p: P) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: p.cookie } });
  opened.push(ws);
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const until = async (pred: (f: any) => boolean, ms = 2000) => { const t = Date.now(); for (;;) { const f = frames.find(pred); if (f) return f; if (Date.now() - t > ms) throw new Error('no frame'); await new Promise(r => setTimeout(r, 10)); } };
  await until(f => f.t === 'hello');
  return { ws, frames, until };
}
const messages = async (p: P, id: number) => (await call(p.cookie, `/api/circles/${id}/messages?after=0`)).json as any[];
const count = (id: number) => one('SELECT COUNT(*) AS n FROM messages WHERE circle_id = ? AND kind != ?', id, 'system')!.n as number;

// ---- 13. voice notes -----------------------------------------------------------------------

test('voice: a retry with the same client id stores the note once, and the waveform comes back as the device measured it', async () => {
  const g = await group();
  const fields: Array<[string, string | Blob, string?]> = [['audio', AUDIO, 'voice'], ['duration', '4200'], ['client_msg_id', 'rec-1'], ['waveform', JSON.stringify([0, 12.4, 250, 40, 8])]];
  const first = await form(g.owner.cookie, `/api/circles/${g.id}/voice`, fields);
  assert.equal(first.status, 201);
  const again = await form(g.owner.cookie, `/api/circles/${g.id}/voice`, fields);
  assert.equal(again.status, 200, 'the retry is answered with the first one');
  assert.equal(again.json.id, first.json.id);
  assert.equal(count(g.id), 1, 'never lost, never doubled');
  const m = (await messages(g.member, g.id)).find(x => x.id === first.json.id);
  assert.equal(m.kind, 'voice'); assert.equal(m.audioMs, 4200);
  assert.deepEqual(m.waveform, [0, 12, 100, 40, 8], 'rounded and kept within 0-100');
  assert.deepEqual(m.playedBy, []);
  const bad = await form(g.owner.cookie, `/api/circles/${g.id}/voice`, [['audio', AUDIO, 'voice'], ['waveform', '"<script>"']]);
  assert.equal(bad.status, 201, 'a waveform that is not one is dropped, the note still goes');
  assert.equal((await messages(g.owner, g.id)).find(x => x.id === bad.json.id).waveform, null);
});

test('voice: "played" is recorded once per listener, announced to the chat, and means nothing for the sender or an outsider', async () => {
  const g = await group(), outsider = await person('غريب');
  const id = (await form(g.owner.cookie, `/api/circles/${g.id}/voice`, [['audio', AUDIO, 'voice']])).json.id as number;
  const s = await socket(g.owner);
  assert.equal((await call(outsider.cookie, `/api/messages/${id}/played`, 'POST', {})).status, 404);
  assert.equal((await call(g.owner.cookie, `/api/messages/${id}/played`, 'POST', {})).status, 200);
  assert.deepEqual((await messages(g.owner, g.id)).find(x => x.id === id).playedBy, [], 'my own listening marks nothing');
  const rev = (await messages(g.owner, g.id)).find(x => x.id === id).rev;
  assert.equal((await call(g.member.cookie, `/api/messages/${id}/played`, 'POST', {})).status, 200);
  const f = await s.until(x => x.t === 'update' && x.m.id === id);
  assert.deepEqual(f.m.playedBy, [g.member.id]);
  assert.ok(f.m.rev > rev, 'the revision moves, so a device that was offline catches the mark by syncing');
  await call(g.member.cookie, `/api/messages/${id}/played`, 'POST', {});
  assert.equal(one('SELECT COUNT(*) AS n FROM voice_plays WHERE message_id = ?', id)!.n, 1);
  const text = (await call(g.owner.cookie, `/api/circles/${g.id}/messages`, 'POST', { body: 'نص' })).json.id;
  assert.equal((await call(g.member.cookie, `/api/messages/${text}/played`, 'POST', {})).status, 404, 'only a voice note can be played');
});

test('voice: the audio can be asked for in parts, which is what lets a player jump to any moment (seek)', async () => {
  const g = await group();
  const id = (await form(g.owner.cookie, `/api/circles/${g.id}/voice`, [['audio', AUDIO, 'voice']])).json.id as number;
  const whole = await app.request(`/api/messages/${id}/audio`, { headers: { cookie: g.member.cookie } });
  assert.equal(whole.status, 200); assert.equal(whole.headers.get('accept-ranges'), 'bytes'); assert.equal(whole.headers.get('content-type'), 'audio/webm');
  const part = await app.request(`/api/messages/${id}/audio`, { headers: { cookie: g.member.cookie, range: 'bytes=5-9' } });
  assert.equal(part.status, 206);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), 'audio');
  const outsider = await person('غريب');
  assert.equal((await app.request(`/api/messages/${id}/audio`, { headers: { cookie: outsider.cookie } })).status, 404);
});

test('voice: a group set to "only admins send" refuses a member\'s voice note', async () => {
  const g = await group();
  await call(g.owner.cookie, `/api/circles/${g.id}`, 'PATCH', { sendPolicy: 'admins' });
  assert.equal((await form(g.member.cookie, `/api/circles/${g.id}/voice`, [['audio', AUDIO, 'voice']])).status, 403);
});

// ---- 14. uploads ---------------------------------------------------------------------------

const bigPng = (size: number) => { const b = Buffer.alloc(size, 7); PNG_BYTES.copy(b); return b; };

test('uploads: a file sent in pieces becomes one message only when every byte has arrived', async () => {
  const g = await group();
  const file = bigPng(300_000);
  const open = await call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'صورة.png', size: file.length });
  assert.equal(open.status, 201); assert.equal(open.json.offset, 0); assert.ok(open.json.chunk >= 1024 * 1024);
  const id = open.json.id as string;
  assert.equal((await put(g.owner.cookie, id, 0, file.subarray(0, 100_000))).json.offset, 100_000);
  assert.equal(count(g.id), 0, 'nothing in the chat yet');
  const early = await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['upload', id]]);
  assert.equal(early.status, 409); assert.equal(early.json.error, 'upload_incomplete'); assert.equal(early.json.offset, 100_000);
  assert.equal((await put(g.owner.cookie, id, 100_000, file.subarray(100_000))).json.offset, file.length);
  const sent = await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['upload', id], ['caption', 'من الرحلة'], ['client_msg_id', 'up-1']]);
  assert.equal(sent.status, 201);
  const m = (await messages(g.member, g.id)).find(x => x.id === sent.json.id);
  assert.equal(m.body, 'من الرحلة'); assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].kind, 'image'); assert.equal(m.attachments[0].size, file.length); assert.equal(m.attachments[0].name, 'صورة.png');
  const media = await app.request(`/api/media/${m.attachments[0].id}`, { headers: { cookie: g.member.cookie } });
  assert.ok(Buffer.from(await media.arrayBuffer()).equals(file), 'the stored file is byte for byte what was sent');
  assert.equal(one('SELECT COUNT(*) AS n FROM uploads WHERE id = ?', id)!.n, 0, 'the waiting pieces are gone');
  const retry = await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['upload', id], ['client_msg_id', 'up-1']]);
  assert.equal(retry.status, 200, 'a retry of the last step returns the same message'); assert.equal(retry.json.id, sent.json.id);
  assert.equal(count(g.id), 1);
});

test('uploads: after a dropped connection the device asks where the server stopped and continues from there', async () => {
  const g = await group();
  const file = bigPng(250_000);
  const id = (await call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'a.png', size: file.length })).json.id as string;
  await put(g.owner.cookie, id, 0, file.subarray(0, 90_000));
  // The answer to the second piece was lost: the device does not know whether it arrived, and sends from the wrong place.
  await put(g.owner.cookie, id, 90_000, file.subarray(90_000, 170_000));
  const wrong = await put(g.owner.cookie, id, 90_000, file.subarray(90_000, 170_000));
  assert.equal(wrong.status, 409); assert.equal(wrong.json.offset, 170_000, 'the server says where it really is; nothing is written twice');
  assert.deepEqual((await call(g.owner.cookie, `/api/uploads/${id}`)).json, { offset: 170_000, size: file.length });
  assert.equal((await put(g.owner.cookie, id, 170_000, file.subarray(170_000))).status, 200);
  const past = await put(g.owner.cookie, id, file.length, Buffer.from('more'));
  assert.equal(past.status, 409, 'nothing can be added past the declared size');
  const sent = await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['upload', id]]);
  const m = (await messages(g.owner, g.id)).find(x => x.id === sent.json.id);
  const got = Buffer.from(await (await app.request(`/api/media/${m.attachments[0].id}`, { headers: { cookie: g.owner.cookie } })).arrayBuffer());
  assert.ok(got.equals(file));
});

test('uploads: cancelling leaves no message and no bytes; another person cannot touch or use the upload', async () => {
  const g = await group();
  const file = bigPng(50_000);
  const id = (await call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'a.png', size: file.length })).json.id as string;
  await put(g.owner.cookie, id, 0, file.subarray(0, 20_000));
  assert.equal((await put(g.member.cookie, id, 20_000, file.subarray(20_000))).status, 404, 'not theirs');
  assert.equal((await call(g.member.cookie, `/api/uploads/${id}`)).status, 404);
  assert.equal((await form(g.member.cookie, `/api/circles/${g.id}/attachments`, [['upload', id]])).status, 404);
  assert.equal((await call(g.owner.cookie, `/api/uploads/${id}`, 'DELETE')).status, 200);
  assert.equal((await call(g.owner.cookie, `/api/uploads/${id}`)).status, 404);
  assert.equal((await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['upload', id]])).status, 404);
  assert.equal(count(g.id), 0, 'no broken message');
  assert.ok(!existsSync(join(process.env.THIKRA_BLOBS!, '.uploads', id)), 'the partial file is deleted');
  assert.equal((await call(g.owner.cookie, `/api/uploads/${id}`, 'DELETE')).status, 200, 'cancelling twice is fine');
});

test('uploads: an oversized file is refused before any byte is sent, with the limit; so are a forbidden type, an oversized piece and a non-sender', async () => {
  const g = await group();
  const big = await call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'film.mp4', size: 100 * 1024 * 1024 + 1 });
  assert.equal(big.status, 413); assert.equal(big.json.error, 'attachment_too_large'); assert.equal(big.json.max, 100 * 1024 * 1024);
  assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'film.mp4', size: 100 * 1024 * 1024 })).status, 201, 'a video of exactly the limit is accepted');
  assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'virus.exe', size: 10 })).status, 400);
  assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'a.png', size: 0 })).status, 400);
  const id = (await call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'a.mp4', size: 20 * 1024 * 1024 })).json.id as string;
  const huge = await put(g.owner.cookie, id, 0, new Uint8Array(8 * 1024 * 1024 + 1));
  assert.equal(huge.status, 413); assert.equal(huge.json.error, 'chunk_too_large');
  // What a file is still comes from its bytes at the end: a script named .png makes no message.
  const fake = Buffer.from('<script>alert(1)</script>');
  const f = (await call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'x.png', size: fake.length })).json.id as string;
  await put(g.owner.cookie, f, 0, fake);
  assert.equal((await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['upload', f]])).status, 400);
  assert.equal(count(g.id), 0);
  await call(g.owner.cookie, `/api/circles/${g.id}`, 'PATCH', { sendPolicy: 'admins' });
  assert.equal((await call(g.member.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'a.png', size: 10 })).status, 403, 'only admins send: refused at the first step');
});

test('uploads: what was never finished is thrown away after a day', async () => {
  const g = await group();
  const id = (await call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'a.png', size: 5000 })).json.id as string;
  await put(g.owner.cookie, id, 0, bigPng(1000));
  run("UPDATE uploads SET created_at = datetime('now', '-2 days') WHERE id = ?", id);
  assert.equal((await call(g.owner.cookie, `/api/uploads/${id}`)).status, 404, 'an expired upload is already unusable');
  assert.ok(await purgeStaleUploads() >= 1);
  assert.ok(!readdirSync(join(process.env.THIKRA_BLOBS!, '.uploads')).includes(id));
});

// ---- 15. link previews ---------------------------------------------------------------------

test('link safety: only public internet addresses pass', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::1', '2001::1', '64:ff9b::7f00:1', 'fe80::1%eth0', 'not-an-ip', ''])
    assert.equal(isPublicAddress(ip), false, `${ip} must be refused`);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e']) assert.equal(isPublicAddress(ip), true, `${ip} is public`);
});

test('link safety: only plain http/https links to a real site name on the usual ports are ever considered', () => {
  for (const bad of ['ftp://example.com/a', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@example.com/', 'http://example.com:8080/', 'https://example.com:22/', 'http://localhost/', 'http://intranet/x', 'gopher://example.com', 'example.com', '', 'x'.repeat(2100), 42, null])
    assert.equal(cleanLink(bad as any), null, `${String(bad).slice(0, 40)} must be refused`);
  assert.equal(cleanLink(' https://Example.com/a?b=1#frag ')!.href, 'https://example.com/a?b=1', 'one canonical form: no fragment');
  assert.equal(cleanLink('http://2130706433/')?.hostname, '127.0.0.1', 'a number that hides an address is read as the address it is…');
});

test('link safety: the route refuses this machine, the private network and cloud metadata, by number or by name, and never stores a card for them', async () => {
  const p = await person('ناصر');
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/admin',
    'http://localhost./', 'http://localhost/', `http://127.0.0.1:${port}/api/me`, 'ftp://example.com/']) {
    const r = await call(p.cookie, '/api/link-preview', 'POST', { url });
    assert.equal(r.status, 400, url); assert.equal(r.json.error, 'unsafe_link', url);
  }
  assert.equal(one('SELECT COUNT(*) AS n FROM link_previews')!.n, 0);
  assert.equal((await app.request('/api/link-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"https://example.com"}' })).status, 401, 'signed-in people only');
});

test('link safety: every redirect is checked again, the size is capped, and a slow site is given up on', async () => {
  const listen = (h: http.RequestListener) => new Promise<number>(res => { const s = http.createServer(h); extra.push(s); s.listen(0, '127.0.0.1', () => res((s.address() as any).port)); });
  let hits = 0;
  const inner = await listen((_q, r) => { hits++; r.end('secret'); });
  const outer = await listen((q, r) => {
    if (q.url === '/hop') { r.writeHead(302, { location: `http://127.0.0.1:${inner}/` }); return r.end(); }
    if (q.url === '/loop') { r.writeHead(302, { location: '/loop' }); return r.end(); }
    if (q.url === '/big') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('x'.repeat(50_000)); }
    if (q.url === '/slow') return;   // never answers
    if (q.url === '/file') { r.writeHead(302, { location: 'file:///etc/passwd' }); return r.end(); }
    r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>ok</title>');
  });
  // The tests' "public" address is the outer server only: the redirect to the inner one must be refused before any connection is made.
  let calls = 0;
  const firstOnly = () => ++calls === 1;
  await assert.rejects(safeGet(new URL(`http://127.0.0.1:${outer}/hop`), { maxBytes: 1000, allow: firstOnly }), UnsafeLink);
  assert.equal(hits, 0, 'the private target of the redirect was never contacted');
  await assert.rejects(safeGet(new URL(`http://127.0.0.1:${outer}/file`), { maxBytes: 1000, allow: () => true }), UnsafeLink);
  const all = () => true;
  assert.equal(await safeGet(new URL(`http://127.0.0.1:${outer}/loop`), { maxBytes: 1000, allow: all }), null, 'at most 3 redirects');
  const big = await safeGet(new URL(`http://127.0.0.1:${outer}/big`), { maxBytes: 1000, allow: all });
  assert.equal(big!.body.length, 1000); assert.equal(big!.truncated, true);
  const t = Date.now();
  assert.equal(await safeGet(new URL(`http://127.0.0.1:${outer}/slow`), { maxBytes: 1000, allow: all, timeoutMs: 300 }), null);
  assert.ok(Date.now() - t < 2000);
  assert.equal((await safeGet(new URL(`http://127.0.0.1:${outer}/`), { maxBytes: 1000, allow: all }))!.body.toString(), '<title>ok</title>');
  // And with the real rule, the very first hop is refused.
  await assert.rejects(safeGet(new URL(`http://127.0.0.1:${outer}/`), { maxBytes: 1000 }), UnsafeLink);
});

test('link previews: common page shapes give a title, a site name and a picture', () => {
  const base = new URL('https://www.example.com/news/1');
  const og = parsePreview(`<html><head><meta property="og:title" content="خبر &amp; عنوان"><meta property="og:description" content='وصف "قصير"'>
    <meta property="og:image" content="/img/a.jpg"><meta property="og:site_name" content="الموقع"><title>ignored</title></head>`, base)!;
  assert.deepEqual(og, { title: 'خبر & عنوان', description: 'وصف "قصير"', site: 'الموقع', image: 'https://www.example.com/img/a.jpg' });
  const tw = parsePreview('<meta name="twitter:title" content="Tweet title"><meta name=twitter:image content=https://cdn.example.com/x.png>', base)!;
  assert.equal(tw.title, 'Tweet title'); assert.equal(tw.image, 'https://cdn.example.com/x.png'); assert.equal(tw.site, 'example.com', 'no site name: the host without www');
  const plain = parsePreview('<html><head><title>  A plain\n page &#8211; title </title><meta name="description" content="About it"></head><body>', base)!;
  assert.deepEqual(plain, { title: 'A plain page – title', description: 'About it', site: 'example.com', image: null });
  assert.equal(parsePreview('<html><body>no title at all</body></html>', base), null);
  assert.equal(parsePreview('<meta property="og:title" content="x"><meta property="og:image" content="javascript:alert(1)">', base)!.image, null, 'a picture address that is not http(s) is dropped');
  const long = parsePreview(`<title>${'ا'.repeat(500)}</title>`, base)!;
  assert.equal(long.title.length, 200);
  assert.ok(!parsePreview('<title>a\u202Eb</title>', base)!.title.includes('\u202E'), 'direction-override characters cannot disguise a title');
  // A YouTube video is described by YouTube's own "oEmbed" answer.
  assert.deepEqual(fromOembed({ title: 'أغنية العيد', author_name: 'قناة العائلة', thumbnail_url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' }, 'YouTube'),
    { title: 'أغنية العيد', description: 'قناة العائلة', site: 'YouTube', image: 'https://i.ytimg.com/vi/x/hqdefault.jpg' });
  assert.equal(fromOembed({ author_name: 'no title' }, 'YouTube'), null);
  assert.equal(fromOembed({ title: 'x', thumbnail_url: 'http://insecure.example.com/a.jpg' }, 'YouTube')!.image, null);
  assert.equal(fromOembed('nonsense', 'YouTube'), null);
});

test('link previews: the sender asks, the server keeps the answer, and the sent message carries a card built from the server\'s own fetch', async () => {
  const g = await group();
  let fetched = 0;
  setPreviewFetcher(async u => { fetched++; return u.hostname === 'news.example.com' ? { page: { title: 'عنوان الخبر', description: 'وصف', site: 'الأخبار', image: null }, image: { buf: PNG_BYTES, mime: 'image/png' } } : null; });
  try {
    const url = 'https://news.example.com/a/1';
    const asked = await call(g.owner.cookie, '/api/link-preview', 'POST', { url });
    assert.equal(asked.status, 200);
    assert.equal(asked.json.preview.title, 'عنوان الخبر'); assert.match(asked.json.preview.image, /^[0-9a-f]{64}$/);
    const pic = await app.request(`/api/link-preview/image/${asked.json.preview.image}`, { headers: { cookie: g.owner.cookie } });
    assert.equal(pic.status, 200); assert.equal(pic.headers.get('content-type'), 'image/png');
    await call(g.member.cookie, '/api/link-preview', 'POST', { url });
    assert.equal(fetched, 1, 'the same link is fetched once, not once per person');
    assert.deepEqual((await call(g.owner.cookie, '/api/link-preview', 'POST', { url: 'https://nothing.example.com/' })).json, { preview: null });
    await call(g.owner.cookie, '/api/link-preview', 'POST', { url: 'https://nothing.example.com/' });
    assert.equal(fetched, 2, 'a link that gave nothing is not asked again at once');

    const sent = await call(g.owner.cookie, `/api/circles/${g.id}/messages`, 'POST', { body: `شوفوا ${url}`, preview: url });
    const m = (await messages(g.member, g.id)).find(x => x.id === sent.json.id);
    assert.equal(m.card.type, 'link'); assert.equal(m.card.title, 'عنوان الخبر'); assert.equal(m.card.site, 'الأخبار'); assert.equal(m.card.url, url);
    const img = await app.request(`/api/media/${m.card.image}`, { headers: { cookie: g.member.cookie } });
    assert.equal(img.status, 200, 'the picture is served to members from our own server');
    assert.equal((await call(g.owner.cookie, '/api/circles')).json.find((x: any) => x.id === g.id).lastKind, 'text', 'a link message is still a text message in the chat list');

    // Over the socket too.
    const s = await socket(g.owner);
    s.ws.send(JSON.stringify({ t: 'send', circle: g.id, client_msg_id: 'lp-1', body: url, preview: url }));
    const ack = await s.until(f => f.t === 'ack' && f.client_msg_id === 'lp-1');
    assert.equal((await messages(g.owner, g.id)).find(x => x.id === ack.id).card.type, 'link');

    // No card for a link that is not in the text, was never asked for, or is not a safe link; a client cannot write the card itself.
    for (const [body, preview] of [['بدون رابط', url], ['https://other.example.com/x', 'https://other.example.com/x'], ['http://127.0.0.1/', 'http://127.0.0.1/'], [url, { url, title: 'مزيف' }]] as Array<[string, unknown]>) {
      const r = await call(g.owner.cookie, `/api/circles/${g.id}/messages`, 'POST', { body, preview });
      assert.equal(r.status, 201, 'the message itself is always sent');
      assert.equal((await messages(g.owner, g.id)).find(x => x.id === r.json.id).card, null, body);
    }
    // Editing the link out of the text removes the card; deleting the message removes it too.
    await call(g.owner.cookie, `/api/messages/${sent.json.id}`, 'PATCH', { body: `شوفوا ${url} الآن` });
    assert.equal((await messages(g.owner, g.id)).find(x => x.id === sent.json.id).card.type, 'link', 'still there while the link is');
    await call(g.owner.cookie, `/api/messages/${sent.json.id}`, 'PATCH', { body: 'غيرت رأيي' });
    assert.equal((await messages(g.owner, g.id)).find(x => x.id === sent.json.id).card, null);
    assert.equal((await app.request(`/api/media/${m.card.image}`, { headers: { cookie: g.member.cookie } })).status, 404);
    await call(g.owner.cookie, `/api/messages/${ack.id}`, 'DELETE');
    assert.equal(one('SELECT COUNT(*) AS n FROM message_cards WHERE message_id = ?', ack.id)!.n, 0);
    assert.equal((await app.request(`/api/link-preview/image/${asked.json.preview.image}`, { headers: { cookie: g.owner.cookie } })).status, 200, 'the stored preview keeps its picture for the next person');
  } finally { setPreviewFetcher(null); }
});

// ---- 16. GIFs and stickers -----------------------------------------------------------------

test('GIFs: without a provider key the panel is told it is not set up, and nothing else breaks', async () => {
  const g = await group();
  setGifProvider(null);
  assert.deepEqual((await call(g.owner.cookie, '/api/gifs?q=cat')).json, { configured: false, items: [] });
  assert.equal((await call(g.owner.cookie, '/api/gifs/abc/preview')).status, 503);
  const r = await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'gif', id: 'abc' });
  assert.equal(r.status, 503); assert.equal(r.json.error, 'gifs_off');
  assert.equal(count(g.id), 0);
});

test('GIFs: search and thumbnails go through the server; sending stores a copy as a picture of the chat', async () => {
  const g = await group();
  const asked: string[] = [], downloaded: string[] = [];
  const gif = (id: string) => ({ id, title: `gif ${id}`, preview: { url: `https://media.giphy.com/${id}/small.gif`, w: 100, h: 80 }, full: { url: `https://media.giphy.com/${id}/full.gif`, w: 250, h: 200 } });
  setGifProvider({
    search: async (q, offset) => { asked.push(`${q}@${offset}`); return q === 'none' ? [] : [gif('aaa'), gif('bbb')]; },
    byId: async id => (id === 'ccc' ? gif('ccc') : null),
    download: async url => { downloaded.push(url); return url.includes('broken') ? Buffer.from('<html>not a gif</html>') : GIF_BYTES; },
  });
  try {
    const found = await call(g.owner.cookie, '/api/gifs?q=%D9%82%D8%B7%D8%A9&offset=24');
    assert.equal(found.json.configured, true);
    assert.deepEqual(found.json.items, [{ id: 'aaa', title: 'gif aaa', w: 100, h: 80 }, { id: 'bbb', title: 'gif bbb', w: 100, h: 80 }], 'no provider address reaches the device');
    assert.deepEqual(asked, ['قطة@24']);
    assert.deepEqual((await call(g.owner.cookie, '/api/gifs')).json.items.length, 2, 'no words: what is trending');
    const thumb = await app.request('/api/gifs/aaa/preview', { headers: { cookie: g.owner.cookie } });
    assert.equal(thumb.status, 200); assert.equal(thumb.headers.get('content-type'), 'image/gif');
    await app.request('/api/gifs/aaa/preview', { headers: { cookie: g.owner.cookie } });
    assert.equal(downloaded.filter(u => u.includes('aaa/small')).length, 1, 'a thumbnail is fetched from the provider once');
    assert.equal((await app.request('/api/gifs/zzz/preview', { headers: { cookie: g.owner.cookie } })).status, 404);

    const sent = await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'gif', id: 'bbb', client_msg_id: 'gif-1', url: 'https://evil.example.com/x.gif' });
    assert.equal(sent.status, 201);
    assert.ok(downloaded.includes('https://media.giphy.com/bbb/full.gif') && !downloaded.some(u => u.includes('evil')), 'the address comes from the provider, never from the device');
    const m = (await messages(g.member, g.id)).find(x => x.id === sent.json.id);
    assert.equal(m.card.type, 'gif'); assert.equal(m.body, '');
    assert.equal(m.attachments.length, 1); assert.equal(m.attachments[0].mime, 'image/gif'); assert.equal(m.attachments[0].w, 250);
    assert.equal((await app.request(`/api/media/${m.attachments[0].id}`, { headers: { cookie: g.member.cookie } })).status, 200);
    assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'gif', id: 'bbb', client_msg_id: 'gif-1' })).status, 200, 'a retry is the same message');
    assert.equal(count(g.id), 1);
    assert.equal((await call(g.member.cookie, '/api/circles')).json.find((x: any) => x.id === g.id).lastKind, 'gif');
    assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'gif', id: 'ccc' })).status, 201, 'a recently used GIF the server no longer remembers is looked up by id');
    assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'gif', id: 'nope' })).status, 404);
    assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'gif', id: '../../etc' })).status, 404);
  } finally { setGifProvider(null); }
});

test('stickers: only a sticker of a built-in pack can be sent', async () => {
  const g = await group();
  const ok = await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'sticker', pack: 'greetings', id: 'sabah' });
  assert.equal(ok.status, 201);
  assert.deepEqual((await messages(g.member, g.id)).find(x => x.id === ok.json.id).card, { type: 'sticker', pack: 'greetings', id: 'sabah' });
  for (const bad of [{ pack: 'greetings', id: 'nope' }, { pack: 'nope', id: 'sabah' }, { pack: 'greetings' }, { pack: 'greetings', id: 'sabah<script>' }])
    assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'sticker', ...bad })).status, 400);
  assert.equal((await call(g.owner.cookie, '/api/circles')).json.find((x: any) => x.id === g.id).lastKind, 'sticker');
});

// ---- 17. contact and location --------------------------------------------------------------

test('contact: a card with a name and numbers; anything else is refused', async () => {
  const g = await group();
  const ok = await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'contact', name: '  أبو خالد \n', phones: ['+966 50 123 4567', '050-123-4567'], client_msg_id: 'c-1' });
  assert.equal(ok.status, 201);
  const m = (await messages(g.member, g.id)).find(x => x.id === ok.json.id);
  assert.deepEqual(m.card, { type: 'contact', name: 'أبو خالد', phones: ['+966 50 123 4567', '050-123-4567'] });
  assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'contact', name: 'أبو خالد', phones: ['+966 50 123 4567'], client_msg_id: 'c-1' })).json.id, ok.json.id);
  for (const bad of [{ name: '', phones: ['+966501234567'] }, { name: 'x', phones: [] }, { name: 'x', phones: ['javascript:alert(1)'] }, { name: 'x', phones: ['1', '2', '3', '4', '5', '6'].map(d => d.repeat(5)) }, { name: 'x', phones: 'no' }, { name: 'x', phones: ['--'] }])
    assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'contact', ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'nothing' })).status, 400);
  assert.equal((await call(g.member.cookie, '/api/circles')).json.find((x: any) => x.id === g.id).lastKind, 'contact');
});

test('location: the place is kept exactly as measured (to 6 decimals) with its accuracy; impossible coordinates are refused', async () => {
  const g = await group();
  const ok = await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'location', lat: 24.713551789, lng: 46.675295611, accuracy: 12.6, label: 'البيت' });
  assert.equal(ok.status, 201);
  assert.deepEqual((await messages(g.member, g.id)).find(x => x.id === ok.json.id).card, { type: 'location', lat: 24.713552, lng: 46.675296, accuracy: 13, label: 'البيت' });
  const bare = await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'location', lat: -33.86, lng: 151.21 });
  assert.deepEqual((await messages(g.owner, g.id)).find(x => x.id === bare.json.id).card, { type: 'location', lat: -33.86, lng: 151.21, accuracy: null, label: null });
  for (const bad of [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: '24.7', lng: '46.6' }, { lat: null, lng: 1 }, { lng: 1 }, { lat: NaN, lng: 1 }])
    assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', { type: 'location', ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await call(g.member.cookie, '/api/circles')).json.find((x: any) => x.id === g.id).lastKind, 'location');
});

test('cards obey the chat\'s rules: only admins send, a blocked chat, replies, no editing, no forwarding, and deleting erases the card', async () => {
  const g = await group();
  const loc = { type: 'location', lat: 24.7, lng: 46.6 };
  const first = await call(g.member.cookie, `/api/circles/${g.id}/cards`, 'POST', loc);
  const reply = await call(g.owner.cookie, `/api/circles/${g.id}/messages`, 'POST', { body: 'وين هذا؟', reply_to: first.json.id });
  const quoted = (await messages(g.owner, g.id)).find(x => x.id === reply.json.id).replyTo;
  assert.equal(quoted.card, 'location', 'a reply knows it quotes a location, though the card has no text');
  assert.equal((await call(g.member.cookie, `/api/messages/${first.json.id}`, 'PATCH', { body: 'نص' })).status, 403);
  assert.equal((await call(g.member.cookie, `/api/messages/${first.json.id}/forward`, 'POST', { circles: [g.id] })).status, 404);
  await call(g.member.cookie, `/api/messages/${first.json.id}`, 'DELETE');
  const gone = (await messages(g.owner, g.id)).find(x => x.id === first.json.id);
  assert.equal(gone.deleted, 1); assert.equal(gone.card, null);
  assert.equal(one('SELECT COUNT(*) AS n FROM message_cards WHERE message_id = ?', first.json.id)!.n, 0, 'the place itself is erased, not just hidden');

  await call(g.owner.cookie, `/api/circles/${g.id}`, 'PATCH', { sendPolicy: 'admins' });
  for (const body of [loc, { type: 'contact', name: 'x', phones: ['+966501234567'] }, { type: 'sticker', pack: 'faces', id: 'joy' }]) {
    const r = await call(g.member.cookie, `/api/circles/${g.id}/cards`, 'POST', body);
    assert.equal(r.status, 403); assert.equal(r.json.error, 'admins_only');
  }
  assert.equal((await call(g.owner.cookie, `/api/circles/${g.id}/cards`, 'POST', loc)).status, 201, 'an admin still can');
  const outsider = await person('غريب');
  assert.equal((await call(outsider.cookie, `/api/circles/${g.id}/cards`, 'POST', loc)).status, 404);

  const a = await person('أحمد'), b = await person('بدر');
  const shared = (await call(a.cookie, '/api/circles', 'POST', { name: 'مشتركة', kind: 'group' })).json.id as number;
  await call(b.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${shared}`)).json.inviteCode });
  const direct = (await call(a.cookie, '/api/direct', 'POST', { userId: b.id })).json.id as number;
  await call(b.cookie, `/api/users/${a.id}/block`, 'POST', {});
  assert.ok(one('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', b.id, a.id));
  const r = await call(a.cookie, `/api/circles/${direct}/cards`, 'POST', loc);
  assert.equal(r.status, 403); assert.equal(r.json.error, 'blocked');
  assert.equal((await form(a.cookie, `/api/circles/${direct}/voice`, [['audio', AUDIO, 'voice']])).status, 403, 'nor a voice note');
});

// ---- found by the independent review -------------------------------------------------------

test('review: a tiny compressed page that unpacks to a gigabyte is cut at the size limit, not unpacked', async () => {
  const bomb = zlib.brotliCompressSync(Buffer.alloc(200 * 1024 * 1024), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
  const gz = zlib.gzipSync(Buffer.alloc(100 * 1024 * 1024));
  const s = http.createServer((q, r) => { const br = q.url === '/br'; r.writeHead(200, { 'content-type': 'text/html', 'content-encoding': br ? 'br' : 'gzip' }); r.end(br ? bomb : gz); });
  extra.push(s);
  await new Promise<void>(res => s.listen(0, '127.0.0.1', () => res()));
  const at = (s.address() as any).port;
  for (const path of ['/br', '/gz']) {
    const t = Date.now();
    const res = await safeGet(new URL(`http://127.0.0.1:${at}${path}`), { maxBytes: 512 * 1024, allow: () => true });
    assert.ok(!res || res.body.length <= 512 * 1024, `${path}: at most the limit comes out`);
    assert.ok(Date.now() - t < 1500, `${path}: took ${Date.now() - t} ms`);
  }
});

test('review: a page made to choke the reader (thousands of unclosed tags) is read in a moment', () => {
  const base = new URL('https://example.com/');
  for (const html of ['<meta '.repeat(50_000), '<title>'.repeat(40_000), '<meta property="og:title" content="' + 'x'.repeat(290_000)]) {
    const t = Date.now();
    parsePreview(html, base);
    assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
  }
  assert.equal(parsePreview('<meta '.repeat(1000) + '<title>still read</title>', base)!.title, 'still read');
});

test('review: stored previews older than a week are thrown away with their pictures, unless a message still shows the picture', async () => {
  const g = await group();
  setPreviewFetcher(async u => ({ page: { title: u.pathname, description: '', site: 'x', image: null }, image: { buf: Buffer.concat([PNG_BYTES, Buffer.from(u.pathname)]), mime: 'image/png' } }));
  try {
    const old = (await call(g.owner.cookie, '/api/link-preview', 'POST', { url: 'https://old.example.com/gone' })).json.preview;
    const kept = (await call(g.owner.cookie, '/api/link-preview', 'POST', { url: 'https://old.example.com/kept' })).json.preview;
    const fresh = (await call(g.owner.cookie, '/api/link-preview', 'POST', { url: 'https://old.example.com/fresh' })).json.preview;
    const sent = await call(g.owner.cookie, `/api/circles/${g.id}/messages`, 'POST', { body: 'https://old.example.com/kept', preview: 'https://old.example.com/kept' });
    run("UPDATE link_previews SET fetched_at = ? WHERE url LIKE '%/gone' OR url LIKE '%/kept'", Date.now() - 8 * 24 * 3600_000);
    assert.equal(await purgeLinkPreviews(), 2);
    const pic = (hash: string) => Promise.resolve(app.request(`/api/link-preview/image/${hash}`, { headers: { cookie: g.owner.cookie } })).then(r => r.status);
    assert.equal(await pic(old.image), 404); assert.equal(await pic(fresh.image), 200);
    assert.equal(one('SELECT COUNT(*) AS n FROM blobs WHERE hash = ?', old.image)!.n, 0, 'the picture nobody shows is deleted');
    const m = (await messages(g.owner, g.id)).find(x => x.id === sent.json.id);
    assert.equal((await app.request(`/api/media/${m.card.image}`, { headers: { cookie: g.owner.cookie } })).status, 200, 'a sent message keeps its picture');
  } finally { setPreviewFetcher(null); }
});

test('review: the same attachment message arriving twice at the same moment is stored once, with its files once', async () => {
  const g = await group();
  const send = () => form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['file', new Blob([PNG_BYTES], { type: 'image/png' }), 'a.png'], ['client_msg_id', 'twice-1']]);
  const [a, b] = await Promise.all([send(), send()]);
  assert.equal(a.json.id, b.json.id);
  assert.equal(count(g.id), 1);
  assert.equal((await messages(g.owner, g.id)).find((x: any) => x.id === a.json.id).attachments.length, 1, 'one picture, not two');
});

test('review: cancelling while a piece is being written leaves no stray file behind', async () => {
  const g = await group();
  const file = bigPng(4 * 1024 * 1024);
  for (let i = 0; i < 5; i++) {
    const id = (await call(g.owner.cookie, `/api/circles/${g.id}/uploads`, 'POST', { name: 'a.png', size: file.length })).json.id as string;
    await Promise.all([put(g.owner.cookie, id, 0, file), call(g.owner.cookie, `/api/uploads/${id}`, 'DELETE')]);
    await new Promise(r => setTimeout(r, 30));
    assert.ok(!existsSync(join(process.env.THIKRA_BLOBS!, '.uploads', id)), 'no orphan');
  }
});

test('review: thumbnails of GIFs the server has not just listed are tightly limited, so guessing ids cannot use up the provider key', async () => {
  const p = await person('x');
  let lookups = 0;
  setGifProvider({ search: async () => [], byId: async () => { lookups++; return null; }, download: async () => null });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await app.request(`/api/gifs/guess${i}/preview`, { headers: { cookie: p.cookie } })).status);
    assert.ok(codes.includes(429)); assert.ok(lookups <= 20, `${lookups} lookups`);
  } finally { setGifProvider(null); }
});

/**
 * MED-05 (transfer policy) and MED-01 (voice) of the chat specification name these figures. They are the contract with
 * the client, not a preference, so they are asserted here: changing one by hand should fail until the document changes too.
 */
test('the transfer limits are exactly the ones the specification names', async () => {
  const MB = 1024 * 1024;
  const { MAX_FILES, MAX_IMAGE, MAX_OTHER } = await import('./lib/attachments.ts');
  const { MAX_AUDIO } = await import('./lib/moments.ts');
  assert.equal(MAX_IMAGE / MB, 20, 'an image: 20 MB');
  assert.equal(MAX_OTHER / MB, 100, 'a video or a document: 100 MB');
  assert.equal(MAX_AUDIO / MB, 25, 'a voice note: 25 MB');
  assert.equal(MAX_FILES, 20, 'twenty files in one message');
});

// ---- M-11 forwarding a file ------------------------------------------------------------------
// Forwarding used to be text only, which is the one thing a family does most: pass on a photo. The copy carries the
// same stored bytes (content-addressed, so the server keeps ONE copy however many chats it reaches).

test('forward carries the picture itself: same bytes stored once, thumbnail and caption travel, hop count grows', async () => {
  const g = await group();
  const other = (await call(g.owner.cookie, '/api/circles', 'POST', { name: 'الثانية', kind: 'group' })).json.id as number;
  const code = (await call(g.owner.cookie, `/api/circles/${other}`)).json.inviteCode as string;
  const far = await person('بدر');
  await call(far.cookie, '/api/circles/join', 'POST', { code });
  await call(g.member.cookie, '/api/circles/join', 'POST', { code });   // the one who passes the picture on is not the one who took it
  const sent = await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [
    ['file', new Blob([PNG_BYTES], { type: 'image/png' }), 'رحلة.png'],
    ['thumb', new Blob([PNG_BYTES], { type: 'image/png' }), 't.png'],
    ['caption', 'من الرحلة'], ['w', '1'], ['h', '1'],
  ]);
  assert.equal(sent.status, 201);
  const blobsBefore = one('SELECT COUNT(*) AS n FROM blobs')!.n as number;

  const res = await call(g.member.cookie, `/api/messages/${sent.json.id}/forward`, 'POST', { circles: [other] });
  assert.equal(res.status, 200);
  const fwd = (await messages(far, other)).find(x => x.id === res.json.sent[0]);
  assert.equal(fwd.body, 'من الرحلة', 'the caption goes with the picture');
  assert.equal(fwd.forwardCount, 1);
  assert.equal(fwd.attachments.length, 1);
  assert.equal(fwd.attachments[0].name, 'رحلة.png');
  assert.equal(fwd.attachments[0].size, PNG_BYTES.length);
  assert.ok(fwd.attachments[0].thumb, 'the small preview is copied too, so the list does not fetch the full picture');
  assert.notEqual(fwd.attachments[0].id, (await messages(g.owner, g.id)).find(x => x.id === sent.json.id).attachments[0].id, 'a copy of its own, not a pointer into the other chat');
  assert.equal(one('SELECT COUNT(*) AS n FROM blobs')!.n, blobsBefore, 'nothing is stored twice: the file is content-addressed');

  // Someone who was never in the first chat can open the forwarded file; and the first chat is untouched.
  const got = await app.request(`/api/media/${fwd.attachments[0].id}`, { headers: { cookie: far.cookie } });
  assert.equal(got.status, 200);
  assert.equal(Buffer.from(await got.arrayBuffer()).length, PNG_BYTES.length);
  assert.equal((await messages(g.owner, g.id)).filter(x => x.attachments?.length).length, 1, 'the original message is left alone');

  // A second hop says so, as WhatsApp does.
  const again = await call(far.cookie, `/api/messages/${fwd.id}/forward`, 'POST', { circles: [other] });
  assert.equal((await messages(far, other)).find(x => x.id === again.json.sent[0]).forwardCount, 2);
});

test('forward carries a voice note with its length and shape; a view-once photo is never forwardable', async () => {
  const g = await group();
  const other = (await call(g.owner.cookie, '/api/circles', 'POST', { name: 'الثالثة', kind: 'group' })).json.id as number;
  const voice = await form(g.owner.cookie, `/api/circles/${g.id}/voice`, [['audio', AUDIO, 'voice'], ['duration', '4200'], ['waveform', JSON.stringify([0, 50, 100, 25])]]);
  const res = await call(g.owner.cookie, `/api/messages/${voice.json.id}/forward`, 'POST', { circles: [other] });
  assert.equal(res.status, 200);
  const fwd = (await messages(g.owner, other)).find(x => x.id === res.json.sent[0]);
  assert.equal(fwd.kind, 'voice');
  assert.equal(fwd.audioMs, 4200);
  assert.deepEqual(fwd.waveform, [0, 50, 100, 25], 'the shape the sender\'s device measured travels with it');
  assert.equal(fwd.archiveStatus, 'none', 'a forwarded clip is somebody else\'s words from elsewhere: the archive agent never reads it');
  assert.equal((await app.request(`/api/messages/${fwd.id}/audio`, { headers: { cookie: g.owner.cookie } })).status, 200, 'and it plays');

  const once = await form(g.owner.cookie, `/api/circles/${g.id}/attachments`, [['file', new Blob([PNG_BYTES], { type: 'image/png' }), 'once.png'], ['view_once', '1']]);
  assert.equal(once.status, 201);
  assert.equal((await call(g.owner.cookie, `/api/messages/${once.json.id}/forward`, 'POST', { circles: [other] })).status, 404, 'a view-once picture cannot be passed on');
});
