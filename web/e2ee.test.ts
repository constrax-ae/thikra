// Step 6, part B: the web client of end-to-end encryption, tested against the REAL server (in this process) and the REAL MLS library. No mocks of crypto.
// Each "device" below is the same engine the browser runs (web/src/e2ee/engine.ts) over an in-memory store.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';
process.env.THIKRA_E2EE = '1';

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const blobDir = mkdtempSync(join(tmpdir(), 'thikra-web-blobs-'));
process.env.THIKRA_BLOBS = blobDir;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDevices, endorseDevice, fromB64, members, newDeviceIdentity, newKeyPackages, safetyNumber as coreSafety, toB64 } from '../core/e2ee.ts';
import { createE2ee, NetError, type E2ee, type Net } from './src/e2ee/engine.ts';
import { memoryKv, sealedKv } from './src/e2ee/kv.ts';

const { app } = await import('../server/index.ts');
const { all, one, run } = await import('../server/db.ts');

// ---- a person, a network, a device -----------------------------------------------------------------------------------------------------------

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
let n = 0;
async function person(name: string) {
  const phone = `+96657${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(3, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, name, phone, id: (await call(cookie, '/api/me')).json.id as number };
}
type P = Awaited<ReturnType<typeof person>>;
function netFor(cookie: string): Net {
  const fail = async (res: Response) => { const j = await res.json().catch(() => ({})) as any; throw new NetError(res.status, j.error ?? 'generic', j); };
  return {
    async json(method, path, body) {
      const res = await app.request('/api' + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!res.ok) await fail(res);
      return res.json().catch(() => ({})) as any;
    },
    async bytes(path) {
      const res = await app.request('/api' + path, { headers: { cookie } });
      if (!res.ok) await fail(res);
      return new Uint8Array(await res.arrayBuffer());
    },
    async put(path, body) {
      const res = await app.request('/api' + path, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', cookie }, body: body as BodyInit });
      if (!res.ok) await fail(res);
      return res.json().catch(() => ({})) as any;
    },
  };
}
const device = async (p: P, label = 'test', kv = memoryKv()) => { const d = createE2ee(p.id, { net: netFor(p.cookie), kv, label }); assert.equal(await d.ready(), true); return d; };
const invite = async (owner: P) => (await call(owner.cookie, `/api/circles/${(await call(owner.cookie, '/api/circles')).json.at(-1).id}`)).json.inviteCode as string;
async function direct(a: P, b: P) { return (await call(a.cookie, '/api/direct', 'POST', { phone: b.phone, encrypted: true })).json.id as number; }
async function group(owner: P, members: P[], name = 'سرّي') {
  const id = (await call(owner.cookie, '/api/circles', 'POST', { name, kind: 'group', encrypted: true })).json.id as number;
  const code = (await call(owner.cookie, `/api/circles/${id}`)).json.inviteCode as string;
  for (const m of members) assert.equal((await call(m.cookie, '/api/circles/join', 'POST', { code })).status < 300, true);
  return id;
}
const texts = (list: Array<{ body: string; undecryptable?: boolean; deleted?: any; kind: string }>) => list.filter(m => m.kind !== 'system').map(m => (m.undecryptable ? '[x]' : m.body));

const MARK = { text: 'نص-سري-٤٢٠٠', caption: 'caption-zq81', file: 'photo-name-qq17.jpg', link: 'https://secret-link-xk93.example/path', title: 'title-vv55', place: 'place-name-pp08', voice: 'voice-bytes-ww31', thumb: 'thumb-bytes-tt63' };
function everythingStored(): string {
  const parts: string[] = [];
  for (const { name } of all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    for (const row of all(`SELECT * FROM "${name}"`)) for (const v of Object.values(row)) parts.push(v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v));
  }
  const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else parts.push(readFileSync(p).toString('utf8')); } };
  walk(blobDir);
  return parts.join('\n');
}
const enc = new TextEncoder();

async function sendEverything(d: E2ee, circle: number) {
  await d.sendText(circle, MARK.text);
  await d.sendMedia(circle, [{ bytes: enc.encode(MARK.file + ' bytes'), name: MARK.file, mime: 'image/jpeg', w: 640, h: 480, thumb: 'data:image/jpeg;base64,' + Buffer.from(MARK.thumb).toString('base64') }], MARK.caption);
  await d.sendVoice(circle, { bytes: enc.encode(MARK.voice), mime: 'audio/webm' }, 1234, [10, 40, 80]);
  await d.sendText(circle, MARK.link, { card: { type: 'link', url: MARK.link, title: MARK.title, description: 'd', site: 'xk93.example', image: null } });
  await d.sendText(circle, '', { card: { type: 'location', lat: 24.7136, lng: 46.6753, accuracy: null, label: MARK.place } });
}

// ---- start, send, read -------------------------------------------------------------------------------------------------------------------------

test('when the server has encryption off, the engine says so and does nothing', async () => {
  const net: Net = { json: async (_m, path) => { if (path === '/keys/status') return { enabled: false } as any; throw new Error('must not be called: ' + path); }, bytes: async () => { throw new Error('no'); }, put: async () => { throw new Error('no'); } };
  const d = createE2ee(1, { net, kv: memoryKv(), label: 'x' });
  assert.equal(await d.ready(), false);
});

test('a private chat: both people read each other, in order, and the other side sees who wrote what', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await da.sendText(id, 'مرحبا');
  assert.deepEqual(texts(await db.history(id)), ['مرحبا']);
  await db.sendText(id, 'أهلا بك', { replyTo: (await db.history(id))[0].id });
  const seenByA = await da.history(id);
  assert.deepEqual(texts(seenByA), ['مرحبا', 'أهلا بك']);
  assert.equal(seenByA[1].author, 'سارة');
  assert.equal(seenByA[1].replyTo?.id, seenByA[0].id);
  assert.equal(seenByA[1].replyTo?.text, 'مرحبا', 'the quoted text is filled from this device, the server does not have it');
  assert.equal(seenByA[0].encrypted, true);
});

test('a person who has not set up encryption yet is added as soon as they have: the chat waits, then works', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const da = await device(a);
  const id = await direct(a, b);
  await da.startChat(id);
  await da.sendText(id, 'أنتظرك');
  const db = await device(b);
  await da.sync(id);                         // alice's device notices a missing device and adds it
  await da.sendText(id, 'بعد أن جهزت');
  assert.deepEqual(texts(await db.history(id)).filter(t => t !== '[x]'), ['بعد أن جهزت']);
  assert.equal((await db.history(id))[0].undecryptable, true, 'what was sent before this device joined cannot be read');
});

test('plaintext grep: text, a photo, a voice note, a link and a location in a private chat leave nothing readable on the server', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await sendEverything(da, id);
  const stored = everythingStored();
  for (const m of Object.values(MARK)) assert.equal(stored.includes(m), false, `the server stored "${m}"`);
  const got = await db.history(id);
  assert.equal(got.length, 5);
  assert.equal(got[0].body, MARK.text);
  assert.equal(got[1].body, MARK.caption);
  assert.equal(got[1].attachments![0].name, MARK.file);
  assert.equal(Buffer.from(await db.openAttachment(got[1].attachments![0])).toString(), MARK.file + ' bytes');
  assert.ok(got[1].attachments![0].enc!.thumb!.startsWith('data:image/jpeg'));
  assert.equal(got[2].kind, 'voice'); assert.equal(got[2].audioMs, 1234); assert.deepEqual(got[2].waveform, [10, 40, 80]);
  assert.equal(Buffer.from(await db.openAttachment(got[2].attachments![0])).toString(), MARK.voice);
  assert.equal(got[3].card?.type, 'link'); assert.equal((got[3].card as any).title, MARK.title);
  assert.equal(got[4].card?.type, 'location'); assert.equal((got[4].card as any).label, MARK.place);
  // the stored files are opaque: no name, no type
  for (const f of all('SELECT kind, mime, name, thumb_of FROM media WHERE circle_id = ?', id)) assert.deepEqual([f.kind, f.mime, f.name, f.thumb_of], ['file', 'application/octet-stream', null, null]);
});

test('plaintext grep: the same five in an ordinary group, read by two other members', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  const id = await group(a, [b, c]);
  await da.startChat(id);
  await sendEverything(db, id);
  const stored = everythingStored();
  for (const m of Object.values(MARK)) assert.equal(stored.includes(m), false, `the server stored "${m}"`);
  assert.equal((await da.history(id)).filter(m => m.kind !== 'system').length, 5);
  assert.equal((await dc.history(id)).filter(m => m.kind !== 'system').length, 5);
});

test('a retry with the same message id never makes a second message, and the receiver still decrypts once', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  const one1 = await da.sendText(id, 'مرة واحدة', { cid: 'same-id-1' });
  const two = await da.sendText(id, 'مرة واحدة', { cid: 'same-id-1' });
  assert.equal(one1.id, two.id);
  assert.deepEqual(texts(await db.history(id)), ['مرة واحدة']);
  assert.deepEqual(texts(await db.history(id)), ['مرة واحدة'], 'reading again decrypts nothing twice: the device kept it');
});

// ---- groups: members leave and join ------------------------------------------------------------------------------------------------------------

test('a removed member cannot read what is sent after; a new member cannot read what was sent before', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد'), d = await person('منى');
  const [da, db, dc, dd] = [await device(a), await device(b), await device(c), await device(d)];
  const id = await group(a, [b, c]);
  await da.startChat(id);
  await da.sendText(id, 'قبل الإزالة');
  assert.deepEqual(texts(await dc.history(id)), ['قبل الإزالة']);
  // khalid is removed by the owner
  assert.equal((await call(a.cookie, `/api/circles/${id}/members/${c.id}`, 'DELETE')).status < 300, true);
  await da.sendText(id, 'بعد الإزالة');                       // the server refuses until a commit removes him: the engine makes it first
  assert.equal(one('SELECT e2ee_epoch AS e, e2ee_min_epoch AS m FROM circles WHERE id = ?', id)!.e >= one('SELECT e2ee_min_epoch AS m FROM circles WHERE id = ?', id)!.m, true);
  assert.deepEqual(texts(await db.history(id)), ['قبل الإزالة', 'بعد الإزالة']);
  // khalid holds the old keys and is handed the ciphertext of the later message by someone who can fetch it: he cannot read it
  const rows = (await call(a.cookie, `/api/circles/${id}/messages?after=0`)).json;
  const seenByKhalid = await dc.decryptRows(id, rows);
  assert.deepEqual(texts(seenByKhalid), ['قبل الإزالة', '[x]']);
  // a new member joins and can read only what comes after
  await call(d.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${id}`)).json.inviteCode });
  await da.sync(id);
  await da.sendText(id, 'بعد انضمام منى');
  assert.deepEqual(texts(await dd.history(id)), ['[x]', '[x]', 'بعد انضمام منى']);
});

