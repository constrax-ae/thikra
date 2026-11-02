// What an uploaded file REALLY is, judged by its first bytes, never by the name or the type the client claims.
// This is the gate for attachments: a file is accepted only if its bytes match the family it claims to be.

export type Family = 'image' | 'video' | 'file';

export interface Sniffed {
  family: Family;
  /** The type we will serve it as. Inline-safe types only for image/video; everything else is served as a download. */
  mime: string;
  /** Safe to show inline in the page (images and videos of known types); documents never are. */
  inline: boolean;
}

const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (b: Buffer, at: number, s: string) => b.length >= at + s.length && b.toString('latin1', at, at + s.length) === s;

export function sniff(b: Buffer): Sniffed | null {
  if (b.length < 12) return null;
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { family: 'image', mime: 'image/jpeg', inline: true };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { family: 'image', mime: 'image/png', inline: true };
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return { family: 'image', mime: 'image/gif', inline: true };
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return { family: 'image', mime: 'image/webp', inline: true };
  if (ascii(b, 4, 'ftyp')) {
    const brand = b.toString('latin1', 8, 12);
    if (brand === 'qt  ') return { family: 'video', mime: 'video/quicktime', inline: true };
    if (/^(heic|heix|hevc|mif1|msf1|avif)$/.test(brand)) return { family: 'image', mime: brand === 'avif' ? 'image/avif' : 'image/heic', inline: false }; // not displayable in every browser: offered as a file
    return { family: 'video', mime: 'video/mp4', inline: true };
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { family: 'video', mime: 'video/webm', inline: true };
  if (ascii(b, 0, '%PDF-')) return { family: 'file', mime: 'application/pdf', inline: false };
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return { family: 'file', mime: 'application/zip', inline: false }; // also docx/xlsx/pptx
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0])) return { family: 'file', mime: 'application/octet-stream', inline: false }; // legacy Office
  return null;
}

/** Plain text and common office formats are accepted as downloads by extension, but only if the bytes are not an executable or markup that could run. */
const TEXT_EXT = /\.(txt|csv|md|rtf|json|log)$/i;
export function sniffText(name: string, b: Buffer): Sniffed | null {
  if (!TEXT_EXT.test(name)) return null;
  const head = b.subarray(0, 2048);
  if (head.includes(0)) return null;                                  // binary pretending to be text
  const t = head.toString('utf8').trimStart().toLowerCase();
  if (t.startsWith('<!doctype') || t.startsWith('<html') || t.startsWith('<svg') || t.startsWith('<script') || t.startsWith('#!')) return null;
  return { family: 'file', mime: 'application/octet-stream', inline: false };
}

/** Executables and scripts are refused whatever their bytes look like. */
export const BLOCKED_NAME = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|mjs|jar|apk|dmg|app|sh|php|html?|svg|xml|swf)$/i;

/** A filename that is safe to store and to put in a header: no paths, no control characters, bounded. */
export function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim().slice(0, 120);
  return cleaned || 'file';
}
