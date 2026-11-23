// The recovery backup (step 6, part B). A person can keep an encrypted copy of this device's whole encryption state (identity key, chat states, decrypted history) on the server,
// so a lost or reset phone can come back. The copy is encrypted on the device with a key made from a RECOVERY CODE the person writes down; the server never has the code.
//
//   code  -> scrypt (N=2^15, r=8, p=1, 16-byte random salt) -> a 256-bit AES-GCM key
//   blob  =  "TMB1" | salt | iv | AES-GCM( gzip( JSON of every stored entry ) )
//
// Honest limits, said to the person before they turn it on: whoever has the code AND can fetch the blob from the server can read the history; a lost code with a lost device means
// lost history; and a restored device is the SAME device as the lost one (so it must not be used while the old one is still in use).

import { scryptAsync } from '@noble/hashes/scrypt.js';
import { fromB64, toB64 } from '../../../core/e2ee';
import type { Kv } from './kv';

const MAGIC = new Uint8Array([0x54, 0x4d, 0x42, 0x31]);   // "TMB1"
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';        // no 0/O, 1/I/L: the code is written by hand
const MAX_BACKUP = 3_500_000;                                // bytes of the blob (the server accepts 4 MB)

/** 25 characters in five groups, about 124 bits. */
export function newRecoveryCode(): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < 25) for (const b of crypto.getRandomValues(new Uint8Array(32))) { if (b < limit && out.length < 25) out.push(ALPHABET[b % ALPHABET.length]); }
  return out.join('').match(/.{5}/g)!.join('-');
}
export const normaliseCode = (code: string) => code.toUpperCase().split('').filter(c => ALPHABET.includes(c)).join('');
export const validCode = (code: string) => normaliseCode(code).length === 25;

export async function deriveKey(code: string, salt: Uint8Array): Promise<Uint8Array> {
  return scryptAsync(new TextEncoder().encode(normaliseCode(code)), salt, { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });
}

export async function gzip(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Keys that are never part of a backup: the backup's own key and anything in flight. */
const SKIP = (k: string) => k === 'bk' || k.startsWith('pend:');
const idOf = (k: string) => Number(k.split(':')[2]) || 0;

/** Everything this device stores, as one encrypted blob. If it would be too big, the oldest decrypted history goes first (the keys and chat states always stay). */
export async function sealBackup(kv: Kv, key: Uint8Array, salt: Uint8Array): Promise<{ blob: Uint8Array; dropped: number }> {
  const entries = new Map<string, string>();
  for (const k of await kv.keys()) { if (SKIP(k)) continue; const v = await kv.get(k); if (v) entries.set(k, toB64(v)); }
  const history = [...entries.keys()].filter(k => k.startsWith('pl:') || k.startsWith('row:')).sort((a, b) => idOf(a) - idOf(b));
  let dropped = 0;
  const aes = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
  for (;;) {
    const packed = await gzip(new TextEncoder().encode(JSON.stringify(Object.fromEntries(entries))));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: MAGIC as BufferSource }, aes, packed as BufferSource));
    const blob = new Uint8Array(MAGIC.length + 16 + 12 + ct.length);
    blob.set(MAGIC); blob.set(salt, MAGIC.length); blob.set(iv, MAGIC.length + 16); blob.set(ct, MAGIC.length + 28);
    if (blob.length <= MAX_BACKUP || !history.length) return { blob, dropped };
    for (let i = 0; i < Math.max(2, Math.ceil(history.length / 10)) && history.length; i++) { entries.delete(history.shift()!); dropped++; }
  }
}
export const saltOf = (blob: Uint8Array) => blob.slice(MAGIC.length, MAGIC.length + 16);
/** The entries inside a backup, or throws 'bad_recovery_code' (wrong code or a damaged blob). */
export async function openBackup(blob: Uint8Array, key: Uint8Array): Promise<Record<string, string>> {
  try {
    if (blob.length < MAGIC.length + 29 || MAGIC.some((x, i) => blob[i] !== x)) throw new Error('format');
    const aes = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
    const packed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(MAGIC.length + 16, MAGIC.length + 28), additionalData: MAGIC as BufferSource }, aes, blob.slice(MAGIC.length + 28) as BufferSource));
    return JSON.parse(new TextDecoder().decode(await gunzip(packed)));
  } catch { throw new Error('bad_recovery_code'); }
}
export { fromB64 };
