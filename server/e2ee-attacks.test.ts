process.env.THIKRA_DEV = '1';   // these tests sign in with the on-screen code, which only exists in explicit development mode
// RED TEAM: attacks on the server side of end-to-end encryption (feature 26). Every test is an ATTACK written as a test: it passes when the attack FAILS.
// A test marked `todo` is an attack that still works and cannot be fixed in our code (it is listed in docs/RED-TEAM-REPORT.md as open); it is reported but does not fail the run.
// Attacker models: a malicious group member, an ex-member, a hostile client sending bytes the honest app never would. Local throwaway database only; no network.
// The devices use the REAL encryption core (core/e2ee.ts, MLS), exactly like server/e2ee.test.ts.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';
process.env.THIKRA_E2EE = '1';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));
process.env.THIKRA_BACKUPS = mkdtempSync(join(tmpdir(), 'thikra-backups-'));   // the backup test writes a real backup: never into the repository

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { addDevices, createGroup, decryptText, encryptText, fromB64, join as joinGroup, newDeviceIdentity, newKeyPackages, processCommit, removeDevices, rotateKeys, toB64, type DeviceIdentity, type Group, type StoredKeyPackage } from '../core/e2ee.ts';

const { app, startServer } = await import('./index.ts');
const { all, one } = await import('./db.ts');
const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
after(() => { server.close(); server.closeAllConnections?.(); });

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
const until = async (cond: () => boolean) => { for (let i = 0; i < 60 && !cond(); i++) await new Promise(r => setTimeout(r, 50)); };
let n = 0;
async function person(name: string) {
  const phone = `+96659${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(3, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, name, id: (await call(cookie, '/api/me')).json.id as number };
}
type P = Awaited<ReturnType<typeof person>>;

class Device {
  deviceId = 0; stock: StoredKeyPackage[] = []; identity!: DeviceIdentity; groups = new Map<number, Group>();
  constructor(public p: P) {}
  static async make(p: P, packages = 6) {
    const d = new Device(p);
    const r = await call(p.cookie, '/api/keys/devices', 'POST', { label: 'attack' });
    d.deviceId = r.json.deviceId; d.identity = await newDeviceIdentity();
    d.stock = await newKeyPackages(p.id, d.deviceId, packages + 1, d.identity);
    const last = d.stock.pop()!;
    const up = await call(p.cookie, `/api/keys/devices/${d.deviceId}/packages`, 'POST', { packages: d.stock.map(k => toB64(k.publicBytes)), lastResort: toB64(last.publicBytes) });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    d.stock.push(last);
    return d;
  }
  mine(ref: Uint8Array) { return this.stock.find(k => Buffer.compare(Buffer.from(k.publicBytes), Buffer.from(ref)) === 0); }
  async claim(uid: number) { const r = await call(this.p.cookie, `/api/keys/users/${uid}/claim`, 'POST'); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.packages as Array<{ deviceId: number; package: string }>; }
  async start(circle: number, others: Device[]) {
    let g = await createGroup(`c${circle}`, this.stock.shift()!);
    const claimed: Array<{ dev: Device; pkg: Uint8Array }> = [];
    for (const o of others) for (const k of await this.claim(o.p.id)) if (k.deviceId === o.deviceId) claimed.push({ dev: o, pkg: fromB64(k.package) });
    const h = await addDevices(g, claimed.map(c => c.pkg)); g = h.group;
    const r = await call(this.p.cookie, `/api/circles/${circle}/e2ee/commits`, 'POST', { device: this.deviceId, epoch: 1, commit: toB64(h.commit), welcomes: claimed.map(c => ({ device: c.dev.deviceId, welcome: toB64(h.welcome!) })) });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    this.groups.set(circle, g);
    for (const c of claimed) await c.dev.acceptWelcomes(circle, claimed.map(x => x.pkg));
  }
  async acceptWelcomes(circle: number, packages: Uint8Array[]) {
    const r = await call(this.p.cookie, `/api/circles/${circle}/e2ee/welcomes?device=${this.deviceId}`);
    for (const w of r.json as Array<{ id: number; welcome: string }>) for (const pkg of packages) {
      const kp = this.mine(pkg); if (!kp) continue;
      try { this.groups.set(circle, await joinGroup(fromB64(w.welcome), kp)); await call(this.p.cookie, `/api/e2ee/welcomes/${w.id}`, 'DELETE'); break; } catch { /* not for this package */ }
    }
  }
  /** Encrypt and keep the state; returns the raw ciphertext and the epoch it was made in (so an attack can send it wrongly). */
  async seal(circle: number, text: string) {
    const g = this.groups.get(circle)!;
    const r = await encryptText(g, text);
    this.groups.set(circle, r.group);
    return { ciphertext: r.ciphertext, epoch: Number(g.groupContext.epoch) };
  }
  async say(circle: number, text: string, extra: Record<string, unknown> = {}, kind = 'text') {
    const s = await this.seal(circle, text);
    return call(this.p.cookie, `/api/circles/${circle}/e2ee/messages`, 'POST', { ciphertext: toB64(s.ciphertext), kind, epoch: s.epoch, ...extra });
  }
}
async function chat(kind: 'direct' | 'group', extra = 1) {
  const owner = await person('ناصر');
  const others: P[] = [];
  for (let i = 0; i < extra; i++) others.push(await person(`عضو${i}`));
  let id: number;
  if (kind === 'direct') id = (await call(owner.cookie, '/api/direct', 'POST', { phone: (await call(others[0].cookie, '/api/me')).json.phone, encrypted: true })).json.id;
  else {
    id = (await call(owner.cookie, '/api/circles', 'POST', { name: 'سرّي', kind: 'group', encrypted: true })).json.id;
    const code = (await call(owner.cookie, `/api/circles/${id}`)).json.inviteCode as string;
    for (const o of others) await call(o.cookie, '/api/circles/join', 'POST', { code });
  }
  const devs = [await Device.make(owner), ...await Promise.all(others.map(o => Device.make(o)))];
  await devs[0].start(id, devs.slice(1));
  return { id, owner, others, devs };
}
const postMsg = (d: Device, circle: number, body: Record<string, unknown>) => call(d.p.cookie, `/api/circles/${circle}/e2ee/messages`, 'POST', body);
const postCommit = (d: Device, circle: number, body: Record<string, unknown>) => call(d.p.cookie, `/api/circles/${circle}/e2ee/commits`, 'POST', { device: d.deviceId, ...body });
const epochNow = (circle: number) => one('SELECT e2ee_epoch e FROM circles WHERE id = ?', circle)!.e as number;
const b64 = (s: string) => toB64(new TextEncoder().encode(s));

// ---- (1)+(2) what the server accepts as "ciphertext", commits, welcomes and key packages ---------------------------------------------------

test('attack: a member stores readable bytes as "ciphertext" (a buggy or hostile client): the server refuses anything that is not an MLS message of this chat', async () => {
  const { id, devs } = await chat('direct');
  const m = 'READABLE-attack-MARKER-1';
  for (const bytes of [b64(m), b64(JSON.stringify({ text: m })), toB64(new Uint8Array(40))]) {
    const r = await postMsg(devs[0], id, { ciphertext: bytes, kind: 'text', epoch: epochNow(id) });
    assert.equal(r.status, 400, `accepted junk as ciphertext: ${JSON.stringify(r.json)}`);
  }
  assert.equal(all('SELECT id FROM messages WHERE circle_id = ? AND enc_kind IS NOT NULL', id).length, 0);
});

test('attack: a real MLS message of ANOTHER chat, replayed into this one, is refused (group id is in the header)', async () => {
  const a = await chat('direct'), b = await chat('direct');
  const s = await b.devs[0].seal(b.id, 'for chat b');
  const r = await postMsg(a.devs[0], a.id, { ciphertext: toB64(s.ciphertext), kind: 'text', epoch: epochNow(a.id) });
  assert.equal(r.status, 400, JSON.stringify(r.json));
});

test('attack: the epoch in the plain header must be the epoch the ciphertext was made in (it drives the removal gate, so a lie would dodge it)', async () => {
  const { id, devs, owner, others } = await chat('group', 2);
  const s = await devs[0].seal(id, 'honest');
  const lie = await postMsg(devs[0], id, { ciphertext: toB64(s.ciphertext), kind: 'text', epoch: s.epoch + 1 });
  assert.notEqual(lie.status, 201, 'claimed a different epoch than the one inside the ciphertext');
  // the removal gate: after a removal a message from the OLD epoch must not get through by claiming the new one
  await call(owner.cookie, `/api/circles/${id}/members/${others[1].id}`, 'DELETE');
  const min = one('SELECT e2ee_min_epoch m FROM circles WHERE id = ?', id)!.m as number;
  const old = await devs[0].seal(id, 'sent with the keys the removed person still holds');
  const dodge = await postMsg(devs[0], id, { ciphertext: toB64(old.ciphertext), kind: 'text', epoch: min });
  assert.notEqual(dodge.status, 201, 'a message in the old epoch got past the removal gate by claiming the new epoch');
});

test('attack: authenticated_data is sent in the clear in MLS: a member cannot smuggle readable text there', async () => {
  const { id, devs } = await chat('direct');
  const { createApplicationMessage, encodeMlsMessage, getCiphersuiteImpl, getCiphersuiteFromName } = await import('ts-mls');
  const cs = await getCiphersuiteImpl(getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'));
  const g = devs[0].groups.get(id)!;
  const r = await createApplicationMessage(g, new TextEncoder().encode('x'), cs, new TextEncoder().encode('READABLE-aad-MARKER-2'));
  const bytes = encodeMlsMessage({ privateMessage: r.privateMessage, wireformat: 'mls_private_message', version: 'mls10' });
  const res = await postMsg(devs[0], id, { ciphertext: toB64(bytes), kind: 'text', epoch: Number(g.groupContext.epoch) });
  assert.notEqual(res.status, 201, 'cleartext authenticated data was stored');
});

test('attack: a commit that is not a commit of this chat at the next epoch (junk, an old commit replayed, another chat\'s commit) is refused, so it cannot stall everyone', async () => {
  const { id, devs } = await chat('group', 2);
  const other = await chat('direct');
  const old = one('SELECT data FROM e2ee_commits WHERE circle_id = ? AND epoch = 1', id)!.data as Uint8Array;
  const foreign = (await rotateKeys(other.devs[0].groups.get(other.id)!)).commit;
  const next = epochNow(id) + 1;
  for (const [name, bytes] of [['junk', new Uint8Array(200).fill(7)], ['replayed old commit', new Uint8Array(old)], ['commit of another chat', foreign]] as const) {
    const r = await postCommit(devs[0], id, { epoch: next, commit: toB64(bytes), welcomes: [] });
    assert.notEqual(r.status, 201, `${name}: accepted`);
  }
  assert.equal(epochNow(id), next - 1, 'the chat\'s epoch moved on a bad commit');
});

test('attack: a welcome that is not an MLS welcome (readable bytes in a welcome slot) is refused', async () => {
  const { id, devs } = await chat('group', 2);
  const h = await rotateKeys(devs[0].groups.get(id)!);
  const r = await postCommit(devs[0], id, { epoch: epochNow(id) + 1, commit: toB64(h.commit), welcomes: [{ device: devs[1].deviceId, welcome: b64('READABLE-welcome-MARKER-3') }] });
  assert.notEqual(r.status, 201, 'a junk welcome was stored');
});

test('attack: a key package with a broken signature, a different ciphersuite or no end date is not accepted into the directory', async () => {
  const p = await person('مهاجم');
  const d = await call(p.cookie, '/api/keys/devices', 'POST', { label: 'x' });
  const idn = await newDeviceIdentity();
  const [kp] = await newKeyPackages(p.id, d.json.deviceId, 1, idn);
  const bad = new Uint8Array(kp.publicBytes); bad[bad.length - 3] ^= 0xff;   // inside the signature
  const r = await call(p.cookie, `/api/keys/devices/${d.json.deviceId}/packages`, 'POST', { packages: [toB64(bad)] });
  assert.equal(r.status, 400, 'a key package whose signature does not verify was stored');
});

// ---- (2) ex-member and member abuse ---------------------------------------------------------------------------------------------------------

test('attack: an ex-member keeps asking: every route of the chat, the files and the live socket stay closed', async () => {
  const { id, owner, others, devs } = await chat('group', 2);
  const photo = crypto.getRandomValues(new Uint8Array(2048));
  const up = await call(devs[0].p.cookie, `/api/circles/${id}/uploads`, 'POST', { name: 'blob', size: photo.length });
  await app.request(`/api/uploads/${up.json.id}?offset=0`, { method: 'PUT', headers: { cookie: devs[0].p.cookie }, body: photo });
  const sent = await devs[0].say(id, 'media', { uploads: [up.json.id] }, 'media');
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const mediaId = one('SELECT id FROM media WHERE circle_id = ?', id)!.id;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: others[1].cookie } });
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise<void>(r => ws.once('open', () => r()));
  await new Promise(r => setTimeout(r, 200));
  await call(owner.cookie, `/api/circles/${id}/members/${others[1].id}`, 'DELETE');
  await new Promise(r => setTimeout(r, 300));   // the removal's own notices (the person is told they are out) have arrived
  const settled = frames.length;
  const ex = others[1].cookie;
  try {
  for (const [m, path, body] of [
    ['GET', `/api/circles/${id}/messages?after=0`], ['GET', `/api/circles/${id}/e2ee`], ['GET', `/api/circles/${id}/e2ee/commits?after=0`], ['GET', `/api/circles/${id}/e2ee/welcomes?device=${devs[2].deviceId}`],
    ['GET', `/api/media/${mediaId}`], ['POST', `/api/circles/${id}/e2ee/messages`, { ciphertext: b64('x'), kind: 'text', epoch: 1 }], ['POST', `/api/circles/${id}/e2ee/commits`, { device: devs[2].deviceId, epoch: 99, commit: b64('x') }],
    ['POST', `/api/circles/${id}/uploads`, { name: 'x', size: 10 }], ['GET', `/api/circles/${id}`],
  ] as Array<[string, string, unknown?]>) {
    const r = await call(ex, path, m, body);
    assert.ok(r.status === 404 || r.status === 403, `${m} ${path} answered ${r.status} to an ex-member`);
  }
  await devs[0].say(id, 'after the removal, for the others');
  const h = await rotateKeys(devs[0].groups.get(id)!);
  await postCommit(devs[0], id, { epoch: epochNow(id) + 1, commit: toB64(h.commit), welcomes: [] });
  await new Promise(r => setTimeout(r, 400));
  assert.deepEqual(frames.slice(settled), [], `the ex-member's open socket still receives this chat: ${JSON.stringify(frames.slice(settled)).slice(0, 600)}`);
  } finally { ws.close(); }
});

