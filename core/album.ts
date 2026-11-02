// What an old chat export holds worth keeping: the PICTURES and the VOICES (and, only if asked, the videos), with the day they were sent.
// Pure and dependency-free: it runs on the person's own device, on the parsed text, and decides what the album will contain.

import type { ImportedMessage } from './whatsapp.ts';

export type AlbumKind = 'image' | 'voice' | 'video';

const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const VOICE = /\.(opus|ogg|m4a|mp3|aac|wav)$/i;   // WhatsApp voice notes are .opus (Android and iPhone), audio files .m4a/.mp3
const VIDEO = /\.(mp4|mov|webm)$/i;

/** What a chat file name stands for, by its extension. Documents, contacts, stickers (.webp is kept as a picture), .heic and .amr are not album material. */
export function kindOfFile(name: string): AlbumKind | null {
  if (IMAGE.test(name)) return 'image';
  if (VOICE.test(name)) return 'voice';
  if (VIDEO.test(name)) return 'video';
  return null;
}
const baseName = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/[‎‏‪-‮]/g, '').trim();

export interface AlbumItemPlan { file: string; entry: string; kind: AlbumKind; takenAt: string; day: string; year: number; sender: string }
export interface YearStat { year: number; messages: number; image: number; voice: number; video: number }
export interface AlbumPlan {
  range: { from: string; to: string } | null;
  years: YearStat[];
  items: AlbumItemPlan[];
  /** Files the chat names that are not in the export (it was exported without media, or they were deleted). */
  missing: number;
  /** Files in the chat of a kind the album does not keep (documents, .heic pictures, .amr voices). */
  notKept: number;
}

/** `resolve` maps a file name written in the chat to the entry that holds it (in a zip) or undefined. Pass `() => undefined` for a text-only export. */
export function planAlbum(messages: ImportedMessage[], resolve: (file: string) => string | undefined): AlbumPlan {
  const years = new Map<number, YearStat>();
  const stat = (y: number) => { let s = years.get(y); if (!s) years.set(y, (s = { year: y, messages: 0, image: 0, voice: 0, video: 0 })); return s; };
  const items: AlbumItemPlan[] = [], seen = new Set<string>();
  let missing = 0, notKept = 0, from = '', to = '';
  for (const m of messages) {
    const year = Number(m.date.slice(0, 4));
    stat(year).messages++;
    if (!from || m.date < from) from = m.date;
    if (!to || m.date > to) to = m.date;
    if (!m.file) continue;
    const kind = kindOfFile(m.file);
    if (!kind) { notKept++; continue; }
    const entry = resolve(m.file);
    if (!entry) { missing++; continue; }
    if (seen.has(entry)) continue;           // the same file named twice
    seen.add(entry);
    items.push({ file: baseName(m.file), entry, kind, takenAt: `${m.date} ${m.time}`, day: m.date, year, sender: m.sender });
    stat(year)[kind]++;
  }
  return { range: from ? { from, to } : null, years: [...years.values()].sort((a, b) => a.year - b.year), items, missing, notKept };
}

/** A resolver over the names inside a zip: the chat names a file without its folder, so match by base name, ignoring case. */
export function zipResolver(entryNames: Iterable<string>) {
  const byBase = new Map<string, string>();
  for (const n of entryNames) { const b = baseName(n).toLowerCase(); if (!byBase.has(b)) byBase.set(b, n); }
  return (file: string) => byBase.get(baseName(file).toLowerCase());
}

export const defaultAlbumTitle = (range: { from: string; to: string } | null, lang: string) => {
  const y = (d: string) => d.slice(0, 4);
  const span = range ? (y(range.from) === y(range.to) ? y(range.from) : `${y(range.from)}–${y(range.to)}`) : '';
  return lang === 'ar' ? `ألبوم واتساب ${span}`.trim() : `WhatsApp album ${span}`.trim();
};
