/**
 * End-to-end encryption core (feature 26). Pure TypeScript, no server or UI: the web app, the server's tests and the future mobile app use the same code.
 *
 * Protocol: MLS (RFC 9420), through the `ts-mls` library. We write NO cryptography here. This file only
 *  - fixes one ciphersuite (the one every MLS stack supports),
 *  - turns the library's objects into bytes (so a device can store them and the server can carry them),
 *  - names things the way Tamtim does (device, group epoch, safety number).
 * Why MLS and not the Signal protocol: docs/superpowers/specs/2026-11-19-encryption-plan.md.
 *
 * Model: every DEVICE is one member (leaf) of the MLS group of a chat. A person with a phone and a laptop is two leaves. A private chat is a
 * group of two people. Adding or removing a device or a person is a Commit, which moves the group to the next EPOCH (new keys): a removed device
 * cannot read anything sent in a later epoch, and a device that joins by a Welcome cannot read earlier epochs.
 *
 * The server is only a delivery service: it stores KeyPackages (a device's one-time public keys), Commits and Welcomes as opaque bytes.
 *
 * NOT AUDITED: ts-mls says of itself that it "has not undergone a formal security audit". Nothing here may be announced as secure until an
 * independent external review is done (docs/STATUS.md).
 */
import {
  createApplicationMessage, createCommit, createGroup as mlsCreateGroup, decodeGroupState, decodeMlsMessage, defaultCapabilities, defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig, defaultLifetime, defaultLifetimeConfig, defaultPaddingConfig, emptyPskIndex, encodeGroupState, encodeMlsMessage, generateKeyPackageWithKey,
  getCiphersuiteFromName, getCiphersuiteImpl, joinGroup, processPrivateMessage, nobleCryptoProvider,
  type ClientConfig, type ClientState, type CiphersuiteImpl, type CryptoProvider, type Credential, type KeyPackage, type PrivateKeyPackage, type Proposal,
} from 'ts-mls';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { verifyKeyPackage } from 'ts-mls/keyPackage.js';
import { verifyLeafNodeSignatureKeyPackage } from 'ts-mls/leafNode.js';

/** The one ciphersuite: X25519 key agreement, AES-128-GCM, SHA-256, Ed25519 signatures (MLS ciphersuite 1, the mandatory one). */
export const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;
let cached: Promise<CiphersuiteImpl> | undefined;
let provider: CryptoProvider | undefined;   // undefined: the library's default, which uses the platform's WebCrypto (browser, Node)
const suite = () => (cached ??= getCiphersuiteImpl(getCiphersuiteFromName(SUITE), provider));
/**
 * The phone app: React Native has no WebCrypto (`crypto.subtle`), so it uses the library's pure-JavaScript provider built on the
 * same @noble libraries. Same ciphersuite, same bytes on the wire: a phone and a browser read each other's messages.
 * Called once at start-up, before anything is encrypted.
 */
export function usePureJsCrypto(): void { provider = nobleCryptoProvider; cached = undefined; }

const enc = new TextEncoder(), dec = new TextDecoder();

/** Decode one MLS message and NOTHING else: the library ignores bytes after the message, so two different byte strings could mean the same message (a copy with junk appended would use up the real one's key). */
function decodeStrict(bytes: Uint8Array) {
  const d = decodeMlsMessage(bytes, 0);
  if (!d || d[1] !== bytes.length) return undefined;
  return d[0];
}

// ---- identities --------------------------------------------------------------------------------------------------------------------------

/** A device's name inside MLS: `u<user id>.d<device id>`. The server's device registry (POST /api/keys) uses the same two numbers. */
export const identityOf = (userId: number, deviceId: number) => `u${userId}.d${deviceId}`;
export function parseIdentity(identity: string): { userId: number; deviceId: number } | null {
  const m = /^u(\d{1,12})\.d(\d{1,12})$/.exec(identity);
  return m ? { userId: Number(m[1]), deviceId: Number(m[2]) } : null;
}