test('attack: view-once media of an encrypted chat: the file cannot be fetched without "open", and a second open is refused', async () => {
  const { id, devs } = await chat('direct');
  const up = await call(devs[0].p.cookie, `/api/circles/${id}/uploads`, 'POST', { name: 'blob', size: 1024 });
  await app.request(`/api/uploads/${up.json.id}?offset=0`, { method: 'PUT', headers: { cookie: devs[0].p.cookie }, body: crypto.getRandomValues(new Uint8Array(1024)) });
  const sent = await devs[0].say(id, 'once', { uploads: [up.json.id], viewOnce: true }, 'media');
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const mediaId = one('SELECT id FROM media WHERE circle_id = ?', id)!.id;
  assert.notEqual((await call(devs[1].p.cookie, `/api/media/${mediaId}`)).status, 200, 'fetched without open');
  assert.notEqual((await call(devs[0].p.cookie, `/api/media/${mediaId}`)).status, 200, 'the sender got their own view-once file back');
  const open = await call(devs[1].p.cookie, `/api/messages/${sent.json.id}/open`, 'POST');
  assert.equal(open.status, 200, JSON.stringify(open.json));
});

test('attack: edit, reaction-style control messages and replies cannot point into another chat or at another person\'s message', async () => {
  const a = await chat('direct'), b = await chat('direct');
  const mine = await b.devs[0].say(b.id, 'in chat b');
  assert.equal((await a.devs[0].say(a.id, 'edit', { target: mine.json.id }, 'edit')).status, 404, 'edit of a message in another chat');
  const first = await a.devs[0].say(a.id, 'first');
  assert.equal((await a.devs[1].say(a.id, 'edit', { target: first.json.id }, 'edit')).status, 403, 'edit of someone else\'s message');
  const reply = await a.devs[0].say(a.id, 'reply', { replyTo: mine.json.id });
  assert.equal(one('SELECT reply_to r FROM messages WHERE id = ?', reply.json.id)!.r, null, 'a reply pointed into another chat');
});

