process.env.THIKRA_DEV = '1';   // these tests sign in with the on-screen code, which only exists in explicit development mode
// Step 6, part A: end-to-end encryption on the server (feature 26). Design: docs/superpowers/specs/2026-11-19-encryption-design.md, plan: ...-encryption-plan.md.
// The devices in these tests use the REAL encryption core (core/e2ee.ts, MLS): the server only ever sees bytes it cannot read.

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_BACKUP = '0';
process.env.THIKRA_E2EE = '1';

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const blobDir = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));
process.env.THIKRA_BLOBS = blobDir;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import {
  addDevices, createGroup, decryptText, encryptText, endorseDevice, fromB64, join as joinGroup, newDeviceIdentity, newKeyPackages, processCommit, removeDevices, toB64, type DeviceIdentity, type Group, type StoredKeyPackage,
} from '../core/e2ee.ts';

const { app, startServer } = await import('./index.ts');
const { all, one, run } = await import('./db.ts');
const { analyze } = await import('./lib/messages.ts');
const { afterMessage, sendText } = await import('./lib/moments.ts');
const { attachLinkPreview } = await import('./lib/cards.ts');
const { setTransport } = await import('./push.ts');
const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
after(() => { server.close(); server.closeAllConnections?.(); });

const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
const form = async (cookie: string, path: string, fields: Array<[string, string | Blob, string?]>) => {
  const fd = new FormData();
  for (const [k, v, name] of fields) { if (v instanceof Blob) fd.append(k, v, name ?? 'f'); else fd.append(k, v); }
  const res = await app.request(path, { method: 'POST', headers: { cookie }, body: fd });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
/** Wait (up to 3 s) until something becomes true: the live frame and the push arrive after the HTTP answer, and a loaded machine is slower. */
const until = async (cond: () => boolean) => { for (let i = 0; i < 60 && !cond(); i++) await new Promise(r => setTimeout(r, 50)); };
let n = 0;
async function person(name: string) {
  const phone = `+96658${String(Date.now() % 100000).padStart(5, '0')}${String(n++).padStart(3, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, name, id: (await call(cookie, '/api/me')).json.id as number };
}
type P = Awaited<ReturnType<typeof person>>;

/** One device of one person, the way the web app will be: it registers, publishes key packages, keeps the secret halves and the group states. */
class Device {
  deviceId = 0;
  stock: StoredKeyPackage[] = [];
  identity!: DeviceIdentity;
  groups = new Map<number, Group>();
  seen = new Set<number>();   // MLS keys are used once: a message already decrypted is kept by the device, never decrypted again
  constructor(public p: P) {}
  static async make(p: P, packages = 6) {
    const d = new Device(p);
    const r = await call(p.cookie, '/api/keys/devices', 'POST', { label: 'test' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    d.deviceId = r.json.deviceId;
    d.identity = await newDeviceIdentity();
    d.stock = await newKeyPackages(p.id, d.deviceId, packages + 1, d.identity);
    const last = d.stock.pop()!;
    const up = await call(p.cookie, `/api/keys/devices/${d.deviceId}/packages`, 'POST', { packages: d.stock.map(k => toB64(k.publicBytes)), lastResort: toB64(last.publicBytes) });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    d.stock.push(last);
    return d;
  }
  /** The key package of mine that a welcome was made for. */
  mine(ref: Uint8Array) { return this.stock.find(k => Buffer.compare(Buffer.from(k.publicBytes), Buffer.from(ref)) === 0); }
  async claim(uid: number) {
    const r = await call(this.p.cookie, `/api/keys/users/${uid}/claim`, 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.packages as Array<{ deviceId: number; package: string }>;
  }
  /** Start a chat's encryption: make the group, add the other devices, post the commit with the welcomes. */
  async start(circle: number, others: Device[]) {
    const own = this.stock.shift()!;
    let g = await createGroup(`c${circle}`, own);
    const claimed: Array<{ dev: Device; pkg: Uint8Array }> = [];
    for (const o of others) for (const k of await this.claim(o.p.id)) if (k.deviceId === o.deviceId) claimed.push({ dev: o, pkg: fromB64(k.package) });
    const h = await addDevices(g, claimed.map(c => c.pkg));
    g = h.group;
    const r = await call(this.p.cookie, `/api/circles/${circle}/e2ee/commits`, 'POST', {
      device: this.deviceId, epoch: 1, commit: toB64(h.commit), welcomes: claimed.map(c => ({ device: c.dev.deviceId, welcome: toB64(h.welcome!) })),
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    this.groups.set(circle, g);
    for (const c of claimed) await c.dev.acceptWelcomes(circle, claimed.map(x => x.pkg));
    return g;
  }
  async acceptWelcomes(circle: number, packages: Uint8Array[]) {
    const r = await call(this.p.cookie, `/api/circles/${circle}/e2ee/welcomes?device=${this.deviceId}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    for (const w of r.json as Array<{ id: number; welcome: string }>) {
      let joined: Group | null = null;
      for (const pkg of packages) { const kp = this.mine(pkg); if (kp) { try { joined = await joinGroup(fromB64(w.welcome), kp); break; } catch { /* not for this package */ } } }
      if (joined) { this.groups.set(circle, joined); await call(this.p.cookie, `/api/e2ee/welcomes/${w.id}`, 'DELETE'); }
    }
  }
  async say(circle: number, text: string, extra: Record<string, unknown> = {}, kind = 'text') {
    const g = this.groups.get(circle)!;
    const { group, ciphertext } = await encryptText(g, text);
    this.groups.set(circle, group);
    return call(this.p.cookie, `/api/circles/${circle}/e2ee/messages`, 'POST', { ciphertext: toB64(ciphertext), kind, epoch: Number(g.groupContext.epoch), ...extra });
  }
  async read(circle: number) {
    const list = (await call(this.p.cookie, `/api/circles/${circle}/messages?after=0`)).json as any[];
    const out: string[] = [];
    for (const m of list) {
      if (!m.ciphertext || m.deleted) continue;
      if (m.userId === this.p.id || this.seen.has(m.id)) continue;   // MLS cannot decrypt what one sent oneself: the device keeps its own copy
      this.seen.add(m.id);
      const r = await decryptText(this.groups.get(circle)!, fromB64(m.ciphertext));
      this.groups.set(circle, r.group);
      out.push(r.text);
    }
    return out;
  }
}

async function chat(kind: 'direct' | 'group', extra = 1) {
  const owner = await person('ناصر');
  const others: P[] = [];
  for (let i = 0; i < extra; i++) others.push(await person(`عضو${i}`));
  let id: number;
  if (kind === 'direct') id = (await call(owner.cookie, '/api/direct', 'POST', { phone: await phoneOf(others[0]), encrypted: true })).json.id;
  else {
    id = (await call(owner.cookie, '/api/circles', 'POST', { name: 'سرّي', kind: 'group', encrypted: true })).json.id;
    const code = (await call(owner.cookie, `/api/circles/${id}`)).json.inviteCode as string;
    for (const o of others) await call(o.cookie, '/api/circles/join', 'POST', { code });
  }
  const devs = [await Device.make(owner), ...await Promise.all(others.map(o => Device.make(o)))];
  await devs[0].start(id, devs.slice(1));
  return { id, owner, others, devs };
}
async function phoneOf(p: P) { return (await call(p.cookie, '/api/me')).json.phone as string; }

// ---- schema and gate ----------------------------------------------------------------------------------------------------------------------

test('the migration adds the flag (off for everything that exists) and the key tables', () => {
  const cols = (t: string) => all(`PRAGMA table_info(${t})`).map(r => r.name as string);
  assert.ok(cols('circles').includes('encrypted') && cols('circles').includes('e2ee_epoch') && cols('circles').includes('e2ee_min_epoch'));
  assert.ok(['ciphertext', 'enc_kind', 'epoch', 'ctl_target'].every(c => cols('messages').includes(c)));
  for (const t of ['e2ee_devices', 'e2ee_key_packages', 'e2ee_commits', 'e2ee_welcomes']) assert.ok(cols(t).length, t);
  assert.equal(one('SELECT COUNT(*) n FROM circles WHERE encrypted != 0')!.n, 0);
});