/**
 * Who may be a member. MLS checks a member's signature, but WHO that key belongs to is for the application to say. `trusted` is asked about
 * every credential that appears in a group (a key package, a welcome, a commit); the app answers from the server's device directory and from the
 * keys the person has already verified (safety numbers). The default refuses anything that is not a well-formed Tamtim device name.
 */
export type Trust = (identity: string, signaturePublicKey: Uint8Array) => boolean | Promise<boolean>;
const configFor = (trusted?: Trust): ClientConfig => ({
  keyRetentionConfig: { ...defaultKeyRetentionConfig, retainKeysForGenerations: 100, retainKeysForEpochs: 16, maximumForwardRatchetSteps: 1000 },
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
  authService: {
    async validateCredential(credential: Credential, signaturePublicKey: Uint8Array) {
      if (credential.credentialType !== 'basic') return false;
      const identity = dec.decode(credential.identity);
      return !!parseIdentity(identity) && (trusted ? await trusted(identity, signaturePublicKey) : true);
    },
  },
});

// ---- key packages (a device's public keys, published to the server) ----------------------------------------------------------------------

/** What a device keeps for one key package: the public part (also sent to the server) and the secret part (never leaves the device). */
export interface StoredKeyPackage { ref: string; publicBytes: Uint8Array; secretBytes: Uint8Array }

function packSecret(p: PrivateKeyPackage): Uint8Array {
  const parts = [p.initPrivateKey, p.hpkePrivateKey, p.signaturePrivateKey];
  const out = new Uint8Array(parts.reduce((n, x) => n + 2 + x.length, 0));
  let o = 0;
  for (const x of parts) { out[o++] = x.length >> 8; out[o++] = x.length & 255; out.set(x, o); o += x.length; }
  return out;
}
function unpackSecret(b: Uint8Array): PrivateKeyPackage {
  const parts: Uint8Array[] = [];
  for (let o = 0; o < b.length;) { const n = (b[o] << 8) | b[o + 1]; parts.push(b.slice(o + 2, o + 2 + n)); o += 2 + n; }
  if (parts.length !== 3) throw new Error('bad_key_package_secret');
  return { initPrivateKey: parts[0], hpkePrivateKey: parts[1], signaturePrivateKey: parts[2] };
}
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
// @noble's SHA-256 (the same digest as WebCrypto's) so this works where there is no crypto.subtle (React Native).
async function sha256(b: Uint8Array) { return nobleSha256(b); }
async function refOf(publicBytes: Uint8Array) { return hex(await sha256(publicBytes)).slice(0, 32); }

/** A device's long-lived identity: one Ed25519 signing key pair, made once when the device is set up. The public half is what a safety number is made from. */
export interface DeviceIdentity { signKey: Uint8Array; publicKey: Uint8Array }
export async function newDeviceIdentity(): Promise<DeviceIdentity> {
  const { signKey, publicKey } = await (await suite()).signature.keygen();
  return { signKey, publicKey };
}
/** Make `n` fresh key packages for one device, all signed by its identity key. Upload `publicBytes` (POST /api/keys/devices/:id/packages); keep `secretBytes` on the device until used. */
export async function newKeyPackages(userId: number, deviceId: number, n: number, identity: DeviceIdentity): Promise<StoredKeyPackage[]> {
  const cs = await suite();
  const credential: Credential = { credentialType: 'basic', identity: enc.encode(identityOf(userId, deviceId)) };
  const out: StoredKeyPackage[] = [];
  for (let i = 0; i < n; i++) {
    const kp = await generateKeyPackageWithKey(credential, defaultCapabilities(), defaultLifetime, [], identity, cs);
    const publicBytes = encodeMlsMessage({ keyPackage: kp.publicPackage, wireformat: 'mls_key_package', version: 'mls10' });
    out.push({ ref: await refOf(publicBytes), publicBytes, secretBytes: packSecret(kp.privatePackage) });
  }
  return out;
}
function decodeKeyPackage(bytes: Uint8Array): KeyPackage {
  const m = decodeStrict(bytes);
  if (!m || m.wireformat !== 'mls_key_package') throw new Error('not_a_key_package');
  return m.keyPackage;
}
/** Who a published key package says it belongs to, and its signing key (the device's identity key): what the server and the safety number look at. */
export function describeKeyPackage(bytes: Uint8Array): { identity: string; signaturePublicKey: Uint8Array } {
  const kp = decodeKeyPackage(bytes);
  const c = kp.leafNode.credential;
  if (c.credentialType !== 'basic') throw new Error('bad_credential');
  return { identity: dec.decode(c.identity), signaturePublicKey: kp.leafNode.signaturePublicKey };
}

