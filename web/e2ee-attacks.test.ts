process.env.THIKRA_DEV = '1';   // these tests sign in with the on-screen code, which only exists in explicit development mode
// RED TEAM: attacks on the browser side of end-to-end encryption (feature 26). Every test is an ATTACK written as a test: it passes when the attack FAILS.
// A test marked `todo` is an attack that still works and cannot be fixed in our code; it is listed in docs/RED-TEAM-REPORT.md and reported, but does not fail the run.
// Attacker models: a malicious group member (a hostile device that really is in the MLS group and sends bytes the honest app never would), a malicious server (it
// controls every answer the engine reads), a page or device that can read the storage. The engine, the server and MLS are the real ones; nothing is mocked but the network wire.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';
process.env.THIKRA_E2EE = '1';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-web-attack-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroup, encrypt, fromB64, join as joinGroup, newDeviceIdentity, newKeyPackages, toB64, type DeviceIdentity, type Group, type StoredKeyPackage } from '../core/e2ee.ts';
import { createE2ee, NetError, type E2ee, type Net } from './src/e2ee/engine.ts';
import { decodePayload, encodePayload, type Payload } from './src/e2ee/payload.ts';
import { render, emptyLedger, mergeLedger } from './src/e2ee/view.ts';
import { memoryKv, sealedKv, chooseKv } from './src/e2ee/kv.ts';
import { deriveKey, newRecoveryCode, openBackup, sealBackup, validCode } from './src/e2ee/backup.ts';
import { linkKey, newLinkKeys, openTransfer, sealTransfer } from './src/e2ee/link.ts';
import { parseLinkPayload, parseSafetyPayload } from './src/e2ee/qr.ts';
import { guardPlain, isKnownEncrypted, markEncrypted, resetKnownEncrypted } from './src/e2ee/known.ts';

