// WebCrypto for a platform that has none (React Native / Hermes), covering exactly what the encryption needs.
//
// The encryption (core/e2ee.ts on ts-mls, HPKE from @hpke/core, the recovery backup) calls `crypto.subtle`. Browsers and
// Node have it; React Native does not. Rather than fork those libraries, this supplies the same `crypto.subtle` calls,
// implemented with the audited @noble libraries (the same ones ts-mls already uses for its pure-JavaScript path).
// It is NOT new cryptography: every primitive is a standard one from @noble, wrapped in WebCrypto's calling shape.
//
// Covered (measured from a full run of the encryption: key packages, groups, joins, commits, messages, safety numbers):
//   digest SHA-256 · HMAC-SHA-256 sign/verify · HKDF-SHA-256 deriveBits · AES-GCM encrypt/decrypt (128/256)
//   X25519 generateKey/importKey/exportKey/deriveBits · Ed25519 generateKey/importKey/exportKey/sign/verify
//   key formats: raw, jwk, pkcs8 (and spki for the public curve keys)
// Anything else throws NotSupportedError, loudly, rather than doing something half right.
//
// Checked against the platform's real WebCrypto byte for byte in core/webcrypto-lite.test.ts, and the whole encryption
// test suite runs on it there too.

import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { gcm } from '@noble/ciphers/aes.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';

type Bytes = Uint8Array;
type Alg = string | { name: string; [k: string]: unknown };
type Usage = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'deriveKey' | 'deriveBits' | 'wrapKey' | 'unwrapKey';

/** The key object handed back: shaped like a CryptoKey (type, algorithm, extractable, usages); the bytes stay inside. */
export class LiteKey {
  readonly type: 'secret' | 'public' | 'private';
  readonly algorithm: { name: string; hash?: { name: string }; length?: number };
  readonly extractable: boolean;
  readonly usages: Usage[];
  /** @internal the raw key bytes (32-byte scalar/seed for private curve keys) */
  readonly _raw: Bytes;
  /** @internal for private curve keys: the matching public key, so jwk export can include `x` */
  readonly _pub?: Bytes;
  constructor(type: LiteKey['type'], algorithm: LiteKey['algorithm'], extractable: boolean, usages: Usage[], raw: Bytes, pub?: Bytes) {
    this.type = type; this.algorithm = algorithm; this.extractable = extractable; this.usages = usages; this._raw = raw; this._pub = pub;
  }
}

export class NotSupportedError extends Error { constructor(what: string) { super(`webcrypto-lite: ${what} is not supported`); this.name = 'NotSupportedError'; } }

const name = (a: Alg) => (typeof a === 'string' ? a : a.name).toUpperCase().replace(/^X25519$/, 'X25519').replace(/^ED25519$/, 'ED25519');
const hashName = (h: unknown) => (typeof h === 'string' ? h : (h as { name?: string })?.name ?? '').toUpperCase();
// Always a COPY, as WebCrypto does: callers wipe or reuse their buffers after handing them over (@hpke zeroes a key's bytes
// right after importing it). Keeping a view instead of a copy left keys silently zeroed — caught by the browser↔phone test.
const bytesOf = (d: BufferSource): Bytes => (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) : new Uint8Array((d as ArrayBuffer).slice(0)));
const out = (b: Bytes): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const requireSha256 = (h: unknown) => { if (hashName(h) !== 'SHA-256') throw new NotSupportedError(`hash ${hashName(h) || '(none)'}`); };

// base64url (JWK)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64url(b: Bytes): string {
  let s = '', i = 0;
  for (; i + 2 < b.length; i += 3) { const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]; s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]; }
  if (i < b.length) { const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8); s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : ''); }
  return s;
}
function unb64url(s: string): Bytes {
  const clean = s.replace(/=+$/, ''); const outArr: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c = [0, 1, 2, 3].map(k => (i + k < clean.length ? B64.indexOf(clean[i + k].replace('+', '-').replace('/', '_')) : -1));
    if (c.slice(0, Math.min(4, clean.length - i)).some(v => v < 0)) throw new Error('bad base64url');
    const n = (c[0] << 18) | (c[1] << 12) | ((c[2] < 0 ? 0 : c[2]) << 6) | (c[3] < 0 ? 0 : c[3]);
    outArr.push((n >> 16) & 255); if (c[2] >= 0) outArr.push((n >> 8) & 255); if (c[3] >= 0) outArr.push(n & 255);
  }
  return new Uint8Array(outArr);
}