/**
 * Does this key package hold up: our ciphersuite and version, both signatures (the package's and its leaf's) verify, and it has not expired. The server asks this before it
 * stores one, so a broken or foreign package cannot sit in the directory and make a chat that claims it fail (red-team 2026-11-19).
 */
export async function checkKeyPackage(bytes: Uint8Array, now = Date.now()): Promise<boolean> {
  try {
    const kp = decodeKeyPackage(bytes), cs = await suite();
    if (kp.cipherSuite !== SUITE || kp.version !== 'mls10') return false;
    if (kp.leafNode.leafNodeSource !== 'key_package') return false;
    const life = kp.leafNode.lifetime;
    if (life && (BigInt(Math.floor(now / 1000)) < life.notBefore - 3600n || BigInt(Math.floor(now / 1000)) > life.notAfter)) return false;
    return (await verifyKeyPackage(kp, cs.signature)) && (await verifyLeafNodeSignatureKeyPackage(kp.leafNode, cs.signature));
  } catch { return false; }
}

/**
 * What the PLAIN header of an MLS message says, for a server that must not read it but may check its shape: which kind of message it is, and for a private message (a
 * commit or a chat message) the group, the epoch, the content type and the authenticated data (which MLS sends in the clear, so it must be empty). Null if it is not MLS.
 */
export type MessageHeader = { wireformat: 'mls_private_message'; groupId: string; epoch: number; contentType: string; authenticatedDataLength: number } | { wireformat: 'mls_welcome' } | { wireformat: string };
export function describeMessage(bytes: Uint8Array): MessageHeader | null {
  try {
    const d = decodeMlsMessage(bytes, 0);
    if (!d || d[1] !== bytes.length) return null;   // trailing bytes are not part of an MLS message
    const m = d[0];
    if (m.version !== 'mls10') return null;
    if (m.wireformat === 'mls_private_message') {
      const p = m.privateMessage;
      return { wireformat: 'mls_private_message', groupId: dec.decode(p.groupId), epoch: Number(p.epoch), contentType: p.contentType, authenticatedDataLength: p.authenticatedData.length };
    }
    return { wireformat: m.wireformat };
  } catch { return null; }
}

// ---- groups -------------------------------------------------------------------------------------------------------------------------------

/** One chat as this device knows it. Opaque: save it with `saveGroup` after EVERY operation (each one moves the keys forward). */
export type Group = ClientState;

export async function createGroup(groupId: string, own: StoredKeyPackage, trusted?: Trust): Promise<Group> {
  return mlsCreateGroup(enc.encode(groupId), decodeKeyPackage(own.publicBytes), unpackSecret(own.secretBytes), [], await suite(), configFor(trusted));
}
/** Serialise a group (keep it in the device's encrypted storage) and bring it back. */
export const saveGroup = (g: Group): Uint8Array => encodeGroupState(g);
export function loadGroup(bytes: Uint8Array, trusted?: Trust): Group {
  const d = decodeGroupState(bytes, 0);
  if (!d) throw new Error('bad_group_state');
  return { ...d[0], clientConfig: configFor(trusted) };
}
/** Which key epoch the group is in. The server shows it next to every message (a plain number) so it can keep removed members out. */
export const epochOf = (g: Group): number => Number(g.groupContext.epoch);
export const groupIdOf = (g: Group): string => dec.decode(g.groupContext.groupId);

