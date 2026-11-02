// The client's view of one conversation, as the protocol defines it (PROTOCOL.md invariant I5, plus revisions):
//  - messages are shown in `seq` order, and a hole in the sequence means "ask the server to sync";
//  - every message has a `rev` that moves whenever it changes (edit, reaction, delete), and the client syncs by
//    "everything newer than the last rev I received in a SYNC REPLY".
// Pure and tiny on purpose, so the property tests can drive it with hostile delivery (drops, duplicates, reordering).

export interface Seqd { seq: number; rev?: number }

export class Timeline<T extends Seqd> {
  private items = new Map<number, T>();
  /** The sync watermark. Moves only on sync replies: a push can arrive while an earlier one was lost, so it proves nothing. */
  syncedRev = 0;

  /** Accepts a pushed or synced message. A repeat is ignored; a newer revision of a held message replaces it. */
  add(m: T) {
    const held = this.items.get(m.seq);
    if (!held || (m.rev ?? 0) > (held.rev ?? 0)) this.items.set(m.seq, m);
  }

  /**
   * Accepts a whole sync reply (it arrives complete or not at all) and advances the watermark to its last rev.
   * Returns true if the reply was a full page, meaning the caller should ask again.
   */
  applySync(messages: T[], pageSize: number): boolean {
    for (const m of messages) { this.add(m); if ((m.rev ?? 0) > this.syncedRev) this.syncedRev = m.rev ?? 0; }
    return messages.length >= pageSize;
  }

  /** Highest seq such that 1..n are all held. */
  get contiguous() { let n = 0; while (this.items.has(n + 1)) n++; return n; }

  /** True when something later than the contiguous prefix is held, i.e. there is a hole to fill. */
  get hasGap() { for (const s of this.items.keys()) if (s > this.contiguous + 1) return true; return false; }

  /** What the screen shows: in seq order. */
  get ordered(): T[] { return [...this.items.values()].sort((a, b) => a.seq - b.seq); }
}