const { app } = await import('../server/index.ts');
const { one } = await import('../server/db.ts');

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
let n = 0;
async function person(name: string) {
  const phone = `+96656${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(3, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, name, phone, id: (await call(cookie, '/api/me')).json.id as number };
}
type P = Awaited<ReturnType<typeof person>>;
function netFor(cookie: string, tamper?: (method: string, path: string, answer: any) => any): Net {
  const fail = async (res: Response) => { const j = await res.json().catch(() => ({})) as any; throw new NetError(res.status, j.error ?? 'generic', j); };
  return {
    async json(method, path, body) {
      const res = await app.request('/api' + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!res.ok) await fail(res);
      const a = await res.json().catch(() => ({})) as any;
      return tamper ? tamper(method, path, a) : a;
    },
    async bytes(path) { const res = await app.request('/api' + path, { headers: { cookie } }); if (!res.ok) await fail(res); return new Uint8Array(await res.arrayBuffer()); },
    async put(path, body) { const res = await app.request('/api' + path, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', cookie }, body: body as BodyInit }); if (!res.ok) await fail(res); return res.json().catch(() => ({})) as any; },
  };
}
const device = async (p: P, label = 'test', kv = memoryKv(), tamper?: (m: string, path: string, a: any) => any) => { const d = createE2ee(p.id, { net: netFor(p.cookie, tamper), kv, label }); assert.equal(await d.ready(), true); return d; };
const direct = async (a: P, b: P) => (await call(a.cookie, '/api/direct', 'POST', { phone: b.phone, encrypted: true })).json.id as number;
const enc = new TextEncoder();

/** A hostile member: it speaks MLS directly, so it can send any payload bytes it likes. Its device is a real, listed device that the honest engines add to the chat. */
class Rogue {
  deviceId = 0; identity!: DeviceIdentity; stock: StoredKeyPackage[] = []; groups = new Map<number, Group>();
  constructor(public p: P) {}
  static async make(p: P) {
    const r = new Rogue(p);
    r.deviceId = (await call(p.cookie, '/api/keys/devices', 'POST', { label: 'rogue' })).json.deviceId;
    r.identity = await newDeviceIdentity();
    r.stock = await newKeyPackages(p.id, r.deviceId, 4, r.identity);
    const last = r.stock.pop()!;
    assert.equal((await call(p.cookie, `/api/keys/devices/${r.deviceId}/packages`, 'POST', { packages: r.stock.map(k => toB64(k.publicBytes)), lastResort: toB64(last.publicBytes) })).status, 200);
    r.stock.push(last);
    return r;
  }
  get name() { return `u${this.p.id}.d${this.deviceId}`; }
  /** Join the chat from the welcome the honest device posted. */
  async join(circle: number) {
    const ws = (await call(this.p.cookie, `/api/circles/${circle}/e2ee/welcomes?device=${this.deviceId}`)).json as Array<{ welcome: string }>;
    for (const w of ws) for (const kp of this.stock) { try { this.groups.set(circle, await joinGroup(fromB64(w.welcome), kp)); return; } catch { /* not this package */ } }
    throw new Error('no welcome for the rogue device');
  }
  async sendRaw(circle: number, payload: unknown, kind = 'text', extra: Record<string, unknown> = {}) {
    const g = this.groups.get(circle)!;
    const r = await encrypt(g, enc.encode(typeof payload === 'string' ? payload : JSON.stringify(payload)));
    this.groups.set(circle, r.group);
    return call(this.p.cookie, `/api/circles/${circle}/e2ee/messages`, 'POST', { ciphertext: toB64(r.ciphertext), kind, epoch: Number(g.groupContext.epoch), clientMsgId: crypto.randomUUID(), ...extra });
  }
  async upload(circle: number) {
    const up = await call(this.p.cookie, `/api/circles/${circle}/uploads`, 'POST', { name: 'blob', size: 64 });
    await app.request(`/api/uploads/${up.json.id}?offset=0`, { method: 'PUT', headers: { cookie: this.p.cookie }, body: crypto.getRandomValues(new Uint8Array(64)) });
    return up.json.id as string;
  }
}
/** Alice's honest engine and a rogue member in a private chat; the rogue has joined. */
async function withRogue() {
  const a = await person('ناصر'), b = await person('سارة');
  const da = await device(a);
  const rogue = await Rogue.make(b);
  const id = await direct(a, b);
  await da.startChat(id);
  await rogue.join(id);
  return { a, b, da, rogue, id };
}
const goodFile = { i: 0, kind: 'image', k: toB64(new Uint8Array(32)), hash: '0'.repeat(64), name: 'a.jpg', mime: 'image/jpeg', size: 10, w: 1, h: 1 };
const dec = (o: unknown) => decodePayload(enc.encode(JSON.stringify(o)));
const from = 'u1.d1';

// ---- (2) a hostile member: what it can make the other person's screen do ----------------------------------------------------------------------

test('attack: a member points the receiver\'s picture at a web address (a tracking pixel: it learns when and from where the chat is opened)', async () => {
  const { da, rogue, id } = await withRogue();
  const evil = 'https://tracker.example/pixel.png?u=1';
  const up = await rogue.upload(id);
  const r = await rogue.sendRaw(id, { v: 1, from: rogue.name, t: 'media', text: 'look', files: [{ ...goodFile, thumb: evil, mime: 'image/jpeg' }] }, 'media', { uploads: [up] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const seen = await da.history(id);
  const json = JSON.stringify(seen);
  assert.ok(!json.includes('tracker.example'), 'the receiver would load a picture from the sender\'s web address');
});

test('attack: a thumbnail must be a small inline picture; a script or an enormous string is refused', () => {
  const ok = dec({ v: 1, from, t: 'media', text: '', files: [{ ...goodFile, thumb: 'data:image/jpeg;base64,/9j/4AAQ' }] });
  assert.ok(ok, 'the honest thumbnail form is refused');
  for (const thumb of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=', '//evil.example/x.png', 'data:image/jpeg;base64,' + 'A'.repeat(300_000)]) {
    assert.equal(dec({ v: 1, from, t: 'media', text: '', files: [{ ...goodFile, thumb }] }), null, `accepted thumb ${thumb.slice(0, 40)}`);
  }
});

test('attack: a file type chosen by the sender cannot be something a browser runs (html, svg, javascript) or a header-injection string', () => {
  for (const mime of ['text/html', 'image/svg+xml', 'application/javascript', 'text/html; charset=utf-8', 'x'.repeat(500), 'image/png\r\nx-evil: 1', '']) {
    const p = dec({ v: 1, from, t: 'media', text: '', files: [{ ...goodFile, mime }] });
    assert.ok(p === null || (p as any).files[0].mime === 'application/octet-stream', `mime ${JSON.stringify(mime.slice(0, 30))} kept as ${p && (p as any).files[0].mime}`);
  }
  assert.ok(dec({ v: 1, from, t: 'media', text: '', files: [{ ...goodFile, mime: 'video/mp4' }] }), 'a normal video type is refused');
});

test('attack: a message cannot be used to eat memory or time on every device: bounded files, options, waveform, names', () => {
  const files = (k: number) => Array.from({ length: k }, (_, i) => ({ ...goodFile, i }));
  assert.equal(dec({ v: 1, from, t: 'media', text: '', files: files(500) }), null, 'a message with hundreds of files');
  assert.equal(dec({ v: 1, from, t: 'media', text: '', files: [{ ...goodFile, name: 'n'.repeat(5000) }] }), null, 'a file name of 5000 characters');
  assert.equal(dec({ v: 1, from, t: 'media', text: '', files: [{ ...goodFile, k: 'k'.repeat(5000) }] }), null, 'a file key of 5000 characters');
  assert.equal(dec({ v: 1, from, t: 'voice', ms: 1000, wave: Array.from({ length: 20000 }, () => 5), file: goodFile }), null, 'a waveform of 20000 points');
  assert.equal(dec({ v: 1, from, t: 'voice', ms: 1000, wave: ['<img src=x onerror=1>', { a: 1 }], file: goodFile }), null, 'a waveform of text and objects');
  assert.equal(dec({ v: 1, from, t: 'poll', text: 'q', options: Array.from({ length: 3000 }, (_, i) => 'o' + i), multiple: false }), null, 'a poll of 3000 options');
  assert.equal(dec({ v: 1, from, t: 'poll', text: 'q', options: ['a', 'x'.repeat(9000)], multiple: false }), null, 'a poll option of 9000 characters');
  assert.ok(dec({ v: 1, from, t: 'poll', text: 'q', options: ['a', 'b', 'c'], multiple: true }), 'an ordinary poll is refused');
  assert.equal(dec({ v: 1, from: 'not-a-device', t: 'text', text: 'x' }), null, 'a sender name that is not a device name');
});

test('attack: a person in a single-choice poll votes for several options at once (one voice counted many times)', () => {
  const p: Payload = { v: 1, from, t: 'poll', text: 'q', options: ['a', 'b', 'c'], multiple: false };
  const led = emptyLedger();
  led.vote['5'] = { '7': { o: [0, 1, 2, 11, 50], s: 3, rv: 1 }, '8': { o: [1], s: 4, rv: 1 } };
  const m = render({ id: 5, userId: 9, seq: 1, createdAt: '2026-01-01' } as any, p, led);
  const per = m.poll!.options.map(o => o.voters.length);
  assert.deepEqual(per, [1, 1, 0], 'person 7 was counted for more than one option, or for options that do not exist');
  assert.equal(m.poll!.voters, 2);
});

test('attack: a control message that names a message the sender did not write cannot edit or delete it; an edit needs the header and the sealed target to agree', async () => {
  const { da, rogue, id } = await withRogue();
  const mine = await da.sendText(id, 'alice wrote this');
  const rogueMsg = await rogue.sendRaw(id, { v: 1, from: rogue.name, t: 'text', text: 'rogue wrote this' });
  // the rogue edits ALICE's message: the server refuses (not its message)
  const e1 = await rogue.sendRaw(id, { v: 1, from: rogue.name, t: 'edit', target: mine.id, text: 'HACKED' }, 'edit', { target: mine.id });
  assert.equal(e1.status, 403);
  // the header names its own message but the sealed content names Alice's
  const e2 = await rogue.sendRaw(id, { v: 1, from: rogue.name, t: 'edit', target: mine.id, text: 'HACKED-2' }, 'edit', { target: rogueMsg.json.id });
  assert.equal(e2.status, 201);
  const seen = await da.history(id);
  assert.ok(!JSON.stringify(seen).includes('HACKED'), 'an edit of someone else\'s message was applied');
});

test('attack: a member claims to be another device (the sealed "from" must match the server\'s sender)', async () => {
  const { a, da, rogue, id } = await withRogue();
  const r = await rogue.sendRaw(id, { v: 1, from: `u${a.id}.d${da.deviceId}`, t: 'text', text: 'ALICE SAYS GIVE ME MONEY' });
  assert.equal(r.status, 201);
  const seen = await da.history(id);
  const shown = seen.find(m => m.id === r.json.id)!;
  assert.ok(shown.undecryptable && !JSON.stringify(shown).includes('GIVE ME MONEY'), 'a forged sender was shown as a normal message');
});

test('attack: hostile JSON keys (__proto__, constructor) in a payload, a ledger or a hand-over change nothing outside themselves', async () => {
  const poisoned = '{"v":1,"from":"u1.d1","t":"text","text":"x","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}';
  decodePayload(enc.encode(poisoned));
  const led = mergeLedger(undefined, JSON.parse('{"react":{"__proto__":{"1":{"e":"x","s":1,"rv":0}},"5":{"__proto__":{"e":"y","s":1,"rv":0}}},"vote":{},"edit":{}}'));
  assert.ok(led);
  const key = new Uint8Array(32).fill(3);
  const parts = await sealTransfer(JSON.parse('{"__proto__":"x","pl:1:2":"ok","constructor":"y","row:3:4":"ok"}'), key);
  const out = await openTransfer(parts, key);
  assert.deepEqual(Object.keys(out).sort(), ['pl:1:2', 'row:3:4']);
  assert.equal(({} as any).polluted, undefined, 'Object.prototype was changed');
});

test('attack: replaying a captured ciphertext (a server or a member sends the same bytes again) does not repeat its effect or wedge the chat', async () => {
  const { da, rogue, id } = await withRogue();
  const g = rogue.groups.get(id)!;
  const r = await encrypt(g, enc.encode(JSON.stringify({ v: 1, from: rogue.name, t: 'text', text: 'once' })));
  rogue.groups.set(id, r.group);
  const post = () => call(rogue.p.cookie, `/api/circles/${id}/e2ee/messages`, 'POST', { ciphertext: toB64(r.ciphertext), kind: 'text', epoch: Number(g.groupContext.epoch), clientMsgId: crypto.randomUUID() });
  assert.equal((await post()).status, 201);
  assert.equal((await post()).status, 201);   // the server cannot tell it is the same message
  await rogue.sendRaw(id, { v: 1, from: rogue.name, t: 'text', text: 'after the replay' });
  const seen = (await da.history(id)).filter(m => m.kind !== 'system');
  assert.equal(seen.filter(m => m.body === 'once').length, 1, 'the replayed message was shown twice');
  assert.ok(seen.some(m => m.body === 'after the replay'), 'a replay stopped later messages from being read');
});

// ---- (1) a hostile server controls what the engine reads ---------------------------------------------------------------------------------------

test('attack: the server says a chat is NOT encrypted that this device knows is: no readable message may be sent into it', () => {
  resetKnownEncrypted();
  markEncrypted(4242);
  assert.equal(isKnownEncrypted(4242), true);
  for (const [m, path] of [['POST', '/circles/4242/messages'], ['POST', '/circles/4242/attachments'], ['POST', '/circles/4242/voice'], ['POST', '/circles/4242/cards'], ['POST', '/circles/4242/polls'], ['POST', '/circles/4242/poll']] as const) {
    assert.throws(() => guardPlain(m, path), (e: any) => e.code === 'encrypted_chat', `${m} ${path} was allowed`);
  }
  for (const [m, path] of [['GET', '/circles/4242/messages'], ['POST', '/circles/4242/e2ee/messages'], ['POST', '/circles/9/messages'], ['POST', '/circles/4242/read'], ['POST', '/circles/4242/uploads']] as const) assert.doesNotThrow(() => guardPlain(m, path), `${m} ${path} was refused`);
});

test('attack: the engine remembers on this device which chats are encrypted (a server cannot talk it out of it later)', async () => {
  resetKnownEncrypted();
  const a = await person('ناصر'), b = await person('سارة');
  const da = await device(a);
  await device(b);
  const id = await direct(a, b);
  await da.startChat(id);
  assert.equal(isKnownEncrypted(id), true, 'the chat this device started was not recorded as encrypted');
});

test('attack: a server hands out a key package that is not the device\'s (same name, a key the attacker owns): the chat is not started with it', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const db = await device(b);   // the honest device of b, with its real directory entry
  const evil = await newDeviceIdentity();
  const bDev = (await call(b.cookie, '/api/keys/devices')).json[0].id as number;
  const [fake] = await newKeyPackages(b.id, bDev, 1, evil);
  const da = await device(a, 'a', memoryKv(), (m, path, ans) => (m === 'POST' && /\/keys\/users\/\d+\/claim$/.test(path) ? { packages: [{ deviceId: bDev, package: toB64(fake.publicBytes), lastResort: false }] } : ans));
  const id = await direct(a, b);
  await da.startChat(id).catch(() => undefined);
  const welcomes = (await call(b.cookie, `/api/circles/${id}/e2ee/welcomes?device=${bDev}`)).json as unknown[];
  assert.equal(welcomes.length, 0, 'a welcome was made for a package whose key is not the one in the directory');
  void db;
});

test('attack: the server shows a different member list (an extra device of someone already trusted in the chat): the device is not added without a yes', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a), await device(b)];
  const id = await direct(a, b);
  await da.startChat(id);
  await da.sendText(id, 'hello');
  await db.history(id);
  // a stranger device appears under b's name in the directory only (the server invents it)
  const evil = await newDeviceIdentity();
  const real = (await call(b.cookie, '/api/keys/devices', 'POST', { label: 'evil-looking' })).json.deviceId as number;
  const kps = await newKeyPackages(b.id, real, 2, evil);
  await call(b.cookie, `/api/keys/devices/${real}/packages`, 'POST', { packages: kps.slice(0, 1).map(k => toB64(k.publicBytes)), lastResort: toB64(kps[1].publicBytes) });
  await da.sync(id);
  await da.sendText(id, 'after the stranger appeared').catch(() => undefined);
  const members = (await da.__state(id)).group.ratchetTree.filter((x: any, i: number) => i % 2 === 0 && x?.nodeType === 'leaf').length;
  assert.equal(members, 2, 'a device that nobody confirmed was added to the chat');
});

// ---- (5) leftovers: what "delete for everyone" leaves on the devices ---------------------------------------------------------------------------------

async function kvText(kv: ReturnType<typeof memoryKv>) {
  const out: string[] = [];
  for (const k of await kv.keys()) out.push(k + '=' + Buffer.from((await kv.get(k))!).toString('utf8'));
  return out.join('\n');
}
test('attack: after "delete for everyone" no copy of the words stays on the sender\'s device or the receiver\'s (not in the sent-copy cache, the preview, the edit history or the reactions)', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [kva, kvb] = [memoryKv(), memoryKv()];
  const [da, db] = [await device(a, 'a', kva), await device(b, 'b', kvb)];
  const id = await direct(a, b);
  await da.startChat(id);
  const sent = await da.sendText(id, 'FIRST-WORDS-MARKER-31');
  await db.history(id);
  await da.edit(id, sent.id, 'EDITED-WORDS-MARKER-32');
  await db.react(id, sent.id, '👍');
  await db.history(id); await da.history(id);
  assert.ok((await kvText(kva)).includes('EDITED-WORDS-MARKER-32'), 'the test did not set the edit up');
  await da.remove(id, sent.id);
  await db.history(id); await da.history(id);
  for (const [who, kv] of [['sender', kva], ['receiver', kvb]] as const) {
    const t = await kvText(kv);
    for (const m of ['FIRST-WORDS-MARKER-31', 'EDITED-WORDS-MARKER-32']) assert.ok(!t.includes(m), `${who}'s device still holds "${m}" after the message was deleted for everyone: ${t.split('\n').filter(l => l.includes(m)).map(l => l.slice(0, 60)).join(' | ')}`);
  }
});

