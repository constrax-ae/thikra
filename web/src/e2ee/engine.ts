// End-to-end encryption on the device (step 6, part B). One engine per signed-in person per browser; it runs the same in the browser and in the tests.
// Design: docs/superpowers/specs/2026-11-19-encryption-design.md; protocol and library (MLS, ts-mls): ...-encryption-plan.md. NOT AUDITED: nothing here may be called secure
// until an independent external review is done (docs/STATUS.md).
//
// What this file does, in one picture:
//   - this DEVICE has one identity key and a stock of one-time key packages the server hands out (so others can add it to a chat);
//   - a chat is an MLS group, every device is a member; the server only orders and carries bytes;
//   - before anything is sent or read the device (1) applies the commits it missed, (2) checks the chat's members against the server's directory (the server cannot check
//     what a commit does, so WE do: a commit that adds an unlisted device is refused, and a key that differs from the directory stops everything), (3) makes the commit that
//     removes or adds devices when the server says it must;
//   - every message is encrypted here, and every message read is decrypted here and KEPT here (MLS keys are used once: a message cannot be decrypted twice);
//   - nothing in the chat is readable on the server: the text, the card, the caption, the file names, the files, the thumbnails, the waveform, the reactions and the votes
//     are all inside ciphertext. The server sees who, when, which chat, the kind marker, the key epoch, sizes, the message answered, and the mentioned ids.

import * as core from '../../../core/e2ee';
import { fromB64, toB64, type Group, type StoredKeyPackage } from '../../../core/e2ee';
import type { Attachment, Card, Message } from '../api';
import { getJson, setJson, type Kv } from './kv';
import { decodePayload, encKindOf, encodePayload, isControl, type FileRef, type Payload } from './payload';
import { openFile, sealFile } from './files';
import { applyControl, emptyLedger, lineOf, mergeLedger, render, type Ledger, type Row } from './view';
import { deriveKey, newRecoveryCode, normaliseCode, openBackup, saltOf, sealBackup, validCode } from './backup';
import { openTransfer, sealTransfer, linkProof, linkKey, newLinkCode, newLinkKeys, normaliseLink, validLink, b64url, fromB64url, idTag, TRANSFER_KEYS } from './link';
import { markEncrypted } from './known';
import { linkPayload, parseLinkPayload, parseSafetyPayload, safetyPayload } from './qr';

// ---- the network, as the engine needs it ------------------------------------------------------------------------------------------------------

export class NetError extends Error {
  constructor(public status: number, public code: string, public data: Record<string, any> = {}) { super(code); }
}
export interface Net {
  /** A JSON call to the app's API (the path has no "/api" in front). Throws NetError. */
  json<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  /** A download (a stored file or media). */
  bytes(path: string): Promise<Uint8Array>;
  /** An upload piece. */
  put(path: string, body: Uint8Array): Promise<any>;
}
/** A mistake the engine itself names. `code` is what the screen translates. */
export class E2eeError extends Error { constructor(public code: string, public data: Record<string, any> = {}) { super(code); } }

export interface Env {
  net: Net;
  kv: Kv;
  /** A name for this device in the device list ("Chrome on Mac"). */
  label?: string;
  /** Runs `fn` while nothing else (another tab) uses `name`. The default only orders calls inside this tab; the browser passes Web Locks. */
  lock?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** Called after the engine changed something a screen may show (a chat joined, keys changed, a notice). */
  onChange?: (circle: number | null) => void;
  /** Keep the recovery backup up to date by itself (after changes, at most every few minutes). */
  autoBackup?: boolean;
}

export interface Dir { epoch: number; minEpoch: number; rekeyNeeded: boolean; devices: Array<{ userId: number; deviceId: number; identityKey: string; endorsement?: string | null; endorserKey?: string | null }> }
export interface Notice { id: string; at: number; userId: number; kind: 'keys_changed' | 'own_device_added' | 'device_waiting' | 'new_device_waiting' | 'new_device_unconfirmed' | 'gone'; detail?: { added?: number; removed?: number; deviceId?: number; code?: string } }
export interface DeviceInfo { deviceId: number; label: string | null; createdAt: string; mine: boolean; approved: boolean; identityKey: string | null; code: string | null; stock: number }
export interface PlainFile { bytes: Uint8Array; name: string; mime: string; w?: number | null; h?: number | null; thumb?: string }
export interface WaitingDevice { circle: number; userId: number; deviceId: number; code: string }
type WaitEntry = { userId: number; deviceId: number; key: string; dismissed?: boolean };
export interface SendOpts { cid?: string; replyTo?: number | null; mentions?: number[]; viewOnce?: boolean }
type Draft<P extends Payload = Payload> = P extends Payload ? Omit<P, 'v' | 'from'> : never;

const MAX_COMMIT_ROUNDS = 8;
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const hexToB64 = (h: string) => toB64(Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16)));
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
const ctHash = async (ct: Uint8Array) => hex(await sha(ct)).slice(0, 32);
const uuid = () => crypto.randomUUID();

/** Order calls that use the same name inside one tab. */
function memoryLocks() {
  const chains = new Map<string, Promise<unknown>>();
  return <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
    const run = (chains.get(name) ?? Promise.resolve()).then(fn, fn);
    chains.set(name, run.catch(() => undefined));
    return run;
  };
}

interface DeviceRecord { deviceId: number; label: string | null; signKey: string; publicKey: string }
interface PkgRecord { ref: string; pub: string; sec: string; lastResort?: boolean }
const PREFIX = { pendc: 'pendc:', tk: 'tk:', wait: 'waitdev:', drain: 'drain:', fail: 'fail:', pkg: 'pkg:', grp: 'grp:', pl: 'pl:', row: 'row:', own: 'oc:', pend: 'pend:', led: 'led:', notice: 'notice:', pin: 'pin:', last: 'last:', unconf: 'unconf:' };

export class E2ee {
  /** This device's number on the server (known after `ready`). */
  deviceId = 0;
  private dev: DeviceRecord | null = null;
  private lockFn: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  private kv: Kv;
  private net: Net;
  /** The browser opens its storage asynchronously: give it over before `ready`. */
  useKv(kv: Kv) { this.kv = kv; this.env.kv = kv; }
  private backupTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  readonly backup: { enable(): Promise<string>; saveNow(): Promise<{ dropped: number }>; enabled(): Promise<boolean>; disable(): Promise<void> };

  constructor(public readonly userId: number, private env: Env) {
    this.kv = env.kv; this.net = env.net; this.lockFn = env.lock ?? memoryLocks();
    const self = this;
    this.backup = {
      async enable() {
        const code = newRecoveryCode(), salt = crypto.getRandomValues(new Uint8Array(16));
        await setJson(self.kv, 'bk', { salt: toB64(salt), key: toB64(await deriveKey(code, salt)) });
        await self.backup.saveNow();
        return code;
      },
      async saveNow() {
        const m = await getJson<{ salt: string; key: string }>(self.kv, 'bk');
        if (!m) throw new E2eeError('backup_off');
        const { blob, dropped } = await sealBackup(self.kv, fromB64(m.key), fromB64(m.salt));
        await self.net.json('PUT', '/keys/backup', { data: toB64(blob), version: 1 });
        self.dirty = false;
        return { dropped };
      },
      enabled: async () => !!(await self.kv.get('bk')),
      async disable() { await self.kv.del('bk'); await self.net.json('DELETE', '/keys/backup').catch(() => undefined); },
    };
  }

  // ---- this device ----------------------------------------------------------------------------------------------------------------------------

  /**
   * Make this device ready: false when the server has encryption switched off (then nothing here does anything). Otherwise it registers the device once, keeps the key package
   * stock topped up, and returns true. Safe to call again and again.
   */
  async ready(): Promise<boolean> {
    const st = await this.net.json<{ enabled: boolean }>('GET', '/keys/status').catch(() => ({ enabled: false }));
    if (!st.enabled) return false;
    // Two tabs opening at the same moment must not each register a device: one at a time, the second finds the first's.
    this.dev = await this.devLock(async () => (await getJson<DeviceRecord>(this.kv, 'dev')) ?? this.register());
    this.deviceId = this.dev.deviceId;
    await this.topUp();
    return true;
  }
  private devLock<T>(fn: () => Promise<T>) { return this.lockFn(`thikra-e2ee-${this.userId}-device`, fn); }
  /** Make this device on the server and here. Callers hold the device lock. */
  private async register(): Promise<DeviceRecord> {
    const r = await this.net.json<{ deviceId: number }>('POST', '/keys/devices', { label: this.env.label ?? null });
    const id = await core.newDeviceIdentity();
    const made: DeviceRecord = { deviceId: r.deviceId, label: this.env.label ?? null, signKey: toB64(id.signKey), publicKey: toB64(id.publicKey) };
    await setJson(this.kv, 'dev', made);
    return made;
  }
  /**
   * Another tab shares this storage. Before anything is done in a chat, look at the stored device: if another tab made this device fresh, follow it; if another tab wiped the
   * storage ("forget this device"), stop (never write anything back into a store that was emptied).
   */
  private async followStoredDevice(): Promise<void> {
    let rec = await getJson<DeviceRecord>(this.kv, 'dev');
    if (!rec) rec = await this.devLock(() => getJson<DeviceRecord>(this.kv, 'dev'));   // another tab may be in the middle of making a new device
    if (!rec) throw new E2eeError('device_gone');
    if (!this.dev || rec.deviceId !== this.dev.deviceId) { this.dev = rec; this.deviceId = rec.deviceId; }
  }
  private get identity(): string { return core.identityOf(this.userId, this.deviceId); }
  private identityKey(): core.DeviceIdentity { return { signKey: fromB64(this.dev!.signKey), publicKey: fromB64(this.dev!.publicKey) }; }

  /** Keep about 20 one-time key packages on the server, and one last-resort package. The secret halves are saved BEFORE they are published. */
  private async topUp() {
    const mine = (await this.net.json<any[]>('GET', '/keys/devices')).find(d => d.id === this.deviceId);
    if (!mine || mine.revokedAt) throw new E2eeError('device_revoked');
    const hasLast = (await this.kv.keys(PREFIX.pkg)).length > 0 && !!(await getJson<string>(this.kv, 'lr'));
    if (mine.stock >= 10 && hasLast) return;
    const want = mine.stock >= 10 ? 0 : 20;
    const made = await core.newKeyPackages(this.userId, this.deviceId, want + (hasLast ? 0 : 1), this.identityKey());
    let last: StoredKeyPackage | undefined;
    if (!hasLast) last = made.pop();
    for (const k of [...made, ...(last ? [last] : [])]) await setJson(this.kv, PREFIX.pkg + k.ref, { ref: k.ref, pub: toB64(k.publicBytes), sec: toB64(k.secretBytes), lastResort: k === last } satisfies PkgRecord);
    if (last) await setJson(this.kv, 'lr', last.ref);
    await this.net.json('POST', `/keys/devices/${this.deviceId}/packages`, { packages: made.map(k => toB64(k.publicBytes)), ...(last ? { lastResort: toB64(last.publicBytes) } : {}) });
  }
  private async packages(): Promise<Array<StoredKeyPackage & { lastResort: boolean }>> {
    const out = [];
    for (const k of await this.kv.keys(PREFIX.pkg)) {
      const r = await getJson<PkgRecord>(this.kv, k);
      if (r) out.push({ ref: r.ref, publicBytes: fromB64(r.pub), secretBytes: fromB64(r.sec), lastResort: !!r.lastResort });
    }
    return out.sort((a, b) => Number(a.lastResort) - Number(b.lastResort));   // one-time packages first
  }
  private spend = async (k: { ref: string; lastResort: boolean }) => { if (!k.lastResort) await this.kv.del(PREFIX.pkg + k.ref); };

