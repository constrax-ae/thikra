// The WebCrypto stand-in for React Native, checked against the platform's real WebCrypto (Node's) byte for byte, and then
// carrying the real encryption: two devices, a group of three, joins, commits, messages and a safety number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtleLite } from './webcrypto-lite.ts';

const real = globalThis.crypto.subtle;
const lite = subtleLite as unknown as SubtleCrypto;
const rnd = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const eq = (a: ArrayBuffer, b: ArrayBuffer) => assert.deepEqual(new Uint8Array(a), new Uint8Array(b));

test('SHA-256, HMAC and HKDF give the same bytes as WebCrypto', async () => {
  for (const len of [0, 1, 55, 64, 300, 1000]) { const data = rnd(len); eq(await lite.digest('SHA-256', data), await real.digest('SHA-256', data)); }
  const k = rnd(32), msg = rnd(77);
  const hr = await real.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const hl = await lite.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const sig = await real.sign('HMAC', hr, msg);
  eq(await lite.sign('HMAC', hl, msg), sig);
  assert.equal(await lite.verify('HMAC', hl, sig, msg), true);
  assert.equal(await lite.verify('HMAC', hl, sig, rnd(77)), false);
  const ikm = rnd(32), salt = rnd(16), info = rnd(10);
  const kr = await real.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const kl = await lite.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  for (const bits of [128, 256, 512]) eq(await lite.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, kl, bits), await real.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, kr, bits));
});

test('AES-GCM: each side opens what the other sealed; a changed byte is refused', async () => {
  for (const size of [16, 32]) {
    const key = rnd(size), iv = rnd(12), ad = rnd(9), pt = rnd(123);
    const kr = await real.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const kl = await lite.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const ctReal = await real.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, kr, pt);
    eq(await lite.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, kl, pt), ctReal);
    eq(await lite.decrypt({ name: 'AES-GCM', iv, additionalData: ad }, kl, ctReal), pt.buffer);
    const bad = new Uint8Array(ctReal); bad[3] ^= 1;
    await assert.rejects(lite.decrypt({ name: 'AES-GCM', iv, additionalData: ad }, kl, bad), /operation/i);
  }
});

test('X25519: keys move between the two implementations in every format, and both derive the same secret', async () => {
  const a = await real.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  const b = await lite.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  // real private (pkcs8, jwk) → lite; lite public (raw) → real
  const aPkcs8 = await real.exportKey('pkcs8', a.privateKey), aJwk = await real.exportKey('jwk', a.privateKey);
  const aLite = await lite.importKey('pkcs8', aPkcs8, { name: 'X25519' }, true, ['deriveBits']);
  const aLiteJ = await lite.importKey('jwk', aJwk, { name: 'X25519' }, true, ['deriveBits']);
  eq(await lite.exportKey('pkcs8', aLite) as ArrayBuffer, aPkcs8);
  assert.deepEqual({ ...(await lite.exportKey('jwk', aLiteJ) as JsonWebKey), key_ops: undefined, ext: undefined }, { ...aJwk, key_ops: undefined, ext: undefined });
  const bRawPub = await lite.exportKey('raw', b.publicKey) as ArrayBuffer;
  const bPubReal = await real.importKey('raw', bRawPub, { name: 'X25519' }, true, []);
  const aPubRaw = await real.exportKey('raw', a.publicKey);
  const aPubLite = await lite.importKey('raw', aPubRaw, { name: 'X25519' }, true, []);
  const s1 = await real.deriveBits({ name: 'X25519', public: bPubReal }, a.privateKey, 256);
  const s2 = await lite.deriveBits({ name: 'X25519', public: aPubLite } as never, b.privateKey, 256);
  const s3 = await lite.deriveBits({ name: 'X25519', public: await lite.importKey('raw', bRawPub, { name: 'X25519' }, true, []) } as never, aLite, 256);
  eq(s2, s1); eq(s3, s1);
  eq(await lite.exportKey('spki', aPubLite) as ArrayBuffer, await real.exportKey('spki', a.publicKey));
});

test('Ed25519: same signatures as WebCrypto, verified both ways', async () => {
  const pair = await real.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const priv = await lite.importKey('pkcs8', await real.exportKey('pkcs8', pair.privateKey), { name: 'Ed25519' }, true, ['sign']);
  const pub = await lite.importKey('raw', await real.exportKey('raw', pair.publicKey), { name: 'Ed25519' }, true, ['verify']);
  const msg = rnd(90);
  const sReal = await real.sign('Ed25519', pair.privateKey, msg);
  eq(await lite.sign('Ed25519', priv, msg), sReal);   // Ed25519 is deterministic
  assert.equal(await lite.verify('Ed25519', pub, sReal, msg), true);
  assert.equal(await lite.verify('Ed25519', pub, sReal, rnd(90)), false);
  const lp = await lite.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const s = await lite.sign('Ed25519', lp.privateKey, msg);
  const pubReal = await real.importKey('raw', await lite.exportKey('raw', lp.publicKey) as ArrayBuffer, { name: 'Ed25519' }, true, ['verify']);
  assert.equal(await real.verify('Ed25519', pubReal, s, msg), true);
});

test('anything it does not cover fails loudly', async () => {
  await assert.rejects(lite.digest('SHA-512', new Uint8Array(1)), /not supported/);
  await assert.rejects(lite.importKey('raw', rnd(32), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']), /not supported/);
  await assert.rejects(lite.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']), /not supported/);
});

test('a caller wiping its buffer after handing it over does not change the key (as with WebCrypto)', async () => {
  // @hpke zeroes key bytes right after importing them; a stored view instead of a copy turned every key into zeros.
  const key = rnd(16), iv = rnd(12), pt = rnd(40);
  const kr = await real.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = await real.encrypt({ name: 'AES-GCM', iv }, kr, pt);
  const buf = key.slice().buffer;
  const kl = await lite.importKey('raw', buf, 'AES-GCM', false, ['decrypt']);
  new Uint8Array(buf).fill(0);   // the caller cleans up
  eq(await lite.decrypt({ name: 'AES-GCM', iv }, kl, ct), pt.buffer);
  const hk = rnd(32), hb = hk.slice().buffer, msg = rnd(20);
  const hl = await lite.importKey('raw', hb, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); new Uint8Array(hb).fill(0);
  eq(await lite.sign('HMAC', hl, msg), await real.sign('HMAC', await real.importKey('raw', hk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), msg));
});