test('attack: mentions name only members of the chat (a stranger cannot be pinged, and the list is bounded)', async () => {
  const { id, devs } = await chat('group', 1);
  const stranger = await person('غريب');
  const r = await devs[0].say(id, 'hi', { mentions: [stranger.id, devs[1].p.id, ...Array.from({ length: 500 }, (_, i) => 100000 + i)] });
  assert.equal(r.status, 201);
  const ids = all('SELECT user_id u FROM message_mentions WHERE message_id = ?', r.json.id).map(x => x.u);
  assert.deepEqual(ids, [devs[1].p.id]);
});

// ---- (3) a stranger on the same server, and a key package of another ciphersuite -----------------------------------------------------------------

test('attack: a stranger who knows the device numbers of someone else cannot read, write, retire or link them (every device route is the owner\'s only)', async () => {
  const { devs } = await chat('direct');
  const victim = devs[0], stranger = await person('غريب');
  const sc = stranger.cookie, d = victim.deviceId;
  const routes: Array<[string, string, unknown?]> = [
    ['POST', `/api/keys/devices/${d}/packages`, { packages: [] }], ['DELETE', `/api/keys/devices/${d}`], ['PUT', `/api/keys/devices/${d}/link`, { pub: 'A'.repeat(43), proof: '0'.repeat(64) }],
    ['PUT', `/api/keys/devices/${d}/transfer`, { part: 0, data: b64('x'), peer: 'A'.repeat(43) }], ['GET', `/api/keys/devices/${d}/transfer`], ['GET', `/api/keys/devices/${d}/transfer/0`], ['DELETE', `/api/keys/devices/${d}/transfer`],
    ['PUT', `/api/keys/devices/${d}/endorsement`, { by: d, sig: b64('x') }], ['GET', `/api/keys/users/${victim.p.id}`], ['POST', `/api/keys/users/${victim.p.id}/claim`],
  ];
  for (const [m, path, body] of routes) {
    const r = await call(sc, path, m, body);
    assert.ok(r.status === 404 || r.status === 400, `${m} ${path} answered ${r.status} to a stranger`);
  }
  assert.ok((await call(sc, '/api/keys/devices')).json.every((x: any) => x.id !== d), 'the device list shows someone else\'s device');
  assert.equal((await call(sc, '/api/keys/backup')).status, 404, 'a stranger got a backup');
  assert.equal(one('SELECT revoked_at r FROM e2ee_devices WHERE id = ?', d)!.r, null, 'a stranger retired the device');
});