test('encryption is off unless the server turns it on: nothing can be created encrypted, nothing changes for anyone', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  process.env.THIKRA_E2EE = '0';
  try {
    assert.equal((await call(a.cookie, '/api/keys/status')).json.enabled, false);
    const g = await call(a.cookie, '/api/circles', 'POST', { name: 'x', kind: 'group', encrypted: true });
    assert.equal(g.status, 409); assert.equal(g.json.error, 'e2ee_unavailable');
    const d = await call(a.cookie, '/api/direct', 'POST', { phone: await phoneOf(b), encrypted: true });
    assert.equal(d.status, 409); assert.equal(d.json.error, 'e2ee_unavailable');
    assert.equal((await call(a.cookie, '/api/keys/devices', 'POST', { label: 'x' })).status, 409);
    // a plain group and a plain direct chat still work exactly as before
    assert.equal((await call(a.cookie, '/api/circles', 'POST', { name: 'x', kind: 'group' })).status, 201);
    assert.equal((await call(a.cookie, '/api/direct', 'POST', { phone: await phoneOf(b) })).status, 201);
  } finally { process.env.THIKRA_E2EE = '1'; }
});

test('a family circle can never be encrypted; a group or a direct chat can, at creation only', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const fam = await call(a.cookie, '/api/circles', 'POST', { name: 'العائلة', encrypted: true });
  assert.equal(fam.status, 409); assert.equal(fam.json.error, 'circle_not_encryptable');
  const circle = (await call(a.cookie, '/api/circles', 'POST', { name: 'العائلة' })).json.id;
  assert.equal(one('SELECT encrypted FROM circles WHERE id = ?', circle)!.encrypted, 0);
  const g = await call(a.cookie, '/api/circles', 'POST', { name: 'سرّي', kind: 'group', encrypted: true });
  assert.equal(g.status, 201);
  const d = await call(a.cookie, '/api/direct', 'POST', { phone: await phoneOf(b), encrypted: true });
  assert.equal(d.status, 201);
  assert.equal(one('SELECT encrypted, kind FROM circles WHERE id = ?', d.json.id)!.encrypted, 1);
  assert.equal((await call(a.cookie, `/api/circles/${g.json.id}`)).json.encrypted, true);
  assert.equal((await call(a.cookie, `/api/circles/${circle}`)).json.encrypted, false);
  assert.ok((await call(a.cookie, '/api/circles')).json.find((c: any) => c.id === g.json.id).encrypted === true);
});

test('the type of a chat cannot be changed by any request', async () => {
  const a = await person('ناصر');
  const enc = (await call(a.cookie, '/api/circles', 'POST', { name: 'سرّي', kind: 'group', encrypted: true })).json.id;
  const plain = (await call(a.cookie, '/api/circles', 'POST', { name: 'عادي', kind: 'group' })).json.id;
  for (const body of [{ encrypted: false }, { encrypted: 0 }, { kind: 'circle' }, { agentActive: true }]) await call(a.cookie, `/api/circles/${enc}`, 'PATCH', body);
  await call(a.cookie, `/api/circles/${plain}`, 'PATCH', { encrypted: true, e2ee_epoch: 9 });
  const conv = await call(a.cookie, `/api/circles/${enc}/convert`, 'POST');
  assert.equal(conv.status, 409); assert.equal(conv.json.error, 'encrypted_chat');
  const row = one('SELECT encrypted, kind, agent_active, e2ee_epoch FROM circles WHERE id = ?', enc)!;
  assert.deepEqual([row.encrypted, row.kind, row.agent_active], [1, 'group', 0]);
  const p = one('SELECT encrypted, e2ee_epoch FROM circles WHERE id = ?', plain)!;
  assert.deepEqual([p.encrypted, p.e2ee_epoch], [0, 0]);
  assert.equal((await call(a.cookie, `/api/circles/${plain}/convert`, 'POST')).status, 200, 'a plain group still becomes a family circle');
});

// ---- the key directory ------------------------------------------------------------------------------------------------------------------

test('a device registers, publishes key packages that really belong to it, and others claim one per device', async () => {
  const a = await person('ناصر'), b = await person('سارة'), c = await person('خالد');
  await call(a.cookie, '/api/circles', 'POST', { name: 'سرّي', kind: 'group', encrypted: true }).then(async r => {
    const code = (await call(a.cookie, `/api/circles/${r.json.id}`)).json.inviteCode;
    await call(b.cookie, '/api/circles/join', 'POST', { code });
  });
  const d1 = await Device.make(b, 3);
  const mine = (await call(b.cookie, '/api/keys/devices')).json as any[];
  assert.equal(mine.length, 1); assert.equal(mine[0].stock, 3); assert.equal(typeof mine[0].identityKey, 'string');
  // someone else cannot add packages to my device, and garbage or someone else's name inside a package is refused
  assert.equal((await call(a.cookie, `/api/keys/devices/${d1.deviceId}/packages`, 'POST', { packages: [] })).status, 404);
  assert.equal((await call(b.cookie, `/api/keys/devices/${d1.deviceId}/packages`, 'POST', { packages: [toB64(new Uint8Array([1, 2, 3]))] })).status, 400);
  const intruder = await Device.make(a, 1);
  const stolen = await newKeyPackages(a.id, intruder.deviceId, 1, intruder.identity);   // a's own device name, offered under b's device
  assert.equal((await call(b.cookie, `/api/keys/devices/${d1.deviceId}/packages`, 'POST', { packages: [toB64(stolen[0].publicBytes)] })).status, 400);
  const wrongKey = await newKeyPackages(b.id, d1.deviceId, 1, await newDeviceIdentity());   // right name, but a different identity key than the device registered
  assert.equal((await call(b.cookie, `/api/keys/devices/${d1.deviceId}/packages`, 'POST', { packages: [toB64(wrongKey[0].publicBytes)] })).status, 400, 'one device, one identity key');
  // claiming: a person who shares no chat with me is not visible
  assert.equal((await call(c.cookie, `/api/keys/users/${b.id}/claim`, 'POST')).status, 404);
  assert.equal((await call(c.cookie, `/api/keys/users/${b.id}`)).status, 404);
  const first = (await call(a.cookie, `/api/keys/users/${b.id}/claim`, 'POST')).json.packages as any[];
  assert.equal(first.length, 1); assert.equal(first[0].deviceId, d1.deviceId); assert.equal(first[0].lastResort, false);
  assert.equal((await call(b.cookie, '/api/keys/devices')).json[0].stock, 2);
  const view = (await call(a.cookie, `/api/keys/users/${b.id}`)).json;
  assert.deepEqual(view.devices.map((d: any) => d.id), [d1.deviceId]);
  assert.equal(view.devices[0].identityKey, mine[0].identityKey);
});

test('when the one-time packages run out the last-resort one is handed out again (and never consumed)', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const code = (await call(a.cookie, '/api/circles', 'POST', { name: 'سرّي', kind: 'group', encrypted: true }).then(async r => (await call(a.cookie, `/api/circles/${r.json.id}`)).json.inviteCode));
  await call(b.cookie, '/api/circles/join', 'POST', { code });
  const d = await Device.make(b, 1);
  const got: any[] = [];
  for (let i = 0; i < 4; i++) got.push((await call(a.cookie, `/api/keys/users/${b.id}/claim`, 'POST')).json.packages[0]);
  assert.equal(got[0].lastResort, false);
  assert.ok(got.slice(1).every(g => g.lastResort === true && g.package === got[1].package));
  assert.equal(d.deviceId, got[0].deviceId);
});

test('a revoked device is no longer offered, and every encrypted chat of its person is told to change keys', async () => {
  const { id, owner, others, devs } = await chat('group', 2);
  const second = await Device.make(others[0]);
  const before = one('SELECT e2ee_epoch AS e, e2ee_min_epoch AS m FROM circles WHERE id = ?', id)!;
  assert.equal((await call(others[0].cookie, `/api/keys/devices/${second.deviceId}`, 'DELETE')).status, 200);
  const view = (await call(owner.cookie, `/api/keys/users/${others[0].id}`)).json;
  assert.ok(!view.devices.some((d: any) => d.id === second.deviceId));
  assert.equal((await call(owner.cookie, `/api/keys/users/${others[0].id}/claim`, 'POST')).json.packages.every((p: any) => p.deviceId !== second.deviceId), true);
  const after = one('SELECT e2ee_epoch AS e, e2ee_min_epoch AS m FROM circles WHERE id = ?', id)!;
  assert.equal(after.m, before.e + 1, 'a new epoch is required before anyone may send');
  assert.equal((await call(owner.cookie, `/api/circles/${id}/e2ee`)).json.rekeyNeeded, true);
  void devs;
});

