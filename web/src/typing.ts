import { useEffect, useState } from 'react';
import { live } from './live';

// Who is typing or recording right now, per chat. One store for the whole app, so the chat and the chat list say the same thing.
// Nothing is stored anywhere: an entry lives for 5 seconds after the person's last frame and then clears by itself
// (so a lost "stopped" frame, or a closed tab, never leaves someone typing forever).

export const TYPING_MS = 5000;
export interface Typer { user: number; name: string; kind: 'text' | 'voice'; until: number }
interface Frame { circle: number; user: number; name?: string; kind?: 'text' | 'voice'; on?: boolean }

export function createTyping() {
  const chats = new Map<number, Map<number, Typer>>();
  return {
    note(f: Frame, now = Date.now()) {
      if (f.on === false) return this.clear(f.circle, f.user);
      let chat = chats.get(f.circle);
      if (!chat) chats.set(f.circle, (chat = new Map()));
      chat.set(f.user, { user: f.user, name: typeof f.name === 'string' ? f.name : '', kind: f.kind === 'voice' ? 'voice' : 'text', until: now + TYPING_MS });
    },
    clear(circle: number, user: number) { chats.get(circle)?.delete(user); },
    in(circle: number, now = Date.now()): Typer[] {
      const chat = chats.get(circle);
      if (!chat) return [];
      for (const [id, x] of chat) if (x.until <= now) chat.delete(id);
      return [...chat.values()];
    },
  };
}

/** "Sara is typing…", "Sara is recording audio…", or "Several people are typing…". Empty when nobody is. */
export function typingLabel(typers: Typer[], t: { typingOne: string; typingMany: string; recordingOne: string }, withName = true): string {
  if (!typers.length) return '';
  if (typers.length > 1) return t.typingMany;
  const [x] = typers;
  return `${withName ? x.name : ''}${x.kind === 'voice' ? t.recordingOne : t.typingOne}`.trim();
}

const store = createTyping();
/** For a screen: returns "who is typing in this chat", kept fresh while the screen is mounted. `meId` is never shown to oneself. */
export function useTyping(meId: number): (circle: number) => Typer[] {
  const [, redraw] = useState(0);
  useEffect(() => {
    const off = live.on(f => {
      if (f.t === 'typing') { store.note(f as unknown as Frame); redraw(n => n + 1); }
      else if (f.t === 'msg' && f.m?.userId) { store.clear(f.circle, f.m.userId); redraw(n => n + 1); }   // their message arrived: no longer typing
    });
    const timer = setInterval(() => redraw(n => n + 1), 1000);   // entries expire by themselves
    return () => { off(); clearInterval(timer); };
  }, []);
  return circle => store.in(circle).filter(x => x.user !== meId);
}
