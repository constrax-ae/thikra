// Live delivery: who is connected right now, per circle. The gateway (server/ws.ts) registers sockets here;
// the HTTP side just announces events. Nothing in here is required for correctness: a client that is not
// connected catches up through GET /messages (sync by seq), so a lost event is never a lost message.
//
// With several nodes (server/state.ts: Bus), the sockets of a circle are spread over them: an event is handed to the local
// sockets and published on the bus, and every other node hands it to ITS sockets. Sockets themselves never leave their node.
import { busProxy, type Bus } from './state.ts';

export type Sink = (event: unknown) => void;

export interface Live {
  join(circleId: number, sink: Sink, userId?: number): () => void;
  publish(circleId: number, event: unknown, reached?: (userId: number) => void, except?: number): number;
  online(): number;
  setVisible(userId: number, was: boolean, now: boolean): void;
  isVisible(userId: number): boolean;
  /** Called for each local user an event from ANOTHER node reached (this is how "delivered" is known for remote senders). */
  onRemoteReached(fn: (circleId: number, event: unknown, userId: number) => void): void;
}

export function createLive(bus: Bus): Live {
  const rooms = new Map<number, Map<Sink, number>>(); // circle -> sink -> the user it belongs to
  const visible = new Map<number, number>();           // user -> number of visible connections
  let remoteReached: ((circleId: number, event: unknown, userId: number) => void) | undefined;

  /** Hand an event to the sockets on THIS node. Returns how many it reached. */
  function deliver(circleId: number, event: unknown, reached?: (userId: number) => void, except?: number): number {
    let n = 0;
    const seen = new Set<number>();
    for (const [sink, userId] of rooms.get(circleId) ?? []) {
      if (except !== undefined && userId === except) continue;
      try {
        sink(event); n++;
        if (reached && userId && !seen.has(userId)) { seen.add(userId); reached(userId); }
      } catch { /* a dead socket must not stop the others */ }
    }
    return n;
  }

  bus.onRemote(m => deliver(m.circleId, m.event, remoteReached ? uid => remoteReached!(m.circleId, m.event, uid) : undefined, m.except));

  return {
    join(circleId, sink, userId = 0) {
      let room = rooms.get(circleId);
      if (!room) rooms.set(circleId, (room = new Map()));
      room.set(sink, userId);
      return () => { room!.delete(sink); if (!room!.size) rooms.delete(circleId); };
    },
    /**
     * Hand an event to every connection in the circle, on every node. Returns how many LOCAL ones it reached.
     * `reached` (optional) is told which local users got it, once per user: this is how "delivered" is known without a round trip.
     */
    publish(circleId, event, reached, except) {
      const n = deliver(circleId, event, reached, except);
      bus.publish({ circleId, event, except });
      return n;
    },
    online: () => [...rooms.values()].reduce((n, s) => n + s.size, 0),
    // Which people have the app on screen right now. A notification for a message is skipped for them (they are looking at it);
    // otherwise a connected-but-hidden tab would silently swallow notifications.
    setVisible(userId, was, now) {
      if (was === now) return;
      const n = (visible.get(userId) ?? 0) + (now ? 1 : -1);
      if (n <= 0) visible.delete(userId); else visible.set(userId, n);
    },
    isVisible: userId => (visible.get(userId) ?? 0) > 0,
    onRemoteReached(fn) { remoteReached = fn; },
  };
}

/** The one this server uses. */
export const live = createLive(busProxy);
export const { join, publish, online, setVisible, isVisible } = live;
