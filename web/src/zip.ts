// A zip reader for a chat export that can be GIGABYTES: it never loads the whole file. It reads the end of the file for the list of
// entries, and then reads (and inflates) only the entries asked for, straight from the file on disk. Supports stored and deflated
// entries and the zip64 extension. Uses the browser's own DecompressionStream, so there is no library to download.

export interface ZipEntry { name: string; offset: number; csize: number; usize: number; method: number }
export interface Zip { entries: Map<string, ZipEntry>; read(name: string): Promise<Blob>; text(name: string): Promise<string> }

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);
const u64 = (v: DataView, o: number) => Number(v.getBigUint64(o, true));
const view = async (b: Blob, start: number, end: number) => new DataView(await b.slice(start, end).arrayBuffer());

export async function openZip(file: Blob): Promise<Zip> {
  const size = file.size;
  if (size < 22) throw new Error('not a zip');
  // The end-of-central-directory record is in the last 22 + 65535 bytes (the comment can be that long).
  const tailStart = Math.max(0, size - 22 - 65535);
  const tail = await view(file, tailStart, size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  let total = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOffset = u32(tail, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // zip64: a locator just before the record points at the real one
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new Error('zip64 locator missing');
    const z64 = await view(file, u64(tail, loc + 8), u64(tail, loc + 8) + 56);
    if (u32(z64, 0) !== 0x06064b50) throw new Error('zip64 record missing');
    total = u64(z64, 32); cdSize = u64(z64, 40); cdOffset = u64(z64, 48);
  }
  const cd = await view(file, cdOffset, cdOffset + cdSize);
  const dec = new TextDecoder('utf-8');
  const entries = new Map<string, ZipEntry>();
  let p = 0;
  for (let n = 0; n < total && p + 46 <= cd.byteLength; n++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20), usize = u32(cd, p + 24), offset = u32(cd, p + 42);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
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

  async function read(name: string): Promise<Blob> {
    const en = entries.get(name);
    if (!en) throw new Error(`not in the zip: ${name}`);
    const head = await view(file, en.offset, en.offset + 30);
    if (u32(head, 0) !== 0x04034b50) throw new Error('bad local header');
    const start = en.offset + 30 + u16(head, 26) + u16(head, 28);
    const raw = file.slice(start, start + en.csize);
    if (en.method === 0) return raw;
    if (en.method !== 8) throw new Error(`unsupported compression ${en.method}`);
    return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  }
  return { entries, read, text: async name => new TextDecoder('utf-8').decode(await (await read(name)).arrayBuffer()) };
}