// ---- messages in a private chat and in an ordinary group, with real encryption ----------------------------------------------------------

test('a private chat: the two devices read each other, and the server stores only bytes', async () => {
  const { id, devs } = await chat('direct');
  const [a, b] = devs;
  const sent = await a.say(id, 'مرحبا SECRET-HELLO-1');
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  assert.deepEqual(await b.read(id), ['مرحبا SECRET-HELLO-1']);
  const row = one('SELECT body, search_text, transcript, kind, enc_kind, epoch, length(ciphertext) AS n FROM messages WHERE id = ?', sent.json.id)!;
  assert.equal(row.body, ''); assert.equal(row.search_text, null); assert.equal(row.transcript, null);
  assert.equal(row.enc_kind, 'text'); assert.equal(row.epoch, 1); assert.ok(row.n > 20);
});

test('an ordinary group: all members read, and a removed member gets nothing more', async () => {
  const { id, owner, others, devs } = await chat('group', 2);
  const [a, b, c] = devs;
  assert.equal((await a.say(id, 'to everyone')).status, 201);
  assert.deepEqual(await b.read(id), ['to everyone']);
  assert.deepEqual(await c.read(id), ['to everyone']);
  // the owner removes the third person: the server refuses sending in the old epoch until a commit moves it on
  assert.equal((await call(owner.cookie, `/api/circles/${id}/members/${others[1].id}`, 'DELETE')).status, 200);
  const stale = await a.say(id, 'still the old keys');
  assert.equal(stale.status, 409); assert.equal(stale.json.error, 'rekey_required'); assert.equal(stale.json.minEpoch, 2);
  const h = await removeDevices(a.groups.get(id)!, { userId: others[1].id });
  const commit = await call(owner.cookie, `/api/circles/${id}/e2ee/commits`, 'POST', { device: a.deviceId, epoch: 2, commit: toB64(h.commit), welcomes: [] });
  assert.equal(commit.status, 201, JSON.stringify(commit.json));
  a.groups.set(id, h.group);
  const fetched = (await call(others[0].cookie, `/api/circles/${id}/e2ee/commits?after=1`)).json as any[];
  assert.deepEqual(fetched.map(f => f.epoch), [2]);
  b.groups.set(id, await processCommit(b.groups.get(id)!, fromB64(fetched[0].commit)));
  assert.equal((await a.say(id, 'only two of us now')).status, 201);
  assert.deepEqual(await b.read(id).then(r => r.at(-1)), 'only two of us now');
  // the removed person is out of the chat for the server, and could not decrypt it anyway
  assert.equal((await call(others[1].cookie, `/api/circles/${id}/messages?after=0`)).status, 404);
  assert.equal((await call(others[1].cookie, `/api/circles/${id}/e2ee/commits?after=0`)).status, 404);
  const last = one('SELECT ciphertext FROM messages WHERE circle_id = ? ORDER BY id DESC LIMIT 1', id)!;
  await assert.rejects(() => decryptText(c.groups.get(id)!, new Uint8Array(last.ciphertext)));
});

test('a person who joins later is added by a commit, and sees only what is sent after it', async () => {
  const { id, owner, devs } = await chat('group', 1);
  const [a, b] = devs;
  await a.say(id, 'before the newcomer');
  const late = await person('متأخر');
  await call(late.cookie, '/api/circles/join', 'POST', { code: (await call(owner.cookie, `/api/circles/${id}`)).json.inviteCode });
  const ld = await Device.make(late);
  const pkgs = (await a.claim(late.id)).map(k => fromB64(k.package));
  const h = await addDevices(a.groups.get(id)!, pkgs);
  assert.equal((await call(owner.cookie, `/api/circles/${id}/e2ee/commits`, 'POST', { device: a.deviceId, epoch: 2, commit: toB64(h.commit), welcomes: [{ device: ld.deviceId, welcome: toB64(h.welcome!) }] })).status, 201);
  a.groups.set(id, h.group);
  b.groups.set(id, await processCommit(b.groups.get(id)!, h.commit));
  ld.stock = ld.stock;   // its packages are the ones it published
  await ld.acceptWelcomes(id, pkgs);
  assert.ok(ld.groups.get(id), 'the welcome let the newcomer in');
  await a.say(id, 'after the newcomer');
  const list = (await call(late.cookie, `/api/circles/${id}/messages?after=0`)).json as any[];
  const mls = list.filter(m => m.ciphertext);
  // the server shows the newcomer the old ciphertext too (it is the same chat) but the keys for it do not exist
  let readable = 0;
  for (const m of mls) { try { const r = await decryptText(ld.groups.get(id)!, fromB64(m.ciphertext)); ld.groups.set(id, r.group); readable++; } catch { /* earlier epoch */ } }
  assert.equal(readable, 1, 'only the message after the commit');
});

test('commits and welcomes: one commit per epoch, welcomes only for devices of members, each device sees only its own', async () => {
  const { id, owner, others, devs } = await chat('group', 1);
  const [a, b] = devs;
  const g = a.groups.get(id)!;
  const rotate = await removeDevices(g, { identity: 'u0.d0' }).catch(() => null);
  assert.equal(rotate, null);
  const { rotateKeys } = await import('../core/e2ee.ts');
  const h = await rotateKeys(g);
  assert.equal((await call(owner.cookie, `/api/circles/${id}/e2ee/commits`, 'POST', { device: a.deviceId, epoch: 5, commit: toB64(h.commit), welcomes: [] })).status, 409, 'only the next epoch');
  assert.equal((await call(owner.cookie, `/api/circles/${id}/e2ee/commits`, 'POST', { device: b.deviceId, epoch: 2, commit: toB64(h.commit), welcomes: [] })).status, 403, 'a device that is not yours');
  const outsider = await person('غريب'), od = await Device.make(outsider);
  assert.equal((await call(owner.cookie, `/api/circles/${id}/e2ee/commits`, 'POST', { device: a.deviceId, epoch: 2, commit: toB64(h.commit), welcomes: [{ device: od.deviceId, welcome: toB64(h.commit) }] })).status, 400, 'a welcome for a non-member');
  const ok = await call(owner.cookie, `/api/circles/${id}/e2ee/commits`, 'POST', { device: a.deviceId, epoch: 2, commit: toB64(h.commit), welcomes: [] });
  assert.equal(ok.status, 201);
  const dup = await call(owner.cookie, `/api/circles/${id}/e2ee/commits`, 'POST', { device: a.deviceId, epoch: 2, commit: toB64(h.commit), welcomes: [] });
  assert.equal(dup.status, 409); assert.equal(dup.json.error, 'epoch_conflict'); assert.equal(dup.json.epoch, 2);
  // welcomes of the start: b's, listed only for b's own device and not for a's
  assert.equal((await call(owner.cookie, `/api/circles/${id}/e2ee/welcomes?device=${a.deviceId}`)).json.length, 0);
  assert.equal((await call(others[0].cookie, `/api/circles/${id}/e2ee/welcomes?device=${a.deviceId}`)).status, 403);
  void b;
});

test('the state of a chat: epoch, who may be a member, and the members\' device keys', async () => {
  const { id, owner, devs } = await chat('direct');
  const s = (await call(owner.cookie, `/api/circles/${id}/e2ee`)).json;
  assert.equal(s.epoch, 1); assert.equal(s.minEpoch, 0); assert.equal(s.rekeyNeeded, false);
  assert.deepEqual(s.devices.map((d: any) => d.deviceId).sort(), devs.map(d => d.deviceId).sort());
  assert.ok(s.devices.every((d: any) => typeof d.identityKey === 'string' && d.userId));
  const plain = (await call(owner.cookie, '/api/circles', 'POST', { name: 'x', kind: 'group' })).json.id;
  assert.equal((await call(owner.cookie, `/api/circles/${plain}/e2ee`)).status, 409);
});