export interface Member { leafIndex: number; identity: string; signaturePublicKey: Uint8Array }
/** Every device in the group now. (MLS numbers the leaves; a removed device leaves a blank that is skipped.) */
export function members(g: Group): Member[] {
  const out: Member[] = [];
  g.ratchetTree.forEach((node, i) => {
    if (i % 2 === 0 && node && node.nodeType === 'leaf' && node.leaf.credential.credentialType === 'basic') {
      out.push({ leafIndex: i / 2, identity: dec.decode(node.leaf.credential.identity), signaturePublicKey: node.leaf.signaturePublicKey });
    }
  });
  return out;
}

export interface Handshake {
  group: Group;
  /** Send to every current member (POST /api/circles/:id/e2ee/commits). */
  commit: Uint8Array;
  /** Only when someone was added: send to the new devices (the server hands it to each of them). */
  welcome?: Uint8Array;
}
const wrap = (r: { newState: ClientState; commit: unknown; welcome?: unknown; consumed: Uint8Array[] }): Handshake => {
  const h: Handshake = {
    group: r.newState,
    commit: encodeMlsMessage(r.commit as never),
    welcome: r.welcome ? encodeMlsMessage({ welcome: r.welcome as never, wireformat: 'mls_welcome', version: 'mls10' }) : undefined,
  };
  r.consumed.forEach(x => x.fill(0));   // the library asks us to wipe the keys it used
  return h;
};
/** Add devices (their published key packages). Also the way a person's second device joins every chat of theirs. */
export async function addDevices(g: Group, keyPackages: Uint8Array[]): Promise<Handshake> {
  const extra: Proposal[] = keyPackages.map(b => ({ proposalType: 'add', add: { keyPackage: decodeKeyPackage(b) } }));
  return wrap(await createCommit({ state: g, cipherSuite: await suite() }, { extraProposals: extra, ratchetTreeExtension: true }));
}
/** Remove devices by name (`identityOf`) or every device of a person (`u<id>.`). The next epoch's keys are unknown to them. */
export async function removeDevices(g: Group, who: { userId: number } | { identity: string }): Promise<Handshake> {
  const leaves = members(g).filter(m => 'userId' in who ? parseIdentity(m.identity)?.userId === who.userId : m.identity === who.identity);
  if (!leaves.length) throw new Error('not_a_member');
  const extra: Proposal[] = leaves.map(m => ({ proposalType: 'remove', remove: { removed: m.leafIndex } }));
  return wrap(await createCommit({ state: g, cipherSuite: await suite() }, { extraProposals: extra }));
}
/** Refresh the group's keys without changing who is in it (done now and then, and after a device is suspected lost). */
export async function rotateKeys(g: Group): Promise<Handshake> {
  return wrap(await createCommit({ state: g, cipherSuite: await suite() }));
}
/** Join a chat from a Welcome, with the key package the welcome was made for (found by `welcomeFor`). */
export async function join(welcome: Uint8Array, own: StoredKeyPackage, trusted?: Trust): Promise<Group> {
  const m = decodeStrict(welcome);
  if (!m || m.wireformat !== 'mls_welcome') throw new Error('not_a_welcome');
  return joinGroup(m.welcome, decodeKeyPackage(own.publicBytes), unpackSecret(own.secretBytes), emptyPskIndex, await suite(), undefined, undefined, configFor(trusted));
}
/** A commit from another member: move to the next epoch. Throws if it is not valid for this group (wrong epoch, bad signature, not a member...). */
export async function processCommit(g: Group, commit: Uint8Array): Promise<Group> {
  const m = decodeStrict(commit);
  if (!m || m.wireformat !== 'mls_private_message') throw new Error('not_a_commit');
  const r = await processPrivateMessage(g, m.privateMessage, emptyPskIndex, await suite());
  r.consumed.forEach(x => x.fill(0));
  if (r.kind !== 'newState') throw new Error('not_a_commit');
  return r.newState;
}