  /** The short code a new device shows so the person can recognise it on their other device. */
  static shortCode = async (identityKey: Uint8Array) => { const d = await sha(identityKey); let n = 0n; for (const b of d.slice(0, 8)) n = (n << 8n) | BigInt(b); const s = String(n % 10n ** 12n).padStart(12, '0'); return `${s.slice(0, 4)} ${s.slice(4, 8)} ${s.slice(8)}`; };   // 12 digits (about 40 bits): 8 digits could be ground for a look-alike key in minutes

  // ---- locks and small stores -----------------------------------------------------------------------------------------------------------------

  private lock<T>(circle: number, fn: () => Promise<T>) { return this.lockFn(`thikra-e2ee-${this.userId}-${circle}`, async () => { if (this.dev) await this.followStoredDevice(); return fn(); }); }
  private changed(circle: number | null) { try { this.env.onChange?.(circle); } catch { /* a screen's mistake must not stop encryption */ } this.dirty = true; this.scheduleBackup(); }
  private scheduleBackup(delay = 120_000) {
    if (!this.env.autoBackup) return;
    if (this.backupTimer) { if (delay >= 120_000) return; clearTimeout(this.backupTimer); }
    this.backupTimer = setTimeout(async () => { this.backupTimer = undefined; if (this.dirty && await this.backup.enabled()) await this.backup.saveNow().catch(() => undefined); }, delay);
    (this.backupTimer as any)?.unref?.();
  }

  // ---- chats: directory, state, commits ------------------------------------------------------------------------------------------------------

  private async directory(circle: number): Promise<Dir> {
    try { const d = await this.net.json<Dir>('GET', `/circles/${circle}/e2ee`); markEncrypted(circle); return d; }
    catch (e) { if (e instanceof NetError && e.code === 'not_encrypted') throw new E2eeError('not_encrypted'); throw e; }
  }
  /** Who may be a member: a device the server lists with exactly this identity key. */
  private trustFor(dir: Dir | null, lenient = false): core.Trust {
    return (identity, key) => {
      if (!dir) return true;
      const p = core.parseIdentity(identity);
      const d = p && dir.devices.find(x => x.userId === p.userId && x.deviceId === p.deviceId);
      // Lenient (joining a chat that still holds a device the server has since removed): only a LISTED device with a different key is refused.
      const ok = d ? eq(fromB64(d.identityKey), key) : lenient && !!p;
      if (!ok) this.refused = identity;
      return ok;
    };
  }
  private refused: string | null = null;
  private async load(circle: number, dir: Dir | null): Promise<Group | null> {
    const b = await this.kv.get(PREFIX.grp + circle);
    return b ? core.loadGroup(b, this.trustFor(dir)) : null;
  }
  private async save(circle: number, g: Group) {
    markEncrypted(circle);   // this device now holds keys for the chat: whatever the server says later, it is encrypted
    await this.kv.set(PREFIX.grp + circle, core.saveGroup(g));
    this.changed(circle);
  }
  /** The device keys this person has trusted in this chat, per person: a device that is (or was) a member, or that they accepted. A person with none yet is NEW: their first device is trusted on first sight. */
  private async trusted(circle: number): Promise<Record<string, string[]>> { return (await getJson<Record<string, string[]>>(this.kv, PREFIX.tk + circle)) ?? {}; }
  private async trustMembers(circle: number, list: Array<{ identity: string; key: string }>) {
    const tk = await this.trusted(circle);
    let changed = false;
    for (const m of list) {
      const p = core.parseIdentity(m.identity); if (!p) continue;
      const ks = (tk[p.userId] ??= []);
      if (!ks.includes(m.key)) { ks.push(m.key); changed = true; }
    }
    if (changed) {
      await setJson(this.kv, PREFIX.tk + circle, tk);
      // a device that is now a member (added by its person's own commit, say) is no longer "waiting"
      const w = (await getJson<WaitEntry[]>(this.kv, PREFIX.wait + circle)) ?? [];
      const rest = w.filter(x => x.dismissed || !(tk[x.userId] ?? []).includes(x.key));
      if (rest.length !== w.length) await setJson(this.kv, PREFIX.wait + circle, rest);
    }
  }
  /** The listed devices of one person that this device trusts: all of them while the person is new to this chat, afterwards only the trusted ones. */
  private trustedDevices(dir: Dir, uid: number, tk: Record<string, string[]>) {
    const mine = dir.devices.filter(d => d.userId === uid);
    const known = tk[uid];
    return known?.length ? mine.filter(d => known.includes(hex(fromB64(d.identityKey)))) : mine;
  }

  /** The group as this device has it (tests and the safety screen). */
  async __state(circle: number): Promise<{ group: Group; epoch: number }> {
    const g = await this.load(circle, null);
    if (!g) throw new E2eeError('not_ready');
    return { group: g, epoch: core.epochOf(g) };
  }
  async status(circle: number): Promise<'ok' | 'stuck' | 'waiting' | 'not_member'> {
    const s = await getJson<string>(this.kv, `stuck:${circle}`);
    if (s === 'not_member') return 'not_member';
    if (s) return 'stuck';
    return (await this.kv.get(PREFIX.grp + circle)) ? 'ok' : 'waiting';
  }
  async stuckReason(circle: number): Promise<string | null> { return (await getJson<string>(this.kv, `stuck:${circle}`)) ?? null; }
  /**
   * A restored copy that is behind: retire this device on the server, make a new one, keep everything the device has read, and let the other people's devices add it again.
   * (The chats' keys of the stale device are dropped; the history, the files' keys and the reactions stay.)
   */
  async startFresh(): Promise<void> {
    const old = this.deviceId;
    // The old device must really be retired on the server first: if that fails, nothing here changes (a half-fresh device would be neither).
    try { await this.net.json('DELETE', `/keys/devices/${old}`); } catch (e) { if (!(e instanceof NetError && e.status === 404)) throw e; }
    await this.devLock(async () => {   // other tabs wait here and then follow the new device
      for (const prefix of [PREFIX.grp, PREFIX.pendc, PREFIX.pkg, 'stuck:', 'joined:', 'approved:', PREFIX.drain, PREFIX.pend, PREFIX.unconf]) for (const k of await this.kv.keys(prefix)) await this.kv.del(k);
      for (const k of ['dev', 'lr', 'link']) await this.kv.del(k);
      this.dev = await this.register(); this.deviceId = this.dev.deviceId;
    });
    await this.ready();
    await this.syncAll().catch(() => undefined);
    this.changed(null);
  }
  private stuck = async (circle: number, why: string | null) => { if (why) console.warn('[e2ee] chat', circle, 'stopped:', why); if (why) await setJson(this.kv, `stuck:${circle}`, why); else await this.kv.del(`stuck:${circle}`); };

  /** Join from a welcome, if there is one for this device and we have no state yet. */
  private async tryJoin(circle: number, dir: Dir): Promise<Group | null> {
    const welcomes = await this.net.json<Array<{ id: number; epoch: number; welcome: string }>>('GET', `/circles/${circle}/e2ee/welcomes?device=${this.deviceId}`);
    if (!welcomes.length) return null;
    const pkgs = await this.packages();
    for (const w of welcomes) {
      for (const k of pkgs) {
        let g: Group;
        this.refused = null;
        try { g = await core.join(fromB64(w.welcome), k, this.trustFor(dir, true)); } catch { if (this.refused) { await this.stuck(circle, 'keys_mismatch'); throw new E2eeError('keys_mismatch', { identity: this.refused }); } continue; }
        // It must be THIS chat's group (whoever posted the welcome could have built any group).
        if (core.groupIdOf(g) !== `c${circle}`) { await this.stuck(circle, 'wrong_group'); throw new E2eeError('wrong_group'); }
        // The chat must be exactly the people the server says (or a subset waiting for a commit): never a member the directory does not know.
        const bad = this.untrusted(core.members(g), dir, true);
        if (bad) { await this.stuck(circle, 'untrusted_commit'); throw new E2eeError('untrusted_commit', { identity: bad }); }
        await this.save(circle, g);
        await setJson(this.kv, `joined:${circle}`, core.epochOf(g));
        await setJson(this.kv, `fs:${circle}`, 1);
        await this.spend(k);
        await this.net.json('DELETE', `/e2ee/welcomes/${w.id}`).catch(() => undefined);
        await this.stuck(circle, null);
        return g;
      }
    }
    return null;
  }
  /** The first member (by identity) that is not a listed device with the listed key; `allowRemoved` lets through devices the server no longer lists (they wait to be removed). */
  private untrusted(list: core.Member[], dir: Dir, allowRemoved: boolean): string | null {
    for (const m of list) {
      const p = core.parseIdentity(m.identity);
      const d = p && dir.devices.find(x => x.userId === p.userId && x.deviceId === p.deviceId);
      if (d) { if (!eq(fromB64(d.identityKey), m.signaturePublicKey)) return m.identity; }
      else if (!allowRemoved || !p) return m.identity;
    }
    return null;
  }
  /**
   * A commit this device posted whose answer never came back: the new state was kept aside BEFORE posting, so when the server turns out to hold that very commit (same epoch,
   * posted by this device) the kept state is adopted instead of leaving the device behind its own commit.
   */
  private async keepPending(circle: number, g: Group) { await this.kv.set(PREFIX.pendc + circle, core.saveGroup(g)); await setJson(this.kv, `${PREFIX.pendc}e:${circle}`, core.epochOf(g)); }
  private async dropPending(circle: number) { await this.kv.del(PREFIX.pendc + circle); await this.kv.del(`${PREFIX.pendc}e:${circle}`); }
  private async adoptPending(circle: number, epoch: number, device: number | undefined, dir: Dir | null): Promise<Group | null> {
    const kept = await this.kv.get(PREFIX.pendc + circle);
    if (!kept || device !== this.deviceId || (await getJson<number>(this.kv, `${PREFIX.pendc}e:${circle}`)) !== epoch) return null;
    const g = await core.loadGroup(kept, this.trustFor(dir));
    await this.save(circle, g);
    await this.dropPending(circle);
    return g;
  }
  /** Apply the commits this device missed, in order, checking each one against the directory. */
  private async applyCommits(circle: number, g: Group, dir: Dir): Promise<Group> {
    for (let guard = 0; guard < 20; guard++) {
      const list = await this.net.json<Array<{ epoch: number; commit: string; userId: number; device?: number }>>('GET', `/circles/${circle}/e2ee/commits?after=${core.epochOf(g)}`);
      if (!list.length) break;
      g = await this.catchUp(circle, g, Infinity);   // read everything this epoch can still read before the keys move on
      if (list.length > 1) g = await core.loadGroup(core.saveGroup(g), this.trustFor(dir, true));   // old commits may add devices that were removed again since: those are let through here, and the later commits remove them
      for (const c of list) {
        if (c.epoch !== core.epochOf(g) + 1) break;
        const before = new Set(core.members(g).map(m => m.identity));
        this.refused = null;
        let next: Group;
        const mine = await this.adoptPending(circle, c.epoch, c.device, dir);
        if (mine) { g = mine; continue; }
        try { next = await core.processCommit(g, fromB64(c.commit)); }
        catch {
          // A commit that removes this device, or one this device cannot trust.
          // A commit this very device made after the backup cannot be replayed from an older copy: the copy is behind and this chat cannot go on from it.
          const why = this.refused ? 'untrusted_commit' : (c as any).device === this.deviceId ? 'restored_behind' : 'bad_commit';
          await this.stuck(circle, why);
          throw new E2eeError(why, { epoch: c.epoch, identity: this.refused });
        }
        const added = core.members(next).filter(m => !before.has(m.identity));
        const bad = this.untrusted(added, dir, c.epoch < dir.epoch);   // only the newest state must match the directory
        if (bad) { await this.stuck(circle, 'untrusted_commit'); throw new E2eeError('untrusted_commit', { identity: bad, epoch: c.epoch }); }
        for (const m of core.members(g)) {   // a device somebody removed while the server still lists it: nobody puts it back without a yes
          const p = core.parseIdentity(m.identity);
          if (p && p.userId !== this.userId && !core.members(next).some(x => x.identity === m.identity) && dir.devices.some(d => d.userId === p.userId && d.deviceId === p.deviceId && eq(fromB64(d.identityKey), m.signaturePublicKey))) await this.holdBack(circle, p, hex(m.signaturePublicKey));
        }
        g = next;
        await this.save(circle, g);
        g = await this.catchUp(circle, g, Infinity);   // read what this epoch can read BEFORE the next commit moves the keys on
      }
    }
    return g;
  }