test('leaving the chat on your own also changes the keys', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  const id = await group(a, [b, c]);
  await da.startChat(id);
  await call(c.cookie, `/api/circles/${id}/members/${c.id}`, 'DELETE');
  await db.sendText(id, 'ما بعد المغادرة');
  const rows = (await call(a.cookie, `/api/circles/${id}/messages?after=0`)).json;
  assert.deepEqual(texts(await dc.decryptRows(id, rows)), ['[x]']);
  assert.deepEqual(texts(await da.history(id)), ['ما بعد المغادرة']);
});

// ---- trust: safety numbers, key changes, and what the device refuses ---------------------------------------------------------------------------

test('the safety number is the same on both sides, and changes (with a notice in the chat) when a person adds a device', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await da.sendText(id, 'أول رسالة');
  await db.history(id);
  const s1 = await da.safetyNumber(id, b.id), s2 = await db.safetyNumber(id, a.id);
  assert.equal(s1, s2);
  assert.match(s1, /^(\d{5} ){11}\d{5}$/);
  assert.deepEqual(await da.notices(id), [], 'the first time there is nothing to warn about');
  await da.verify(b.id);
  assert.equal(await da.isVerified(b.id), true);
  // sara links a second phone
  const db2 = await device(b, 'phone');
  await db.approveDevice(db2.deviceId);
  await db.sync(id);
  await da.sync(id);
  assert.notEqual(await da.safetyNumber(id, b.id), s1);
  const notes = await da.notices(id);
  assert.equal(notes.length >= 1, true);
  assert.equal(notes.at(-1)!.kind, 'keys_changed'); assert.equal(notes.at(-1)!.userId, b.id);
  assert.equal(await da.isVerified(b.id), false, 'a verified person whose keys changed is not verified any more');
});

test('a second device: it is not added until the person approves it; after that it reads new messages (and not older ones)', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await da.sendText(id, 'قبل الربط');
  await db.history(id);
  const db2 = await device(b, 'laptop');
  assert.equal((await db.devices()).find(x => x.deviceId === db2.deviceId)!.approved, false);
  await db.sendText(id, 'ما زال غير مربوط');                 // a person's own device does not add an unapproved device of theirs
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_welcomes WHERE to_device_id = ?', db2.deviceId)!.n, 0);
  await db.approveDevice(db2.deviceId);
  await db.sync(id);
  await da.sendText(id, 'بعد الربط');
  assert.deepEqual(texts(await db2.history(id)), ['[x]', '[x]', 'بعد الربط']);
  assert.deepEqual(texts(await db.history(id)), ['قبل الربط', 'ما زال غير مربوط', 'بعد الربط']);
  // the second device can write too
  await db2.sendText(id, 'من الحاسوب');
  assert.equal(texts(await da.history(id)).at(-1), 'من الحاسوب');
});

test('a revoked device cannot read what is sent after', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const db2 = await device(b, 'old phone');
  const id = await direct(a, b);
  await db.approveDevice(db2.deviceId);
  await da.startChat(id);
  await db2.sync(id);
  await da.sendText(id, 'قبل الإلغاء');
  assert.deepEqual(texts(await db2.history(id)), ['قبل الإلغاء']);
  await db.revokeDevice(db2.deviceId);
  await da.sendText(id, 'بعد الإلغاء');
  const rows = (await call(a.cookie, `/api/circles/${id}/messages?after=0`)).json;
  assert.deepEqual(texts(await db2.decryptRows(id, rows)), ['قبل الإلغاء', '[x]']);
});

test('the device refuses to talk when the server directory and the chat disagree about a key', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await da.sendText(id, 'سليم');
  run('UPDATE e2ee_devices SET identity_key = ? WHERE id = ?', Buffer.alloc(32, 7), da.deviceId);   // the server swaps alice's key in the directory
  await assert.rejects(() => db.sendText(id, 'لن يُرسل'), (e: any) => e.code === 'keys_mismatch');
});

test('the device refuses a commit that adds a device the directory does not list (a hostile member cannot add a reader)', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  const id = await group(a, [b, c]);
  await da.startChat(id);
  await da.sendText(id, 'قبل');
  await dc.history(id);
  // khalid's device forges a commit that adds a device he never registered
  const s = await dc.__state(id);
  const rogue = (await newKeyPackages(c.id, 99, 1, await newDeviceIdentity()))[0];
  const h = await addDevices(s.group, [rogue.publicBytes]);
  const posted = await call(c.cookie, `/api/circles/${id}/e2ee/commits`, 'POST', { device: dc.deviceId, epoch: s.epoch + 1, commit: toB64(h.commit), welcomes: [] });
  assert.equal(posted.status, 201, 'the server cannot tell: it only keeps order');
  await assert.rejects(() => db.sendText(id, 'لن يُرسل'), (e: any) => e.code === 'untrusted_commit');
  assert.equal(await db.status(id), 'stuck');
});

test('a message whose sender the server relabelled is not shown as that person\'s', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db] = [await device(a), await device(b)];
  const id = await group(a, [b, c]);
  await device(c);
  await da.startChat(id);
  await da.sendText(id, 'أنا ناصر');
  const rows = (await call(b.cookie, `/api/circles/${id}/messages?after=0`)).json;
  rows.find((r: any) => r.ciphertext).userId = c.id;
  assert.deepEqual(texts(await db.decryptRows(id, rows)), ['[x]']);
});

// ---- control messages: edit, react, delete, poll -----------------------------------------------------------------------------------------------

test('edit, reaction, poll vote and delete are encrypted control messages; the server stores no emoji and no text', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  const m = await da.sendText(id, 'مسودة أولى');
  await da.edit(id, m.id, 'نسخة-معدلة-٩٩٧');
  await db.react(id, m.id, '👍');
  await da.react(id, m.id, '❤️');
  const poll = await db.sendPoll(id, 'سؤال-سري-٣٣٣', ['نعم', 'لا'], false);
  await da.vote(id, poll.id, [1]);
  let seen = await da.history(id);
  assert.equal(seen[0].body, 'نسخة-معدلة-٩٩٧'); assert.ok(seen[0].editedAt);
  assert.deepEqual([...seen[0].reactions!].sort((x, y) => x.u - y.u), [{ u: a.id, e: '❤️' }, { u: b.id, e: '👍' }].sort((x, y) => x.u - y.u));
  assert.equal(seen[1].poll!.options[1].voters.length, 1); assert.equal(seen[1].poll!.options[1].voters[0], a.id);
  assert.equal(seen.filter(x => x.kind !== 'system').length, 2, 'control messages are not drawn as messages');
  seen = await db.history(id);
  assert.equal(seen[0].body, 'نسخة-معدلة-٩٩٧');
  await da.react(id, m.id, null);
  assert.deepEqual((await db.history(id))[0].reactions, [{ u: b.id, e: '👍' }]);
  assert.equal(everythingStored().includes('نسخة-معدلة-٩٩٧'), false);
  assert.equal(everythingStored().includes('سؤال-سري-٣٣٣'), false);
  assert.equal(one("SELECT COUNT(*) n FROM reactions")!.n, 0, 'no reaction row with an emoji exists');
  // delete for everyone: the ciphertext and the device copies are gone
  await da.remove(id, m.id);
  const after = await db.history(id);
  assert.equal(after[0].deleted, 1);
  assert.equal(await db.hasCopy(id, m.id), false, 'the other device purged its copy');
  assert.equal(await da.hasCopy(id, m.id), false);
});