// The fixed DER wrappers of RFC 8410 for 32-byte curve keys (OID 1.3.101.110 = X25519, 1.3.101.112 = Ed25519).
const PKCS8 = { X25519: '302e020100300506032b656e04220420', ED25519: '302e020100300506032b657004220420' } as const;
const SPKI = { X25519: '302a300506032b656e032100', ED25519: '302a300506032b6570032100' } as const;
const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map(h => parseInt(h, 16)));
function unwrap(der: Bytes, prefixHex: string, what: string): Bytes {
  const p = hex(prefixHex);
  if (der.length !== p.length + 32 || p.some((v, i) => der[i] !== v)) throw new Error(`webcrypto-lite: not a ${what} key`);
  return der.slice(p.length);
}
const wrap = (prefixHex: string, key: Bytes) => { const p = hex(prefixHex), r = new Uint8Array(p.length + key.length); r.set(p); r.set(key, p.length); return r; };

const curve = (n: string) => (n === 'X25519' ? { pub: (sk: Bytes) => x25519.getPublicKey(sk), rand: () => x25519.utils.randomSecretKey() }
  : n === 'ED25519' ? { pub: (sk: Bytes) => ed25519.getPublicKey(sk), rand: () => ed25519.utils.randomSecretKey() } : null);
const curveName = (n: string) => (n === 'X25519' ? 'X25519' : 'Ed25519');

function needUsage(k: LiteKey, u: Usage) { if (!k.usages.includes(u)) throw new Error(`webcrypto-lite: key cannot be used to ${u}`); }