  /**
   * Bring this device up to date with one chat and return its group and the directory: join if a welcome waits, apply missed commits, start the chat if nobody has,
   * and (for a person who left) say so. Callers hold the chat's lock.
   */
  private async syncLocked(circle: number): Promise<{ g: Group | null; dir: Dir }> {
    let dir: Dir;
    try { dir = await this.directory(circle); }
    catch (e) { if (e instanceof NetError && e.status === 404) { await this.stuck(circle, 'not_member'); throw new E2eeError('not_member'); } throw e; }
    await this.stuck(circle, null).catch(() => undefined);
    let g = await this.load(circle, dir);
    if (!g && dir.epoch > 0 && await this.kv.get(PREFIX.pendc + circle)) {   // my first commit went through but its answer was lost
      const list = await this.net.json<Array<{ epoch: number; device?: number }>>('GET', `/circles/${circle}/e2ee/commits?after=0`);
      const first = list.find(x => x.epoch === 1);
      if (first) g = await this.adoptPending(circle, first.epoch, first.device, dir);
    }
    if (!g) g = await this.tryJoin(circle, dir);
    if (!g && dir.epoch === 0) g = await this.startLocked(circle, dir);
    if (!g) return { g: null, dir };
    g = await this.applyCommits(circle, g, dir);
    await this.audit(circle, g, dir);
    await this.noteKeys(circle, dir);
    return { g, dir };
  }
  /** Public: bring one chat up to date (join, catch up, repair). */
  async sync(circle: number): Promise<'ok' | 'stuck' | 'waiting' | 'not_member'> {
    return this.lock(circle, async () => {
      try {
        const { g, dir } = await this.syncLocked(circle);
        if (g) await this.reconcile(circle, g, dir);
      } catch (e) { if (!(e instanceof E2eeError)) throw e; }
      return this.status(circle);
    });
  }
  /** Public: start the chat's encryption if nobody has (the person who created the chat does this right away). Also joins and catches up. */
  async startChat(circle: number): Promise<void> {
    await this.lock(circle, async () => {
      const { g, dir } = await this.syncLocked(circle);
      if (g) await this.reconcile(circle, g, dir);
    });
  }
  /** Every encrypted chat this person is in. */
  async syncAll(): Promise<void> {
    await this.receiveHistory().catch(() => undefined);   // a device that was linked with a code takes the history its older device handed over
    const list = await this.net.json<Array<{ id: number; encrypted?: boolean }>>('GET', '/circles');
    for (const c of list.filter(x => x.encrypted)) await this.sync(c.id).catch(() => undefined);
  }

