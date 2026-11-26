import { useEffect, useState } from 'react';
import { live } from './live';
import { createTyping, type Typer } from '../../core/typing.ts';

// The store and label moved to core/typing.ts (shared with the phone app).
export * from '../../core/typing.ts';
type Frame = Parameters<ReturnType<typeof createTyping>['note']>[0];

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