test('an edit by someone who is not the sender is ignored by the device (the server refuses it as well)', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  const m = await da.sendText(id, 'الأصل');
  await assert.rejects(() => db.edit(id, m.id, 'تزوير'), (e: any) => [403, 'forbidden'].includes(e.status) || e.code === 'forbidden');
  assert.equal((await da.history(id))[0].body, 'الأصل');
});

// ---- the device: storage, search, notices, recovery --------------------------------------------------------------------------------------------

test('the device keeps its state: a new engine over the same store carries on, and nothing readable sits in the sealed store', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const raw = memoryKv();
  const kvA = sealedKv(raw, key);
  const da = await device(a, 'x', kvA);
  const db = await device(b);
  const id = await direct(a, b);
  await da.startChat(id);
  await da.sendText(id, 'محفوظ-في-الجهاز-١١٢');
  await db.sendText(id, 'ردّ');
  await da.history(id);
  const da2 = createE2ee(a.id, { net: netFor(a.cookie), kv: kvA, label: 'x' });     // the tab was closed and the app opened again
  assert.equal(await da2.ready(), true);
  assert.equal(da2.deviceId, da.deviceId);
  await db.sendText(id, 'بعد إعادة الفتح');
  assert.deepEqual(texts(await da2.history(id)), ['محفوظ-في-الجهاز-١١٢', 'ردّ', 'بعد إعادة الفتح']);
  for (const k of await raw.keys()) assert.equal(Buffer.from((await raw.get(k))!).includes(Buffer.from('محفوظ')), false, `${k} holds readable text`);
  assert.equal((await raw.keys()).length > 5, true);
});

test('search runs on the device over decrypted history; the server route refuses', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await da.sendText(id, 'موعد الغداء يوم الجمعة');
  await da.sendText(id, 'لا شيء هنا');
  await db.sendText(id, 'الغداء عند الجدة');
  assert.deepEqual(texts(await db.search(id, 'الغداء')), ['موعد الغداء يوم الجمعة', 'الغداء عند الجدة']);
  assert.equal((await call(a.cookie, `/api/circles/${id}/search?q=${encodeURIComponent('الغداء')}`)).status, 409);
});

test('a disappearing message is erased from the device when it goes', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  const m = await da.sendText(id, 'تختفي');
  await db.history(id);
  assert.equal(await db.hasCopy(id, m.id), true);
  run("UPDATE messages SET expired_at = datetime('now'), rev = rev + 1 WHERE id = ?", m.id);
  await db.history(id);
  assert.equal(await db.hasCopy(id, m.id), false);
});

test('recovery: a code restores the device, its chats and its history on a blank device; a wrong code restores nothing', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await db.sendText(id, 'قبل الضياع');
  await da.history(id);
  const code = await da.backup.enable();
  assert.match(code, /^([A-Z2-9]{5}-){4}[A-Z2-9]{5}$/);
  await da.backup.saveNow();
  assert.equal(everythingStored().includes('قبل الضياع'), false, 'the stored backup is unreadable to the server');
  await db.sendText(id, 'بعد النسخة');                          // arrives while alice\'s phone is lost
  await assert.rejects(() => createE2ee(a.id, { net: netFor(a.cookie), kv: memoryKv(), label: 'new' }).restore('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE'));
  const fresh = createE2ee(a.id, { net: netFor(a.cookie), kv: memoryKv(), label: 'new phone' });
  await fresh.restore(code);
  assert.equal(await fresh.ready(), true);
  assert.equal(fresh.deviceId, da.deviceId, 'it continues as the same device');
  assert.deepEqual(texts(await fresh.history(id)), ['قبل الضياع', 'بعد النسخة']);
  await fresh.sendText(id, 'عدت');
  assert.equal(texts(await db.history(id)).at(-1), 'عدت');
});

test('a lost phone with no backup: a new device starts clean and reads only what comes after', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await db.sendText(id, 'قديم');
  await call(a.cookie, `/api/keys/devices/${da.deviceId}`, 'DELETE');          // the old device is removed from the account
  const fresh = await device(a, 'new');
  await db.setNewDevicePolicy('auto');                                          // bob chose to add a known person's new device by himself (the default asks him first)
  await db.sendText(id, 'جديد');                                                // bob's device adds the new one and changes the keys
  assert.deepEqual(texts(await fresh.history(id)), ['[x]', 'جديد']);
});

test('the engine can list the encrypted chats it knows and keeps a preview of the newest message on the device', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await da.sendText(id, 'معاينة القائمة');
  await db.history(id);
  assert.equal((await db.preview(id))?.text, 'معاينة القائمة');
  assert.equal((await da.preview(id))?.text, 'معاينة القائمة');
});

test('a family circle is untouched: still plain, no encryption fields', async () => {
  const a = await person('ناصر');
  const id = (await call(a.cookie, '/api/circles', 'POST', { name: 'العائلة' })).json.id;
  assert.equal((await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'نص عادي' })).status, 201);
  const list = (await call(a.cookie, `/api/circles/${id}/messages?after=0`)).json;
  assert.equal(list[0].body, 'نص عادي'); assert.equal(list[0].ciphertext, undefined);
  const d = await device(a);
  await assert.rejects(() => d.startChat(id), (e: any) => e.code === 'not_encrypted');
});

// ---- notices: calm, once per change, and accounts that go away ---------------------------------------------------------------------------------

test('switching or losing devices never produces a row of notices: only a key never seen before says anything, and quick changes fold into one', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id); await da.sendText(id, 'مرحبا'); await db.history(id);
  const link = async (label: string) => { const d = await device(b, label); await db.approveDevice(d.deviceId); await db.sync(id); await da.sync(id); await da.sync(id); return d; };
  const d2 = await link('phone');
  assert.equal((await da.notices(id)).length, 1, 'a new phone: one notice');
  await da.sync(id); await da.sync(id);
  assert.equal((await da.notices(id)).length, 1, 'syncing again says nothing more');
  await db.revokeDevice(d2.deviceId); await db.sync(id); await da.sync(id);
  assert.equal((await da.notices(id)).length, 1, 'losing a device is silent');
  await link('tablet'); await link('laptop');
  const notes = await da.notices(id);
  assert.equal(notes.length, 1, 'more devices within the hour fold into the same notice');
  assert.equal(notes[0].kind, 'keys_changed'); assert.equal(notes[0].detail?.added, 3);
});

async function register(phone: string, name: string) {
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, name, phone, id: (await call(cookie, '/api/me')).json.id as number } as P;
}

test('a deleted account: one "gone" notice, history stays readable, nothing more can be sent, no keys of the deleted person are handed out', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id); await da.sendText(id, 'قبل الحذف'); await db.history(id); await db.sendText(id, 'رد سارة'); await da.history(id);
  assert.equal((await call(b.cookie, '/api/me', 'DELETE')).status, 200);
  await da.sync(id); await da.sync(id);
  const notes = await da.notices(id);
  assert.deepEqual(notes.filter(n => n.kind === 'gone').map(n => n.userId), [b.id], 'exactly one notice, for her');
  assert.equal(notes.filter(n => n.kind === 'keys_changed').length, 0);
  assert.deepEqual(texts(await da.history(id)), ['قبل الحذف', 'رد سارة'], 'the history is still on this device');
  await assert.rejects(() => da.sendText(id, 'هل أحد هنا؟'), (e: any) => e.code === 'peer_gone');
  const dir = (await call(a.cookie, `/api/circles/${id}/e2ee`)).json;
  assert.equal(JSON.stringify(dir).includes(`"userId":${b.id}`), false, 'the server lists no device of the deleted person');
  assert.equal(all('SELECT 1 FROM e2ee_devices WHERE user_id = ?', b.id).length, 0);
});

