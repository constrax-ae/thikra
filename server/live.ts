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
  /** Register a connection under its person, whatever chats they are in. Returns the function that removes it. */
  attach(userId: number, sink: Sink): () => void;
  /** Hand an event to every connection of these people, on every node (an event that belongs to people, not to a chat: presence). */
  publishTo(userIds: number[], event: unknown): void;
  /** A person was removed from a chat: their open connections stop receiving it, on every node (they would otherwise keep hearing it until they reconnect). */
  evict(circleId: number, userId: number): void;
  /** Is this connection still in the chat's room? (a person who was evicted and added back must be put in again) */
  isJoined(circleId: number, sink: Sink): boolean;
  online(): number;
  setVisible(userId: number, was: boolean, now: boolean): void;
  isVisible(userId: number): boolean;
  /** Told when a person's FIRST connection puts the app on screen (true) and when their last one leaves it (false). This is "online". */
  onVisibility(fn: (userId: number, online: boolean) => void): void;
  /** Called for each local user an event from ANOTHER node reached (this is how "delivered" is known for remote senders). */
  onRemoteReached(fn: (circleId: number, event: unknown, userId: number) => void): void;
}

export function createLive(bus: Bus): Live {
  const rooms = new Map<number, Map<Sink, number>>(); // circle -> sink -> the user it belongs to
  const visible = new Map<number, number>();           // user -> number of visible connections
  let remoteReached: ((circleId: number, event: unknown, userId: number) => void) | undefined;
  const visibilityListeners: Array<(userId: number, online: boolean) => void> = [];

  /** Hand an event to the sockets on THIS node. Returns how many it reached. */
  const people = new Map<number, Set<Sink>>();          // user -> their connections on this node
  function deliverTo(userIds: number[], event: unknown) {
    for (const id of userIds) for (const sink of people.get(id) ?? []) { try { sink(event); } catch { /* a dead socket must not stop the others */ } }
  }
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

  function evictLocal(circleId: number, userId: number) {
    const room = rooms.get(circleId);
    if (!room) return;
    for (const [sink, u] of [...room]) if (u === userId) room.delete(sink);
    if (!room.size) rooms.delete(circleId);
  }
  bus.onRemote(m => {
    if (m.evict) return evictLocal(m.circleId, m.evict);
    if (m.users) return deliverTo(m.users, m.event);
    deliver(m.circleId, m.event, remoteReached ? uid => remoteReached!(m.circleId, m.event, uid) : undefined, m.except);
  });

  return {
    join(circleId, sink, userId = 0) {
      let room = rooms.get(circleId);
      if (!room) rooms.set(circleId, (room = new Map()));
      room.set(sink, userId);
      return () => { room!.delete(sink); if (!room!.size && rooms.get(circleId) === room) rooms.delete(circleId); };
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
      const before = (visible.get(userId) ?? 0) > 0;
      const n = (visible.get(userId) ?? 0) + (now ? 1 : -1);
      if (n <= 0) visible.delete(userId); else visible.set(userId, n);
      const after = n > 0;
      if (before !== after) for (const fn of visibilityListeners) { try { fn(userId, after); } catch (e) { console.error('[presence]', e); } }
    },
    isVisible: userId => (visible.get(userId) ?? 0) > 0,
    onRemoteReached(fn) { remoteReached = fn; },
    onVisibility(fn) { visibilityListeners.push(fn); },
    attach(userId, sink) {
      let set = people.get(userId);
      if (!set) people.set(userId, (set = new Set()));
      set.add(sink);
      return () => { set!.delete(sink); if (!set!.size) people.delete(userId); };
    },
    evict(circleId, userId) { evictLocal(circleId, userId); bus.publish({ circleId, event: null, evict: userId }); },
    isJoined: (circleId, sink) => !!rooms.get(circleId)?.has(sink),
    publishTo(userIds, event) {
      if (!userIds.length) return;
      deliverTo(userIds, event);
      bus.publish({ circleId: 0, event, users: userIds });
    },
  };
}

/** The one this server uses. */
export const live = createLive(busProxy);
export const { join, publish, online, setVisible, isVisible, attach, evict, isJoined } = live;

/**
 * A person became a member of a chat (made it, joined it, was added, or someone opened a private chat with them).
 * Their open connections join the chat's room at once, on every node, so its messages arrive live without a reconnect;
 * the frame also tells their apps to refresh the chat list.
 */
export function memberJoined(circleId: number, userIds: number[]) { live.publishTo(userIds, { t: 'member_added', circle: circleId }); }

