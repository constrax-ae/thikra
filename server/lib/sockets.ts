// Open live connections by person, on THIS node, so that ending someone's sessions (suspend, ban, "sign out everywhere") also ends their live sockets.
// (With several nodes each node closes its own; the others close when the person's next frame or reconnect finds no session.)
const open = new Map<number, Set<() => void>>();
export function trackSocket(userId: number, close: () => void): () => void {
  let set = open.get(userId);
  if (!set) open.set(userId, (set = new Set()));
  set.add(close);
  return () => { set!.delete(close); if (!set!.size) open.delete(userId); };
}
export function closeUserSockets(userId: number): number {
  const set = open.get(userId);
  if (!set) return 0;
  const n = set.size;
  for (const close of [...set]) { try { close(); } catch { /* already gone */ } }
  return n;
}
