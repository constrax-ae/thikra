// Message formatting, the way people already write it in WhatsApp:
//   *bold*   _italic_   ~strike~   `code`   ```a block of code```
// Shared by the web and the phone apps, so a message looks the same everywhere.
//
// It only ever produces TEXT and a style name for it: nothing here is HTML, and the apps render
// each piece as an escaped text node. A message can never inject markup, whatever it contains.

/** The longest text message (characters). The server refuses longer ones instead of cutting them. */
export const MAX_TEXT = 10_000;

export type Style = 'b' | 'i' | 's' | 'm';
export type Seg = { text: string } | { style: Style; children: Seg[] };

const MARK: Record<string, Style> = { '*': 'b', _: 'i', '~': 's', '`': 'm' };
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
// A link is never formatted inside: "https://a.com/x_y_z" keeps its underscores.
const LINK = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const LINK_TAIL = /[.,;:!?)\]}»"'،؛؟…*_~`]+$/;

function linkRanges(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of s.matchAll(LINK)) { const len = m[0].replace(LINK_TAIL, '').length; out.push([m.index, m.index + len]); }
  return out;
}

/** Cuts a message into plain and styled pieces. Markers that do not pair up stay as written. */
export function parseFormat(s: string): Seg[] {
  const links = linkRanges(s);
  const inLink = (k: number) => links.some(([a, b]) => k >= a && k < b);
  const out: Seg[] = [];
  let plain = '';
  const flush = () => { if (plain) { out.push({ text: plain }); plain = ''; } };
  let i = 0;
  while (i < s.length) {
    // A block of code: three backticks, may run over several lines, nothing inside is formatted.
    if (s.startsWith('```', i) && !inLink(i)) {
      const end = s.indexOf('```', i + 3);
      if (end > i + 3) { flush(); out.push({ style: 'm', children: [{ text: s.slice(i + 3, end) }] }); i = end + 3; continue; }
    }
    const ch = s[i];
    const style = MARK[ch];
    // An opening marker starts a word: nothing word-like before it, and no space after it.
    if (style && !inLink(i) && (i === 0 || !WORD.test(s[i - 1])) && i + 1 < s.length && !SPACE.test(s[i + 1]) && s[i + 1] !== ch) {
      let j = -1;
      for (let k = i + 2; k < s.length; k++) {
        if (s[k] === '\n') break;   // the short markers stay on one line
        // A closing marker ends a word: no space before it, nothing word-like after it.
        if (s[k] === ch && !inLink(k) && !SPACE.test(s[k - 1]) && (k + 1 === s.length || !WORD.test(s[k + 1]))) { j = k; break; }
      }
      if (j > 0) {
        flush();
        const inner = s.slice(i + 1, j);
        out.push({ style, children: style === 'm' ? [{ text: inner }] : parseFormat(inner) });
        i = j + 1;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

/** The same message with its markers taken off: for a chat-list preview or a notification. */
export function plainText(s: string): string {
  const walk = (segs: Seg[]): string => segs.map(x => ('text' in x ? x.text : walk(x.children))).join('');
  return walk(parseFormat(s));
}

/** Wraps the selected part of a text in a marker (or takes it off again if it is already wrapped). */
export function toggleMark(text: string, start: number, end: number, style: Style): { text: string; start: number; end: number } {
  const mk = style === 'm' ? '`' : Object.keys(MARK).find(k => MARK[k] === style)!;
  // Leave the spaces round a selection outside the markers, or the markers would not count.
  while (start < end && SPACE.test(text[start])) start++;
  while (end > start && SPACE.test(text[end - 1])) end--;
  if (start === end) return { text, start, end };
  const before = text.slice(start - mk.length, start), after = text.slice(end, end + mk.length);
  if (before === mk && after === mk) {
    return { text: text.slice(0, start - mk.length) + text.slice(start, end) + text.slice(end + mk.length), start: start - mk.length, end: end - mk.length };
  }
  return { text: text.slice(0, start) + mk + text.slice(start, end) + mk + text.slice(end), start: start + mk.length, end: end + mk.length };
}