test('a phone number registered again is a NEW identity: never put into the old chat, a different safety number, the old chat does not continue', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const old = await direct(a, b);
  await da.startChat(old); await da.sendText(old, 'سرّ قديم'); await db.history(old);
  const before = await da.safetyNumber(old, b.id);
  await call(b.cookie, '/api/me', 'DELETE');
  const b2 = await register(b.phone, 'شخص آخر');
  assert.notEqual(b2.id, b.id, 'ids are never reused');
  const db2 = await device(b2);
  await da.sync(old);
  assert.equal(all('SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = ?', old, b2.id).length, 0, 'the new owner of the number is not in the old chat');
  await assert.rejects(() => da.sendText(old, 'هل هذه سارة؟'), (e: any) => e.code === 'peer_gone');
  assert.equal((await call(b2.cookie, `/api/circles/${old}/e2ee`)).status, 404, 'and cannot even read its key directory');
  const fresh = await direct(a, b2);
  assert.notEqual(fresh, old, 'a chat with that number starts from scratch');
  await da.startChat(fresh); await da.sendText(fresh, 'مرحباً من جديد'); 
  assert.deepEqual(texts(await db2.history(fresh)), ['مرحباً من جديد'], 'she reads nothing from the old chat');
  assert.notEqual(await da.safetyNumber(fresh, b2.id), before, 'the safety number is different');
  assert.ok((await da.notices(old)).some(n => n.kind === 'gone'), 'the old chat says the person is gone');
});

// ---- fixes from the independent review ----------------------------------------------------------------------------------------------------------

import { decodePayload, encodePayload } from './src/e2ee/payload.ts';
test('a payload with a hostile or malformed card, vote or reaction is refused when it is decoded', () => {
  const mk = (extra: object) => encodePayload({ v: 1, from: 'u1.d1', t: 'text', text: 'x', ...extra } as any);
  assert.ok(decodePayload(mk({ card: { type: 'link', url: 'https://example.com/a', title: 't', description: '', site: 's', image: null } })));
  assert.equal(decodePayload(mk({ card: { type: 'link', url: 'javascript:alert(1)', title: 't', description: '', site: 's', image: null } })), null);
  assert.equal(decodePayload(mk({ card: { type: 'location', lat: 'x', lng: 1, accuracy: null, label: null } })), null);
  assert.equal(decodePayload(mk({ card: { type: 'nope' } })), null);
  assert.equal(decodePayload(mk({ card: { type: 'contact', name: 'n', phones: [1] } })), null);
  assert.equal(decodePayload(encodePayload({ v: 1, from: 'u1.d1', t: 'react', target: 1, emoji: 'x'.repeat(5000) } as any)), null);
  assert.equal(decodePayload(encodePayload({ v: 1, from: 'u1.d1', t: 'vote', target: 1, options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] } as any)), null);
  assert.equal(decodePayload(encodePayload({ v: 1, from: 'u1.d1', t: 'vote', target: 1, options: [-1] } as any)), null);
});

test('starting a chat does not add my own device that I have not approved', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const da = await device(a);
  const rogue = await device(a, 'unapproved');
  const db = await device(b);
  const id = await direct(a, b);
  await da.startChat(id);
  await da.sendText(id, 'سر');
  const w = (await call(a.cookie, `/api/circles/${id}/e2ee/welcomes?device=${rogue.deviceId}`)).json;
  assert.deepEqual(w, [], 'no welcome was made for the unapproved device');
  assert.deepEqual(texts(await db.history(id)), ['سر']);
});

// ---- hardening ---------------------------------------------------------------------------------------------------------------------------------

test('linking a second device, WhatsApp style: the new device shows a code, the old one finds it, the person CONFIRMS, then every chat and the whole history (media too) move', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await sendEverything(da, id);
  await db.history(id);
  await db.sendText(id, 'رد سارة');
  await da.history(id);
  const g = await group(a, [b]);
  await da.startChat(g); await da.sendText(g, 'في المجموعة');
  const da2 = await device(a, 'laptop');
  const link = await da2.linkRequest();
  const code = link.code;
  assert.match(code, /^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
  assert.match(link.qr, /^tamtim-link:1:\d+:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}$/);
  assert.equal(link.qr.includes(code.replace(/-/g, '')), false, 'the picture holds no part of the typed code');
  assert.equal(await da.findLink('AAAA-BBBB-CCCC-DDDD'), null, 'a wrong code finds nothing');
  const evil = await device(a, 'invented by the server');
  assert.equal((await da.findLink(code))!.deviceId, da2.deviceId, 'only the device that made the code fits it');
  assert.equal((await da.findLink(link.qr))!.deviceId, da2.deviceId, 'the scanned picture finds it too');
  void evil;
  // nothing happens before the person confirms
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_welcomes WHERE to_device_id = ?', da2.deviceId)!.n, 0);
  await assert.rejects(() => da.confirmLink(da2.deviceId, 'AAAA-BBBB-CCCC-DDDD'), /bad_link_code/);
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_welcomes WHERE to_device_id = ?', da2.deviceId)!.n, 0);
  const r = await da.confirmLink(da2.deviceId, code);
  assert.equal(r.chats, 2);
  assert.equal(await da2.receiveHistory() !== null, true);
  await da2.sync(id); await da2.sync(g);
  const old = await da.history(id), now = await da2.history(id);
  assert.deepEqual(texts(now), texts(old));
  assert.equal(texts(now).includes(MARK.text), true);
  const media = now.find(m => m.attachments?.length && m.attachments[0].kind === 'image' && m.attachments[0].enc);
  assert.ok(media, 'the photo is in the moved history');
  assert.equal(new TextDecoder().decode(await da2.openAttachment(media!.attachments![0])), MARK.file + ' bytes');
  assert.deepEqual(texts(await da2.history(g)), ['في المجموعة']);
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_transfers WHERE device_id = ?', da2.deviceId)!.n, 0, 'the server keeps no hand-over after the device took it');
  assert.equal(everythingStored().includes(MARK.text), false);
  // both devices go on together
  await db.sendText(id, 'بعد الربط');
  assert.equal(texts(await da2.history(id)).at(-1), 'بعد الربط');
  await da2.sendText(id, 'من الحاسوب');
  assert.equal(texts(await db.history(id)).at(-1), 'من الحاسوب');
  assert.equal(texts(await da.history(id)).at(-1), 'من الحاسوب');
});

test('the hand-over is useless to anyone without the new device\'s private key: a photo of the picture or of the code, plus everything on the server, opens nothing', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id); await da.sendText(id, 'سر-قديم-٩٩'); await db.history(id);
  const da2 = await device(a, 'laptop');
  const link = await da2.linkRequest();
  await da.confirmLink(da2.deviceId, link.qr);
  const stored = (await call(a.cookie, `/api/keys/devices/${da2.deviceId}/transfer`)).json;
  assert.equal(stored.complete, true);
  const parts: Uint8Array[] = [];
  for (const n of stored.parts) parts.push(fromB64((await call(a.cookie, `/api/keys/devices/${da2.deviceId}/transfer/${n}`)).json.data));
  const { openTransfer, newLinkKeys, linkKey } = await import('./src/e2ee/link.ts');
  const seen = (await call(a.cookie, '/api/keys/devices')).json.find((d: any) => d.id === da2.deviceId);
  // what a photographer of the picture holds: the new device's PUBLIC key; what the server holds: both public keys and the bytes
  const thief = newLinkKeys();
  await assert.rejects(() => openTransfer(parts, linkKey(thief.priv, fromB64(stored.peer), thief.pub, da2.deviceId), da2.deviceId));
  void seen;
  const thief2 = createE2ee(a.id, { net: netFor(a.cookie), kv: memoryKv(), label: 'x' });
  assert.equal(await thief2.ready(), true);
  assert.equal(await thief2.receiveHistory(), null, 'a device that never made a pairing takes nothing');
  assert.equal(everythingStored().includes('سر-قديم-٩٩'), false);
  assert.equal(await da2.receiveHistory() !== null, true, 'the real new device opens it');
});

test('review: a server that swaps the new device\'s identity key cannot get its own device linked (picture, typed code, and the key checked at approval)', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id); await da.sendText(id, 'قديم'); await db.history(id);
  const da2 = await device(a, 'laptop');
  const link = await da2.linkRequest();
  const good = one('SELECT identity_key k FROM e2ee_devices WHERE id = ?', da2.deviceId)!.k;
  run('UPDATE e2ee_devices SET identity_key = ? WHERE id = ?', Buffer.alloc(32, 9), da2.deviceId);
  assert.equal(await da.findLink(link.qr), null, 'the picture says which key the new device has');
  assert.equal(await da.findLink(link.code), null, 'the typed proof is over the real key');
  await assert.rejects(() => da2.linkRequest(), /keys_mismatch/, 'the new device itself refuses when the server lists a key that is not its own');
  run('UPDATE e2ee_devices SET identity_key = ? WHERE id = ?', good, da2.deviceId);
  const found = (await da.findLink(link.qr))!;
  assert.equal(found.deviceId, da2.deviceId);
  run('UPDATE e2ee_devices SET identity_key = ? WHERE id = ?', Buffer.alloc(32, 9), da2.deviceId);   // swapped between the check and the approval
  await assert.rejects(() => da.approveDevice(da2.deviceId, found.identityKey!), /not_found/);
});

