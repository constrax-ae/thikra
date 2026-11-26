// What is INSIDE an encrypted message (the server only ever sees the MLS ciphertext of this). One JSON object, version 1.
//
//   text   : words, and optionally one card (a link preview made on the device, a contact, a location, a sticker, a GIF)
//   media  : a caption and one or more files (each with its own key; the thumbnail is made on the device and travels inside the message)
//   voice  : a voice note: length, its shape (waveform), and the file
//   poll   : a question and its options (votes are `vote` control messages)
//   edit   : the new text of one of my messages (a control message)
//   react  : an emoji on a message, or null to take it back (a control message)
//   vote   : my choice in a poll (a control message)
//
// `from` is the sender's own name for themselves (`u<user>.d<device>`). The server says who sent a message; the two must agree or the message is shown as unreadable.

import type { Card } from '../chat-types.ts';
import { parseIdentity } from '../e2ee.ts';

export interface FileRef {
  /** Position among the message's stored files (the server lists them in upload order). */
  i: number;
  kind: 'image' | 'video' | 'file';
  /** The file's own key (base64) and the SHA-256 (hex) of the bytes the server holds. */
  k: string; hash: string;
  name: string | null; mime: string; size: number; w: number | null; h: number | null;
  /** A small preview made on the device (a data URL), so the list needs no extra download. */
  thumb?: string;
}
export type Payload =
  | { v: 1; from: string; t: 'text'; text: string; card?: Card | null }
  | { v: 1; from: string; t: 'media'; text: string; files: FileRef[] }
  | { v: 1; from: string; t: 'voice'; ms: number; wave: number[]; file: FileRef }
  | { v: 1; from: string; t: 'poll'; text: string; options: string[]; multiple: boolean }
  | { v: 1; from: string; t: 'edit'; target: number; text: string }
  | { v: 1; from: string; t: 'react'; target: number; emoji: string | null }
  | { v: 1; from: string; t: 'vote'; target: number; options: number[] };

/** The kind marker the server needs to route (and nothing more): text, media, voice, card, edit, ctl. */
export function encKindOf(p: Payload): 'text' | 'media' | 'voice' | 'card' | 'edit' | 'ctl' {
  switch (p.t) {
    case 'text': return p.card && p.card.type !== 'link' ? 'card' : 'text';
    case 'poll': return 'card';
    case 'media': return 'media';
    case 'voice': return 'voice';
    case 'edit': return 'edit';
    default: return 'ctl';
  }
}
export const isControl = (p: Payload) => p.t === 'edit' || p.t === 'react' || p.t === 'vote';

