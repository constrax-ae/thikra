import { createHmac, randomBytes } from 'node:crypto';

// One-time codes from an authenticator app (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits). No library: it is forty lines and the algorithm is fixed by the standard.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32 = (buf: Buffer) => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
export const unbase32 = (s: string) => { let bits = ''; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const v = ALPHABET.indexOf(ch); if (v >= 0) bits += v.toString(2).padStart(5, '0'); } const bytes: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(bytes); };
export const newSecret = () => base32(randomBytes(20));
export const stepNow = (now = Date.now()) => Math.floor(now / 30_000);
export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
/** The step the code belongs to (this one, or one either side for a slow clock), or null. A step already used is refused, so a code works once. */
export function verifyCode(secret: string, code: unknown, lastStep = 0, now = Date.now()): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return null;
  const s = stepNow(now);
  for (const step of [s, s - 1, s + 1]) if (step > lastStep && codeAt(secret, step) === code.trim()) return step;
  return null;
}
export const otpauthUri = (secret: string, account: string, issuer = 'Thekra') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