test('attack: the short code a person compares between two devices is too long to grind a look-alike key for (12 digits, about 40 bits; 8 digits took minutes)', async () => {
  const code = await createE2ee(1, { net: netFor(''), kv: memoryKv() }).myCodeFor(crypto.getRandomValues(new Uint8Array(32)));
  assert.match(code, /^\d{4} \d{4} \d{4}$/);
});

// ---- (4) a stolen profile or a page that reads the storage -------------------------------------------------------------------------------------

test('attack: the stored values are sealed with a key script cannot export, bound to their storage key, and tampering is detected', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await assert.rejects(() => crypto.subtle.exportKey('raw', key), 'the wrapping key can be exported');
  const raw = memoryKv(), kv = sealedKv(raw, key);
  await kv.set('grp:1', enc.encode('SECRET-STATE'));
  const stored = (await raw.get('grp:1'))!;
  assert.ok(!Buffer.from(stored).includes(Buffer.from('SECRET-STATE')), 'stored in clear');
  await raw.set('grp:2', stored);   // moved to another name
  await assert.rejects(() => kv.get('grp:2'), 'a sealed value was accepted under another key');
  const t = stored.slice(); t[20] ^= 1; await raw.set('grp:1', t);
  await assert.rejects(() => kv.get('grp:1'), 'a tampered value was accepted');
});