const enc = new TextEncoder(), dec = new TextDecoder();
export const encodePayload = (p: Payload) => enc.encode(JSON.stringify(p));
const str = (v: unknown, max = 2000) => typeof v === 'string' && v.length <= max;
/** A card written by another member (the server cannot check it in an encrypted chat): a known type, http(s) links only, finite numbers, short strings. */
function validCard(c: any): boolean {
  if (!c || typeof c !== 'object') return false;
  switch (c.type) {
    case 'link': return str(c.url) && /^https?:\/\//i.test(c.url) && str(c.title, 500) && str(c.site, 200) && (c.description == null || str(c.description, 1000)) && c.image == null;
    case 'sticker': return str(c.pack, 100) && str(c.id, 100);
    case 'contact': return str(c.name, 200) && Array.isArray(c.phones) && c.phones.length <= 10 && c.phones.every((x: unknown) => str(x, 40));
    case 'location': return Number.isFinite(c.lat) && Number.isFinite(c.lng) && Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180 && (c.accuracy == null || Number.isFinite(c.accuracy)) && (c.label == null || str(c.label, 200));
    default: return false;   // a GIF card needs the server: not allowed here
  }
}
// What another member's device may put in a message is untrusted input (the server cannot check it in an encrypted chat): every field is bounded and shaped here, once, before any screen sees it.
export const LIMITS = { files: 10, options: 12, optionLength: 300, question: 2000, wave: 300, name: 255, thumb: 60_000 };
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/i;
/** Types a browser may show inline (a picture, a video, a sound). Anything else (html, svg, scripts, unknown) is kept as an opaque download, never opened as a page. */
const SAFE_INLINE = /^(image\/(jpeg|png|gif|webp|avif|heic|heif)|video\/(mp4|webm|quicktime|3gpp|x-m4v)|audio\/(webm|ogg|mp4|mpeg|aac|wav|x-m4a|3gpp|opus))(;.*)?$/i;
const THUMB = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]*$/;
const B64KEY = /^[A-Za-z0-9+/]{43}=?$/;
const finite = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const orNull = (v: unknown, lo: number, hi: number) => v == null || finite(v, lo, hi);
/** One file reference, checked and rebuilt with only the fields we know (nothing else the sender added is kept). Null if it is not well formed. */
function cleanFile(f: any): FileRef | null {
  if (!f || typeof f !== 'object' || !Number.isInteger(f.i) || f.i < 0 || f.i >= LIMITS.files) return null;
  if (!['image', 'video', 'file'].includes(f.kind) || typeof f.k !== 'string' || !B64KEY.test(f.k) || typeof f.hash !== 'string' || !/^[0-9a-f]{64}$/.test(f.hash)) return null;
  if (f.name != null && !(typeof f.name === 'string' && f.name.length <= LIMITS.name)) return null;
  if (typeof f.mime !== 'string' || f.mime.length > 120 || !MIME.test(f.mime.replace(/;.*$/, '')) || /[\r\n]/.test(f.mime)) return null;
  if (!finite(f.size, 0, 2 ** 40) || !orNull(f.w, 0, 100_000) || !orNull(f.h, 0, 100_000)) return null;
  if (f.thumb != null && !(typeof f.thumb === 'string' && f.thumb.length <= LIMITS.thumb && THUMB.test(f.thumb))) return null;
  const mime = SAFE_INLINE.test(f.mime) ? f.mime : 'application/octet-stream';
  const kind = mime === 'application/octet-stream' ? 'file' : f.kind;
  return { i: f.i, kind, k: f.k, hash: f.hash, name: f.name ?? null, mime, size: f.size, w: f.w ?? null, h: f.h ?? null, ...(f.thumb ? { thumb: f.thumb } : {}) };
}
/** A payload from bytes, or null if it is not one of ours (wrong shape, wrong version, a field of the wrong type or size). */
export function decodePayload(bytes: Uint8Array): Payload | null {
  let p: any;
  try { p = JSON.parse(dec.decode(bytes)); } catch { return null; }
  if (!p || p.v !== 1 || typeof p.from !== 'string' || typeof p.t !== 'string' || !parseIdentity(p.from)) return null;
  switch (p.t) {
    case 'text': return typeof p.text === 'string' && (p.card == null || validCard(p.card)) ? p : null;
    case 'media': {
      if (typeof p.text !== 'string' || !Array.isArray(p.files) || !p.files.length || p.files.length > LIMITS.files) return null;
      const files = p.files.map(cleanFile);
      return files.every(Boolean) ? { ...p, files } : null;
    }
    case 'voice': {
      const file = cleanFile(p.file);
      return finite(p.ms, 0, 36_000_000) && Array.isArray(p.wave) && p.wave.length <= LIMITS.wave && p.wave.every((x: unknown) => finite(x, -1e6, 1e6)) && file ? { ...p, file } : null;
    }
    case 'poll': return typeof p.text === 'string' && p.text.length <= LIMITS.question && Array.isArray(p.options) && p.options.length >= 2 && p.options.length <= LIMITS.options && p.options.every((o: unknown) => typeof o === 'string' && o.length <= LIMITS.optionLength) ? p : null;
    case 'edit': return Number.isInteger(p.target) && typeof p.text === 'string' ? p : null;
    case 'react': return Number.isInteger(p.target) && (p.emoji === null || (typeof p.emoji === 'string' && p.emoji.length <= 16)) ? p : null;
    case 'vote': return Number.isInteger(p.target) && Array.isArray(p.options) && p.options.length <= 12 && p.options.every((o: unknown) => Number.isInteger(o) && (o as number) >= 0 && (o as number) < 12) ? p : null;
    default: return null;
  }
}