test('attack: a key package of another ciphersuite (a weaker or different one) is not accepted: the suite is fixed, nothing is negotiated', async () => {
  const p = await person('مهاجم');
  const d = await call(p.cookie, '/api/keys/devices', 'POST', { label: 'x' });
  const { generateKeyPackage, defaultCapabilities, defaultLifetime, getCiphersuiteImpl, getCiphersuiteFromName, encodeMlsMessage } = await import('ts-mls');
  const cs = await getCiphersuiteImpl(getCiphersuiteFromName('MLS_128_DHKEMP256_AES128GCM_SHA256_P256'));
  const kp = await generateKeyPackage({ credentialType: 'basic', identity: new TextEncoder().encode(`u${p.id}.d${d.json.deviceId}`) }, defaultCapabilities(), defaultLifetime, [], cs);
  const bytes = encodeMlsMessage({ keyPackage: kp.publicPackage, wireformat: 'mls_key_package', version: 'mls10' });
  const r = await call(p.cookie, `/api/keys/devices/${d.json.deviceId}/packages`, 'POST', { packages: [toB64(bytes)] });
  assert.equal(r.status, 400, 'a key package of another ciphersuite was stored');
});

// ---- (5) metadata: exactly what the server may know, frozen so a new field cannot leak by accident -------------------------------------------------------