test('the server tells a chat when its keys must change: a rekey frame on removal, an add frame on joining', async () => {
  const { id, owner, others } = await chat('group', 2);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: owner.cookie } });
  const frames: any[] = [];
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise<void>(r => ws.once('open', () => r()));
  await new Promise(r => setTimeout(r, 200));   // the gateway puts the socket in its chats just after it opens
  await call(owner.cookie, `/api/circles/${id}/members/${others[1].id}`, 'DELETE');
  await until(() => frames.some(f => f.t === 'e2ee'));
  assert.ok(frames.some(f => f.t === 'e2ee' && f.kind === 'rekey' && f.circle === id && f.minEpoch === 2), JSON.stringify(frames));
  ws.close();
});

// ---- attachments, voice, links, locations, mentions, edits: all ciphertext ---------------------------------------------------------------

const MARKERS = { text: 'PLAIN-text-MARKER-71', caption: 'PLAIN-caption-MARKER-72', file: 'holiday-beach-MARKER-73.jpg', link: 'https://example.com/MARKER-74-secret', place: 'Riyadh-MARKER-75', voice: 'PLAIN-voice-MARKER-76' };
async function uploadEncrypted(d: Device, circle: number, plain: string) {
  // the device encrypts the file itself before sending; here its "file" is random bytes that stand for a ciphertext, with its real name in the request
  const bytes = crypto.getRandomValues(new Uint8Array(4096));
  const up = await call(d.p.cookie, `/api/circles/${circle}/uploads`, 'POST', { name: plain, size: bytes.length });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const put = await app.request(`/api/uploads/${up.json.id}?offset=0`, { method: 'PUT', headers: { cookie: d.p.cookie }, body: bytes });
  assert.equal(put.status, 200);
  return { id: up.json.id as string, bytes };
}
/** Every stored value of every table, and every file of the blob store, as one string to search. */
function everythingStored(): string {
  const parts: string[] = [];
  for (const { name } of all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    for (const row of all(`SELECT * FROM "${name}"`)) {
      for (const v of Object.values(row)) parts.push(v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : String(v));
    }
  }
  const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else parts.push(readFileSync(p).toString('latin1')); } };
  walk(blobDir);
  return parts.join('\n');
}
async function sendEverything(d: Device, circle: number) {
  const out: Array<{ status: number; json: any }> = [];
  out.push(await d.say(circle, MARKERS.text));                                                       // text
  const photo = await uploadEncrypted(d, circle, MARKERS.file);                                      // photo: file and thumbnail
  const thumb = await uploadEncrypted(d, circle, 'thumb-' + MARKERS.file);
  out.push(await d.say(circle, JSON.stringify({ caption: MARKERS.caption, name: MARKERS.file, key: 'k' }), { uploads: [photo.id, thumb.id], kind: 'media' }));
  const voice = await uploadEncrypted(d, circle, MARKERS.voice + '.webm');                           // voice note
  out.push(await d.say(circle, JSON.stringify({ waveform: [1, 2, 3], ms: 1234, note: MARKERS.voice }), { uploads: [voice.id], kind: 'voice' }));
  out.push(await d.say(circle, JSON.stringify({ type: 'link', url: MARKERS.link, title: MARKERS.link }), { kind: 'card' }));   // link card (made on the device)
  out.push(await d.say(circle, JSON.stringify({ type: 'location', name: MARKERS.place, lat: 24.7136, lng: 46.6753 }), { kind: 'card' }));   // location
  return out;
}
const leaks = (hay: string) => Object.values(MARKERS).filter(m => hay.includes(m));

test('a private chat: after text, a photo, a voice note, a link and a location, no readable trace is stored anywhere', async () => {
  const { id, devs } = await chat('direct');
  const results = await sendEverything(devs[0], id);
  for (const r of results) assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(all('SELECT id FROM messages WHERE circle_id = ? AND enc_kind IS NOT NULL', id).length, 5);
  assert.deepEqual(leaks(everythingStored()), []);
  // and the other device reads all five
  assert.equal((await devs[1].read(id)).length, 5);
  // the files are stored as opaque files: no name, no type, no thumbnail link
  const files = all("SELECT kind, mime, name, width, height, duration_ms, waveform, thumb_of FROM media WHERE circle_id = ?", id);
  assert.equal(files.length, 3);
  for (const f of files) assert.deepEqual([f.kind, f.mime, f.name, f.width, f.duration_ms, f.waveform, f.thumb_of], ['file', 'application/octet-stream', null, null, null, null, null]);
  assert.equal(all('SELECT name FROM uploads WHERE circle_id = ?', id).every(u => u.name === 'blob'), true, 'the file name the device told the upload route is not kept');
});

test('an ordinary group: the same five kinds of message leave no readable trace', async () => {
  const { id, devs } = await chat('group', 2);
  for (const r of await sendEverything(devs[1], id)) assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(leaks(everythingStored()), []);
  assert.equal((await devs[0].read(id)).length, 5);
  assert.equal((await devs[2].read(id)).length, 5);
});

test('the listing and the live frame carry the ciphertext, its kind and its epoch, and nothing readable', async () => {
  const { id, owner, devs } = await chat('direct');
  await devs[0].say(id, 'x1', {}, 'text');
  const m = ((await call(owner.cookie, `/api/circles/${id}/messages?after=0`)).json as any[]).find(x => x.ciphertext)!;
  assert.deepEqual([m.encKind, m.epoch, m.body, m.transcript], ['text', 1, '', null]);
  const list = (await call(devs[1].p.cookie, '/api/circles')).json.find((c: any) => c.id === id);
  assert.deepEqual([list.encrypted, list.lastText, list.lastKind, list.lastMessage], [true, '', 'encrypted', null]);
});

test('mentions: the device sends user ids and the server notes them (nothing is read from text)', async () => {
  const { id, devs } = await chat('group', 2);
  const r = await devs[0].say(id, 'hey @sara', { mentions: [devs[1].p.id, 999999, devs[0].p.id] });
  assert.equal(r.status, 201);
  assert.deepEqual(all('SELECT user_id FROM message_mentions WHERE message_id = ?', r.json.id).map(x => x.user_id), [devs[1].p.id]);
  assert.equal((await call(devs[1].p.cookie, '/api/circles')).json.find((c: any) => c.id === id).mentioned, true);
});

test('edit is a control message: only the sender, only a text message, inside the edit window; it never counts as unread', async () => {
  const { id, devs } = await chat('direct');
  const [a, b] = devs;
  const sent = await a.say(id, 'first draft');
  const e = await a.say(id, JSON.stringify({ text: 'second draft' }), { kind: 'edit', target: sent.json.id });
  assert.equal(e.status, 201, JSON.stringify(e.json));
  assert.ok(one('SELECT edited_at FROM messages WHERE id = ?', sent.json.id)!.edited_at);
  assert.equal((await b.say(id, '{}', { kind: 'edit', target: sent.json.id })).status, 403, 'not the sender');
  assert.equal((await a.say(id, '{}', { kind: 'edit', target: 999999 })).status, 404);
  const list = (await call(b.p.cookie, '/api/circles')).json.find((c: any) => c.id === id);
  assert.equal(list.unread, 1, 'the edit is not a new message');
  run("UPDATE messages SET created_at = datetime('now', '-1 hour') WHERE id = ?", sent.json.id);
  assert.equal((await a.say(id, '{}', { kind: 'edit', target: sent.json.id })).status, 403, 'the 15 minutes are over');
});

test('delete works on an encrypted message and leaves no ciphertext behind', async () => {
  const { id, devs } = await chat('direct');
  const sent = await devs[0].say(id, 'oops');
  assert.equal((await call(devs[0].p.cookie, `/api/messages/${sent.json.id}`, 'DELETE')).status, 200);
  const row = one('SELECT ciphertext, deleted_at FROM messages WHERE id = ?', sent.json.id)!;
  assert.equal(row.ciphertext, null); assert.ok(row.deleted_at);
});

