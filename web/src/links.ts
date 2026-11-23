// The first link in a text, as the person wrote it (the preview is asked for exactly this, and sent with the message).
const TRAILING = /[.,;:!?)\]}»"'،؛؟…]+$/;
export function firstLink(text: string): string | null {
  const m = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (!m) return null;
  const url = m[0].replace(TRAILING, '');
  try { const u = new URL(url); return u.hostname.includes('.') && url.length <= 2000 ? url : null; } catch { return null; }
}
/** A text cut into plain parts and links, to draw links as links. */
export function splitLinks(text: string): Array<{ text: string; href?: string }> {
  const out: Array<{ text: string; href?: string }> = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const url = m[0].replace(TRAILING, '');
    let ok = false; try { ok = new URL(url).hostname.includes('.'); } catch { /* not a link */ }
    if (!ok) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: url, href: url });
    last = m.index + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** A contact as a vCard file, the format every phone's address book opens. */
export function vcard(name: string, phones: string[]): string {
  const esc = (s: string) => s.replace(/[\;,]/g, c => `\\${c}`).replace(/\r?\n/g, ' ');
  return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(name)}`, `N:${esc(name)};;;;`, ...phones.map(p => `TEL;TYPE=CELL:${p.replace(/[^\d+]/g, '')}`), 'END:VCARD', ''].join('\r\n');
}
/** Where a place opens: Google Maps and Apple Maps, both by coordinates only. */
export const mapLinks = (lat: number, lng: number) => ({
  google: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
  apple: `https://maps.apple.com/?ll=${lat},${lng}&q=${lat},${lng}`,
});