test('attack: when the browser cannot make the sealing key, the device keeps nothing in clear on disk (memory only, and says so) instead of falling back silently', async () => {
  const disk = memoryKv(); (disk as any).durable = true;
  const k = chooseKv(disk, null);
  assert.equal(k.durable, false, 'unsealed storage was used');
  await k.set('dev', enc.encode('SECRET'));
  assert.equal(await disk.get('dev'), undefined, 'a secret reached the unsealed disk store');
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  assert.equal(chooseKv(disk, key).durable, true);
});

test('attack: recovery phrase: offline guessing is not feasible (about 124 bits, slow key derivation), a wrong or damaged backup opens nothing', async () => {
  const codes = new Set(Array.from({ length: 200 }, newRecoveryCode));
  assert.equal(codes.size, 200, 'recovery codes repeat');
  const code = newRecoveryCode();
  assert.ok(validCode(code));
  const alphabet = new Set(code.replace(/-/g, ''));
  assert.ok(alphabet.size > 12, 'the code looks low-entropy');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const t0 = performance.now(); const key = await deriveKey(code, salt); const ms = performance.now() - t0;
  assert.ok(ms > 20, `key derivation took ${ms.toFixed(1)} ms: too fast to slow a guesser down`);
  const kv = memoryKv(); await kv.set('dev', enc.encode('{"x":1}')); await kv.set('grp:1', enc.encode('STATE'));
  const { blob } = await sealBackup(kv, key, salt);
  assert.ok(!Buffer.from(blob).includes(Buffer.from('STATE')));
  const wrongKey = await deriveKey(newRecoveryCode(), salt);
  await assert.rejects(() => openBackup(blob, wrongKey), /bad_recovery_code/);
  const bad = blob.slice(); bad[bad.length - 5] ^= 1;
  await assert.rejects(() => openBackup(bad, key), /bad_recovery_code/);
  const swapped = blob.slice(); swapped[0] = 0x58;
  await assert.rejects(() => openBackup(swapped, key), /bad_recovery_code/);
});

