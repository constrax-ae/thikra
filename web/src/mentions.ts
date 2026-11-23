// @mentions in the message box and in shown messages. Pure text logic, no screen.

interface Person { id: number; name: string }
const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

/** Is the person typing a mention right now? Returns where its "@" is and what was typed after it, or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (wordChar(before[at - 1])) return null;                 // "a@b": an address, not a mention
  const query = before.slice(at + 1);
  if (/\s/.test(query) || query.length > 30) return null;    // the caret has moved on, or this is not a name
  return { start: at, query };
}

/** Write the chosen name in place of what was typed, with a space after it. */
export function pickMention(text: string, caret: number, start: number, name: string): { text: string; caret: number } {
  const head = `${text.slice(0, start)}@${name} `;
  return { text: head + text.slice(caret), caret: head.length };
}

/** Longest names first, so "@Sara Ahmed" is not taken for "@Sara". */
const byLength = <T extends Person>(people: T[]) => [...people].filter(p => p.name).sort((a, b) => b.name.length - a.name.length);
/** Find every "@Name" of these people in the text, left to right, never overlapping. */
function find(text: string, people: Person[]): Array<{ at: number; end: number; id: number }> {
  const sorted = byLength(people), out: Array<{ at: number; end: number; id: number }> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@' || wordChar(text[i - 1])) continue;
    const hit = sorted.find(p => text.startsWith(p.name, i + 1) && !wordChar(text[i + 1 + p.name.length]));
    if (hit) { out.push({ at: i, end: i + 1 + hit.name.length, id: hit.id }); i += hit.name.length; }
  }
  return out;
}

/** Who a message being sent mentions: the people whose "@Name" is still in the text. */
export const mentionedIds = (text: string, members: Person[]): number[] => [...new Set(find(text, members).map(h => h.id))].sort((a, b) => a - b);

/** Split a shown message into plain text and mentions, for highlighting. Only people the server says were mentioned count. */
export function splitMentions(text: string, mentions: Person[]): Array<{ text: string; id?: number }> {
  const out: Array<{ text: string; id?: number }> = [];
  let from = 0;
  for (const h of find(text, mentions)) {
    if (h.at > from) out.push({ text: text.slice(from, h.at) });
    out.push({ text: text.slice(h.at, h.end), id: h.id });
    from = h.end;
  }
  if (from < text.length) out.push({ text: text.slice(from) });
  return out;
}
