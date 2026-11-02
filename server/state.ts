/**
 * The few things the server must share between processes once there is more than one of it (LAUNCH-PLAN D3):
 *   RateLimiter: how often a person or address did something recently
 *   KeyValue:    short-lived values (the two-step sign-in ticket)
 *   Bus:         an event for a circle that sockets on OTHER nodes must hear too
 * Today each is in memory, which is exactly right for one process. A production build swaps them for Redis implementations
 * with `setState`; nothing else in the code changes. The contract tests (server/state.test.ts) are written against the
 * interfaces, so the Redis versions only have to pass the same tests.
 * (Metrics stay per process on purpose: each node reports its own numbers.)
 */

export interface RateLimiter {
  /** Record one hit and say whether the caller is now OVER the limit (more than `max` hits within `windowMs`). */
  hit(key: string, max: number, windowMs: number): Promise<boolean>;
}
export interface KeyValue {
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  get(key: string): Promise<unknown | undefined>;
  del(key: string): Promise<void>;
}
export interface BusMessage { circleId: number; event: unknown; except?: number }
export interface Bus {
  /** Tell the OTHER nodes. Never echoes back to the node that published. */
  publish(m: BusMessage): void;
  /** Be told about events published by other nodes. */
  onRemote(handler: (m: BusMessage) => void): void;
}

export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, number[]>();
  async hit(key: string, max: number, windowMs: number) {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 20_000) for (const [k, v] of this.hits) if (!v.length || now - v[v.length - 1] > 3600_000) this.hits.delete(k);   // keep the map from growing without end
    return recent.length > max;
  }
}

export class MemoryKeyValue implements KeyValue {
  private m = new Map<string, { v: unknown; exp: number }>();
  async set(key: string, value: unknown, ttlMs: number) { this.m.set(key, { v: value, exp: Date.now() + ttlMs }); }
  async get(key: string) { const e = this.m.get(key); if (!e) return undefined; if (e.exp < Date.now()) { this.m.delete(key); return undefined; } return e.v; }
  async del(key: string) { this.m.delete(key); }
}

/** One process: nobody else to tell. */
export class LocalBus implements Bus {
  publish() { /* no other node */ }
  onRemote() { /* nothing arrives from elsewhere */ }
}

/** For tests (and a single-machine multi-process dev setup): buses that hear each other. Each `bus()` is one node. */
export function createBusNetwork() {
  const handlers: Array<{ id: number; h: (m: BusMessage) => void }> = [];
  let next = 0;
  return {
    bus(): Bus {
      const id = next++;
      return {
        publish: m => { for (const x of handlers) if (x.id !== id) queueMicrotask(() => x.h(m)); },
        onRemote: h => { handlers.push({ id, h }); },
      };
    },
  };
}

export interface State { limiter: RateLimiter; kv: KeyValue; bus: Bus }
export const state: State = { limiter: new MemoryRateLimiter(), kv: new MemoryKeyValue(), bus: new LocalBus() };
const remoteHandlers: Array<(m: BusMessage) => void> = [];

/** Swap the implementations (a Redis build, or a test). Handlers registered through `busProxy` follow the new bus. */
export function setState(next: Partial<State>) {
  if (next.limiter) state.limiter = next.limiter;
  if (next.kv) state.kv = next.kv;
  if (next.bus) { state.bus = next.bus; for (const h of remoteHandlers) state.bus.onRemote(h); }
}

/** What the rest of the server holds: always the CURRENT bus, even after `setState`. */
export const busProxy: Bus = {
  publish: m => state.bus.publish(m),
  onRemote: h => { remoteHandlers.push(h); state.bus.onRemote(h); },
};
