// The messages a chat screen holds: a window on the chat's history, from some seq up to the newest.
// The window only grows in two ways: new messages at the bottom, and a whole older page at the top (web/src/CircleView.tsx: loadOlder).

interface Held { id: number; seq?: number; rev?: number }

/**
 * Merge what arrived into what the screen holds. A held message is replaced by a newer revision of itself; a message we do not hold
 * is added only if it belongs to the window, i.e. its seq is not below `oldestLoaded` (0 = the whole chat is loaded).
 * Without that rule, a reaction to a very old message would drop that one message at the top of the screen, and scrolling back
 * would continue from IT, silently skipping everything in between.
 */
export function mergeMessages<T extends Held>(prev: T[], incoming: T[], oldestLoaded: number): T[] {
  const byId = new Map(prev.map(m => [m.id, m]));
  for (const m of incoming) {
    const held = byId.get(m.id);
    if (!held && m.seq !== undefined && m.seq < oldestLoaded) continue;
    if (!held || (m.rev ?? 0) >= (held.rev ?? 0)) byId.set(m.id, { ...held, ...m });
  }
  return [...byId.values()].sort((x, y) => (x.seq ?? Number.MAX_SAFE_INTEGER) - (y.seq ?? Number.MAX_SAFE_INTEGER) || x.id - y.id);
}

/** The seq of the oldest message in a list, or null if it has none. */
export function oldestOf<T extends { seq?: number }>(list: T[]): number | null {
  let min: number | null = null;
  for (const m of list) if (m.seq !== undefined && (min === null || m.seq < min)) min = m.seq;
  return min;
}
