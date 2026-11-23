// Linking a second device (step 6 hardening). A PAIRING, short-lived and used once:
//
//   NEW device: makes a one-time X25519 key pair (E_n) and a typed code S (16 characters, about 79 bits). It shows a QR code that holds ONLY its device number and E_n's PUBLIC
//     key, and the typed code S as a fallback. It publishes E_n's public key and proof = HMAC(S, "tamtim-link-v2" | device id | identity key | E_n public).
//   OLDER device: scans the picture (so E_n comes from the picture, not from the server) or types S (so E_n is trusted because the proof binds it). It checks the device on the server
//     has that very key, asks the person to CONFIRM, makes its own one-time pair (E_o), and seals the history with
//       K = HKDF-SHA256( X25519(E_o private, E_n public), salt = device id, info = "tamtim-transfer-v2" | E_n public | E_o public )
//     and uploads E_o's public key with the first part. The new device derives the same K from its E_n private key.
//
// Why this holds: a photo of the picture gives E_n public, which is useless without a private key; the server sees both public keys and the sealed bytes but cannot make K, and
// cannot swap E_n (the picture or the proof says which key is the real one). Honest limits: whoever sees the typed code S on the new device's screen before it is used could make
// a device that also fits the code, so the older device shows the device's name and short code to confirm, and a pairing expires after three minutes and works once; whoever holds
// the NEW device unlocked can of course link it.

import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromB64, toB64 } from '../../../core/e2ee';
import { gunzip, gzip } from './backup';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const MAGIC = new Uint8Array([0x54, 0x4d, 0x48, 0x32]);   // "TMH2"
const cat = (...p: Uint8Array[]) => { const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of p) { out.set(x, o); o += x.length; } return out; };
const num = (n: number) => enc.encode(String(n));

export const normaliseLink = (code: string) => code.toUpperCase().split('').filter(c => ALPHABET.includes(c)).join('');
export const validLink = (code: string) => normaliseLink(code).length === 16;
export const prettyLink = (code: string) => normaliseLink(code).match(/.{1,4}/g)?.join('-') ?? '';
export function newLinkCode(): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < 16) for (const b of crypto.getRandomValues(new Uint8Array(32))) { if (b < limit && out.length < 16) out.push(ALPHABET[b % ALPHABET.length]); }
  return prettyLink(out.join(''));
}
export const b64url = (b: Uint8Array) => toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s: string) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

/** A short tag of a device's identity key for the picture (first 12 bytes of its hash). */
export const idTag = (identityKeyB64: string) => b64url(sha256(fromB64(identityKeyB64)).slice(0, 12));

export interface LinkKeys { priv: Uint8Array; pub: Uint8Array }
export function newLinkKeys(): LinkKeys { const k = x25519.keygen(); return { priv: k.secretKey, pub: k.publicKey }; }

/** The proof a new device publishes (hex): it binds the typed code to this device, its identity key and its one-time public key. */
export const linkProof = (code: string, deviceId: number, identityKeyB64: string, pub: Uint8Array) =>
  hex(hmac(sha256, enc.encode(normaliseLink(code)), cat(enc.encode('tamtim-link-v2'), num(deviceId), enc.encode(identityKeyB64), pub)));

/** The key that seals the hand-over, from my private key, my public key and the other side's public key (both sides get the same key; the two public keys go into it in sorted order). */
export function linkKey(myPriv: Uint8Array, theirPub: Uint8Array, myPub: Uint8Array, deviceId: number, secret: Uint8Array = new Uint8Array(0)): Uint8Array {
  // `secret` is what only the person's two screens share (the typed code, or the random secret inside the picture): the server never sees it, so it cannot make this key even though it knows both public keys.
  const shared = cat(x25519.getSharedSecret(myPriv, theirPub), secret);
  const [lo, hi] = hex(myPub) < hex(theirPub) ? [myPub, theirPub] : [theirPub, myPub];
  return hkdf(sha256, shared, num(deviceId), cat(enc.encode('tamtim-transfer-v2'), lo, hi), 32);
}

/** What the older device hands over: only the DECRYPTED history and its small records (never a group state or a key). */
const MAX_PLAIN = 48 * 1024 * 1024;   // what a hand-over may unpack to
export const TRANSFER_KEYS = /^(pl:\d+:\d+|row:\d+:\d+|led:\d+|last:\d+|tk:\d+|ver:\d+|verkeys:\d+)$/;
export async function sealTransfer(entries: Record<string, string>, key: Uint8Array, partSize = 2_000_000): Promise<Uint8Array[]> {
  const aes = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
  const packed = await gzip(enc.encode(JSON.stringify(entries)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: MAGIC as BufferSource }, aes, packed as BufferSource));
  const all = cat(MAGIC, iv, ct);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < all.length; i += partSize) parts.push(all.slice(i, i + partSize));
  return parts;
}
/** Open the parts with the key; throws when the key does not fit or the bytes were changed. Only well-formed history keys come out. */
export async function openTransfer(parts: Uint8Array[], key: Uint8Array, _deviceId?: number): Promise<Record<string, string>> {
  const all = cat(...parts);
  if (all.length < MAGIC.length + 29 || MAGIC.some((x, i) => all[i] !== x)) throw new Error('bad_transfer');
  const aes = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
  const packed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(MAGIC.length, MAGIC.length + 12), additionalData: MAGIC as BufferSource }, aes, all.slice(MAGIC.length + 12) as BufferSource));
  const plain = await gunzip(packed);
  if (plain.length > MAX_PLAIN) throw new Error('too_large');
  const raw = JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (TRANSFER_KEYS.test(k) && typeof v === 'string') out[k] = v;
  return out;
}