export const subtleLite = {
  async digest(alg: Alg, data: BufferSource): Promise<ArrayBuffer> {
    if (name(alg) !== 'SHA-256') throw new NotSupportedError(`digest ${name(alg)}`);
    return out(sha256(bytesOf(data)));
  },

  async generateKey(alg: Alg, extractable: boolean, usages: Usage[]): Promise<{ privateKey: LiteKey; publicKey: LiteKey } | LiteKey> {
    const n = name(alg), c = curve(n);
    if (c) {
      const sk = c.rand(), pk = c.pub(sk), algorithm = { name: curveName(n) };
      const privUse = usages.filter(u => u === 'sign' || u === 'deriveBits' || u === 'deriveKey') as Usage[];
      const pubUse = usages.filter(u => u === 'verify') as Usage[];
      return { privateKey: new LiteKey('private', algorithm, extractable, privUse, sk, pk), publicKey: new LiteKey('public', algorithm, true, pubUse, pk) };
    }
    if (n === 'AES-GCM' || n === 'HMAC') {
      const len = n === 'HMAC' ? 32 : Number((alg as { length?: number }).length ?? 256) / 8;
      const raw = globalThis.crypto.getRandomValues(new Uint8Array(len));
      return new LiteKey('secret', n === 'HMAC' ? { name: 'HMAC', hash: { name: 'SHA-256' }, length: 256 } : { name: 'AES-GCM', length: len * 8 }, extractable, usages, raw);
    }
    throw new NotSupportedError(`generateKey ${n}`);
  },

  async importKey(format: string, keyData: BufferSource | JsonWebKey, alg: Alg, extractable: boolean, usages: Usage[]): Promise<LiteKey> {
    const n = name(alg);
    if (n === 'HMAC') {
      requireSha256((alg as { hash?: unknown }).hash);
      if (format !== 'raw') throw new NotSupportedError(`HMAC import ${format}`);
      const raw = bytesOf(keyData as BufferSource);
      return new LiteKey('secret', { name: 'HMAC', hash: { name: 'SHA-256' }, length: raw.length * 8 }, extractable, usages, raw);
    }
    if (n === 'HKDF') {
      if (format !== 'raw') throw new NotSupportedError(`HKDF import ${format}`);
      return new LiteKey('secret', { name: 'HKDF' }, false, usages, bytesOf(keyData as BufferSource));
    }
    if (n === 'AES-GCM') {
      if (format !== 'raw') throw new NotSupportedError(`AES-GCM import ${format}`);
      const raw = bytesOf(keyData as BufferSource);
      if (![16, 24, 32].includes(raw.length)) throw new Error('webcrypto-lite: bad AES key length');
      return new LiteKey('secret', { name: 'AES-GCM', length: raw.length * 8 }, extractable, usages, raw);
    }
    const c = curve(n);
    if (!c) throw new NotSupportedError(`importKey ${n}`);
    const algorithm = { name: curveName(n) }, which = n as 'X25519' | 'ED25519';
    if (format === 'raw') return new LiteKey('public', algorithm, true, usages, bytesOf(keyData as BufferSource));
    if (format === 'spki') return new LiteKey('public', algorithm, true, usages, unwrap(bytesOf(keyData as BufferSource), SPKI[which], 'spki'));
    if (format === 'pkcs8') { const sk = unwrap(bytesOf(keyData as BufferSource), PKCS8[which], 'pkcs8'); return new LiteKey('private', algorithm, extractable, usages, sk, c.pub(sk)); }
    if (format === 'jwk') {
      const j = keyData as JsonWebKey;
      if (j.kty !== 'OKP' || j.crv !== curveName(n)) throw new Error('webcrypto-lite: jwk is not ' + curveName(n));
      if (j.d) { const sk = unb64url(j.d); return new LiteKey('private', algorithm, extractable, usages, sk, j.x ? unb64url(j.x) : c.pub(sk)); }
      return new LiteKey('public', algorithm, true, usages, unb64url(j.x!));
    }
    throw new NotSupportedError(`importKey format ${format}`);
  },

  async exportKey(format: string, key: LiteKey): Promise<ArrayBuffer | JsonWebKey> {
    if (!key.extractable) throw new Error('webcrypto-lite: key is not extractable');
    const n = name(key.algorithm.name);
    if (n === 'HMAC' || n === 'AES-GCM') { if (format !== 'raw') throw new NotSupportedError(`${n} export ${format}`); return out(key._raw); }
    const c = curve(n);
    if (!c) throw new NotSupportedError(`exportKey ${n}`);
    const which = n as 'X25519' | 'ED25519';
    if (format === 'raw') { if (key.type !== 'public') throw new Error('webcrypto-lite: raw export is for public keys'); return out(key._raw); }
    if (format === 'spki') { if (key.type !== 'public') throw new Error('webcrypto-lite: spki is for public keys'); return out(wrap(SPKI[which], key._raw)); }
    if (format === 'pkcs8') { if (key.type !== 'private') throw new Error('webcrypto-lite: pkcs8 is for private keys'); return out(wrap(PKCS8[which], key._raw)); }
    if (format === 'jwk') {
      const pub = key.type === 'private' ? (key._pub ?? c.pub(key._raw)) : key._raw;
      return { kty: 'OKP', crv: curveName(n), x: b64url(pub), ...(key.type === 'private' ? { d: b64url(key._raw) } : {}), ext: true, key_ops: key.usages };
    }
    throw new NotSupportedError(`exportKey format ${format}`);
  },

  async sign(alg: Alg, key: LiteKey, data: BufferSource): Promise<ArrayBuffer> {
    const n = name(alg);
    needUsage(key, 'sign');
    if (n === 'HMAC') { requireSha256(key.algorithm.hash); return out(hmac(sha256, key._raw, bytesOf(data))); }
    if (n === 'ED25519') return out(ed25519.sign(bytesOf(data), key._raw));
    throw new NotSupportedError(`sign ${n}`);
  },

  async verify(alg: Alg, key: LiteKey, signature: BufferSource, data: BufferSource): Promise<boolean> {
    const n = name(alg);
    needUsage(key, 'verify');
    if (n === 'HMAC') {
      const want = hmac(sha256, key._raw, bytesOf(data)), got = bytesOf(signature);
      if (want.length !== got.length) return false;
      let d = 0; for (let i = 0; i < want.length; i++) d |= want[i] ^ got[i];   // constant time
      return d === 0;
    }
    if (n === 'ED25519') { try { return ed25519.verify(bytesOf(signature), bytesOf(data), key._raw); } catch { return false; } }
    throw new NotSupportedError(`verify ${n}`);
  },

  async deriveBits(alg: Alg & { public?: LiteKey; salt?: BufferSource; info?: BufferSource; hash?: unknown }, key: LiteKey, length: number): Promise<ArrayBuffer> {
    const n = name(alg);
    if (n === 'X25519') {
      needUsage(key, 'deriveBits');
      if (!alg.public) throw new Error('webcrypto-lite: X25519 needs a public key');
      const shared = x25519.getSharedSecret(key._raw, alg.public._raw);
      if (shared.every(b => b === 0)) throw new Error('webcrypto-lite: X25519 produced an all-zero secret');   // as WebCrypto does
      return out(length == null ? shared : shared.slice(0, length / 8));
    }
    if (n === 'HKDF') {
      requireSha256(alg.hash);
      return out(hkdf(sha256, key._raw, alg.salt ? bytesOf(alg.salt) : new Uint8Array(0), alg.info ? bytesOf(alg.info) : new Uint8Array(0), length / 8));
    }
    throw new NotSupportedError(`deriveBits ${n}`);
  },

  async encrypt(alg: Alg & { iv?: BufferSource; additionalData?: BufferSource; tagLength?: number }, key: LiteKey, data: BufferSource): Promise<ArrayBuffer> {
    if (name(alg) !== 'AES-GCM') throw new NotSupportedError(`encrypt ${name(alg)}`);
    needUsage(key, 'encrypt');
    if ((alg.tagLength ?? 128) !== 128) throw new NotSupportedError('AES-GCM tag length other than 128');
    return out(gcm(key._raw, bytesOf(alg.iv!), alg.additionalData ? bytesOf(alg.additionalData) : undefined).encrypt(bytesOf(data)));
  },

  async decrypt(alg: Alg & { iv?: BufferSource; additionalData?: BufferSource; tagLength?: number }, key: LiteKey, data: BufferSource): Promise<ArrayBuffer> {
    if (name(alg) !== 'AES-GCM') throw new NotSupportedError(`decrypt ${name(alg)}`);
    needUsage(key, 'decrypt');
    if ((alg.tagLength ?? 128) !== 128) throw new NotSupportedError('AES-GCM tag length other than 128');
    try { return out(gcm(key._raw, bytesOf(alg.iv!), alg.additionalData ? bytesOf(alg.additionalData) : undefined).decrypt(bytesOf(data))); }
    catch { const e = new Error('The operation failed for an operation-specific reason'); e.name = 'OperationError'; throw e; }   // WebCrypto's error for a bad tag
  },
};

/**
 * Give the platform a `crypto.subtle` when it has none. Does nothing where the real one exists (browsers, Node), so the
 * web keeps the platform's implementation. `getRandomValues` must already be there (on React Native: expo-crypto).
 */
export function installWebCryptoLite(): boolean {
  const g = globalThis as { crypto?: { subtle?: unknown; getRandomValues?: unknown } };
  if (g.crypto?.subtle) return false;
  if (typeof g.crypto?.getRandomValues !== 'function') throw new Error('webcrypto-lite: crypto.getRandomValues is missing (install it first)');
  Object.defineProperty(g.crypto, 'subtle', { value: subtleLite, configurable: true, enumerable: true });
  return true;
}
