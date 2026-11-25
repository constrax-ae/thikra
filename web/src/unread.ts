import { type Message } from './api.ts';

/**
 * Where the "unread messages" line goes in a chat, and how many messages sit below it.
 *
 * `from` is the read mark the chat was OPENED with, so the line stays put while the person reads on. Only other
 * people's messages count: your own, and the chat's own notices, are not news to you. Two deliberate silences:
 *  - a chat nothing has ever been read in (`from` is 0) gets no line — there everything below it is new, and a line
 *    at the very top of the screen says nothing;
 *  - if the message just BEFORE the first unread one is not loaded, the line would be a guess about where the person
 *    stopped (the loaded page may begin in the middle of what they have not read), so it is not drawn.
 */
export function unreadMark(thread: Message[], from: number, meId: number): { id: number; count: number } {
  const none = { id: 0, count: 0 };
  if (!from) return none;
  const fresh = thread.filter(m => !m.pending && m.kind !== 'system' && m.userId !== meId && (m.seq ?? 0) > from);
  const boundaryLoaded = thread.some(m => (m.seq ?? 0) > 0 && (m.seq ?? 0) <= from);   // anything already read, the chat's own notices included, fixes where the line goes
  return fresh.length && boundaryLoaded ? { id: fresh[0].id, count: fresh.length } : none;
}