// ---- messages -----------------------------------------------------------------------------------------------------------------------------

/** Encrypt bytes for the group: one ciphertext every other device can read. Keep the returned group (the sending keys moved forward). */
export async function encrypt(g: Group, plaintext: Uint8Array): Promise<{ group: Group; ciphertext: Uint8Array }> {
  const r = await createApplicationMessage(g, plaintext, await suite());
  const ciphertext = encodeMlsMessage({ privateMessage: r.privateMessage, wireformat: 'mls_private_message', version: 'mls10' });
  r.consumed.forEach(x => x.fill(0));
  return { group: r.newState, ciphertext };
}
export async function decrypt(g: Group, ciphertext: Uint8Array): Promise<{ group: Group; plaintext: Uint8Array }> {
  const m = decodeStrict(ciphertext);
  if (!m || m.wireformat !== 'mls_private_message') throw new Error('not_a_message');
  const r = await processPrivateMessage(g, m.privateMessage, emptyPskIndex, await suite());
  r.consumed.forEach(x => x.fill(0));
  if (r.kind !== 'applicationMessage') throw new Error('not_a_message');
  return { group: r.newState, plaintext: r.message };
}
export const encryptText = (g: Group, text: string) => encrypt(g, enc.encode(text));
export async function decryptText(g: Group, ciphertext: Uint8Array) {
  const r = await decrypt(g, ciphertext);
  return { group: r.group, text: dec.decode(r.plaintext) };
}

// ---- base64 for the wire (JSON) ----------------------------------------------------------------------------------------------------------

export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// ---- safety number ------------------------------------------------------------------------------------------------------------------------

/**
 * The number two people compare (read aloud or scan) to be sure no one sits in between. It is a hash of the two people's device identity keys,
 * in a fixed order, shown as 12 groups of 5 digits. If either person's keys change, the number changes and the app says so.
 */
export async function safetyNumber(a: { userId: number; keys: Uint8Array[] }, b: { userId: number; keys: Uint8Array[] }): Promise<string> {
  const side = (p: typeof a) => [String(p.userId), ...p.keys.map(hex).sort()].join('|');
  const [x, y] = [side(a), side(b)].sort();
  const digest = await sha256(enc.encode(`tamtim-safety-v1|${x}|${y}`));
  let n = 0n;
  for (const byte of digest.slice(0, 25)) n = (n << 8n) | BigInt(byte);
  const digits = n.toString().padStart(60, '0').slice(-60);
  return digits.match(/.{5}/g)!.join(' ');
}

// ---- endorsements: one device of a person vouches for another device of the same person ---------------------------------------------------

/**
 * "This device is mine too": the person's older device signs the new device's name and identity key with its own identity key. Everyone who already trusts the older device
 * (the people in a chat with it) can check the signature themselves, so a new device of a known person may be added without the server's word, and without a vote of the
 * other members. The statement names the user, the device number and the key, so it fits nothing else.
 */
const endorsementText = (userId: number, deviceId: number, key: Uint8Array) => enc.encode(`tamtim-device-v1|u${userId}|d${deviceId}|${hex(key)}`);
export async function endorseDevice(signerKey: Uint8Array, userId: number, deviceId: number, deviceIdentityKey: Uint8Array): Promise<Uint8Array> {
  return (await suite()).signature.sign(signerKey, endorsementText(userId, deviceId, deviceIdentityKey));
}
export async function verifyEndorsement(signerPublicKey: Uint8Array, userId: number, deviceId: number, deviceIdentityKey: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try { return await (await suite()).signature.verify(signerPublicKey, endorsementText(userId, deviceId, deviceIdentityKey), signature); } catch { return false; }
}