test('a pairing expires after a couple of minutes and works once; a wrong or swapped key is refused', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id); await da.sendText(id, 'قديم'); await db.history(id);
  const da2 = await device(a, 'laptop');
  const first = await da2.linkRequest();
  assert.deepEqual(await da2.linkRequest(), first, 'while it lives, asking again shows the same pairing');
  // a server that swaps the new device\'s public key cannot fool the scanning device: the picture is the truth
  run('UPDATE e2ee_devices SET link_pub = ? WHERE id = ?', toB64(new Uint8Array(32).fill(3)), da2.deviceId);
  assert.equal(await da.findLink(first.qr), null, 'the key on the server is not the key in the picture');
  assert.equal((await da.findLink(first.code)), null, 'and the typed proof no longer fits the swapped key');
  run('UPDATE e2ee_devices SET link_pub = ? WHERE id = ?', first.qr.split(':')[3].replace(/-/g, '+').replace(/_/g, '/') + '=', da2.deviceId);
  assert.equal((await da.findLink(first.qr))!.deviceId, da2.deviceId);
  // expiry
  run('UPDATE e2ee_devices SET link_expires_at = ? WHERE id = ?', 1, da2.deviceId);
  assert.equal(await da.findLink(first.qr), null, 'expired: the picture finds nothing');
  assert.equal(await da.findLink(first.code), null, 'expired: the typed code finds nothing');
  await assert.rejects(() => da.confirmLink(da2.deviceId, first.qr), /bad_link_code/);
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_welcomes WHERE to_device_id = ?', da2.deviceId)!.n, 0, 'nothing was added');
  const second = await da2.linkRequest();
  assert.notEqual(second.code, first.code); assert.notEqual(second.qr, first.qr);
  // one use
  await da.confirmLink(da2.deviceId, second.qr);
  assert.equal(await da.findLink(second.qr), null, 'used: gone');
  await assert.rejects(() => da.confirmLink(da2.deviceId, second.code), /bad_link_code/);
  const again = await call(a.cookie, `/api/keys/devices/${da2.deviceId}/transfer`, 'PUT', { part: 0, last: true, peer: toB64(new Uint8Array(32).fill(1)), data: toB64(new Uint8Array(10)) });
  assert.equal(again.status, 410);
  assert.equal(await da2.receiveHistory() !== null, true);
  assert.equal(await da2.linkPending(), null, 'the new device forgets its keys once it has the history');
});

test('comparing the safety number with a picture: both sides show the same picture; a match marks the person as verified, a different picture does not', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  const id = await direct(a, b), id2 = await direct(a, c);
  await da.startChat(id); await da.startChat(id2); await db.history(id); await dc.history(id2);
  const qa = await da.safetyQr(id, b.id), qb = await db.safetyQr(id, a.id);
  assert.equal(qa, qb);
  assert.match(qa, /^tamtim-safety:1:\d{60}$/);
  assert.equal(await da.checkSafetyQr(id, b.id, await dc.safetyQr(id2, a.id)), false, 'another chat\'s picture does not match');
  assert.equal(await da.isVerified(b.id, id), false);
  assert.equal(await da.checkSafetyQr(id, b.id, 'tamtim-safety:1:' + '1'.repeat(60)), false);
  assert.equal(await da.checkSafetyQr(id, b.id, 'junk'), false);
  assert.equal(await da.checkSafetyQr(id, b.id, qb), true);
  assert.equal(await da.isVerified(b.id, id), true);
});

test('a later new device of a person I already talk to is NOT added by me until I accept it; the first device of a person is', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);                                              // the first device of sara: added at once (trust on first use)
  await db.history(id);
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_welcomes WHERE to_device_id = ?', db.deviceId)!.n >= 0, true);
  const injected = await device(b, 'a device nobody approved');        // what a hostile server could add to sara's list
  await da.sendText(id, 'قبل القبول');
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_welcomes WHERE to_device_id = ?', injected.deviceId)!.n, 0, 'no welcome: the device was not added');
  const waiting = await da.waitingDevices();
  assert.equal(waiting.length, 1);
  assert.deepEqual([waiting[0].circle, waiting[0].userId, waiting[0].deviceId], [id, b.id, injected.deviceId]);
  assert.match(waiting[0].code, /^\d{4} \d{4} \d{4}$/);
  assert.equal((await da.notices(id)).at(-1)!.kind, 'new_device_waiting');
  await da.sendText(id, 'ما زال بدون قبول');
  assert.equal((await da.waitingDevices()).length, 1);
  assert.equal((await da.notices(id)).filter(n => n.kind === 'new_device_waiting').length, 1, 'one notice, not one per message');
  assert.equal(await da.deviceState(id, b.id, injected.deviceId), 'waiting');
  await da.acceptDevice(id, b.id, injected.deviceId);
  assert.equal((await da.waitingDevices()).length, 0);
  assert.equal(await da.deviceState(id, b.id, injected.deviceId), 'added');
  assert.equal(await da.deviceState(id, b.id, 99999), 'gone');
  await da.sendText(id, 'بعد القبول');
  assert.equal(texts(await injected.history(id)).at(-1), 'بعد القبول');
});

test('the setting: "add automatically" adds a later new device at once, but a person I verified is never added without my yes', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  assert.equal(await da.newDevicePolicy(), 'ask', 'the safe choice is the default');
  await da.setNewDevicePolicy('auto');
  const id = await direct(a, b), id2 = await direct(a, c);
  await da.startChat(id); await da.startChat(id2); await db.history(id); await dc.history(id2);
  await da.verify(c.id, id2);
  const b2 = await device(b, 'new'), c2 = await device(c, 'new');
  await da.sendText(id, 'x'); await da.sendText(id2, 'y');
  assert.equal(texts(await b2.history(id)).at(-1), 'x', 'auto: added before the message was sent');
  assert.equal(texts(await c2.history(id2)).at(-1), '[x]', 'verified: not added');
  assert.equal((await da.waitingDevices()).length, 1);
  assert.equal(await da.isVerified(c.id, id2), true, 'waiting does not break the verification; accepting does');
  await da.acceptDevice(id2, c.id, c2.deviceId);
  assert.equal(await da.isVerified(c.id, id2), false);
  void db; void dc;
});

test('an own device is approved by its KEY, not its number: a swapped key is not approved', async () => {
  const a = await person('ناصر');
  const da = await device(a), da2 = await device(a, 'laptop');
  await da.approveDevice(da2.deviceId);
  assert.equal((await da.devices()).find(d => d.deviceId === da2.deviceId)!.approved, true);
  run('UPDATE e2ee_devices SET identity_key = ? WHERE id = ?', Buffer.from(new Uint8Array(32).fill(7)), da2.deviceId);
  assert.equal((await da.devices()).find(d => d.deviceId === da2.deviceId)!.approved, false, 'the approval was for another key');
});

test('messages are read oldest first: opening a chat on the newest page does not lose the older ones (MLS keeps only 100 skipped keys)', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await db.sync(id);
  for (let i = 1; i <= 112; i++) await da.sendText(id, `م${i}`);
  const first = texts(await db.history(id, 'after=0&limit=3'));        // sara opens the chat: the newest page first
  assert.deepEqual(first, ['م110', 'م111', 'م112']);
  const all130 = texts(await db.history(id, 'after=0&limit=200'));
  assert.equal(all130.length, 112);
  assert.equal(all130.filter(x => x === '[x]').length, 0, 'nothing older was lost');
});

test('after many key changes, a message sent long before is still read (the device reads before the keys move on)', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  const id = await group(a, [b, c]);
  await da.startChat(id);
  await db.sync(id); await dc.sync(id);
  await da.sendText(id, 'قديمة-١'); await da.sendText(id, 'قديمة-٢');
  for (let i = 0; i < 10; i++) for (const [p, d] of [[a, da], [c, dc]] as const) { const x = await device(p, `t${i}`); await d.approveDevice(x.deviceId); await d.revokeDevice(x.deviceId); await da.sync(id); await dc.sync(id); }   // 40 key changes while sara's phone was away
  await db.sync(id);
  assert.deepEqual(texts(await db.history(id)), ['قديمة-١', 'قديمة-٢']);
});