  /** Start: make the group, add every listed device that has key packages, post the first commit. */
  private async startLocked(circle: number, dir: Dir): Promise<Group | null> {
    const pkgs = await this.packages();
    const own = pkgs[0];
    if (!own) throw new E2eeError('no_key_packages');
    let g = await core.createGroup(`c${circle}`, own, this.trustFor(dir));
    const wanted = this.wantedDevices(dir);
    wanted.delete(this.identity);
    const who: Array<{ userId: number; deviceId: number }> = [];
    for (const id of wanted.keys()) { const p = core.parseIdentity(id)!; if (p.userId === this.userId && !(await this.approved(p.deviceId, dir))) continue; if (p.userId !== this.userId && await this.mustWaitFor(circle, dir, p)) continue; who.push(p); }   // my own other device: only after I approved it
    const claimed = await this.claim(dir, who);
    const h = claimed.length ? await core.addDevices(g, claimed.map(c => c.pkg)) : await core.rotateKeys(g);
    await this.keepPending(circle, h.group);
    try {
      await this.net.json('POST', `/circles/${circle}/e2ee/commits`, { device: this.deviceId, epoch: 1, commit: toB64(h.commit), welcomes: h.welcome ? claimed.map(c => ({ device: c.deviceId, welcome: toB64(h.welcome!) })) : [] });
    } catch (e) {
      if (e instanceof NetError && e.code === 'epoch_conflict') { await this.dropPending(circle); return null; }   // someone else started first: join theirs on the next pass
      throw e;
    }
    g = h.group;
    await this.save(circle, g);
    await this.confirmAdded(circle, claimed.map(c => c.pkg));
    await this.dropPending(circle);
    await setJson(this.kv, `joined:${circle}`, 1);
    await this.spend(own);
    return g;
  }
  /** The devices that should be in the chat, as identity -> key. Another person's listed devices all count; my OWN other devices count only once I approved them. */
  private wantedDevices(dir: Dir): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const d of dir.devices) out.set(core.identityOf(d.userId, d.deviceId), fromB64(d.identityKey));
    return out;
  }
  /** Is this device of mine approved? The approval is for one KEY: a device whose key changed since is not approved. */
  private async approved(deviceId: number, dir: { devices: Array<{ userId: number; deviceId: number; identityKey: string }> } | string | null): Promise<boolean> {
    if (deviceId === this.deviceId) return true;
    const was = await getJson<string>(this.kv, `approved:${deviceId}`);
    if (typeof was !== 'string') return false;
    const key = typeof dir === 'string' ? dir : dir?.devices.find(d => d.userId === this.userId && d.deviceId === deviceId)?.identityKey;
    return !!key && key === was;
  }

  /** One key package per wanted device: claimed from the server and checked against the directory (right name, right identity key). */
  private async claim(dir: Dir, who: Array<{ userId: number; deviceId: number }>): Promise<Array<{ deviceId: number; pkg: Uint8Array }>> {
    const out: Array<{ deviceId: number; pkg: Uint8Array }> = [];
    for (const uid of [...new Set(who.map(w => w.userId))]) {
      const r = await this.net.json<{ packages: Array<{ deviceId: number; package: string }> }>('POST', `/keys/users/${uid}/claim`);
      for (const p of r.packages) {
        if (!who.some(w => w.userId === uid && w.deviceId === p.deviceId)) continue;
        const bytes = fromB64(p.package);
        const d = core.describeKeyPackage(bytes);
        const listed = dir.devices.find(x => x.userId === uid && x.deviceId === p.deviceId);
        if (d.identity !== core.identityOf(uid, p.deviceId) || !listed || !eq(fromB64(listed.identityKey), d.signaturePublicKey)) throw new E2eeError('keys_mismatch', { identity: d.identity });
        out.push({ deviceId: p.deviceId, pkg: bytes });
      }
    }
    return out;
  }

  /**
   * Make the chat's members equal the server's list of devices, and satisfy a rekey the server asks for. Refuses (throws) when a member's key differs from the directory.
   * Callers hold the chat's lock. Returns the group after any commits.
   */
  private async reconcile(circle: number, g: Group, dir: Dir): Promise<Group> {
    for (let round = 0; round < MAX_COMMIT_ROUNDS; round++) {
      const want = this.wantedDevices(dir);
      const have = core.members(g);
      for (const m of have) { const k = want.get(m.identity); if (k && !eq(k, m.signaturePublicKey)) { await this.stuck(circle, 'keys_mismatch'); throw new E2eeError('keys_mismatch', { identity: m.identity }); } }
      const extra = have.filter(m => !want.has(m.identity) && m.identity !== this.identity);
      const missingIds = [...want.keys()].filter(id => !have.some(m => m.identity === id));
      const missing: Array<{ userId: number; deviceId: number }> = [];
      for (const id of missingIds) {
        const p = core.parseIdentity(id)!;
        if (p.userId === this.userId && !(await this.approved(p.deviceId, dir))) continue;   // my own other device: only after I approved it
        if (p.userId !== this.userId && await this.mustWaitFor(circle, dir, p)) continue;     // a later new device of someone I know: only after I say yes, or when their own device vouched for it
        if (p.userId === this.userId) await this.ensureEndorsed(p.deviceId, dir);              // so that the others can add it without asking
        missing.push(p);
      }
      if (!extra.length && !missing.length && dir.minEpoch <= core.epochOf(g)) return g;
      g = await this.catchUp(circle, g, Infinity);
      const epoch = core.epochOf(g);
      let h: core.Handshake, welcomeTo: number[] = [], addedPackages: Uint8Array[] = [];
      if (extra.length) h = await core.removeDevices(g, { identity: extra[0].identity });
      else if (missing.length) {
        const claimed = await this.claim(dir, missing);
        if (!claimed.length) { if (dir.minEpoch <= epoch) return g; h = await core.rotateKeys(g); }   // nobody to add yet (no packages): wait
        else { h = await core.addDevices(g, claimed.map(c => c.pkg)); welcomeTo = claimed.map(c => c.deviceId); addedPackages = claimed.map(c => c.pkg); }
      } else h = await core.rotateKeys(g);
      await this.keepPending(circle, h.group);
      try {
        await this.net.json('POST', `/circles/${circle}/e2ee/commits`, { device: this.deviceId, epoch: epoch + 1, commit: toB64(h.commit), welcomes: h.welcome ? welcomeTo.map(d => ({ device: d, welcome: toB64(h.welcome!) })) : [] });
      } catch (e) {
        if (e instanceof NetError && e.code === 'epoch_conflict') { await this.dropPending(circle); dir = await this.directory(circle); g = await this.applyCommits(circle, g, dir); continue; }
        throw e;
      }
      g = h.group;
      await this.save(circle, g);
      if (h.welcome) await this.confirmAdded(circle, (await Promise.resolve(addedPackages)));
      await this.dropPending(circle);
      this.scheduleBackup(4_000);   // a key change this device made cannot be replayed from an older copy: keep the backup right behind it
      dir = await this.directory(circle);
    }
    return g;
  }

  // ---- keys changing: pins, notices, safety numbers -----------------------------------------------------------------------------------------

  /**
   * Remember each person's device keys the first time; leave ONE calm notice in the chat when a person shows a key never seen before in this chat (a new device, a reinstall),
   * and forget that they were verified. Losing or removing a device is silent (nothing new to trust), a key that comes back is silent, and changes within an hour fold into
   * the notice already there, so switching phones never produces a row of notices. A person who disappears from the chat altogether (account deleted, or left) gets one
   * "gone" notice, and nothing more is sent to them: a number registered again later is a new account with new keys and is never put into the old chat.
   */
  private async pushNotice(circle: number, n: Omit<Notice, 'id' | 'at'>, fold: boolean) {
    const list = (await getJson<Notice[]>(this.kv, PREFIX.notice + circle)) ?? [];
    const last = list.at(-1);
    if (fold && last && last.userId === n.userId && last.kind === n.kind && Date.now() - last.at < 3_600_000) { last.at = Date.now(); last.detail = { added: (last.detail?.added ?? 0) + (n.detail?.added ?? 0), removed: (last.detail?.removed ?? 0) + (n.detail?.removed ?? 0) }; }
    else list.push({ id: uuid(), at: Date.now(), ...n });
    await setJson(this.kv, PREFIX.notice + circle, list.slice(-50));
    this.changed(circle);
  }
  private async noteKeys(circle: number, dir: Dir) {
    const tk = await this.trusted(circle);
    const byUser = new Map<number, string[]>();
    const present = new Set(dir.devices.map(d => d.userId));
    // Only devices this device trusts count here: a device still waiting for a yes is not a "key change" yet (it has its own notice).
    for (const uid of present) { const ks = this.trustedDevices(dir, uid, tk).map(d => hex(fromB64(d.identityKey))); if (ks.length) byUser.set(uid, ks); }
    const peersKey = `peers:${circle}`;
    const peers = (await getJson<number[]>(this.kv, peersKey)) ?? [];
    const push = (n: Omit<Notice, 'id' | 'at'>, fold: boolean) => this.pushNotice(circle, n, fold);
    for (const [uid, keys] of byUser) {
      keys.sort();
      const pinKey = `${PREFIX.pin}${circle}:${uid}`, seenKey = `seen:${circle}:${uid}`;
      const was = await getJson<string[]>(this.kv, pinKey);
      if (!was) { await setJson(this.kv, pinKey, keys); await setJson(this.kv, seenKey, keys); if (uid !== this.userId && !peers.includes(uid)) { peers.push(uid); await setJson(this.kv, peersKey, peers); } continue; }
      if (was.join() === keys.join()) continue;
      const seen = (await getJson<string[]>(this.kv, seenKey)) ?? was;
      const fresh = keys.filter(k => !seen.includes(k));
      await setJson(this.kv, pinKey, keys);
      if (!fresh.length) continue;   // only devices went away, or old keys came back: nothing new to say
      await setJson(this.kv, seenKey, [...new Set([...seen, ...keys])]);
      await push({ userId: uid, kind: uid === this.userId ? 'own_device_added' : 'keys_changed', detail: { added: fresh.length, removed: 0 } }, true);
      if (uid !== this.userId) { await this.kv.del(`ver:${uid}`); await this.kv.del(`verkeys:${uid}`); }
    }
    for (const uid of peers) {
      if (present.has(uid)) continue;
      const goneKey = `gone:${circle}:${uid}`;
      if (await this.kv.get(goneKey)) continue;
      await setJson(this.kv, goneKey, 1);
      await push({ userId: uid, kind: 'gone' }, false);
    }
  }
  /** True when someone was in this chat with us and now nobody else is (their account is gone): a message would reach no one. */
  private async peerGone(circle: number, dir: Dir): Promise<boolean> {
    if (dir.devices.some(d => d.userId !== this.userId)) return false;
    return ((await getJson<number[]>(this.kv, `peers:${circle}`)) ?? []).length > 0;
  }
  async notices(circle: number): Promise<Notice[]> { return (await getJson<Notice[]>(this.kv, PREFIX.notice + circle)) ?? []; }

  /** The keys of one person's devices that are really members of the chat's group on this device. */
  private memberKeys(g: Group, uid: number): string[] { return core.members(g).filter(m => core.parseIdentity(m.identity)?.userId === uid).map(m => hex(m.signaturePublicKey)); }
  /**
   * The number two people compare (read aloud or scan): made from the identity keys of the devices that are members of the chat's MLS group on this device (the group's own,
   * authenticated list), not from what the server lists. A device the server lists but the group does not contain is not in the number; one the group contains counts.
   */
  async safetyNumber(circle: number, otherUserId: number): Promise<string> {
    let g = await this.load(circle, null);
    if (!g) { await this.sync(circle).catch(() => undefined); g = await this.load(circle, null); }   // a chat opened for the first time joins first
    if (!g) throw new E2eeError('not_ready');
    const keys = (uid: number) => this.memberKeys(g, uid).map(h => fromB64(hexToB64(h)));
    if (!keys(otherUserId).length) throw new E2eeError('not_ready');
    return core.safetyNumber({ userId: this.userId, keys: keys(this.userId) }, { userId: otherUserId, keys: keys(otherUserId) });
  }
  /** "We compared the number": remember it. Any later change of either person's keys makes this false again. */
  async verify(otherUserId: number, circle?: number): Promise<void> {
    const c = circle ?? (await this.net.json<any[]>('GET', '/circles')).find(x => x.encrypted && x.kind === 'direct' && x.members === 2)?.id;
    if (c && await this.hasUnconfirmedOf(c, otherUserId)) throw new E2eeError('device_unconfirmed');   // a number that includes a device nobody here confirmed proves nothing
    await setJson(this.kv, `ver:${otherUserId}`, await this.safetyNumber(c, otherUserId));
    const g = await this.load(c, null);
    await setJson(this.kv, `verkeys:${otherUserId}`, g ? this.memberKeys(g, otherUserId) : []);   // the keys I verified (the devices in the chat's group): they count in every chat
  }
  async isVerified(otherUserId: number, circle?: number): Promise<boolean> {
    const was = await getJson<string>(this.kv, `ver:${otherUserId}`);
    if (!was) return false;
    const c = circle ?? (await this.net.json<any[]>('GET', '/circles')).find(x => x.encrypted && x.kind === 'direct')?.id;
    // Verified while every device of this person that is in the chat is one whose keys were compared (a device added since breaks it).
    const g = c ? await this.load(c, null) : null;
    const now = g ? this.memberKeys(g, otherUserId) : [];
    const vk = (await getJson<string[]>(this.kv, `verkeys:${otherUserId}`)) ?? [];
    return now.length > 0 && now.every(k => vk.includes(k)) && !(await this.hasUnconfirmedOf(c, otherUserId));
  }

  // ---- devices: linking, approving, revoking -------------------------------------------------------------------------------------------------

  async devices(): Promise<DeviceInfo[]> {
    const list = await this.net.json<any[]>('GET', '/keys/devices');
    const out: DeviceInfo[] = [];
    for (const d of list.filter(x => !x.revokedAt)) {
      const key = d.identityKey ? fromB64(d.identityKey) : null;
      out.push({ deviceId: d.id, label: d.label, createdAt: d.createdAt, mine: d.id === this.deviceId, approved: await this.approved(d.id, d.identityKey ?? ''), identityKey: d.identityKey, code: key ? await E2ee.shortCode(key) : null, stock: d.stock });
    }
    return out;
  }
  /** This device's own short code (shown on a new device so the person can match it on the old one). */
  /** The short code of any identity key (tests and screens). */
  myCodeFor(publicKey: Uint8Array): Promise<string> { return E2ee.shortCode(publicKey); }
  async myCode(): Promise<string> { return E2ee.shortCode(this.identityKey().publicKey); }
  /** "Yes, that is my other device": it is added to every encrypted chat of this person from now on. */
  async approveDevice(deviceId: number, expectedKey?: string): Promise<void> {
    const d = (await this.net.json<any[]>('GET', '/keys/devices')).find(x => x.id === deviceId && !x.revokedAt);
    if (!d?.identityKey || (expectedKey && d.identityKey !== expectedKey)) throw new E2eeError('not_found');   // with `expectedKey`: only the key that was checked
    await setJson(this.kv, `approved:${deviceId}`, d.identityKey);   // this key, and no other
    await this.endorse(deviceId, d.identityKey).catch(() => undefined);   // and a signature, so that the people in my chats can add it without anyone deciding for them
    await this.syncAll().catch(() => undefined);
  }
  /** A device is lost or not wanted: no longer offered, and every encrypted chat changes keys without it. */
  async revokeDevice(deviceId: number): Promise<void> {
    await this.net.json('DELETE', `/keys/devices/${deviceId}`);
    await this.kv.del(`approved:${deviceId}`);
    if (deviceId !== this.deviceId) await this.syncAll().catch(() => undefined);
  }

  // ---- a later new device of someone I know: it waits for my yes -------------------------------------------------------------------------------
  // The server decides which devices a person has, and a hostile server could list one that is not theirs. So: the FIRST device(s) of a person in a chat are trusted on first
  // sight (nothing to compare with; the safety number is how you check), but a device that shows up LATER for someone I already talk to is not added by me until I accept it
  // ("ask", the default; "auto" adds it and leaves a notice). A person I VERIFIED is always asked, whatever the setting. A device the person's own approved device adds is
  // theirs to add: I apply that commit and a notice follows.

  async newDevicePolicy(): Promise<'ask' | 'auto'> { return (await getJson<string>(this.kv, 'policy')) === 'auto' ? 'auto' : 'ask'; }
  async setNewDevicePolicy(p: 'ask' | 'auto'): Promise<void> { await setJson(this.kv, 'policy', p === 'auto' ? 'auto' : 'ask'); this.changed(null); }

  /**
   * Should reconcile hold back this device of another person? (And remember it, with one notice.) A device is added without asking when this device already trusts it, when the
   * person's own trusted device vouched for it (a signature anyone can check), when it is the person's first device in this chat, or, in a chat of exactly two people, when the
   * setting says "add automatically". In a group the setting does NOT apply: one member's choice would bring a device in for everyone, so it asks.
   */
  private async mustWaitFor(circle: number, dir: Dir, p: { userId: number; deviceId: number }): Promise<boolean> {
    const d = dir.devices.find(x => x.userId === p.userId && x.deviceId === p.deviceId);
    if (!d) return false;
    const key = hex(fromB64(d.identityKey)), tk = await this.trusted(circle);
    const list = await this.waitList(circle);
    if (list.some(w => w.deviceId === p.deviceId && w.key === key)) return true;   // waiting, "not now", or removed by somebody: only a yes brings it in
    if ((tk[p.userId] ?? []).includes(key)) return false;
    if (await this.vouched(dir, p, tk)) return false;
    const known = (tk[p.userId]?.length ?? 0) > 0;
    const verified = !!(await this.kv.get(`ver:${p.userId}`));
    const vk = (await getJson<string[]>(this.kv, `verkeys:${p.userId}`)) ?? [];
    if (!known && (!verified || !vk.length || vk.includes(key))) return false;   // first sight is fine, unless this person was verified in another chat
    const grp = await this.load(circle, null);
    const people = new Set([...dir.devices.map(x => x.userId), ...(grp ? core.members(grp).map(m => core.parseIdentity(m.identity)?.userId ?? 0) : [])]).size;   // the server's list AND the group: hiding someone from the list does not make a group a pair
    if (!verified && people <= 2 && (await this.newDevicePolicy()) === 'auto') return false;
    list.push({ userId: p.userId, deviceId: p.deviceId, key });
    await setJson(this.kv, PREFIX.wait + circle, list);
    await this.pushNotice(circle, { userId: p.userId, kind: 'new_device_waiting', detail: { deviceId: p.deviceId, code: await E2ee.shortCode(fromB64(d.identityKey)) } }, false);
    return true;
  }
  private waitList = async (circle: number) => (await getJson<WaitEntry[]>(this.kv, PREFIX.wait + circle)) ?? [];
  /** Keep a device out of this chat until a yes, without a banner or a notice (somebody removed it, or "not now"). */
  private async holdBack(circle: number, p: { userId: number; deviceId: number }, key: string) {
    const list = await this.waitList(circle);
    const e = list.find(w => w.deviceId === p.deviceId && w.key === key);
    if (e) e.dismissed = true; else list.push({ userId: p.userId, deviceId: p.deviceId, key, dismissed: true });
    await setJson(this.kv, PREFIX.wait + circle, list);
  }
  /** Did a device of this person that I trust sign for this device? Then it is theirs: nobody has to decide. */
  private async vouched(dir: Dir, p: { userId: number; deviceId: number }, tk: Record<string, string[]>): Promise<boolean> {
    const d = dir.devices.find(x => x.userId === p.userId && x.deviceId === p.deviceId);
    if (!d?.endorsement || !d.endorserKey) return false;
    let signer: Uint8Array, sig: Uint8Array, key: Uint8Array;
    try { signer = fromB64(d.endorserKey); sig = fromB64(d.endorsement); key = fromB64(d.identityKey); } catch { return false; }
    if (!(tk[p.userId] ?? []).includes(hex(signer))) return false;
    if (!dir.devices.some(x => x.userId === p.userId && eq(fromB64(x.identityKey), signer))) return false;   // a retired or lost device no longer vouches
    return core.verifyEndorsement(signer, p.userId, p.deviceId, key, sig);
  }
  /** Sign for one of my own devices (once), so that the others can check it. */
  private async endorse(deviceId: number, identityKey: string) {
    const sig = await core.endorseDevice(this.identityKey().signKey, this.userId, deviceId, fromB64(identityKey));
    await this.net.json('PUT', `/keys/devices/${deviceId}/endorsement`, { by: this.deviceId, sig: toB64(sig) });
  }
  private async ensureEndorsed(deviceId: number, dir: Dir) {
    const d = dir.devices.find(x => x.userId === this.userId && x.deviceId === deviceId);
    if (!d || (d.endorsement && d.endorserKey)) return;
    await this.endorse(deviceId, d.identityKey).catch(() => undefined);
  }
  /** Devices I added myself (they were decided on by this device): trusted from now on. */
  private async confirmAdded(circle: number, packages: Uint8Array[]) {
    const list = packages.map(b => core.describeKeyPackage(b)).map(d => ({ identity: d.identity, key: hex(d.signaturePublicKey) }));
    if (list.length) await this.trustMembers(circle, list);
  }

  /**
   * Who is in the chat that this device has not confirmed. A member's device is confirmed when it is this device, the first device of a person new to this chat, a device this
   * device approved or accepted or added, or a device that a confirmed device of the same person vouched for. Anything else in the group (another member said yes by hand, or a
   * hostile commit passed the server's list) is UNCONFIRMED: the chat says so, and this device sends nothing until its person decides (keep it, or remove it).
   */
  private async audit(circle: number, g: Group, dir: Dir): Promise<void> {
    const cf = await this.trusted(circle);
    let changed = false;
    const add = (uid: number, key: string) => { const l = (cf[uid] ??= []); if (!l.includes(key)) { l.push(key); changed = true; } };
    const list = core.members(g).map(m => ({ p: core.parseIdentity(m.identity)!, identity: m.identity, key: hex(m.signaturePublicKey) })).filter(m => m.p);
    const have = (m: { p: { userId: number }; key: string }) => (cf[m.p.userId] ?? []).includes(m.key);
    for (const m of list) if (m.identity === this.identity) add(this.userId, m.key);
    // a person I have no confirmed device of yet: their device(s) in this chat are trusted on first sight (the safety number is how to check)
    for (const uid of new Set(list.map(m => m.p.userId))) if (uid !== this.userId && !cf[uid]?.length) for (const m of list.filter(x => x.p.userId === uid)) add(uid, m.key);
    // A device that has just joined this chat by a welcome (made by the older device its person approved it on) takes the other devices of its own person that are in the group
    // at that moment as theirs, once. Nothing the server names is a root of trust: the directory's signer is never believed on its own.
    if (await this.kv.get(`fs:${circle}`)) {
      for (const m of list) if (m.p.userId === this.userId) add(this.userId, m.key);
      await this.kv.del(`fs:${circle}`);
    }
    const held = await this.waitList(circle);
    for (let pass = 0; pass < 4; pass++) {
      let more = false;
      for (const m of list) {
        if (have(m)) continue;
        if (held.some(w => w.deviceId === m.p.deviceId && w.key === m.key)) continue;   // one somebody removed or that I said "not now" to: only my yes brings it back
        if ((m.p.userId === this.userId && await this.approved(m.p.deviceId, dir)) || await this.vouched(dir, m.p, cf)) { add(m.p.userId, m.key); more = true; }
      }
      if (!more) break;
    }
    if (changed) await setJson(this.kv, PREFIX.tk + circle, cf);
    const was = (await getJson<Array<{ userId: number; deviceId: number; key: string }>>(this.kv, PREFIX.unconf + circle)) ?? [];
    const now = list.filter(m => !have(m)).map(m => ({ userId: m.p.userId, deviceId: m.p.deviceId, key: m.key }));
    if (now.length !== was.length || now.some(n => !was.some(w => w.deviceId === n.deviceId && w.key === n.key))) {
      await setJson(this.kv, PREFIX.unconf + circle, now);
      for (const n of now.filter(n => !was.some(w => w.deviceId === n.deviceId && w.key === n.key))) {
        await this.pushNotice(circle, { userId: n.userId, kind: 'new_device_unconfirmed', detail: { deviceId: n.deviceId, code: await E2ee.shortCode(fromB64(hexToB64(n.key))) } }, false);
      }
      this.changed(circle);
    }
    if (changed) {
      const w = await this.waitList(circle);   // a device that is now trusted is no longer waiting
      const rest = w.filter(x => x.dismissed || !(cf[x.userId] ?? []).includes(x.key));
      if (rest.length !== w.length) await setJson(this.kv, PREFIX.wait + circle, rest);
    }
  }
  /** Members of the chat that this device has not confirmed (their devices are in the group, and nothing is sent until the person decides). */
  async unconfirmedDevices(): Promise<WaitingDevice[]> {
    const out: WaitingDevice[] = [];
    for (const k of await this.kv.keys(PREFIX.unconf)) {
      const circle = Number(k.slice(PREFIX.unconf.length));
      const cf = await this.trusted(circle);
      for (const w of (await getJson<Array<{ userId: number; deviceId: number; key: string }>>(this.kv, k)) ?? []) {
        if ((cf[w.userId] ?? []).includes(w.key)) continue;
        out.push({ circle, userId: w.userId, deviceId: w.deviceId, code: await E2ee.shortCode(fromB64(hexToB64(w.key))) });
      }
    }
    return out;
  }
  private async hasUnconfirmedOf(circle: number, userId: number) {
    const cf = await this.trusted(circle);
    return ((await getJson<Array<{ userId: number; key: string }>>(this.kv, PREFIX.unconf + circle)) ?? []).some(w => w.userId === userId && !(cf[w.userId] ?? []).includes(w.key));
  }
  private async hasUnconfirmed(circle: number) {
    const cf = await this.trusted(circle);
    return ((await getJson<Array<{ userId: number; key: string }>>(this.kv, PREFIX.unconf + circle)) ?? []).some(w => !(cf[w.userId] ?? []).includes(w.key));
  }
  /** "No": take the device out of this chat (a commit by this device); nobody adds it again without a yes. */
  async removeDevice(circle: number, userId: number, deviceId: number): Promise<void> {
    await this.lock(circle, async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const { g: g0, dir } = await this.syncLocked(circle);
        if (!g0) throw new E2eeError('not_ready');
        const target = core.members(g0).find(m => m.identity === core.identityOf(userId, deviceId));
        if (!target) return;   // already gone
        const g = await this.catchUp(circle, g0, Infinity);
        const epoch = core.epochOf(g);
        const h = await core.removeDevices(g, { identity: target.identity });
        await this.keepPending(circle, h.group);
        try {
          await this.net.json('POST', `/circles/${circle}/e2ee/commits`, { device: this.deviceId, epoch: epoch + 1, commit: toB64(h.commit), welcomes: [] });
        } catch (e) { if (e instanceof NetError && e.code === 'epoch_conflict') { await this.dropPending(circle); continue; } throw e; }
        await this.save(circle, h.group);
        await this.dropPending(circle);
        await this.holdBack(circle, { userId, deviceId }, hex(target.signaturePublicKey));
        await this.audit(circle, h.group, dir);
        this.scheduleBackup(4_000);
        this.changed(circle);
        return;
      }
      throw new E2eeError('send_failed');
    });
  }
  /** Devices of other people that this device is holding back, until the person says yes. */
  async waitingDevices(): Promise<WaitingDevice[]> {
    const out: WaitingDevice[] = [];
    for (const k of await this.kv.keys(PREFIX.wait)) {
      const circle = Number(k.slice(PREFIX.wait.length));
      const list = (await getJson<WaitEntry[]>(this.kv, k)) ?? [];
      for (const w of list.filter(x => !x.dismissed)) out.push({ circle, userId: w.userId, deviceId: w.deviceId, code: await E2ee.shortCode(fromB64(hexToB64(w.key))) });
    }
    return out;
  }
  /** What became of a device that once waited here: still waiting, accepted (or added), or gone (retired or no longer listed). */
  async deviceState(circle: number, userId: number, deviceId: number): Promise<'waiting' | 'dismissed' | 'added' | 'gone'> {
    const list = await this.waitList(circle);
    const dir = await this.directory(circle).catch(() => null);
    const d = dir?.devices.find(x => x.userId === userId && x.deviceId === deviceId);
    if (dir && !d) return 'gone';
    const g = await this.load(circle, null);
    if (g && core.members(g).some(m => m.identity === core.identityOf(userId, deviceId))) return 'added';   // already in the chat (someone added it): the question is now the other notice's
    const w = list.find(x => x.deviceId === deviceId && (!d || x.key === hex(fromB64(d.identityKey))));
    if (w) return w.dismissed ? 'dismissed' : 'waiting';
    return 'added';
  }
  /**
   * "Yes, add this device": it joins the chat (or, when it is already in the chat because someone else added it, it is kept), and a verification of that person is gone (their keys
   * are not the ones I compared).
   */
  async acceptDevice(circle: number, userId: number, deviceId: number): Promise<void> {
    await this.lock(circle, async () => {
      const list = await this.waitList(circle);
      const unconf = (await getJson<Array<{ userId: number; deviceId: number; key: string }>>(this.kv, PREFIX.unconf + circle)) ?? [];
      const dir = await this.directory(circle);
      const d = dir.devices.find(x => x.userId === userId && x.deviceId === deviceId);
      const key = d ? hex(fromB64(d.identityKey)) : '';
      const w = list.find(x => x.userId === userId && x.deviceId === deviceId) ?? unconf.find(x => x.userId === userId && x.deviceId === deviceId);
      if (!w || !d || w.key !== key) throw new E2eeError('not_found');   // the device is gone, or its key changed again: look again
      await this.trustMembers(circle, [{ identity: core.identityOf(userId, deviceId), key }]);
      await setJson(this.kv, PREFIX.wait + circle, list.filter(x => x !== w));
      await setJson(this.kv, PREFIX.unconf + circle, unconf.filter(x => x !== w));
      const seenKey = `seen:${circle}:${userId}`;
      await setJson(this.kv, seenKey, [...new Set([...((await getJson<string[]>(this.kv, seenKey)) ?? []), key])]);
      await this.kv.del(`ver:${userId}`);
      this.changed(circle);
    });
    await this.sync(circle);
  }
  /** "Not now": keep it out and stop asking about this device (no banner, no new notice); a later yes still works. */
  async dismissWaiting(circle: number, deviceId: number): Promise<void> {
    const list = await this.waitList(circle);
    for (const w of list) if (w.deviceId === deviceId) w.dismissed = true;
    await setJson(this.kv, PREFIX.wait + circle, list);
    this.changed(circle);
  }

  // ---- linking a second device, with its history -----------------------------------------------------------------------------------------------

  /**
   * On the NEW device: start (or show again) a pairing: a one-time key pair, a typed code, and the picture's text. It lasts about three minutes and works once; asking again after
   * that makes a new one. Only the PUBLIC key goes into the picture and to the server.
   */
  async linkRequest(): Promise<{ code: string; qr: string; expiresAt: number }> {
    const me = (await this.net.json<any[]>('GET', '/keys/devices')).find(d => d.id === this.deviceId);
    if (!me?.identityKey) throw new E2eeError('not_ready');
    if (me.identityKey !== this.dev!.publicKey) throw new E2eeError('keys_mismatch');   // the server lists a key that is not mine: publish nothing
    const kept = await getJson<{ code: string; priv: string; pub: string; qs?: string; expiresAt: number }>(this.kv, 'link');
    const live = !!kept && !!me.linkProof && me.linkExpiresAt === kept.expiresAt && kept.expiresAt > Date.now() / 1000;
    if (kept && live && kept.qs) return { code: kept.code, qr: linkPayload(this.deviceId, b64url(fromB64(kept.pub)), idTag(this.dev!.publicKey), kept.qs), expiresAt: kept.expiresAt };
    const code = newLinkCode(), keys = newLinkKeys();
    const r = await this.net.json<{ expiresAt: number }>('PUT', `/keys/devices/${this.deviceId}/link`, { proof: await linkProof(code, this.deviceId, this.dev!.publicKey, keys.pub), pub: toB64(keys.pub) });
    const qs = b64url(crypto.getRandomValues(new Uint8Array(16)));   // a secret that travels only inside the picture
    await setJson(this.kv, 'link', { code, priv: toB64(keys.priv), pub: toB64(keys.pub), qs, expiresAt: r.expiresAt });
    return { code, qr: linkPayload(this.deviceId, b64url(keys.pub), idTag(this.dev!.publicKey), qs), expiresAt: r.expiresAt };
  }
  async linkPending(): Promise<{ expiresAt: number } | null> { const k = await getJson<{ expiresAt: number }>(this.kv, 'link'); return k ? { expiresAt: k.expiresAt } : null; }
  /**
   * On an OLDER device: which of my devices does this picture or typed code mean? A scanned picture is checked against the key the server lists (a swapped key is refused); a typed
   * code is checked by its proof. null for a wrong code, an expired or used pairing, a typo, or a device someone else invented.
   */
  async findLink(codeOrPicture: string): Promise<DeviceInfo | null> { return (await this.verifyLink(codeOrPicture))?.info ?? null; }
  private async verifyLink(codeOrPicture: string): Promise<{ info: DeviceInfo; linkPub: string; secret: Uint8Array } | null> {
    const pic = parseLinkPayload(codeOrPicture);
    const typed = !pic && validLink(codeOrPicture);
    if (!pic && !typed) return null;
    for (const d of await this.net.json<any[]>('GET', '/keys/devices')) {
      if (d.revokedAt || d.id === this.deviceId || !d.linkProof || !d.linkPub || !d.identityKey) continue;
      if (Number(d.linkExpiresAt) <= Date.now() / 1000) continue;
      const hit = pic ? d.id === pic.deviceId && b64url(fromB64(d.linkPub)) === pic.pub && idTag(d.identityKey) === pic.tag : (linkProof(codeOrPicture, d.id, d.identityKey, fromB64(d.linkPub)) === d.linkProof);
      if (hit) { const info = (await this.devices()).find(x => x.deviceId === d.id); return info && info.identityKey === d.identityKey ? { info, linkPub: d.linkPub, secret: pic ? fromB64url(pic.secret) : new TextEncoder().encode(normaliseLink(codeOrPicture)) } : null; }   // the key checked is the key shown and approved
    }
    return null;
  }
  /** The person CONFIRMED: add the device to every encrypted chat and hand over what this device has read (messages, with the keys of their files), sealed for that one device. */
  async confirmLink(deviceId: number, codeOrPicture: string): Promise<{ chats: number; messages: number }> {
    const v = await this.verifyLink(codeOrPicture);
    if (!v || v.info.deviceId !== deviceId) throw new E2eeError('bad_link_code');
    const newPub = fromB64(v.linkPub);   // the key that was checked, not one fetched again
    await this.approveDevice(deviceId, v.info.identityKey!);
    const chats = (await this.net.json<Array<{ id: number; encrypted?: boolean }>>('GET', '/circles')).filter(c => c.encrypted).map(c => c.id);
    for (const c of chats) { await this.sync(c).catch(() => undefined); await this.readAll(c).catch(() => undefined); }   // read everything first, then the keys move
    for (const c of chats) await this.sync(c).catch(() => undefined);                                                       // (the new device joins here)
    const entries: Record<string, string> = {};
    let messages = 0;
    const once = new Set<string>();   // view-once messages are never copied: they are meant to be seen once, on the device that got them
    for (const k of await this.kv.keys(PREFIX.row)) { const r = await getJson<Row>(this.kv, k); if (r?.viewOnce) once.add(k.slice(PREFIX.row.length)); }
    for (const k of await this.kv.keys()) {
      if (!TRANSFER_KEYS.test(k)) continue;
      if (/^(tk|led|last|pl|row):/.test(k) && !chats.includes(Number(k.split(':')[1]))) continue;   // (ver: and verkeys: are per person)
      if (/^(pl|row):/.test(k) && once.has(k.split(':').slice(1).join(':'))) continue;
      const v = await this.kv.get(k); if (!v) continue;
      entries[k] = toB64(v); if (k.startsWith('pl:')) messages++;
    }
    const mine = newLinkKeys();   // one-time, used for this hand-over only
    const parts = await sealTransfer(entries, linkKey(mine.priv, newPub, mine.pub, deviceId, v.secret));
    for (const [i, part] of parts.entries()) await this.net.json('PUT', `/keys/devices/${deviceId}/transfer`, { part: i, last: i === parts.length - 1, data: toB64(part), ...(i === 0 ? { peer: toB64(mine.pub) } : {}) });
    return { chats: chats.length, messages };
  }
  /** On the NEW device: if the older device handed over its history, take it (only with this pairing's private key), and tell the server it can forget it. null when nothing is there yet. */
  async receiveHistory(): Promise<{ imported: number } | null> {
    const k = await getJson<{ priv: string; pub: string; code?: string; qs?: string }>(this.kv, 'link');
    if (!k || !this.deviceId) return null;
    const st = await this.net.json<{ parts: number[]; complete: boolean; peer: string | null }>('GET', `/keys/devices/${this.deviceId}/transfer`).catch(() => null);
    if (!st?.complete || !st.peer) return null;
    let entries: Record<string, string>;
    try {
      const parts: Uint8Array[] = [];
      for (const n of st.parts) parts.push(fromB64((await this.net.json<{ data: string }>('GET', `/keys/devices/${this.deviceId}/transfer/${n}`)).data));
      const newPub = fromB64(k.pub);
      // The key needs the secret only this pairing's two screens share (the typed code or the one inside the picture): a hand-over made by the server, which knows both public keys, opens with neither.
      const secrets = [k.code ? new TextEncoder().encode(normaliseLink(k.code)) : null, k.qs ? fromB64url(k.qs) : null].filter((x): x is Uint8Array => !!x);
      let opened: Record<string, string> | null = null;
      for (const secret of secrets) { try { opened = await openTransfer(parts, linkKey(fromB64(k.priv), fromB64(st.peer), newPub, this.deviceId, secret)); break; } catch { /* the other secret */ } }
      if (!opened) throw new Error('bad_transfer');
      entries = opened;
    } catch { await this.net.json('DELETE', `/keys/devices/${this.deviceId}/transfer`).catch(() => undefined); await this.kv.del('link'); throw new E2eeError('bad_transfer'); }
    let imported = 0;
    for (const [key, v] of Object.entries(entries)) {
      if (key.startsWith('led:')) { const mine = await getJson<Ledger>(this.kv, key); const theirs = JSON.parse(new TextDecoder().decode(fromB64(v))) as Ledger; await setJson(this.kv, key, mergeLedger(mine, theirs)); continue; }
      if (key.startsWith('tk:') || key.startsWith('verkeys:')) {   // what the older device trusts and verified: the union (a new device may only ever know more)
        const mine = (await getJson<any>(this.kv, key)) ?? (key.startsWith('tk:') ? {} : []);
        const theirs = JSON.parse(new TextDecoder().decode(fromB64(v)));
        if (key.startsWith('verkeys:')) { if (Array.isArray(theirs)) await setJson(this.kv, key, [...new Set([...mine, ...theirs.filter((x: unknown) => typeof x === 'string')])]); continue; }
        if (theirs && typeof theirs === 'object' && !Array.isArray(theirs)) {
          const out: Record<string, string[]> = { ...mine };
          for (const [uid, ks] of Object.entries(theirs)) if (/^\d+$/.test(uid) && Array.isArray(ks)) out[uid] = [...new Set([...(out[uid] ?? []), ...ks.filter((x: unknown) => typeof x === 'string')])];
          await setJson(this.kv, key, out);
        }
        continue;
      }
      if (key.startsWith('last:')) { const mine = await getJson<{ seq: number }>(this.kv, key); const theirs = JSON.parse(new TextDecoder().decode(fromB64(v))) as { seq: number }; if (!mine || mine.seq < theirs.seq) await setJson(this.kv, key, theirs); continue; }
      if (await this.kv.get(key)) continue;                                                      // what this device already has stays
      await this.kv.set(key, fromB64(v)); imported++;
    }
    await this.kv.del('link');                                                                   // one use: the private key is gone
    await this.net.json('DELETE', `/keys/devices/${this.deviceId}/transfer`).catch(() => undefined);
    this.changed(null);
    return { imported };
  }

  // ---- the safety number as a picture ----------------------------------------------------------------------------------------------------------

  /** The text of the picture two people compare: the safety number's digits. Both sides make the same picture. */
  async safetyQr(circle: number, otherUserId: number): Promise<string> { return safetyPayload((await this.safetyNumber(circle, otherUserId)).replace(/\D/g, '')); }
  /** A scanned picture: if it is the same number this device computes for this person, remember "verified" and say true. */
  async checkSafetyQr(circle: number, otherUserId: number, scanned: string): Promise<boolean> {
    const theirs = parseSafetyPayload(scanned);
    if (!theirs) return false;
    const mine = (await this.safetyNumber(circle, otherUserId)).replace(/\D/g, '');
    if (theirs.length !== mine.length || theirs !== mine) return false;
    await this.verify(otherUserId, circle);
    return true;
  }

  // ---- reading: decrypt rows, keep what was decrypted ---------------------------------------------------------------------------------------

  private async ledger(circle: number): Promise<Ledger> { return (await getJson<Ledger>(this.kv, PREFIX.led + circle)) ?? emptyLedger(); }

  /**
   * Read the chat's messages OLDEST FIRST up to (not including) `before`, keeping each. MLS keeps only a limited number of skipped message keys and old epochs, so a message
   * read late (the newest page first, or after many key changes) could be lost for good: reading in order, and before the keys move on, loses nothing.
   */
  private async catchUp(circle: number, g: Group, before: number): Promise<Group> {
    const key = PREFIX.drain + circle;
    let cursor = (await getJson<number>(this.kv, key)) ?? 0;
    const goneNow = new Set((await getJson<number[]>(this.kv, `gone:${circle}`)) ?? []);
    for (let guard = 0; guard < 1000; guard++) {
      const rows = await this.net.json<Row[]>('GET', `/circles/${circle}/messages?after_seq=${cursor}`).catch(() => null);
      if (!rows?.length) break;
      let stop = false;
      for (const row of rows) {
        const seq = row.seq ?? 0;
        if (seq <= cursor) continue;
        if (seq >= before) { stop = true; break; }
        if (row.deleted || row.expired) { await this.purge(circle, row.id); goneNow.add(row.id); }
        if (row.ciphertext && !row.deleted && !row.expired && !goneNow.has(row.id)) {
          if (typeof row.epoch === 'number' && row.epoch > core.epochOf(g)) { stop = true; break; }   // its keys have not reached this device yet
          g = (await this.payloadOf(circle, row, g)).g ?? g;
        }
        cursor = seq;
      }
      await setJson(this.kv, key, cursor);
      if (stop || rows.length < 200) break;
    }
    return g;
  }
  /** Every message of a chat, fetched and decrypted, newest page first (as the screen would load them). */
  async readAll(circle: number): Promise<Message[]> {
    const all: Message[] = [];
    let before = 0;
    for (let guard = 0; guard < 200; guard++) {
      const rows = await this.net.json<Row[]>('GET', `/circles/${circle}/messages?${before ? `before_seq=${before}` : 'after=0'}&limit=200`);
      all.push(...await this.decryptRows(circle, rows));
      if (rows.length < 200) break;
      before = Math.min(...rows.map(r => r.seq ?? Infinity));
    }
    return all;
  }

  /** The decrypted payload of one stored message, from the device's copy or by decrypting it now (saving the group state, and the copy, as the keys move). */
  private async payloadOf(circle: number, row: Row, g: Group | null): Promise<{ p: Payload | null; g: Group | null }> {
    const kept = await getJson<Payload>(this.kv, `${PREFIX.pl}${circle}:${row.id}`);
    if (kept) return { p: kept, g };
    const ctB64 = row.ciphertext as string | undefined;
    if (!ctB64) return { p: null, g };
    const ct = fromB64(ctB64);
    // My own message: MLS cannot decrypt what its own sender made. The device kept a copy under the hash of the ciphertext.
    const own = await getJson<Payload>(this.kv, `${PREFIX.own}${circle}:${await ctHash(ct)}`);
    if (own) {
      await setJson(this.kv, `${PREFIX.pl}${circle}:${row.id}`, own);
      await this.kv.del(`${PREFIX.own}${circle}:${await ctHash(ct)}`);   // the sent copy has done its job: it must not outlive "delete for everyone"
      return { p: own, g };
    }
    if (!g) return { p: null, g };
    const joined = await getJson<number>(this.kv, `joined:${circle}`);
    if (typeof row.epoch === 'number' && typeof joined === 'number' && row.epoch < joined) return { p: null, g };   // sent before this device was in the chat
    try {
      const r = await core.decrypt(g, ct);
      const p = decodePayload(r.plaintext);
      if (!p) return { p: null, g };
      await setJson(this.kv, `${PREFIX.pl}${circle}:${row.id}`, p);   // the copy first, then the moved keys: a crash between the two can only cause a harmless second decrypt
      await this.save(circle, r.group);
      await this.kv.del(`${PREFIX.fail}${circle}:${row.id}`);
      return { p, g: r.group };
    } catch {
      if (typeof row.epoch === 'number' && row.epoch <= core.epochOf(g)) { const n = ((await getJson<number>(this.kv, `${PREFIX.fail}${circle}:${row.id}`)) ?? 0) + 1; await setJson(this.kv, `${PREFIX.fail}${circle}:${row.id}`, n); }
      return { p: null, g };
    }
  }
  private async quoteOf(circle: number, id: number | null | undefined) {
    if (!id) return undefined;
    const p = await getJson<Payload>(this.kv, `${PREFIX.pl}${circle}:${id}`);
    if (!p || isControl(p)) return undefined;
    const l = lineOf(p);
    return { text: p.t === 'text' || p.t === 'media' || p.t === 'poll' ? l.text : '', card: p.t === 'text' && p.card && p.card.type !== 'link' ? p.card.type : null };
  }
  /** A message is gone for everyone (deleted or expired): nothing of its words stays on this device: its copy, the chat-list preview if it was the newest, and its edits, reactions and votes. */
  private async purge(circle: number, id: number) {
    const light = await getJson<{ seq?: number }>(this.kv, `${PREFIX.row}${circle}:${id}`);
    await this.kv.del(`${PREFIX.pl}${circle}:${id}`);
    await this.kv.del(`${PREFIX.row}${circle}:${id}`);
    const last = await getJson<{ seq: number; id?: number }>(this.kv, PREFIX.last + circle);
    if (last && (last.id === id || (light && typeof light.seq === 'number' && last.seq === light.seq))) await this.kv.del(PREFIX.last + circle);
    const led = await this.ledger(circle), k = String(id);
    if (led.edit[k] || led.react[k] || led.vote[k]) { delete led.edit[k]; delete led.react[k]; delete led.vote[k]; await setJson(this.kv, PREFIX.led + circle, led); }
    // The control messages about it (edits, reactions, votes) stay on the server and would be applied again at the next read: remember that this message is gone, so they are dropped.
    const gone = (await getJson<number[]>(this.kv, `gone:${circle}`)) ?? [];
    if (!gone.includes(id)) await setJson(this.kv, `gone:${circle}`, [...gone, id].slice(-5000));
  }
  /** Is a decrypted copy of this message still on the device? */
  async hasCopy(circle: number, id: number): Promise<boolean> { return !!(await this.kv.get(`${PREFIX.pl}${circle}:${id}`)); }

  /**
   * Rows as the server lists them (or pushes them) -> messages the screen can draw. System lines pass through; deleted and expired messages lose their copy on this device;
   * a message that cannot be read here comes back marked `undecryptable`; control messages (edit, reaction, vote) are applied and update the messages they are about.
   */
  async decryptRows(circle: number, rows: Row[]): Promise<Message[]> {
    return this.lock(circle, async () => {
      const sorted = [...rows].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id - b.id);
      const need = sorted.some(r => r.ciphertext && !r.deleted && !r.expired);
      let g: Group | null = null;
      if (need) {
        g = await this.load(circle, null);
        const top = Math.max(0, ...sorted.map(r => (typeof r.epoch === 'number' ? r.epoch : 0)));
        if (!g || top > core.epochOf(g)) {
          try { ({ g } = await this.syncLocked(circle)); }
          catch (e) { if (!(e instanceof E2eeError) && !(e instanceof NetError)) throw e; g = g ?? await this.load(circle, null); }
        }
      }
      if (g && need) {
        const firstSeq = Math.min(...sorted.filter(r => r.ciphertext && !r.deleted && !r.expired).map(r => r.seq ?? Infinity));
        if (Number.isFinite(firstSeq)) g = await this.catchUp(circle, g, firstSeq);   // older messages first, so no key is skipped over
      }
      const led = await this.ledger(circle);
      const joinedAt = await getJson<number>(this.kv, `joined:${circle}`);
      const unreadable = async (row: Row) => {
        const before = typeof row.epoch === 'number' && typeof joinedAt === 'number' && row.epoch < joinedAt;   // sent before this device was in the chat: it never can
        const tries = (await getJson<number>(this.kv, `${PREFIX.fail}${circle}:${row.id}`)) ?? 0;
        return { ...(row as any), body: '', encrypted: true, undecryptable: true, waiting: !before && tries < 5, attachments: [], card: null, poll: null } as Message;
      };
      let ledChanged = false;
      const gone = new Set((await getJson<number[]>(this.kv, `gone:${circle}`)) ?? []);
      const out = new Map<number, Message>();
      const touched = new Set<number>();
      for (const row of sorted) {
        if (!row.encKind) { out.set(row.id, row as unknown as Message); continue; }                       // a system line
        if (row.deleted || row.expired) { await this.purge(circle, row.id); gone.add(row.id); out.set(row.id, { ...(row as any), body: '', encrypted: true }); continue; }
        if (gone.has(row.id)) continue;   // a control message about a deleted message was dropped earlier: its key is used up, it is not "unreadable", it is gone
        const { p, g: g2 } = await this.payloadOf(circle, row, g);
        g = g2;
        if (!p) { out.set(row.id, await unreadable(row)); continue; }
        // The server says who sent it; the message says it too. If they differ, the server relabelled it.
        // A sender whose account was deleted has no id on the server any more; what this device verified when it first read the message stands.
        const sender = core.parseIdentity(p.from)?.userId;
        const earlier = row.userId == null ? await getJson<{ userId?: number | null }>(this.kv, `${PREFIX.row}${circle}:${row.id}`) : null;
        if (sender !== row.userId && !(earlier && earlier.userId === sender)) { out.set(row.id, { ...(await unreadable(row)), waiting: false }); continue; }
        const { ciphertext: _ct, ...light } = row;
        await setJson(this.kv, `${PREFIX.row}${circle}:${row.id}`, light);
        if (isControl(p)) {
          if (gone.has((p as any).target)) { await this.purge(circle, row.id); continue; }   // about a message that was deleted for everyone: nothing of it is kept or applied
          if (applyControl(led, row, p)) ledChanged = true;
          touched.add((p as any).target);
          continue;
        }
        out.set(row.id, { ...(row as any), __p: p } as any);
      }
      if (ledChanged) await setJson(this.kv, PREFIX.led + circle, led);
      // A control message changed a message that is not in this batch: hand back its new look.
      for (const id of touched) if (!out.has(id)) {
        const light = await getJson<Row>(this.kv, `${PREFIX.row}${circle}:${id}`);
        const p = await getJson<Payload>(this.kv, `${PREFIX.pl}${circle}:${id}`);
        if (light && p && !isControl(p)) out.set(id, { ...(light as any), __p: p } as any);
      }
      const result: Message[] = [];
      for (const [, m] of out) {
        const p = (m as any).__p as Payload | undefined;
        if (!p) { result.push(m); continue; }
        const { __p, ...row } = m as any;
        const msg = render(row, p, led, await this.quoteOf(circle, row.replyToId));
        result.push(msg);
        await this.remember(circle, msg, p);
      }
      return result.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id - b.id);
    });
  }
  /** The newest message of a chat, as one line, kept on the device for the chat list (the server cannot make one). */
  private async remember(circle: number, m: Message, p: Payload) {
    const was = await getJson<{ seq: number }>(this.kv, PREFIX.last + circle);
    if (was && (m.seq ?? 0) < was.seq) return;
    await setJson(this.kv, PREFIX.last + circle, { seq: m.seq ?? 0, id: m.id, at: m.createdAt, userId: m.userId, ...lineOf(p) });
  }
  async preview(circle: number): Promise<{ text: string; kind: string; at: string; userId: number | null } | null> { return (await getJson<any>(this.kv, PREFIX.last + circle)) ?? null; }

  /** The chat's messages (the newest page by default), fetched and decrypted. */
  async history(circle: number, query = 'after=0&limit=200'): Promise<Message[]> {
    const rows = await this.net.json<Row[]>('GET', `/circles/${circle}/messages?${query}`);
    return this.decryptRows(circle, rows);
  }
  /** Search runs here, over the history this device can read (it fetches and decrypts the whole chat first). */
  async search(circle: number, q: string): Promise<Message[]> {
    const all = await this.readAll(circle);
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const seen = new Set<number>();
    return all.filter(m => !m.deleted && !m.undecryptable && m.body && m.body.toLowerCase().includes(needle) && !seen.has(m.id) && !!seen.add(m.id)).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  // ---- sending ---------------------------------------------------------------------------------------------------------------------------------

  /**
   * Encrypt a draft and hand it to the server. Before anything is encrypted the device catches up, checks the members against the directory, and makes the commit the server
   * asks for. The ciphertext of a message is kept until the server confirms it, so a retry with the same `cid` sends the very same bytes (never a second message).
   */
  private async post(circle: number, draft: Draft, o: SendOpts & { uploads?: string[]; target?: number } = {}): Promise<{ id: number; seq: number }> {
    return this.lock(circle, async () => {
      const cid = o.cid ?? uuid();
      for (let attempt = 0; attempt < 3; attempt++) {
        const { g: g0, dir } = await this.syncLocked(circle);
        if (!g0) throw new E2eeError('not_ready');
        if (await this.peerGone(circle, dir)) throw new E2eeError('peer_gone');
        const g = await this.reconcile(circle, g0, dir);
        await this.audit(circle, g, await this.directory(circle));   // judged on the group as it is NOW, after this device's own commits and any it applied
        if (await this.hasUnconfirmed(circle)) throw new E2eeError('device_unconfirmed');   // a device nobody here confirmed is in the chat: nothing is sent to it
        const payload = { v: 1, from: this.identity, ...draft } as Payload;
        const kind = encKindOf(payload);
        const epoch = core.epochOf(g);
        const key = `${PREFIX.pend}${circle}:${cid}`;
        let pend = await getJson<{ ct: string; epoch: number }>(this.kv, key);
        if (!pend || pend.epoch !== epoch) {
          const r = await core.encrypt(g, encodePayload(payload));
          pend = { ct: toB64(r.ciphertext), epoch };
          await setJson(this.kv, `${PREFIX.own}${circle}:${await ctHash(r.ciphertext)}`, payload);
          await setJson(this.kv, key, pend);
          await this.save(circle, r.group);
        }
        try {
          const res = await this.net.json<{ id: number; seq: number }>('POST', `/circles/${circle}/e2ee/messages`, {
            ciphertext: pend.ct, kind, epoch, clientMsgId: cid, replyTo: o.replyTo ?? null, mentions: o.mentions ?? [], ...(o.uploads?.length ? { uploads: o.uploads } : {}),
            ...(o.viewOnce ? { viewOnce: true } : {}), ...(o.target ? { target: o.target } : {}),
          });
          await setJson(this.kv, `${PREFIX.pl}${circle}:${res.id}`, payload);
          await this.kv.del(`${PREFIX.own}${circle}:${await ctHash(fromB64(pend.ct))}`);   // the copy under the ciphertext's hash is no longer needed (it would outlive "delete for everyone")
          await this.kv.del(key);
          if (!isControl(payload)) await setJson(this.kv, PREFIX.last + circle, { seq: res.seq, id: res.id, at: new Date().toISOString(), userId: this.userId, ...lineOf(payload) });
          this.changed(circle);
          return res;
        } catch (e) {
          if (e instanceof NetError && (e.code === 'rekey_required' || e.code === 'epoch_ahead') && attempt < 2) { await this.kv.del(key); continue; }
          throw e;
        }
      }
      throw new E2eeError('send_failed');
    });
  }

  async sendText(circle: number, text: string, o: SendOpts & { card?: Card | null } = {}) {
    return this.post(circle, { t: 'text', text, ...(o.card ? { card: o.card } : {}) }, o);
  }
  async sendPoll(circle: number, question: string, options: string[], multiple: boolean, o: SendOpts = {}) {
    return this.post(circle, { t: 'poll', text: question, options, multiple }, o);
  }
  async edit(circle: number, messageId: number, text: string) {
    const row = await getJson<Row>(this.kv, `${PREFIX.row}${circle}:${messageId}`);
    if (row && row.userId !== this.userId) throw new E2eeError('forbidden');
    return this.post(circle, { t: 'edit', target: messageId, text }, { target: messageId });
  }
  async react(circle: number, messageId: number, emoji: string | null) { return this.post(circle, { t: 'react', target: messageId, emoji }); }
  async vote(circle: number, messageId: number, options: number[]) { return this.post(circle, { t: 'vote', target: messageId, options }); }
  /** Delete for everyone: the server erases the ciphertext and the files; the copy on this device goes too (the others' devices drop theirs when they see it). */
  async remove(circle: number, messageId: number) {
    await this.net.json('DELETE', `/messages/${messageId}`);
    await this.purge(circle, messageId);
    this.changed(circle);
  }

  /** Encrypt the files here (each with its own key), upload the ciphertext through the resumable upload routes, then send the message that carries the keys. */
  private async upload(circle: number, bytes: Uint8Array): Promise<string> {
    const open = await this.net.json<{ id: string; chunk: number }>('POST', `/circles/${circle}/uploads`, { name: 'blob', size: bytes.length });
    let offset = 0;
    for (let guard = 0; offset < bytes.length && guard < 100_000; guard++) {
      try { offset = (await this.net.put(`/uploads/${open.id}?offset=${offset}`, bytes.slice(offset, offset + open.chunk))).offset; }
      catch (e) { if (e instanceof NetError && e.code === 'offset_mismatch') offset = e.data.offset; else throw e; }
    }
    return open.id;
  }
  async sendMedia(circle: number, files: PlainFile[], caption: string, o: SendOpts = {}) {
    if (!files.length || files.length > 5) throw new E2eeError('invalid_attachment');
    const refs: FileRef[] = [], ids: string[] = [];
    for (const [i, f] of files.entries()) {
      const sealed = await sealFile(f.bytes);
      ids.push(await this.upload(circle, sealed.bytes));
      refs.push({ i, kind: f.mime.startsWith('image/') ? 'image' : f.mime.startsWith('video/') ? 'video' : 'file', k: sealed.key, hash: sealed.hash, name: f.name, mime: f.mime, size: f.bytes.length, w: f.w ?? null, h: f.h ?? null, ...(f.thumb ? { thumb: f.thumb } : {}) });
    }
    return this.post(circle, { t: 'media', text: caption, files: refs }, { ...o, uploads: ids });
  }
  async sendVoice(circle: number, file: { bytes: Uint8Array; mime: string }, ms: number, wave: number[], o: SendOpts = {}) {
    const sealed = await sealFile(file.bytes);
    const id = await this.upload(circle, sealed.bytes);
    return this.post(circle, { t: 'voice', ms, wave, file: { i: 0, kind: 'file', k: sealed.key, hash: sealed.hash, name: null, mime: file.mime, size: file.bytes.length, w: null, h: null } }, { ...o, uploads: [id] });
  }
  /** A file or thumbnail of an encrypted chat: download the ciphertext, check it is the one the message names, decrypt. */
  async openAttachment(att: Attachment): Promise<Uint8Array> {
    if (!att.enc) throw new E2eeError('not_encrypted');
    return openFile(await this.net.bytes(`/media/${att.id}`), att.enc.k, att.enc.hash);
  }

  // ---- recovery --------------------------------------------------------------------------------------------------------------------------------

  /** On a blank device: bring back the device, its chats and its history from the backup the person made. Throws 'no_backup', 'bad_recovery_code' or 'device_not_blank'. */
  /** Is there a backup this code opens? Touches nothing, so a wrong code costs nothing. */
  async checkRecovery(code: string): Promise<void> {
    if (!validCode(code)) throw new E2eeError('bad_recovery_code');
    let got: { data: string };
    try { got = await this.net.json('GET', '/keys/backup'); } catch (e) { if (e instanceof NetError && e.status === 404) throw new E2eeError('no_backup'); throw e; }
    const blob = fromB64(got.data);
    try { await openBackup(blob, await deriveKey(code, saltOf(blob))); } catch { throw new E2eeError('bad_recovery_code'); }
  }
  async restore(code: string): Promise<void> {
    if (await this.kv.get('dev')) throw new E2eeError('device_not_blank');
    if (!validCode(code)) throw new E2eeError('bad_recovery_code');
    let got: { data: string };
    try { got = await this.net.json('GET', '/keys/backup'); } catch (e) { if (e instanceof NetError && e.status === 404) throw new E2eeError('no_backup'); throw e; }
    const blob = fromB64(got.data), salt = saltOf(blob), key = await deriveKey(code, salt);
    let entries: Record<string, string>;
    try { entries = await openBackup(blob, key); } catch { throw new E2eeError('bad_recovery_code'); }
    for (const [k, v] of Object.entries(entries)) await this.kv.set(k, fromB64(v));
    await setJson(this.kv, 'bk', { salt: toB64(salt), key: toB64(key) });
  }
}

export const createE2ee = (userId: number, env: Env) => new E2ee(userId, env);
export { normaliseCode };