test('attack: linking a device: a wrong secret opens nothing; a picture with extra or malformed parts is not a link; a public key alone makes no key', async () => {
  const [n1, o1] = [newLinkKeys(), newLinkKeys()];
  const good = linkKey(o1.priv, n1.pub, o1.pub, 7, enc.encode('secret-from-the-two-screens'));
  const parts = await sealTransfer({ 'pl:1:1': 'x' }, good);
  await assert.rejects(() => openTransfer(parts, linkKey(newLinkKeys().priv, n1.pub, o1.pub, 7, enc.encode('secret-from-the-two-screens'))), 'a third key opened the hand-over');
  await assert.rejects(() => openTransfer(parts, linkKey(n1.priv, o1.pub, n1.pub, 7, new Uint8Array(0))), 'the server (both public keys, no secret) made the key');
  assert.ok(await openTransfer(parts, linkKey(n1.priv, o1.pub, n1.pub, 7, enc.encode('secret-from-the-two-screens'))), 'the real new device cannot open it');
  for (const junk of ['', 'tamtim-link:1:1:x:y:z', 'tamtim-link:1:1:' + 'A'.repeat(43) + ':' + 'A'.repeat(16) + ':' + 'A'.repeat(22) + ' extra', 'tamtim-link:2:1:' + 'A'.repeat(43), '\u0000'.repeat(1000), 'tamtim-link:1:99999999999999999999:' + 'A'.repeat(43) + ':' + 'A'.repeat(16) + ':' + 'A'.repeat(22)]) assert.equal(parseLinkPayload(junk), null);
  for (const junk of ['', 'tamtim-safety:1:12345', 'tamtim-safety:1:' + '1'.repeat(61), 'x'.repeat(100000)]) assert.equal(parseSafetyPayload(junk), null);
});