test('metadata audit: an encrypted message, as listed and as pushed live, carries only the documented fields and no readable value', async () => {
  const { id, devs } = await chat('direct');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: devs[1].p.cookie } });
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  try {
    await new Promise<void>(r => ws.once('open', () => r()));
    await new Promise(r => setTimeout(r, 200));
    const M = 'META-LEAK-MARKER-8';
    const r = await devs[0].say(id, M, { mentions: [devs[1].p.id] });
    assert.equal(r.status, 201);
    await until(() => frames.some(f => f.t === 'msg'));
    const live = frames.find(f => f.t === 'msg')?.m;
    assert.ok(live, 'no live frame arrived');
    const listed = (await call(devs[1].p.cookie, `/api/circles/${id}/messages?after=0`)).json.find((m: any) => m.id === r.json.id);
    const allowed = new Set(['id', 'seq', 'rev', 'userId', 'author', 'kind', 'body', 'transcript', 'hasAudio', 'archiveStatus', 'score', 'category', 'reason', 'createdAt', 'deleted', 'deletedBy', 'replyToId', 'replyTo', 'editedAt', 'forwardCount', 'mentions', 'playedBy',
      'expiresAt', 'expired', 'viewOnce', 'reactions', 'attachments', 'encKind', 'epoch', 'ciphertext', 'target', 'encrypted', 'card', 'poll', 'audioMs', 'waveform', 'starred', 'pinned', 'delivered', 'readBy', 'ticks', 'status', 'clientMsgId', 'edited', 'forwarded', 'sealed', 'sealedOn', 'archiveId']);
    const extra = [...Object.keys(listed), ...Object.keys(live)].filter(k => !allowed.has(k));
    assert.deepEqual(extra, [], `unexpected fields in an encrypted message: ${extra.join(', ')}`);
    for (const m of [listed, live]) for (const k of ['body', 'transcript', 'card', 'poll', 'waveform']) assert.ok(!m[k], `${k} holds something: ${JSON.stringify(m[k])}`);
    const wire = JSON.stringify([listed, frames]);
    assert.ok(!wire.includes(M) && !wire.includes(b64(M)), 'the text is in a listing or a live frame');
  } finally { ws.close(); }
});

