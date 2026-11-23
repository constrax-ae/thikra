import type { Outbox, OutboxItem } from './outbox';

// The sender: takes what waits in the outbox to the server. One for the whole app, so a message written in one chat goes out
// even after the person moved to another screen.
//
// Rules:
//  - One message at a time per chat, oldest first, and the next goes only when the one before is settled. This is what keeps a
//    person's messages in the order they wrote them, whatever the network does.
//  - Over the socket when it is up (the `ack` settles it), otherwise over HTTP.
//  - No answer (offline, a dropped connection, 15 s of silence): the message stays pending and is tried again, with pauses that grow
//    to a minute. It is never given up on: being offline for a day must not fail a message.
//  - "Too fast" or a server error: tried again after 2, 4, 8, 16 seconds; the fifth refusal marks it failed.
//  - Any other refusal (blocked, chat frozen…): marked failed at once. A failed message waits for the person (retry or discard)
//    and no longer holds up the chat.

export interface Transport {
  connected(): boolean;
  /** true if the frame went out on the socket. */
  socketSend(item: OutboxItem): boolean;
  /** Resolves when stored; rejects with `{ code }` ('network' when there was no answer at all). */
  httpSend(item: OutboxItem): Promise<void>;
}
export interface SenderEvent { type: 'sent' | 'failed' | 'changed'; cid?: string; circle?: number; via?: 'socket' | 'http' }

const SILENCE_MS = 15_000;
const TRIES = 5;
const TRANSIENT = new Set(['rate_limited', 'server', 'too_many_requests']);

export function createSender(box: Outbox, transport: Transport, now: () => number = Date.now) {
  const flying = new Map<number, { cid: string; via: 'socket' | 'http'; at: number }>();   // chat -> the one message on its way
  const waits = new Map<string, { refusals: number; silences: number; next: number }>();     // message -> when it may be tried again
  const listeners = new Set<(e: SenderEvent) => void>();
  const emit = (e: SenderEvent) => listeners.forEach(l => { try { l(e); } catch { /* a screen's mistake must not stop sending */ } });
  const wait = (cid: string) => waits.get(cid) ?? { refusals: 0, silences: 0, next: 0 };
  const land = (cid: string) => { for (const [circle, f] of flying) if (f.cid === cid) { flying.delete(circle); return circle; } return undefined; };

  function settle(cid: string, via: 'socket' | 'http') {
    const circle = land(cid);
    waits.delete(cid);
    if (!box.has(cid)) return;   // discarded meanwhile, or sent by another tab
    box.done(cid);
    emit({ type: 'sent', cid, circle, via });
    kick();
  }
  function refuse(cid: string, code: string) {
    const circle = land(cid);
    if (!box.has(cid)) return;
    const w = wait(cid);
    if (code === 'network') {
      w.silences++; w.next = now() + Math.min(60_000, 2000 * 2 ** (w.silences - 1));
      waits.set(cid, w);
    } else if (TRANSIENT.has(code) && w.refusals + 1 < TRIES) {
      w.refusals++; w.next = now() + 2000 * 2 ** (w.refusals - 1);
      waits.set(cid, w);
    } else {
      waits.delete(cid);
      box.fail(cid, code);
      emit({ type: 'failed', cid, circle });
    }
    kick();
  }
  function kick() {
    for (const circle of box.circles()) {
      const f = flying.get(circle);
      if (f) {
        if (f.via === 'socket' && now() - f.at >= SILENCE_MS) flying.delete(circle);   // the socket swallowed it: send again (same id)
        else continue;
      }
      const head = box.pending(circle)[0];
      if (!head || wait(head.cid).next > now()) continue;
      if (transport.connected() && transport.socketSend(head)) { flying.set(circle, { cid: head.cid, via: 'socket', at: now() }); continue; }
      flying.set(circle, { cid: head.cid, via: 'http', at: now() });
      transport.httpSend(head).then(() => settle(head.cid, 'http'), (e: { code?: string }) => refuse(head.cid, e?.code ?? 'generic'));
    }
  }
  return {
    /** Try to send whatever may go now. Cheap to call often (a timer, "online", a new message). */
    kick,
    /** The server confirmed this id over the socket. */
    acked: (cid: string) => settle(cid, 'socket'),
    /** The server answered this id with an error over the socket. */
    errored: refuse,
    /** The socket closed: what it was carrying has to go again on the next connection. */
    socketClosed() { for (const [circle, f] of flying) if (f.via === 'socket') flying.delete(circle); },
    /** The person asks to try a failed message again. */
    retry(cid: string) { waits.delete(cid); box.retry(cid); emit({ type: 'changed', cid }); kick(); },
    /** The person gives up on a message. */
    discard(cid: string) { land(cid); waits.delete(cid); box.done(cid); emit({ type: 'changed', cid }); kick(); },
    subscribe(fn: (e: SenderEvent) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
export type Sender = ReturnType<typeof createSender>;