// ---- open: attacks that still work and are documented (reported as todo, not failures) ---------------------------------------------------------------

test('OPEN (documented): a server that hides the newest messages of a chat cannot be noticed by the device (no signed count of messages)', { todo: 'inherent to a server that orders and stores messages; needs a signed head of the chat' }, async () => {
  assert.fail('the device has no way to know a trailing message was withheld');
});

test('OPEN (documented): the first device a server lists for a person is trusted on first sight (no earlier key to compare it with)', { todo: 'first-sight trust; the safety number is the only defence' }, async () => {
  assert.fail('a fake first device listed by the server before the person was ever seen is accepted');
});

void one;

test('review: the encrypted upload route (the engine sends already-encrypted bytes there) is not blocked; two tabs do not erase each other\'s marks', () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  resetKnownEncrypted();
  markEncrypted(7);
  assert.doesNotThrow(() => guardPlain('POST', '/circles/7/uploads'));
  // another tab marks chat 8 after this one loaded its list: this tab marking chat 9 must keep both
  localStorage.setItem('thikra_e2ee_known_chats', JSON.stringify([7, 8]));
  markEncrypted(9);
  assert.deepEqual(JSON.parse(localStorage.getItem('thikra_e2ee_known_chats')!).sort(), [7, 8, 9]);
  assert.equal(isKnownEncrypted(8), true);
});

test('review: after delete-for-everyone, later loads show no "unreadable" bubbles for its edits, and the chat-list preview does not keep its words', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const [da, db] = [await device(a, 'a', memoryKv()), await device(b, 'b', memoryKv())];
  const id = await direct(a, b);
  await da.startChat(id);
  const sent = await da.sendText(id, 'SECRET-PREVIEW-77');
  await da.edit(id, sent.id, 'edited words');
  await db.history(id);
  await da.remove(id, sent.id);
  assert.equal(await da.preview(id), null, 'the preview kept the deleted words');
  for (let i = 0; i < 2; i++) for (const d of [da, db]) {
    const rows = (await d.history(id)).filter(m => m.kind !== 'system');
    assert.ok(rows.every(m => !(m as any).undecryptable), `load ${i}: a control message of a deleted message is drawn as unreadable`);
  }
});
