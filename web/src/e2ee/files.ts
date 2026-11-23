// Files in an encrypted chat: encrypted on the device with a random key of their own (AES-256-GCM), uploaded as opaque bytes. The key travels INSIDE the encrypted message,
// together with a hash of the bytes the server holds (so the server cannot swap the file for another one). The server never sees a name, a type, a size class or a thumbnail.

import { fromB64, toB64 } from '../../../core/e2ee';

const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

export interface SealedFile { bytes: Uint8Array; key: string; hash: string }
/** bytes -> iv + ciphertext (what is uploaded), the random key (base64) and the SHA-256 of the uploaded bytes (hex). */
export async function sealFile(plain: Uint8Array): Promise<SealedFile> {
  const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain as BufferSource));
  const bytes = new Uint8Array(12 + ct.length); bytes.set(iv); bytes.set(ct, 12);
  return { bytes, key: toB64(raw), hash: hex(await sha256(bytes)) };
}
/** Refuses bytes whose hash is not the one in the message, then decrypts. Throws 'file_hash' or 'file_decrypt'. */
export async function openFile(bytes: Uint8Array, key: string, hash: string): Promise<Uint8Array> {
  if (hex(await sha256(bytes)) !== hash) throw new Error('file_hash');
  try {
    const k = await crypto.subtle.importKey('raw', fromB64(key) as BufferSource, 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, k, bytes.slice(12) as BufferSource));
  } catch { throw new Error('file_decrypt'); }
}
