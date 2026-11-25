// Photos keep no location. A camera writes where the picture was taken into the file (EXIF GPS, XMP), and sending
// the file as it is would give that place away to everyone in the chat. Re-drawing a photo drops all of it; these
// helpers cover the files that are sent without being re-drawn.

/** A JPEG or a PNG from a camera or a phone may carry metadata; anything else here is sent re-drawn or as a document. */
export function kindOf(bytes: Uint8Array): 'jpeg' | 'png' | 'other' {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return 'other';
}

// PNG chunks that hold words or metadata rather than pixels: EXIF, and the three kinds of text (XMP lives in iTXt).
const PNG_META = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/** A PNG without its metadata chunks. The pixels, the colour profile and everything else stay byte for byte. */
export function stripPng(bytes: Uint8Array): Uint8Array {
  if (kindOf(bytes) !== 'png') return bytes;
  const out: Uint8Array[] = [bytes.subarray(0, 8)];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8, ended = false;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    const end = at + 12 + len;
    if (end > bytes.length) return bytes;   // damaged: leave it alone (it will be refused or shown as a file)
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!PNG_META.has(type)) out.push(bytes.subarray(at, end));
    at = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended) return bytes;   // no proper end: damaged, leave it alone
  const total = out.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let k = 0; for (const p of out) { joined.set(p, k); k += p.length; }
  return joined;
}

/** Whether a JPEG still carries EXIF or XMP (APP1), where a camera writes its GPS position. */
export function jpegHasApp1(bytes: Uint8Array): boolean {
  if (kindOf(bytes) !== 'jpeg') return false;
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    if (marker === 0xda || marker === 0xd9) return false;   // start of the picture data: no more headers
    if (marker === 0xe1) return true;
    at += 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
  }
  return false;
}