// ---- (6) the library: hostile bytes (this is the code that parses what strangers send) -----------------------------------------------------------------

test('attack: damaged, truncated and padded bytes fed to every parser of the core either throw or are refused; they never hang, and the honest state is not harmed', async () => {
  const { id, devs } = await chat('direct');
  const [a, b] = devs;
  const gb = b.groups.get(id)!;
  const real = await a.seal(id, 'real message');
  const rot = await rotateKeys(a.groups.get(id)!);
  const kp = a.stock[1].publicBytes;
  const welcomeBytes = one('SELECT data FROM e2ee_welcomes WHERE circle_id = ? LIMIT 1', id)?.data as Uint8Array | undefined ?? new Uint8Array(rot.commit);
  const rnd = (n: number) => Math.floor(Math.random() * n);
  const mutate = (src: Uint8Array): Uint8Array => {
    const m = new Uint8Array(src);
    switch (rnd(5)) {
      case 0: for (let i = 0; i < 1 + rnd(4); i++) m[rnd(m.length)] ^= 1 << rnd(8); return m;
      case 1: return m.slice(0, rnd(m.length));
      case 2: return new Uint8Array([...m, ...crypto.getRandomValues(new Uint8Array(1 + rnd(64)))]);
      case 3: { const o = rnd(m.length); m.fill(0xff, o, Math.min(m.length, o + 1 + rnd(8))); return m; }
      default: return crypto.getRandomValues(new Uint8Array(1 + rnd(m.length * 2)));
    }
  };
  const { decrypt, describeMessage, describeKeyPackage, checkKeyPackage } = await import('../core/e2ee.ts');
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) {
    for (const [name, src] of [['message', real.ciphertext], ['commit', rot.commit], ['welcome', welcomeBytes], ['key package', kp]] as const) {
      const bad = mutate(src);
      if (Buffer.compare(Buffer.from(bad), Buffer.from(src)) === 0) continue;   // an unchanged copy is the real thing (it would use up the real message's key)
      try { describeMessage(bad); } catch { assert.fail(`describeMessage threw on a damaged ${name}`); }   // the server runs this on every post: it must never throw
      if (name === 'message') await decrypt(gb, bad).then(() => undefined, () => undefined);
      if (name === 'commit') await processCommit(gb, bad).then(() => undefined, () => undefined);
      if (name === 'welcome') await joinGroup(bad, b.stock[2]).then(() => undefined, () => undefined);
      if (name === 'key package') { await checkKeyPackage(bad); try { describeKeyPackage(bad); } catch { /* refused */ } }
    }
  }
  assert.ok(Date.now() - t0 < 60_000, 'parsing damaged bytes was far too slow');
  assert.equal((await decryptText(gb, real.ciphertext)).text, 'real message', 'the honest group state was damaged by hostile input');
});

