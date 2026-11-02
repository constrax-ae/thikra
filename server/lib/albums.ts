import { sniff } from '../sniff.ts';
import { all, one, run, type Row } from '../db.ts';

// ---- albums: what an old chat's photos and voice recordings become -------------------------------------------------------
// The family keeps the PICTURES and the VOICES, not five years of chat lines. They go into an album, grouped by year, and are
// shown next to the archive events of the same days.

export const ALBUM_IMAGE_MAX = 16 * 1024 * 1024;
export const ALBUM_VOICE_MAX = 16 * 1024 * 1024;
export const ALBUM_VIDEO_MAX = 64 * 1024 * 1024;
export type AlbumKind = 'image' | 'voice' | 'video';

const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (b: Buffer, at: number, s: string) => b.length >= at + s.length && b.toString('latin1', at, at + s.length) === s;

/** What an album file REALLY is, by its bytes (the name only breaks a tie between an audio and a video MP4). Returns null for anything we do not keep. */
export function classifyAlbumFile(buf: Buffer, name: string): { kind: AlbumKind; mime: string } | null {
  if (buf.length < 12) return null;
  if (ascii(buf, 0, 'OggS')) return { kind: 'voice', mime: 'audio/ogg' };                       // WhatsApp voice notes: Ogg Opus (.opus)
  if (ascii(buf, 0, 'ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { kind: 'voice', mime: 'audio/mpeg' };
  if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WAVE')) return { kind: 'voice', mime: 'audio/wav' };
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3]) && /\.(weba|opus|ogg)$/i.test(name)) return { kind: 'voice', mime: 'audio/webm' };
  if (ascii(buf, 4, 'ftyp')) {
    const brand = buf.toString('latin1', 8, 12);
    if (brand === 'M4A ' || brand === 'M4B ' || /\.(m4a|aac)$/i.test(name)) return { kind: 'voice', mime: 'audio/mp4' };
  }
  const sn = sniff(buf);
  if (!sn) return null;
  if (sn.family === 'image' && sn.inline) return { kind: 'image', mime: sn.mime };   // HEIC and other non-displayable images are not album material
  if (sn.family === 'video' && sn.inline) return { kind: 'video', mime: sn.mime };
  return null;
}
export const albumLimit = (kind: AlbumKind) => (kind === 'image' ? ALBUM_IMAGE_MAX : kind === 'voice' ? ALBUM_VOICE_MAX : ALBUM_VIDEO_MAX);

/** 'YYYY-MM-DD HH:MM' (the wall-clock time written in the export) or null. */
export function cleanTaken(v: unknown): { takenAt: string; day: string; year: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v ?? ''));
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(mi) > 59 || Number(y) < 1990 || Number(y) > 2100) return null;
  return { takenAt: `${y}-${mo}-${d} ${h}:${mi}`, day: `${y}-${mo}-${d}`, year: Number(y) };
}

/** Per album: how many photos, voices and videos in each year. */
export function albumYears(albumId: number) {
  const rows = all('SELECT year, kind, COUNT(*) n FROM album_items WHERE album_id = ? GROUP BY year, kind ORDER BY year DESC', albumId);
  const years = new Map<number, { year: number; image: number; voice: number; video: number }>();
  for (const r of rows) { const y = years.get(r.year) ?? { year: r.year, image: 0, voice: 0, video: 0 }; (y as Row)[r.kind] = r.n; years.set(r.year, y); }
  return [...years.values()];
}

/** For archive events: the album pictures and voices from the day of the event and the day before and after (people send the photos when it happens). At most `per` each, pictures first. */
export function eventMedia(circleId: number, entries: Array<{ id: number; eventDate: string }>, per = 6) {
  const out = new Map<number, Array<{ id: number; kind: AlbumKind }>>();
  if (!entries.length) return out;
  const dates = entries.map(e => e.eventDate).sort();
  const items = all(
    `SELECT id, kind, day FROM album_items WHERE circle_id = ? AND day >= date(?, '-1 day') AND day <= date(?, '+1 day') ORDER BY kind = 'image' DESC, taken_at`,
    circleId, dates[0], dates[dates.length - 1]);
  if (!items.length) return out;
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 86400_000;
  for (const e of entries) {
    const mine = items.filter(i => near(i.day, e.eventDate)).slice(0, per).map(i => ({ id: i.id as number, kind: i.kind as AlbumKind }));
    if (mine.length) out.set(e.id, mine);
  }
  return out;
}
export const albumOf = (circleId: number, id: number) => one('SELECT * FROM albums WHERE id = ? AND circle_id = ?', id, circleId);
export const albumItemCount = (albumId: number) => Number(one('SELECT COUNT(*) n FROM album_items WHERE album_id = ?', albumId)!.n);
export { run };