test('a retry with the same client message id returns the original; limits and the epoch window are enforced', async () => {
  const { id, devs } = await chat('direct');
  const a = devs[0];
  const one1 = await a.say(id, 'once', { clientMsgId: 'cm-1' });
  assert.equal(one1.status, 201);
  const g = a.groups.get(id)!;
  const again = await call(a.p.cookie, `/api/circles/${id}/e2ee/messages`, 'POST', { ciphertext: toB64(new Uint8Array(40)), kind: 'text', epoch: 1, clientMsgId: 'cm-1' });
  assert.equal(again.status, 200); assert.equal(again.json.id, one1.json.id);
  assert.equal((await call(a.p.cookie, `/api/circles/${id}/e2ee/messages`, 'POST', { ciphertext: toB64(new Uint8Array(70_000)), kind: 'text', epoch: 1 })).status, 413);
  assert.equal((await call(a.p.cookie, `/api/circles/${id}/e2ee/messages`, 'POST', { ciphertext: 'not base64 !!', kind: 'text', epoch: 1 })).status, 400);
  assert.equal((await call(a.p.cookie, `/api/circles/${id}/e2ee/messages`, 'POST', { ciphertext: toB64(new Uint8Array(40)), kind: 'banana', epoch: 1 })).status, 400);
  assert.equal((await call(a.p.cookie, `/api/circles/${id}/e2ee/messages`, 'POST', { ciphertext: toB64(new Uint8Array(40)), kind: 'text', epoch: 7 })).status, 409, 'an epoch the group has not reached');
  void g;
});

test('"only admins send" applies to encrypted posting and uploads too (every posting route goes through mayPost)', async () => {
  const { id, owner, devs } = await chat('group', 1);
  await call(owner.cookie, `/api/circles/${id}`, 'PATCH', { sendPolicy: 'admins' });
  const r = await devs[1].say(id, 'let me in');
  assert.equal(r.status, 403); assert.equal(r.json.error, 'admins_only');
  assert.equal((await call(devs[1].p.cookie, `/api/circles/${id}/uploads`, 'POST', { name: 'x', size: 10 })).status, 403);
  assert.equal((await devs[0].say(id, 'owner may')).status, 201);
});

test('disappearing messages still work: the timer needs no text', async () => {
  const { id, owner, devs } = await chat('group', 1);
  assert.equal((await call(owner.cookie, `/api/circles/${id}/disappearing`, 'PUT', { seconds: 86400 })).status, 200);
  const r = await devs[0].say(id, 'gone tomorrow');
  assert.ok(one('SELECT expires_at FROM messages WHERE id = ?', r.json.id)!.expires_at);
});

// ---- every path that reads text refuses or skips an encrypted chat ----------------------------------------------------------------

