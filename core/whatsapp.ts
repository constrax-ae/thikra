// Reads the text file produced by WhatsApp's "Export chat". Pure and dependency-free so it can run
// on the user's own device: the file holds other people's messages, so it is never uploaded.
//
// What the export looks like depends on the phone and its language:
//   Android  12/05/2024, 14:32 - Name: text            (Arabic: ١٢/٠٥/٢٠٢٤، ٢:٣٢ م - الاسم: نص)
//   iPhone   [5/28/24, 2:32:10 PM] Name: text          (lines start with an invisible LRM mark)
// Dates may be day-first or month-first, times 12h or 24h, digits Latin or Arabic-Indic.

export type ImportedKind = 'text' | 'media' | 'voice' | 'deleted';

export interface ImportedMessage {
  /** Wall-clock time as written in the file, read as UTC so it only serves for ordering and windows. */
  ts: number;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  sender: string;
  text: string;
  kind: ImportedKind;
  file?: string;
}

export interface ParsedChat {
  messages: ImportedMessage[];
  senders: Array<{ name: string; count: number }>;
  format: 'ios' | 'android' | 'unknown';
  dateOrder: 'dmy' | 'mdy' | 'ymd';
  range: { from: string; to: string } | null;
  skippedSystem: number;
}

const DATE = String.raw`(\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4})`;
const TIME = String.raw`(\d{1,2}[:.]\d{2}(?::\d{2})?\s?(?:[AaPp]\.?[Mm]\.?|[صم])?)`;
const IOS_RE = new RegExp(String.raw`^\[${DATE},?\s+${TIME}\]\s?(.*)$`);
const ANDROID_RE = new RegExp(String.raw`^${DATE},?\s+${TIME}\s+[-–]\s(.*)$`);

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Drops direction marks, unifies spaces, Arabic digits and the Arabic comma. */
function clean(line: string): string {
  return line
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[  ]/g, ' ')
    .replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, d => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/،/g, ',')
    .replace(/\r$/, '');
}

interface RawEntry { date: string; time: string; rest: string; format: 'ios' | 'android' }

function inferDateOrder(dates: string[]): 'dmy' | 'mdy' | 'ymd' {
  let first = false, second = false;
  for (const d of dates) {
    const p = d.split(/[\/.\-]/);
    if (p[0].length === 4) return 'ymd';
    if (Number(p[0]) > 12) first = true;
    if (Number(p[1]) > 12) second = true;
  }
  if (second && !first) return 'mdy';
  return 'dmy'; // also the default when every date is ambiguous
}

function toStamp(date: string, time: string, order: 'dmy' | 'mdy' | 'ymd') {
  const p = date.split(/[\/.\-]/).map(Number);
  let [y, m, d] = order === 'ymd' ? p : order === 'mdy' ? [p[2], p[0], p[1]] : [p[2], p[1], p[0]];
  if (y < 100) y += 2000;
  const t = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?|[صم])?$/.exec(time.trim());
  if (!t || m < 1 || m > 12 || d < 1 || d > 31) return null;
  let h = Number(t[1]);
  const meridiem = t[4];
  if (meridiem) {
    const pm = /^[Pp]|م/.test(meridiem);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  if (h > 23) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    ts: Date.UTC(y, m - 1, d, h, Number(t[2]), Number(t[3] ?? 0)),
    date: `${y}-${pad(m)}-${pad(d)}`,
    time: `${pad(h)}:${t[2]}`,
  };
}

const DELETED_RE = /^(this message was deleted|you deleted this message|تم حذف هذه الرسالة|لقد حذفت هذه الرسالة)\.?$/i;
const MEDIA_RES = [
  /^<[^>]*(omitted|attached)[^>]*>$/i,
  /\((file|image|video|audio|document) attached\)$/i,
  /\((الملف|ملف|الصورة|الفيديو|المقطع)\s*(مرفق|مرفقة)\)$/,
  /^<[^>]*(الوسائط|مرفق|المرفق)[^>]*>$/,
  /(الوسائط مُستبعدة|الوسائط مستبعدة|تم استبعاد الوسائط)/,
];
const SYSTEM_TEXT_RE = /(end-to-end encrypted|مشفرة بين الطرفين|مشفّرة بين الطرفين)/i;

function classify(text: string): { kind: ImportedKind; file?: string } {
  const t = text.trim();
  if (DELETED_RE.test(t)) return { kind: 'deleted' };
  if (MEDIA_RES.some(re => re.test(t))) {
    const file = /<(?:attached|مرفق)\s*[:：]\s*([^>]+)>/i.exec(t)?.[1] ?? /^(.+?)\s*\((?:file|image|video|audio|document) attached\)$/i.exec(t)?.[1] ?? /^(.+?)\s*\((?:الملف|ملف|الصورة|الفيديو|المقطع)\s*(?:مرفق|مرفقة)\)$/.exec(t)?.[1];
    const voice = !!file && /(^PTT-|AUDIO|\.opus$|\.ogg$|\.m4a$|\.mp3$)/i.test(file);
    return { kind: voice ? 'voice' : 'media', file: file?.trim() };
  }
  return { kind: 'text' };
}

export function parseWhatsApp(input: string): ParsedChat {
  const lines = input.split('\n').map(clean);
  const entries: Array<RawEntry | { continuation: string }> = [];
  let ios = 0, android = 0;

  for (const line of lines) {
    const m = IOS_RE.exec(line);
    if (m) { ios++; entries.push({ date: m[1], time: m[2], rest: m[3], format: 'ios' }); continue; }
    const a = ANDROID_RE.exec(line);
    if (a) { android++; entries.push({ date: a[1], time: a[2], rest: a[3], format: 'android' }); continue; }
    entries.push({ continuation: line });
  }

  const order = inferDateOrder(entries.flatMap(e => ('date' in e ? [e.date] : [])));
  const messages: ImportedMessage[] = [];
  const bodies: string[] = [];
  let skippedSystem = 0;
  let open = false; // is the previous entry a message we can append continuation lines to?

  for (const e of entries) {
    if ('continuation' in e) {
      if (open) bodies[bodies.length - 1] += `\n${e.continuation}`;
      continue;
    }
    const stamp = toStamp(e.date, e.time, order);
    const split = e.rest.indexOf(': ');
    if (!stamp) { if (open) bodies[bodies.length - 1] += `\n${e.rest}`; continue; }
    if (split < 1 || SYSTEM_TEXT_RE.test(e.rest.slice(split + 2))) { skippedSystem++; open = false; continue; }
    messages.push({ ...stamp, sender: e.rest.slice(0, split).trim(), text: '', kind: 'text' });
    bodies.push(e.rest.slice(split + 2));
    open = true;
  }

  messages.forEach((msg, i) => {
    msg.text = bodies[i].trim();
    Object.assign(msg, classify(msg.text));
  });

  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m.sender, (counts.get(m.sender) ?? 0) + 1);

  return {
    messages,
    senders: [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    format: !messages.length ? 'unknown' : ios >= android ? 'ios' : 'android',
    dateOrder: order,
    range: messages.length ? { from: messages[0].date, to: messages[messages.length - 1].date } : null,
    skippedSystem,
  };
}