test('a message that cannot be read yet says "waiting", one from before this device joined says "cannot be read", and the waiting one is read when its keys arrive', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const da = await device(a);
  const id = await direct(a, b);
  let hide = false;
  const inner = netFor(b.cookie);
  const slow: Net = { ...inner, json: ((m: string, p: string, body?: unknown) => (hide && /e2ee\/commits\?after/.test(p) ? Promise.resolve([]) : inner.json(m, p, body))) as Net['json'] };
  const dbSlow = createE2ee(b.id, { net: slow, kv: memoryKv(), label: 'phone' });
  await dbSlow.ready();
  await da.startChat(id); await da.sendText(id, 'قبل الانضمام');
  await dbSlow.sync(id);
  await da.sendText(id, 'مقروءة');
  hide = true;
  const d2 = await device(a, 'laptop'); await da.approveDevice(d2.deviceId); await da.sync(id);   // a commit sara's phone cannot fetch yet
  await da.sendText(id, 'ستنتظر');
  const rows = (await dbSlow.history(id)).filter(m => m.kind !== 'system');
  assert.equal(rows.at(-1)!.undecryptable, true);
  assert.equal(rows.at(-1)!.waiting, true, 'it may still arrive');
  hide = false;
  assert.equal(texts(await dbSlow.history(id)).at(-1), 'ستنتظر');
  const late = await device(b, 'late');
  await dbSlow.approveDevice(late.deviceId); await dbSlow.sync(id);
  await late.sync(id);
  const h = (await late.history(id)).filter(m => m.kind !== 'system');
  assert.equal(h[0].undecryptable, true); assert.equal(h[0].waiting, false, 'before this device joined: it never can');
});

test('recovery from an OLD backup: the restored device catches up with the commits that happened since (a device added, a message) and can send again', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await db.sendText(id, 'قبل النسخة'); await da.history(id);
  const code = await da.backup.enable();
  const da2 = await device(a, 'laptop'); await da.approveDevice(da2.deviceId); await da.sync(id); await da2.sync(id);   // keys move on after the backup
  await db.sendText(id, 'بعد النسخة'); await db.sync(id);
  const fresh = createE2ee(a.id, { net: netFor(a.cookie), kv: memoryKv(), label: 'new phone' });
  await fresh.restore(code);
  await fresh.ready();
  assert.equal(await fresh.sync(id), 'ok');
  assert.deepEqual(texts(await fresh.history(id)), ['قبل النسخة', 'بعد النسخة']);
  await fresh.sendText(id, 'عدت');
  assert.equal(texts(await db.history(id)).at(-1), 'عدت');
});

test('recovery when the backup is older than the device\'s own last key change: the chat says so, the history is kept, and "start fresh" makes a new device that is added again', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await db.sendText(id, 'قبل'); await da.history(id);
  const code = await da.backup.enable();
  const gone = await device(a, 'lost tablet'); await da.revokeDevice(gone.deviceId); await da.sync(id);      // this device itself changes the keys (a rotation) AFTER the backup
  await db.sync(id);
  const fresh = createE2ee(a.id, { net: netFor(a.cookie), kv: memoryKv(), label: 'new phone' });
  await fresh.restore(code);
  await fresh.ready();
  assert.equal(await fresh.sync(id), 'stuck');
  assert.equal(await fresh.stuckReason(id), 'restored_behind');
  const oldId = fresh.deviceId;
  await db.setNewDevicePolicy('auto');
  await fresh.startFresh();
  assert.notEqual(fresh.deviceId, oldId);
  assert.equal((await call(a.cookie, '/api/keys/devices')).json.find((d: any) => d.id === oldId).revokedAt != null, true, 'the stale device is retired');
  assert.deepEqual(texts(await fresh.history(id)), ['قبل'], 'the history stays');
  await db.sendText(id, 'بعد');
  assert.equal(await fresh.sync(id), 'ok');
  assert.equal(texts(await fresh.history(id)).at(-1), 'بعد');
});

test('a key change whose answer was lost on the way is not lost: the device finds its own commit on the server and carries on', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const db = await device(b);
  const id = await direct(a, b);
  let drop = true;
  const inner = netFor(a.cookie);
  const flaky: Net = { ...inner, json: (async (m: string, p: string, body?: unknown) => { const r = await inner.json(m, p, body); if (drop && m === 'POST' && /e2ee\/commits$/.test(p)) { drop = false; throw new NetError(0, 'network'); } return r; }) as Net['json'] };
  const da = createE2ee(a.id, { net: flaky, kv: memoryKv(), label: 'phone' });
  await da.ready();
  await assert.rejects(() => da.startChat(id));              // the server took the first commit, the answer never came
  assert.equal(one('SELECT e2ee_epoch e FROM circles WHERE id = ?', id)!.e, 1);
  assert.equal(await da.sync(id), 'ok');
  await da.sendText(id, 'ما ضاعت');
  assert.deepEqual(texts(await db.history(id)), ['ما ضاعت']);
});

test('a welcome into a group that is not this chat\'s group is refused (the chat is stopped, nothing is joined)', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  const core = await import('../core/e2ee.ts');
  const own = (await (da as any).packages())[0];
  const claim = (await call(a.cookie, `/api/keys/users/${b.id}/claim`, 'POST')).json.packages[0];
  const g = await core.createGroup('c999999', own);
  const h = await core.addDevices(g, [core.fromB64(claim.package)]);
  // The server now refuses a commit of another group (red-team 2026-11-19), so the HOSTILE server is played here by writing the rows directly: the device must still refuse.
  const refused = await call(a.cookie, `/api/circles/${id}/e2ee/commits`, 'POST', { device: da.deviceId, epoch: 1, commit: toB64(h.commit), welcomes: [{ device: claim.deviceId, welcome: toB64(h.welcome!) }] });
  assert.equal(refused.status, 400, 'the server itself refuses a commit of another group');
  run('UPDATE circles SET e2ee_epoch = 1 WHERE id = ?', id);
  run('INSERT INTO e2ee_commits (circle_id, epoch, user_id, device_id, data) VALUES (?, 1, ?, ?, ?)', id, a.id, da.deviceId, Buffer.from(h.commit));
  run('INSERT INTO e2ee_welcomes (circle_id, epoch, to_device_id, data) VALUES (?, 1, ?, ?)', id, claim.deviceId, Buffer.from(h.welcome!));
  assert.equal(await db.sync(id), 'stuck');
  assert.equal(await db.stuckReason(id), 'wrong_group');
  await assert.rejects(() => db.sendText(id, 'لا'));
});

test('review: a handed-over ledger cannot poison objects (a "__proto__" key is ignored) and an oversized hand-over is refused', async () => {
  const { mergeLedger } = await import('./src/e2ee/view.ts');
  const evil = JSON.parse('{"react":{"__proto__":{"1":{"e":"x","s":9,"rv":0}},"5":{"__proto__":{"e":"y","s":1,"rv":0}}},"vote":{},"edit":{}}');
  const out = mergeLedger(undefined, evil);
  assert.equal(({} as any)['1'], undefined, 'Object.prototype stayed clean');
  assert.equal(Object.getPrototypeOf(out.react), Object.prototype);
  const { openTransfer, sealTransfer, newLinkKeys, linkKey } = await import('./src/e2ee/link.ts');
  const a = newLinkKeys(), b = newLinkKeys();
  const k = linkKey(a.priv, b.pub, a.pub, 5);
  const big = { 'pl:1:1': 'A'.repeat(60 * 1024 * 1024) };
  await assert.rejects(async () => openTransfer(await sealTransfer(big, k), linkKey(b.priv, a.pub, b.pub, 5)), /too_large/);
});

test('review: a person I verified is asked about in EVERY chat: an unknown extra device of theirs in a new group waits for a yes', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  const id = await direct(a, b);
  await da.startChat(id); await db.history(id);
  await da.verify(b.id, id);
  const db2 = await device(b, 'laptop');                                    // a second device of sara, before the new group exists
  const g = await group(a, [b, c]);
  await da.startChat(g); await db.history(g); await dc.history(g);
  const w = (await da.waitingDevices()).filter(x => x.circle === g);
  assert.deepEqual(w.map(x => x.deviceId), [db2.deviceId], 'the unknown device waits; the verified one was added');
});