test('attack: a copy of a message with junk bytes added at the end is not the same message (it would use up the real one\'s key and slip past a duplicate check)', async () => {
  const { id, devs } = await chat('direct');
  const [a, b] = devs;
  const real = await a.seal(id, 'real');
  const padded = new Uint8Array([...real.ciphertext, 1, 2, 3]);
  const { decrypt } = await import('../core/e2ee.ts');
  await assert.rejects(() => decrypt(b.groups.get(id)!, padded), 'a message with trailing bytes was decrypted');
  assert.equal((await decryptText(b.groups.get(id)!, real.ciphertext)).text, 'real', 'the real message was lost to the padded copy');
  const r = await postMsg(a, id, { ciphertext: toB64(padded), kind: 'text', epoch: real.epoch });
  assert.equal(r.status, 400, 'the server stored a message with bytes after the MLS message');
});

// ---- (3)+(6) malformed input must never crash the server or echo secrets -----------------------------------------------------------------------

test('attack: malformed bodies on every encryption route never answer 5xx, and a secret placed in a bad field is not logged or echoed', async () => {
  const { id, devs } = await chat('group', 1);
  const SECRET = 'LOGLEAK-MARKER-9';
  const logs: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a: unknown[]) => { logs.push(a.map(x => (x instanceof Error ? x.stack ?? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  const weird: unknown[] = [null, 1, 'x', [], {}, { ciphertext: SECRET }, { ciphertext: b64(SECRET), kind: { toString: SECRET }, epoch: SECRET }, { ciphertext: b64(SECRET), kind: 'text', epoch: 1e400 }, { ciphertext: b64(SECRET), kind: 'text', epoch: -1 },
    { ciphertext: b64(SECRET), kind: 'text', epoch: 1.5 }, { ciphertext: 'a'.repeat(300_000), kind: 'text', epoch: 1 }, { ciphertext: b64(SECRET), kind: 'text', epoch: 1, uploads: SECRET }, { ciphertext: b64(SECRET), kind: 'media', epoch: 1, uploads: [SECRET, 5, null, {}] },
    { ciphertext: b64(SECRET), kind: 'text', epoch: 1, mentions: [SECRET, {}, null], replyTo: SECRET, target: SECRET, clientMsgId: { a: SECRET } }, { device: SECRET, epoch: SECRET, commit: SECRET, welcomes: SECRET }, { device: devs[0].deviceId, epoch: 2, commit: b64(SECRET), welcomes: [null, 5, { device: SECRET, welcome: SECRET }] },
    { packages: SECRET, lastResort: { x: SECRET } }, { packages: [SECRET], lastResort: SECRET }, { packages: new Array(80).fill(b64(SECRET)) }, { by: SECRET, sig: SECRET }, { pub: SECRET, proof: SECRET }, { part: SECRET, data: SECRET }, { data: SECRET, version: SECRET }];
  const routes: Array<[string, string]> = [['POST', `/api/circles/${id}/e2ee/messages`], ['POST', `/api/circles/${id}/e2ee/commits`], ['POST', `/api/keys/devices/${devs[0].deviceId}/packages`], ['PUT', `/api/keys/devices/${devs[0].deviceId}/endorsement`],
    ['PUT', `/api/keys/devices/${devs[0].deviceId}/link`], ['PUT', `/api/keys/devices/${devs[0].deviceId}/transfer`], ['PUT', '/api/keys/backup'], ['POST', '/api/keys/devices']];
  try {
    for (const [m, path] of routes) for (const body of weird) {
      const r = await call(devs[0].p.cookie, path, m, body);
      assert.ok(r.status < 500, `${m} ${path} ${JSON.stringify(body).slice(0, 80)} answered ${r.status}`);
      assert.ok(!JSON.stringify(r.json).includes(SECRET), `${m} ${path} echoed the secret`);
    }
    for (const raw of ['{"ciphertext":', '\u0000\u0001', '[' .repeat(5000), `{"ciphertext":"${SECRET}`]) for (const [m, path] of routes) {
      const r = await call(devs[0].p.cookie, path, m, raw);
      assert.ok(r.status < 500, `${m} ${path} raw body answered ${r.status}`);
    }
  } finally { Object.assign(console, orig); }
  assert.ok(!logs.join('\n').includes(SECRET), 'a secret from a request body reached the server log');
});

// ---- (1) a server or its backups: nothing readable anywhere ----------------------------------------------------------------------------------

test('attack: the database file and a real backup of it hold no readable text after a busy chat (text, edit, reaction, poll, card, report)', async () => {
  const { id, devs } = await chat('direct');
  const M = 'BACKUP-LEAK-MARKER-5';
  await devs[0].say(id, M); await devs[0].say(id, M, {}, 'card'); await devs[0].say(id, M, { target: 1 }, 'ctl');
  await call(devs[1].p.cookie, '/api/reports', 'POST', { messageId: one('SELECT id FROM messages WHERE circle_id = ? LIMIT 1', id)?.id, reason: 'spam' });
  const { createBackup, backupRoot } = await import('./backup.ts');
  const m = await createBackup();
  const { readFileSync, readdirSync } = await import('node:fs');
  const snapshot = join(backupRoot(), m.id, 'thikra.db');
  assert.ok(readdirSync(join(backupRoot(), m.id)).includes('thikra.db'), 'no snapshot was written');
  const bytes = readFileSync(snapshot).toString('latin1');
  assert.ok(bytes.length > 10_000, 'the snapshot is empty');
  assert.ok(!bytes.includes(M), 'the backup file holds the marker');
});

// ---- open: attacks that still work and are documented (reported as todo, not failures) ---------------------------------------------------------

test('OPEN (documented): a member can post a well-formed but meaningless commit once; no one can repair that chat (availability, not secrecy)', { todo: 'inherent: the server cannot read a commit; there is no repair route yet' }, async () => {
  const { id, devs } = await chat('group', 2);
  const g = devs[0].groups.get(id)!;
  // a valid commit of a member who then throws the new state away: the others apply it fine, so this one is not a stall; the stall needs a commit that others cannot apply
  const h = await removeDevices(g, { userId: devs[1].p.id });
  const r = await postCommit(devs[0], id, { epoch: epochNow(id) + 1, commit: toB64(h.commit), welcomes: [] });
  assert.equal(r.status, 201);
  // devs[1] was removed inside MLS while still a member for the server: it cannot process the commit and nothing can put it back
  await assert.doesNotReject(() => processCommit(devs[1].groups.get(id)!, h.commit), 'a member can silently remove another member from the keys');
});

test('OPEN (documented): another person of a shared chat can drain the one-time key packages of a device (then the reusable last-resort one is used)', { todo: 'rate limited to 8 per hour per pair; a last-resort package is reused until the device tops up' }, async () => {
  const { devs } = await chat('group', 1);
  let last = 0;
  for (let i = 0; i < 8; i++) { const r = await call(devs[0].p.cookie, `/api/keys/users/${devs[1].p.id}/claim`, 'POST'); last = r.json.packages.filter((x: any) => x.lastResort).length; }
  assert.equal(last, 0, 'one person drained the stock to the last-resort package');
});

void decryptText;
