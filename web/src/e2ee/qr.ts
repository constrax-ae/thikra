// The pictures (QR codes) of the app: the link of a new device and the safety number. Made on the device by `uqr` (MIT, no dependencies); read back, where the browser has no
// BarcodeDetector, by `jsqr` (Apache-2.0), which `scan.ts` loads only when it is needed. A picture of the link holds a device number and ONE-TIME PUBLIC KEY: nothing in it opens a chat.
import { encode, renderSVG } from 'uqr';

export const qrMatrix = (text: string): boolean[][] => encode(text, { ecc: 'M', border: 0 }).data;
/** An SVG picture (black on white with a quiet border). The payload is not written into it as text. */
export const qrSvg = (text: string): string => renderSVG(text, { ecc: 'M', border: 2, pixelSize: 1 });

export const LINK_PREFIX = 'tamtim-link:1:';
export const SAFETY_PREFIX = 'tamtim-safety:1:';
/** `tag` is the first 12 bytes of the hash of the new device's own identity key, so the picture also says WHICH device key is meant. */
export const linkPayload = (deviceId: number, pubB64url: string, tag: string, secret: string) => `${LINK_PREFIX}${deviceId}:${pubB64url}:${tag}:${secret}`;
export function parseLinkPayload(text: string): { deviceId: number; pub: string; tag: string; secret: string } | null {
  const m = /^tamtim-link:1:(\d{1,9}):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22})$/.exec(text.trim());
  return m ? { deviceId: Number(m[1]), pub: m[2], tag: m[3], secret: m[4] } : null;
}
export const safetyPayload = (digits: string) => `${SAFETY_PREFIX}${digits}`;
export function parseSafetyPayload(text: string): string | null {
  const m = /^tamtim-safety:1:(\d{60})$/.exec(text.trim());
  return m ? m[1] : null;
}