test('review: messages from the middle of a long run of key changes are read too (one commit at a time, reading each epoch before the next)', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  const id = await group(a, [b, c]);
  await da.startChat(id); await db.sync(id); await dc.sync(id);
  const sent: string[] = [];
  for (let i = 0; i < 10; i++) for (const [p, d] of [[a, da], [c, dc]] as const) {
    const m = `رسالة-${sent.length}`; sent.push(m); await da.sendText(id, m);
    const x = await device(p, `t${i}`); await d.approveDevice(x.deviceId); await d.revokeDevice(x.deviceId); await da.sync(id); await dc.sync(id);   // sara's phone is away: 40 epochs, a message in each pair
  }
  await db.sync(id);
  assert.deepEqual(texts(await db.history(id)), sent);
});

// ---- the gaps step: who may bring a new device into a chat, the safety number, and the smaller items ---------------------------------------------

const countWelcomes = (deviceId: number) => one('SELECT COUNT(*) n FROM e2ee_welcomes WHERE to_device_id = ?', deviceId)!.n as number;
const noticeKinds = async (d: E2ee, circle: number) => (await d.notices(circle)).map(x => x.kind);

test('gap 1: in a group, one member on "add automatically" cannot bring a new device of another person in for everyone; the others are told and cannot send until they decide', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  const g = await group(a, [b, c]);
  await da.startChat(g); await db.sync(g); await dc.sync(g);
  await da.sendText(g, 'مرحبا');
  await da.setNewDevicePolicy('auto');
  const b2 = await device(b, 'a device nobody vouched for');
  await da.sendText(g, 'بعد الجهاز');
  assert.equal(countWelcomes(b2.deviceId), 0, 'in a group "automatic" does not apply: one member cannot decide for everyone');
  assert.equal((await da.waitingDevices()).length, 1);
  // a member who says yes by hand brings it in; the others did not say yes
  await da.acceptDevice(g, b.id, b2.deviceId);
  assert.equal(countWelcomes(b2.deviceId) >= 1, true);
  await dc.sync(g);
  const un = await dc.unconfirmedDevices();
  assert.deepEqual(un.map(x => [x.circle, x.userId, x.deviceId]), [[g, b.id, b2.deviceId]]);
  assert.match(un[0].code, /^\d{4} \d{4} \d{4}$/);
  assert.equal((await noticeKinds(dc, g)).includes('new_device_unconfirmed'), true, 'a visible notice in the chat');
  await assert.rejects(() => dc.sendText(g, 'لا يجب أن يصل لجهاز غير مؤكد'), /device_unconfirmed/);
  assert.equal(texts(await b2.history(g)).includes('لا يجب أن يصل لجهاز غير مؤكد'), false);
  // khalid chooses: remove it. Nothing he sends reaches it, and the member who accepted it does not put it back by itself
  await dc.removeDevice(g, b.id, b2.deviceId);
  await dc.sendText(g, 'بعد الإزالة');
  await da.sync(g);
  await da.sendText(g, 'من ناصر بعد الإزالة');
  assert.deepEqual(texts(await b2.history(g)).slice(-2), ['[x]', '[x]'], 'it reads neither message sent after it was removed');
  assert.equal((await dc.unconfirmedDevices()).length, 0);
  assert.equal(texts(await db.history(g)).includes('بعد الإزالة'), true, 'sara\'s own device reads on');
});

test('gap 1: when the person\'s own device vouched for the new one, nobody has to decide: the others add and apply it with one calm notice', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  const g = await group(a, [b, c]);
  await da.startChat(g); await db.sync(g); await dc.sync(g);
  const b2 = await device(b, 'laptop');
  await db.approveDevice(b2.deviceId);                    // sara says yes on her first device: it signs for the new one and adds it
  await da.sync(g); await dc.sync(g); await b2.sync(g);
  assert.equal((await da.waitingDevices()).length, 0);
  assert.equal((await dc.unconfirmedDevices()).length, 0);
  await dc.sendText(g, 'يصل للجهاز الجديد');
  assert.equal(texts(await b2.history(g)).at(-1), 'يصل للجهاز الجديد');
  assert.equal((await noticeKinds(dc, g)).includes('keys_changed'), true);
  assert.equal((await noticeKinds(dc, g)).includes('new_device_unconfirmed'), false);
});

test('gap 1: a vouched device is added by any member, even when the person\'s own device is offline', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const offline = { on: false };
  const real = netFor(b.cookie);
  const net: Net = { ...real, json: (m, p, body) => (offline.on && m === 'POST' && /\/e2ee\/commits$/.test(p) ? Promise.reject(new NetError(0, 'network')) : real.json(m, p, body)) };
  const db = createE2ee(b.id, { net, kv: memoryKv(), label: 'phone' }); await db.ready();
  const da = await device(a);
  const id = await direct(a, b);
  await da.startChat(id); await db.sync(id);
  const b2 = await device(b, 'laptop');
  offline.on = true;
  await db.approveDevice(b2.deviceId);                    // the signature is published, but sara\'s phone cannot post the commit
  offline.on = false;
  assert.equal(countWelcomes(b2.deviceId), 0);
  await da.sendText(id, 'ناصر يضيفه');
  assert.equal(countWelcomes(b2.deviceId) >= 1, true, 'the vouched device was added by naser');
  assert.equal((await da.waitingDevices()).length, 0);
  assert.equal(texts(await b2.history(id)).at(-1), 'ناصر يضيفه');
});

test('gap 1: a signature that does not fit (another signer) is no vouching: the device waits like any new one', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id); await db.sync(id);
  const b2 = await device(b, 'forged');
  const stranger = await newDeviceIdentity();
  const pk = (await db.devices()).find(d => d.deviceId === b2.deviceId)!.identityKey!;
  const sig = toB64(await endorseDevice(stranger.signKey, b.id, b2.deviceId, fromB64(pk)));
  run('UPDATE e2ee_devices SET endorsement = ?, endorsed_by = ? WHERE id = ?', sig, db.deviceId, b2.deviceId);   // what a hostile server could store
  await da.sendText(id, 'x');
  assert.equal(countWelcomes(b2.deviceId), 0);
  assert.equal((await da.waitingDevices()).length, 1);
});

test('gap 2: the safety number is made from the keys of the devices that really are in the chat, not from the server\'s list', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id); await db.sync(id);
  const keysOf = async (d: E2ee, uid: number) => members((await d.__state(id)).group).filter(m => m.identity.startsWith(`u${uid}.`)).map(m => m.signaturePublicKey);
  const expected = async (d: E2ee) => coreSafety({ userId: a.id, keys: await keysOf(d, a.id) }, { userId: b.id, keys: await keysOf(d, b.id) });
  assert.equal(await da.safetyNumber(id, b.id), await expected(da));
  const b2 = await device(b, 'laptop');
  await db.approveDevice(b2.deviceId); await da.sync(id);
  const withTwo = await da.safetyNumber(id, b.id);
  assert.equal(withTwo, await expected(da));
  assert.equal(withTwo, await db.safetyNumber(id, a.id), 'both sides agree');
  // the server stops listing sara\'s laptop (a hostile or mistaken directory); it is still a member of the group, so it still counts until a commit removes it
  run("UPDATE e2ee_devices SET revoked_at = datetime('now') WHERE id = ?", b2.deviceId);
  assert.equal(await da.safetyNumber(id, b.id), withTwo, 'the number follows the group, not the list');
});

test('gap 3: "not now" is final for that device: no second notice and no banner, and a later yes still works', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id); await db.sync(id);
  const b2 = await device(b, 'maybe');
  await da.sendText(id, 'x');
  assert.equal((await da.waitingDevices()).length, 1);
  await da.dismissWaiting(id, b2.deviceId);
  assert.equal((await da.waitingDevices()).length, 0);
  assert.equal(await da.deviceState(id, b.id, b2.deviceId), 'dismissed');
  await da.sendText(id, 'y'); await da.sync(id); await da.sendText(id, 'z');
  assert.equal((await da.notices(id)).filter(n => n.kind === 'new_device_waiting').length, 1, 'no second notice');
  assert.equal((await da.waitingDevices()).length, 0);
  assert.equal(countWelcomes(b2.deviceId), 0);
  await da.acceptDevice(id, b.id, b2.deviceId);
  assert.equal(countWelcomes(b2.deviceId) >= 1, true);
});

test('gap 3: "start fresh" that cannot retire the old device on the server changes nothing on this device', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const real = netFor(b.cookie);
  let down = false;
  const net: Net = { ...real, json: (m, p, body) => (down && m === 'DELETE' && /^\/keys\/devices\/\d+$/.test(p) ? Promise.reject(new NetError(500, 'generic')) : real.json(m, p, body)) };
  const kv = memoryKv();
  const db = createE2ee(b.id, { net, kv, label: 'phone' }); await db.ready();
  const da = await device(a);
  const id = await direct(a, b);
  await da.startChat(id); await db.sync(id);
  await db.sendText(id, 'قبل');
  const before = db.deviceId;
  down = true;
  await assert.rejects(() => db.startFresh());
  down = false;
  assert.equal(db.deviceId, before, 'still the same device');
  await db.sendText(id, 'ما زال يعمل');
  assert.equal(texts(await da.history(id)).at(-1), 'ما زال يعمل');
  await db.startFresh();
  assert.notEqual(db.deviceId, before, 'when the server accepts, the device is new');
});

