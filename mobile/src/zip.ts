// A zip reader for a WhatsApp chat export that can be GIGABYTES, the phone's version of web/src/zip.ts.
// It never loads the whole file: it reads the end of the file for the list of entries, then reads (and
// inflates) only the entries asked for, straight from the file on disk through a FileHandle. Stored and
// deflated entries and the zip64 extension are supported. The phone's JavaScript engine has no
// DecompressionStream, so deflated entries are inflated with fflate (pure JavaScript, no native code).

import { inflateSync, strFromU8 } from 'fflate';

export interface ZipEntry { name: string; offset: number; csize: number; usize: number; method: number }
export interface Zip {
  entries: Map<string, ZipEntry>;
  read(name: string): Promise<Uint8Array>;
  text(name: string): Promise<string>;
  close(): void;
}

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);
const u64 = (v: DataView, o: number) => Number(v.getBigUint64(o, true));

/** A file on the phone, read through a FileHandle. */
export async function openZip(uri: string): Promise<Zip> {
  const { File } = await import('expo-file-system');   // lazy: the zip logic below also runs in tests
  const file = new File(uri);
  const h = file.open();
  return openZipFrom({
    size: file.size ?? 0,
    readAt: async (start, end) => { h.offset = start; return h.readBytes(end - start); },
    close: () => { try { h.close(); } catch { /* already closed */ } },
  });
}

/** Where the bytes come from: anything that can read a range (the phone's FileHandle, or a test's Buffer). */
export interface ByteSource { size: number; readAt(start: number, end: number): Promise<Uint8Array>; close(): void }

export async function openZipFrom(src: ByteSource): Promise<Zip> {
  const size = src.size;
  if (size < 22) throw new Error('not a zip');
  const h = { close: src.close };
  const bytes = (start: number, end: number) => src.readAt(start, end);
  const view = async (start: number, end: number) => { const b = await bytes(start, end); return new DataView(b.buffer, b.byteOffset, b.byteLength); };

  // The end-of-central-directory record is in the last 22 + 65535 bytes (the comment can be that long).
  const tailStart = Math.max(0, size - 22 - 65535);
  const tail = await view(tailStart, size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) { h.close(); throw new Error('not a zip'); }
  let total = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOffset = u32(tail, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // zip64: a locator just before the record points at the real one
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) { h.close(); throw new Error('zip64 locator missing'); }
    const at = u64(tail, loc + 8);
    const z64 = await view(at, at + 56);
    if (u32(z64, 0) !== 0x06064b50) { h.close(); throw new Error('zip64 record missing'); }
    total = u64(z64, 32); cdSize = u64(z64, 40); cdOffset = u64(z64, 48);
  }
  const cdBytes = await bytes(cdOffset, cdOffset + cdSize);
  const cd = new DataView(cdBytes.buffer, cdBytes.byteOffset, cdBytes.byteLength);
  const entries = new Map<string, ZipEntry>();
  let p = 0;
  for (let n = 0; n < total && p + 46 <= cd.byteLength; n++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20), usize = u32(cd, p + 24), offset = u32(cd, p + 42);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    const name = strFromU8(cdBytes.subarray(p + 46, p + 46 + nameLen));
    // zip64 extra field (id 1): only the values that were 0xFFFFFFFF are present, in this order
    let e = p + 46 + nameLen; const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = u16(cd, e), len = u16(cd, e + 2);
      if (id === 1) { let q = e + 4; if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; } if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; } if (offset === 0xffffffff) offset = u64(cd, q); }
      e += 4 + len;
    }
    if (!name.endsWith('/')) entries.set(name, { name, offset, csize, usize, method });
    p += 46 + nameLen + extraLen + commentLen;
  }

  async function read(name: string): Promise<Uint8Array> {
    const en = entries.get(name);
    if (!en) throw new Error(`not in the zip: ${name}`);
    const head = await view(en.offset, en.offset + 30);
    if (u32(head, 0) !== 0x04034b50) throw new Error('bad local header');
    const start = en.offset + 30 + u16(head, 26) + u16(head, 28);
    const raw = await bytes(start, start + en.csize);
    if (en.method === 0) return raw;
    if (en.method !== 8) throw new Error(`unsupported compression ${en.method}`);
    return inflateSync(raw, { out: new Uint8Array(en.usize) });
  }
  return { entries, read, text: async name => strFromU8(await read(name)), close: () => h.close() };
}