test('path: plain text over HTTP is refused (and over the live gateway: the same function)', async () => {
  const { id, owner } = await chat('direct');
  const r = await call(owner.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'hello server' });
  assert.equal(r.status, 409); assert.equal(r.json.error, 'encrypted_chat');
  assert.throws(() => sendText(id, owner.id, 'hello server', null), (e: any) => e.code === 'encrypted_chat');
  assert.equal(one('SELECT COUNT(*) n FROM messages WHERE circle_id = ? AND body != ?', id, '')!.n, 0);
});
test('path: a plain voice note, plain attachments, plain cards and polls are refused', async () => {
  const { id, owner } = await chat('group', 1);
  const v = await form(owner.cookie, `/api/circles/${id}/voice`, [['audio', new Blob([Buffer.from('fake-audio')], { type: 'audio/webm' }), 'a.webm'], ['transcript', 'PLAIN-transcript-MARKER']]);
  assert.equal(v.status, 409);
  const at = await form(owner.cookie, `/api/circles/${id}/attachments`, [['file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'note.txt'], ['caption', 'PLAIN-caption-MARKER']]);
  assert.equal(at.status, 409);
  assert.equal((await call(owner.cookie, `/api/circles/${id}/cards`, 'POST', { type: 'location', lat: 1, lng: 2, name: 'PLAIN-place-MARKER' })).status, 409);
  assert.equal((await call(owner.cookie, `/api/circles/${id}/polls`, 'POST', { question: 'PLAIN-question-MARKER', options: ['a', 'b'] })).status, 409);
  assert.equal(one('SELECT COUNT(*) n FROM messages WHERE circle_id = ? AND kind != ?', id, 'system')!.n, 0);
  assert.equal(leaks2('PLAIN-'), false);
});
const leaks2 = (needle: string) => everythingStored().includes(needle);

test('path: the old edit route is refused (an edit is a control message)', async () => {
  const { id, devs } = await chat('direct');
  const sent = await devs[0].say(id, 'x');
  const r = await call(devs[0].p.cookie, `/api/messages/${sent.json.id}`, 'PATCH', { body: 'PLAIN-edit-MARKER' });
  assert.equal(r.status, 409);
  assert.equal(leaks2('PLAIN-edit-MARKER'), false);
});
test('path: forward is refused from an encrypted chat and into one', async () => {
  const { id, owner, devs } = await chat('direct');
  const other = (await call(owner.cookie, '/api/circles', 'POST', { name: 'عادي', kind: 'group' })).json.id as number;
  const plainMsg = (await call(owner.cookie, `/api/circles/${other}/messages`, 'POST', { body: 'plain words' })).json.id as number;
  const encMsg = (await devs[0].say(id, 'cipher')).json.id as number;
  assert.equal((await call(owner.cookie, `/api/messages/${encMsg}/forward`, 'POST', { circles: [other] })).status, 409, 'out of an encrypted chat');
  assert.equal((await call(owner.cookie, `/api/messages/${plainMsg}/forward`, 'POST', { circles: [id] })).status, 409, 'into an encrypted chat');
  assert.equal(one('SELECT COUNT(*) n FROM messages WHERE circle_id = ? AND forward_count > 0', id)!.n, 0);
});
test('path: server search does not work in an encrypted chat (the device searches its own history)', async () => {
  const { id, owner, devs } = await chat('direct');
  await devs[0].say(id, 'findable');
  const r = await call(owner.cookie, `/api/circles/${id}/search?q=findable`);
  assert.equal(r.status, 409); assert.equal(r.json.error, 'encrypted_chat');
});
test('path: the memory analysis is skipped (analyze, afterMessage, a manual archive request)', async () => {
  const { id, owner, devs } = await chat('group', 1);
  run('UPDATE circles SET agent_active = 1 WHERE id = ?', id);   // even if someone forced the agent on
  const m = (await devs[0].say(id, 'wasiyya-like words the archive would love')).json.id as number;
  analyze(id, m, 'تم تسجيل وصية العائلة: هذا مهم جدا للأرشيف', true);
  afterMessage(id, owner.id, 'مات جدي رحمه الله', m);
  assert.equal(one('SELECT archive_status FROM messages WHERE id = ?', m)!.archive_status, 'none');
  assert.equal(one('SELECT COUNT(*) n FROM archive_entries WHERE circle_id = ?', id)!.n, 0);
  assert.equal(one('SELECT COUNT(*) n FROM sealed_evidence WHERE circle_id = ?', id)!.n, 0);
  assert.equal((await call(owner.cookie, `/api/messages/${m}/archive`, 'POST')).status, 409);
});
test('path: a link card is never attached by the server', async () => {
  const { id, owner, devs } = await chat('direct');
  const m = (await devs[0].say(id, 'link inside')).json.id as number;
  assert.equal(attachLinkPreview(id, m, owner.id, 'https://example.com/x', { url: 'https://example.com/x', title: 'T' }), false);
  assert.equal(one('SELECT COUNT(*) n FROM message_cards WHERE message_id = ?', m)!.n, 0);
});
test('path: the push says only that something arrived (no text, no sender, no file kind)', async () => {
  const { id, devs } = await chat('group', 1);
  const sent: any[] = [];
  setTransport(async (_s, payload) => { sent.push(JSON.parse(payload)); });
  try {
    await call(devs[1].p.cookie, '/api/push/subscribe', 'POST', { endpoint: 'https://push.example.test/e2ee', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });
    await devs[0].say(id, 'PLAIN-push-MARKER');
    await until(() => sent.length >= 1);
    assert.ok(sent.length >= 1, 'a push went out');
    for (const p of sent) { assert.equal(p.body, 'رسالة جديدة'); assert.equal(p.title, 'Tamtim'); assert.equal(p.circle, id); assert.doesNotMatch(JSON.stringify(p), /MARKER|ناصر|عضو/); }
  } finally { setTransport(null); }
});
test('path: a report carries what the reporting device sends, marked as unverified', async () => {
  const { id, devs } = await chat('direct');
  const m = (await devs[0].say(id, 'something bad')).json.id as number;
  const r = await call(devs[1].p.cookie, `/api/messages/${m}/report`, 'POST', { reason: 'abuse', snapshot: 'the words the reporter chose to share' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = one('SELECT snapshot, unverified FROM reports WHERE message_id = ?', m)!;
  assert.deepEqual([row.snapshot, row.unverified], ['the words the reporter chose to share', 1]);
});
test('path: the export of an encrypted chat says it is encrypted and carries nothing to read', async () => {
  const { id, devs } = await chat('direct');
  await devs[0].say(id, 'PLAIN-export-MARKER');
  const res = await app.request('/api/me/export', { headers: { cookie: devs[0].p.cookie } });
  assert.equal(res.status, 200);
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const path = Object.keys(files).find(f => f.startsWith(`circles/${id}-`) && f.endsWith('messages.json'))!;
  assert.equal(JSON.parse(strFromU8(files[path])).encrypted, true);
  assert.ok(!Object.values(files).some(f => Buffer.from(f).toString('latin1').includes('PLAIN-export-MARKER')));
  assert.ok(!Object.keys(files).some(f => f.startsWith(`circles/${id}-`) && f.includes('/files/')), 'no encrypted files in the export either');
});
test('backstop: even a new route that forgets the check cannot store plain text in an encrypted chat', async () => {
  const { id, owner } = await chat('group', 1);
  const { insertMessage } = await import('./lib/helpers.ts');
  assert.throws(() => insertMessage({ circleId: id, userId: owner.id, kind: 'text', body: 'sneaky' }), (e: any) => e.code === 'encrypted_chat');
  assert.throws(() => insertMessage({ circleId: id, userId: owner.id, kind: 'voice', body: '', transcript: 'sneaky' }), (e: any) => e.code === 'encrypted_chat');
  assert.doesNotThrow(() => insertMessage({ circleId: id, userId: null, kind: 'system', body: 'sys:{"k":"joined","a":{}}' }));
});

// ---- family circles behave exactly as before ----------------------------------------------------------------------------------------------

test('a family circle still reads, searches, analyses and previews text, and its messages carry no encryption fields', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const id = (await call(a.cookie, '/api/circles', 'POST', { name: 'العائلة' })).json.id as number;
  await call(b.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${id}`)).json.inviteCode });
  assert.equal((await call(a.cookie, `/api/circles/${id}/messages`, 'POST', { body: 'سنجتمع يوم الجمعة' })).status, 201);
  assert.equal((await call(b.cookie, `/api/circles/${id}/search?q=الجمعة`)).json.length, 1);
  const m = ((await call(b.cookie, `/api/circles/${id}/messages?after=0`)).json as any[]).find(x => x.body === 'سنجتمع يوم الجمعة')!;
  for (const k of ['ciphertext', 'encKind', 'epoch', 'target']) assert.ok(!(k in m), `${k} must not appear on a family message`);
  const list = (await call(b.cookie, '/api/circles')).json.find((c: any) => c.id === id);
  assert.equal(list.lastText, 'سنجتمع يوم الجمعة'); assert.equal(list.encrypted, false);
  assert.equal((await call(a.cookie, `/api/circles/${id}/e2ee/messages`, 'POST', { ciphertext: toB64(new Uint8Array(40)), kind: 'text', epoch: 0 })).status, 409, 'no encrypted posting into a readable chat');
  assert.equal((await call(a.cookie, `/api/circles/${id}/e2ee`)).status, 409);
});

// ---- fixes from the independent review ----------------------------------------------------------------------------------------------------

test('review: a sealed letter cannot be written in an encrypted chat (its text would sit readable until release), and a release never posts into one', async () => {
  const { id, owner } = await chat('group', 1);
  const r = await call(owner.cookie, `/api/circles/${id}/sealed`, 'POST', { body: 'PLAIN-sealed-MARKER', trigger: 'date', unlockAt: new Date(Date.now() + 86400_000 * 3).toISOString() });
  assert.ok([409, 403].includes(r.status), String(r.status));
  assert.equal(one('SELECT COUNT(*) n FROM sealed_messages WHERE circle_id = ?', id)!.n, 0);
  assert.equal(leaks2('PLAIN-sealed-MARKER'), false);
  const { releaseOne } = await import('./lib/sealed.ts');
  run("INSERT INTO sealed_messages (circle_id, author_id, body, unlock_at, status, sealed_on, kind) VALUES (?, ?, 'x', datetime('now', '-1 day'), 'sealed', datetime('now'), 'text')", id, owner.id);
  const row = one('SELECT * FROM sealed_messages WHERE circle_id = ?', id)!;
  assert.equal(await releaseOne(row), false);
  assert.equal(one('SELECT status FROM sealed_messages WHERE id = ?', row.id)!.status, 'stopped');
});

test('review: deleting an account keeps the chat\'s commit history, and tells its encrypted chats to change keys', async () => {
  const { id, others, devs } = await chat('group', 2);
  const h = await (await import('../core/e2ee.ts')).rotateKeys(devs[1].groups.get(id)!);
  assert.equal((await call(others[0].cookie, `/api/circles/${id}/e2ee/commits`, 'POST', { device: devs[1].deviceId, epoch: 2, commit: toB64(h.commit), welcomes: [] })).status, 201);
  const before = one('SELECT e2ee_epoch AS e FROM circles WHERE id = ?', id)!.e as number;
  assert.equal((await call(others[0].cookie, '/api/me', 'DELETE')).status, 200);
  assert.deepEqual(all('SELECT epoch FROM e2ee_commits WHERE circle_id = ? ORDER BY epoch', id).map(r => r.epoch), [1, 2], 'no hole in the chain');
  assert.equal(one('SELECT e2ee_min_epoch AS m FROM circles WHERE id = ?', id)!.m, before + 1);
});

test('review: one person cannot drain another person\'s key packages', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const code = (await call(a.cookie, '/api/circles', 'POST', { name: 'سرّي', kind: 'group', encrypted: true }).then(async r => (await call(a.cookie, `/api/circles/${r.json.id}`)).json.inviteCode));
  await call(b.cookie, '/api/circles/join', 'POST', { code });
  await Device.make(b, 50);
  let blocked = 0;
  for (let i = 0; i < 20; i++) if ((await call(a.cookie, `/api/keys/users/${b.id}/claim`, 'POST')).status === 429) blocked++;
  assert.ok(blocked >= 8, 'a few per hour per person is plenty to start chats');
  assert.ok((await call(b.cookie, '/api/keys/devices')).json[0].stock >= 40);
});

test('review: a revoked device\'s waiting welcomes go, and it cannot list welcomes', async () => {
  const { id, others, devs } = await chat('group', 1);
  const second = await Device.make(others[0]);
  const g = devs[0].groups.get(id)!;
  const { addDevices } = await import('../core/e2ee.ts');
  const pkg = (await devs[0].claim(others[0].id)).find(k => k.deviceId === second.deviceId)!;
  const h = await addDevices(g, [fromB64(pkg.package)]);
  await call(devs[0].p.cookie, `/api/circles/${id}/e2ee/commits`, 'POST', { device: devs[0].deviceId, epoch: 2, commit: toB64(h.commit), welcomes: [{ device: second.deviceId, welcome: toB64(h.welcome!) }] });
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_welcomes WHERE to_device_id = ?', second.deviceId)!.n, 1);
  await call(others[0].cookie, `/api/keys/devices/${second.deviceId}`, 'DELETE');
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_welcomes WHERE to_device_id = ?', second.deviceId)!.n, 0);
  assert.equal((await call(others[0].cookie, `/api/circles/${id}/e2ee/welcomes?device=${second.deviceId}`)).status, 403);
});

test('review: the people list prefers the encrypted private chat when a pair has both', async () => {
  const a = await person('ناصر'), b = await person('سارة');
  const code = (await call(a.cookie, '/api/circles', 'POST', { name: 'عائلة' }).then(async r => (await call(a.cookie, `/api/circles/${r.json.id}`)).json.inviteCode));
  await call(b.cookie, '/api/circles/join', 'POST', { code });
  const plain = (await call(a.cookie, '/api/direct', 'POST', { userId: b.id })).json.id;
  const enc = (await call(a.cookie, '/api/direct', 'POST', { userId: b.id, encrypted: true })).json.id;
  assert.notEqual(plain, enc);
  assert.equal((await call(a.cookie, '/api/people')).json.find((p: any) => p.id === b.id).chatId, enc);
});

// ---- part B additions (web client): control messages, plain reactions, the recovery backup --------------------------------------------------

test('part B: a "ctl" control message (reaction, poll vote) is stored as bytes, wakes nobody, and is never unread or the last message', async () => {
  const { id, devs } = await chat('direct');
  const [a, b] = devs;
  const first = await a.say(id, 'hello');
  assert.equal(first.status, 201);
  const sent: any[] = [];
  setTransport(async (_s: any, payload: string) => { sent.push(JSON.parse(payload)); });
  const c = await b.say(id, '{"t":"react"}', { kind: 'ctl' });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  await new Promise(r => setTimeout(r, 150));
  assert.equal(sent.length, 0, 'a control message wakes nobody');
  const list = (await call(a.p.cookie, '/api/circles')).json.find((x: any) => x.id === id);
  assert.equal(list.unread, 0, 'a control message is not unread');
  assert.equal(list.lastKind, 'encrypted');
  const row = one('SELECT enc_kind FROM messages WHERE id = ?', c.json.id)!;
  assert.equal(row.enc_kind, 'ctl');
});

test('part B: the plain reaction route is refused in an encrypted chat (a reaction there is a control message; the emoji must not be stored readable)', async () => {
  const { id, devs } = await chat('direct');
  const m = await devs[0].say(id, 'x');
  const r = await call(devs[1].p.cookie, `/api/messages/${m.json.id}/react`, 'POST', { emoji: '👍' });
  assert.equal(r.status, 409); assert.equal(r.json.error, 'encrypted_chat');
  assert.equal(one('SELECT COUNT(*) n FROM reactions WHERE message_id = ?', m.json.id)!.n, 0);
});

test('part B: the recovery backup is stored as opaque bytes, only the owner reads it, and it can be replaced or removed', async () => {
  const p = await person('ناصر'), q = await person('سارة');
  assert.equal((await call(p.cookie, '/api/keys/backup')).status, 404);
  const blob = toB64(new Uint8Array([1, 2, 3, 4, 5, 250]));
  const put = await call(p.cookie, '/api/keys/backup', 'PUT', { data: blob, version: 1 });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const got = await call(p.cookie, '/api/keys/backup');
  assert.equal(got.status, 200); assert.equal(got.json.data, blob); assert.equal(got.json.version, 1);
  assert.equal((await call(q.cookie, '/api/keys/backup')).status, 404, 'another person has none');
  assert.equal((await call(p.cookie, '/api/keys/backup', 'PUT', { data: 'not base64 !!' })).status, 400);
  assert.equal((await call(p.cookie, '/api/keys/backup', 'PUT', { data: toB64(new Uint8Array(5 * 1024 * 1024)) })).status, 413);
  assert.equal((await call(p.cookie, '/api/keys/backup', 'DELETE')).status, 200);
  assert.equal((await call(p.cookie, '/api/keys/backup')).status, 404);
});

// ---- hardening: linking a second device (a short-lived, one-use pairing; the hand-over is opaque) ----------------------------------------------

test('hardening: a pairing is published once, expires, is used once; only the owner sets or reads it; the hand-over is opaque, bounded and removable', async () => {
  const p = await person('ناصر'), q = await person('سارة');
  await call(p.cookie, '/api/keys/devices', 'POST', { label: 'old' });
  const d2 = (await call(p.cookie, '/api/keys/devices', 'POST', { label: 'new' })).json.deviceId as number;
  const proof = 'ab'.repeat(32), pub = toB64(new Uint8Array(32).fill(5)), peer = toB64(new Uint8Array(32).fill(9));
  const row = async () => (await call(p.cookie, '/api/keys/devices')).json.find((d: any) => d.id === d2);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof: 'xyz', pub })).status, 400);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof, pub: toB64(new Uint8Array(5)) })).status, 400, 'a public key is 32 bytes');
  assert.equal((await call(q.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof, pub })).status, 404, 'only the device\'s own person');
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof, pub })).status, 200);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof: 'cd'.repeat(32), pub })).status, 409, 'an active pairing cannot be replaced');
  let r = await row();
  assert.equal(r.linkProof, proof); assert.equal(r.linkPub, pub);
  const left = r.linkExpiresAt - Math.floor(Date.now() / 1000);
  assert.equal(left > 100 && left <= 200, true, `a couple of minutes (${left} s)`);
  // a hand-over needs an active pairing and the older device's public key
  const part = (n: number, last = false, withPeer = n === 0) => ({ part: n, last, data: toB64(new Uint8Array(100).fill(n + 1)), ...(withPeer ? { peer } : {}) });
  assert.equal((await call(q.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(0))).status, 404);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', { ...part(0), peer: 'nope' })).status, 400);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(1))).status, 409, 'part 0 comes first');
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', { part: -1, last: false, data: toB64(new Uint8Array(3)) })).status, 400);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', { part: 0, last: false, peer, data: toB64(new Uint8Array(4 * 1024 * 1024)) })).status, 413);
  // expired: refused and no longer offered
  run('UPDATE e2ee_devices SET link_expires_at = 1 WHERE id = ?', d2);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(0))).status, 410, 'expired');
  assert.equal((await row()).linkProof, null, 'an expired pairing is not offered');
  // a new pairing replaces the expired one
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof, pub })).status, 200);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(0))).status, 200);
  // used once: no second hand-over, no longer offered
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(0))).status, 410, 'one use');
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof: 'ef'.repeat(32), pub })).status, 200, 'a used pairing may be replaced by a new one only after the hand-over is taken');
});

test('hardening: the hand-over parts are listed, read and removed only by the owner; a retired device keeps none', async () => {
  const p = await person('ناصر'), q = await person('سارة');
  await call(p.cookie, '/api/keys/devices', 'POST', { label: 'old' });
  const d2 = (await call(p.cookie, '/api/keys/devices', 'POST', { label: 'new' })).json.deviceId as number;
  const pub = toB64(new Uint8Array(32).fill(5)), peer = toB64(new Uint8Array(32).fill(9));
  await call(p.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof: 'ab'.repeat(32), pub });
  const part = (n: number, last = false) => ({ part: n, last, data: toB64(new Uint8Array(100).fill(n + 1)), ...(n === 0 ? { peer } : {}) });
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(0))).status, 200);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(1, true))).status, 200, 'later parts of a used pairing are accepted');
  assert.equal((await call(q.cookie, `/api/keys/devices/${d2}/transfer`)).status, 404);
  const list = (await call(p.cookie, `/api/keys/devices/${d2}/transfer`)).json;
  assert.deepEqual(list, { parts: [0, 1], complete: true, peer });
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer/1`)).json.data, part(1).data);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer/9`)).status, 404);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'DELETE')).status, 200);
  assert.deepEqual((await call(p.cookie, `/api/keys/devices/${d2}/transfer`)).json, { parts: [], complete: false, peer: null });
  await call(p.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof: 'cd'.repeat(32), pub });
  await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(0));
  await call(p.cookie, `/api/keys/devices/${d2}`, 'DELETE');
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_transfers WHERE device_id = ?', d2)!.n, 0);
});

test('review: parts left over from a failed hand-over never mix into the next one (part 0 starts clean)', async () => {
  const p = await person('ناصر');
  await call(p.cookie, '/api/keys/devices', 'POST', { label: 'old' });
  const d2 = (await call(p.cookie, '/api/keys/devices', 'POST', { label: 'new' })).json.deviceId as number;
  const pub = toB64(new Uint8Array(32).fill(5)), peer = toB64(new Uint8Array(32).fill(9));
  const part = (n: number, last = false) => ({ part: n, last, data: toB64(new Uint8Array(100).fill(n + 1)), ...(n === 0 ? { peer } : {}) });
  await call(p.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof: 'ab'.repeat(32), pub });
  await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(0));
  await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(1));
  await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(2));   // the upload stops here: no last part
  run('UPDATE e2ee_devices SET link_expires_at = 1 WHERE id = ?', d2);
  await call(p.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof: 'cd'.repeat(32), pub });   // a new pairing
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(0))).status, 200);
  assert.equal((await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', part(1, true))).status, 200);
  assert.deepEqual((await call(p.cookie, `/api/keys/devices/${d2}/transfer`)).json, { parts: [0, 1], complete: true, peer });
});

// ---- gaps step: a device vouches for another device of the same person; old hand-over pieces are cleaned -------------------------------------

test('gaps: an endorsement is stored only when the person\'s own device signed it for the other device\'s key; the directory shows it to the chat', async () => {
  const p = await person('ناصر'), q = await person('سارة');
  const d1 = await Device.make(p), d2 = await Device.make(p), dq = await Device.make(q);
  const c = (await call(p.cookie, '/api/direct', 'POST', { phone: (await call(p.cookie, '/api/me')).json.phone, encrypted: true })).status;   // (a chat with myself is refused; the circle below is the real one)
  void c;
  const circle = (await call(p.cookie, '/api/circles', 'POST', { name: 'g', kind: 'group', encrypted: true })).json.id as number;
  const code = (await call(p.cookie, `/api/circles/${circle}`)).json.inviteCode;
  await call(q.cookie, '/api/circles/join', 'POST', { code });
  const sig = toB64(await endorseDevice(d1.identity.signKey, p.id, d2.deviceId, d2.identity.publicKey));
  const put = (cookie: string, did: number, body: unknown) => call(cookie, `/api/keys/devices/${did}/endorsement`, 'PUT', body);
  assert.equal((await put(q.cookie, d2.deviceId, { by: d1.deviceId, sig })).status, 404, 'only the device\'s own person');
  assert.equal((await put(p.cookie, d2.deviceId, { by: dq.deviceId, sig })).status, 404, 'the signer must be the same person\'s device');
  assert.equal((await put(p.cookie, d2.deviceId, { by: d2.deviceId, sig })).status, 400, 'a device cannot vouch for itself');
  assert.equal((await put(p.cookie, d2.deviceId, { by: d1.deviceId, sig: toB64(new Uint8Array(64)) })).status, 400, 'a signature that does not fit is refused');
  const forged = toB64(await endorseDevice(dq.identity.signKey, p.id, d2.deviceId, d2.identity.publicKey));
  assert.equal((await put(p.cookie, d2.deviceId, { by: d1.deviceId, sig: forged })).status, 400, 'signed by another key');
  assert.equal((await put(p.cookie, d2.deviceId, { by: d1.deviceId, sig })).status, 200);
  const list = (await call(p.cookie, '/api/keys/devices')).json.find((d: any) => d.id === d2.deviceId);
  assert.deepEqual([list.endorsement, list.endorsedBy], [sig, d1.deviceId]);
  const dir = (await call(q.cookie, `/api/circles/${circle}/e2ee`)).json.devices.find((d: any) => d.deviceId === d2.deviceId);
  assert.equal(dir.endorsement, sig);
  assert.equal(dir.endorserKey, toB64(d1.identity.publicKey), 'the key of the device that vouched, even when it is retired later');
  const plain = (await call(q.cookie, `/api/circles/${circle}/e2ee`)).json.devices.find((d: any) => d.deviceId === d1.deviceId);
  assert.equal(plain.endorsement ?? null, null);
});

test('gaps: hand-over pieces older than an hour are removed by the clean-up (a hand-over nobody took, or one the person gave up)', async () => {
  const p = await person('ناصر');
  await call(p.cookie, '/api/keys/devices', 'POST', { label: 'old' });
  const d2 = (await call(p.cookie, '/api/keys/devices', 'POST', { label: 'new' })).json.deviceId as number;
  const pub = toB64(new Uint8Array(32).fill(5)), peer = toB64(new Uint8Array(32).fill(9));
  await call(p.cookie, `/api/keys/devices/${d2}/link`, 'PUT', { proof: 'ab'.repeat(32), pub });
  await call(p.cookie, `/api/keys/devices/${d2}/transfer`, 'PUT', { part: 0, last: true, data: toB64(new Uint8Array(50).fill(1)), peer });
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_transfers WHERE device_id = ?', d2)!.n, 1);
  const { purgeStaleTransfers } = await import('./lib/e2ee.ts');
  assert.equal(purgeStaleTransfers(), 0, 'a fresh hand-over stays');
  run("UPDATE e2ee_transfers SET created_at = datetime('now', '-2 hours') WHERE device_id = ?", d2);
  run('UPDATE e2ee_devices SET link_used_at = link_used_at - 7200 WHERE id = ?', d2);
  assert.equal(purgeStaleTransfers() >= 1, true);
  assert.equal(one('SELECT COUNT(*) n FROM e2ee_transfers WHERE device_id = ?', d2)!.n, 0);
  assert.deepEqual((await call(p.cookie, `/api/keys/devices/${d2}/transfer`)).json, { parts: [], complete: false, peer: null });
});

// ---- broadcast lists must use the encrypted private chats when the sender asks for them ------------------------------------------------------

test('broadcast: with encrypted:true each recipient\'s ENCRYPTED private chat is returned (made if missing, the existing one reused), and the plain default still works', async () => {
  const a = await person('مرسل'), b = await person('أول'), c = await person('ثان');
  const g = (await call(a.cookie, '/api/circles', 'POST', { name: 'مشتركة', kind: 'group' })).json;
  for (const x of [b, c]) await call(x.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${g.id}`)).json.inviteCode });
  const existing = (await call(a.cookie, '/api/direct', 'POST', { phone: await phoneOf(b), encrypted: true })).json.id as number;
  const lid = (await call(a.cookie, '/api/broadcast-lists', 'POST', { name: 'قائمة', members: [b.id, c.id] })).json.id;
  const enc = (await call(a.cookie, `/api/broadcast-lists/${lid}/chats`, 'POST', { encrypted: true })).json.chats as Array<{ userId: number; circleId: number; encrypted: boolean }>;
  assert.equal(enc.length, 2);
  for (const ch of enc) {
    assert.equal(ch.encrypted, true);
    assert.equal(one('SELECT encrypted FROM circles WHERE id = ?', ch.circleId)!.encrypted, 1, 'every chat it returns is encrypted');
  }
  assert.equal(enc.find(x => x.userId === b.id)!.circleId, existing, 'the existing encrypted chat is reused, not a new one');
  const plain = (await call(a.cookie, `/api/broadcast-lists/${lid}/chats`, 'POST', {})).json.chats as Array<{ circleId: number; encrypted: boolean }>;
  assert.equal(plain.every(x => x.encrypted === false && one('SELECT encrypted FROM circles WHERE id = ?', x.circleId)!.encrypted === 0), true, 'without the flag the answer is as before: plain chats');
});
test('broadcast: asking for encrypted chats while encryption is off on this server is refused, never silently plain', async () => {
  const mod = await import('./lib/e2ee.ts');
  const a = await person('مرسل'), b = await person('مستلم');
  const g = (await call(a.cookie, '/api/circles', 'POST', { name: 'م', kind: 'group' })).json;
  await call(b.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${g.id}`)).json.inviteCode });
  const lid = (await call(a.cookie, '/api/broadcast-lists', 'POST', { name: 'ق', members: [b.id] })).json.id;
  process.env.THIKRA_E2EE = '0';
  try {
    assert.equal(mod.e2eeEnabled(), false);
    const r = await call(a.cookie, `/api/broadcast-lists/${lid}/chats`, 'POST', { encrypted: true });
    assert.equal(r.status, 409); assert.equal(r.json.error, 'e2ee_unavailable');
  } finally { process.env.THIKRA_E2EE = '1'; }
});