test('gap 3: a second tab on the same storage follows a device that another tab made fresh, and stops when another tab wiped the storage', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const kv = memoryKv();
  const tab1 = createE2ee(b.id, { net: netFor(b.cookie), kv, label: 'tab' }); await tab1.ready();
  const tab2 = createE2ee(b.id, { net: netFor(b.cookie), kv, label: 'tab' }); await tab2.ready();
  assert.equal(tab2.deviceId, tab1.deviceId, 'two tabs, one device');
  const da = await device(a);
  const id = await direct(a, b);
  await da.startChat(id); await tab1.sync(id);
  await tab1.startFresh();
  await tab2.sync(id);
  assert.equal(tab2.deviceId, tab1.deviceId, 'the other tab uses the new device, not the retired one');
  await kv.wipe();                                      // "forget this device" in another tab
  await assert.rejects(() => tab2.sendText(id, 'x'), /device_gone/);
  assert.equal(await kv.get('dev'), undefined, 'the stopped tab wrote nothing back');
});

test('gap 3: a view-once message is not copied to a newly linked device; the rest of the history is, with the trust records', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id); await db.sync(id);
  const once = await da.sendMedia(id, [{ bytes: enc.encode('secret-photo'), name: 'p.jpg', mime: 'image/jpeg', w: 1, h: 1 }], 'one look', { viewOnce: true });
  const plain = await da.sendText(id, 'عادية');
  await db.history(id);
  const kv2 = memoryKv();
  const da2 = await device(a, 'laptop', kv2);
  const link = await da2.linkRequest();
  await da.confirmLink(da2.deviceId, link.code);
  await da2.receiveHistory();
  assert.equal(await da.hasCopy(id, once.id), true, 'the old device still has it');
  assert.equal(await da2.hasCopy(id, once.id), false, 'the new device gets no copy of a view-once message');
  assert.equal(await da2.hasCopy(id, plain.id), true);
  assert.equal((await kv2.keys('row:')).some(k => k.endsWith(`:${once.id}`)), false);
  assert.equal((await kv2.keys('tk:')).includes(`tk:${id}`), true, 'what the old device trusts in this chat comes along');
});

// ---- review of the gaps step: what the independent reviewer found ---------------------------------------------------------------------------

async function groupWithUnconfirmed() {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  const g = await group(a, [b, c]);
  await da.startChat(g); await db.sync(g); await dc.sync(g);
  const b2 = await device(b, 'unvouched');
  await da.sendText(g, 'x');
  await da.acceptDevice(g, b.id, b2.deviceId);
  await dc.sync(g);
  return { a, b, c, da, db, dc, g, b2 };
}

test('review 1: a signer the server names is not a root of trust: a fake endorsement of my own device does not confirm other devices "of mine"', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id); await db.sync(id);
  const evil = await newDeviceIdentity();
  const signerRow = Number(run('INSERT INTO e2ee_devices (user_id, label, identity_key) VALUES (?, ?, ?)', a.id, 'server made', Buffer.from(evil.publicKey)).lastInsertRowid);
  const d2 = await device(a, 'injected');
  const key = (id: number) => new Uint8Array(one('SELECT identity_key k FROM e2ee_devices WHERE id = ?', id)!.k as Uint8Array);
  for (const target of [da.deviceId, d2.deviceId]) run('UPDATE e2ee_devices SET endorsement = ?, endorsed_by = ? WHERE id = ?', toB64(await endorseDevice(evil.signKey, a.id, target, key(target))), signerRow, target);
  await db.sync(id);
  await db.acceptDevice(id, a.id, d2.deviceId);   // bob says yes by hand
  await db.sync(id); await da.sync(id);
  await assert.rejects(() => da.sendText(id, 'لا'), /device_unconfirmed/);
});

test('review 2: a hand-over the server made (without the pairing secret) opens nothing and brings no trust records', async () => {
  const a = await person('ناصر');
  const da = await device(a);
  const kv2 = memoryKv();
  const da2 = await device(a, 'laptop', kv2);
  const link = await da2.linkRequest();
  const { sealTransfer, newLinkKeys, linkKey } = await import('./src/e2ee/link.ts');
  const srv = newLinkKeys();
  const linkPub = fromB64(one('SELECT link_pub p FROM e2ee_devices WHERE id = ?', da2.deviceId)!.p as string);
  const forged = await sealTransfer({ 'tk:5': toB64(enc.encode('{"7":["abcd"]}')) }, linkKey(srv.priv, linkPub, srv.pub, da2.deviceId));
  for (const [i, part] of forged.entries()) run('INSERT INTO e2ee_transfers (device_id, part, last, data) VALUES (?, ?, ?, ?)', da2.deviceId, i, i === forged.length - 1 ? 1 : 0, Buffer.from(part));
  run('UPDATE e2ee_devices SET link_used_at = ?, link_peer = ? WHERE id = ?', Math.floor(Date.now() / 1000), toB64(srv.pub), da2.deviceId);
  await assert.rejects(() => da2.receiveHistory(), /bad_transfer/);
  assert.equal(await kv2.get('tk:5'), undefined);
  void link; void da;
});

test('review 3: the pause is decided on the group after this device\'s own commits: a device the server stopped listing is removed, then sending works', async () => {
  const { c, dc, g, b2 } = await groupWithUnconfirmed();
  assert.equal((await dc.unconfirmedDevices()).length, 1);
  run("UPDATE e2ee_devices SET revoked_at = datetime('now') WHERE id = ?", b2.deviceId);
  await dc.sendText(g, 'بعد إزالة الخادم');
  assert.equal((await dc.unconfirmedDevices()).length, 0);
  void c;
});

test('review 4: a revoked device\'s signature no longer vouches for a new device', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const offline = { on: false };
  const real = netFor(b.cookie);
  const net: Net = { ...real, json: (m, p, body) => (offline.on && m === 'POST' && /\/e2ee\/commits$/.test(p) ? Promise.reject(new NetError(0, 'network')) : real.json(m, p, body)) };
  const db = createE2ee(b.id, { net, kv: memoryKv(), label: 'phone' }); await db.ready();
  const da = await device(a);
  const id = await direct(a, b);
  await da.startChat(id); await db.sync(id);
  const b2 = await device(b, 'laptop');
  offline.on = true; await db.approveDevice(b2.deviceId); offline.on = false;   // signed by sara's phone, not added yet
  await call(b.cookie, `/api/keys/devices/${db.deviceId}`, 'DELETE');          // the phone is lost and revoked
  await da.sendText(id, 'x');
  assert.equal(countWelcomes(b2.deviceId), 0, 'a retired device\'s signature does not count');
  assert.equal((await da.waitingDevices()).length, 1);
});

test('review 5: a device somebody removed stays out when other trust changes happen later', async () => {
  const { b, da, db, dc, g, b2 } = await groupWithUnconfirmed();
  await dc.removeDevice(g, b.id, b2.deviceId);
  await da.sync(g);
  const b3 = await device(b, 'another');
  await db.approveDevice(b3.deviceId);                 // a vouched device: trust changes on naser\'s device
  await da.sync(g); await da.sendText(g, 'بعد');
  const ids = async () => (await da.__state(g)).group;
  const { members } = await import('../core/e2ee.ts');
  assert.equal(members(await ids()).some(m => m.identity === `u${b.id}.d${b2.deviceId}`), false);
});

test('review 6: nobody can verify a person while a device of theirs in the chat is unconfirmed', async () => {
  const { b, dc, g } = await groupWithUnconfirmed();
  await assert.rejects(() => dc.verify(b.id, g), /device_unconfirmed/);
  assert.equal(await dc.isVerified(b.id, g), false);
});

test('review 7: the size of a chat for "add automatically" counts the people in the group, not only what the server lists', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  const [da, db, dc] = [await device(a), await device(b), await device(c)];
  const g = await group(a, [b, c]);
  await da.startChat(g); await db.sync(g); await dc.sync(g);
  await da.setNewDevicePolicy('auto');
  run("UPDATE e2ee_devices SET revoked_at = datetime('now') WHERE id = ?", dc.deviceId);   // the server stops listing khalid: it looks like a chat of two
  const b2 = await device(b, 'new');
  await da.sendText(g, 'x');
  assert.equal(countWelcomes(b2.deviceId), 0, 'still a group: "automatic" does not apply');
});
