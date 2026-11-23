// The outbox: text messages written on this device that the server has not confirmed yet. It is saved on the device, so a message
// written without internet survives closing the app and is sent when the connection returns (by web/src/sender.ts).
//
// Every message keeps ONE id (`cid`, sent as client_msg_id) for all its attempts: the server stores a given id once, so retrying
// can never create a second copy.
//
// It belongs to one person: on a shared browser each account has its own, and signing out wipes it (clear()).
// Every operation re-reads the stored list first, so two tabs of the same person add to one outbox instead of overwriting each other.

export interface OutboxQuote { id: number; author: string | null; kind: string; text: string }
export interface OutboxItem {
  cid: string; circle: number; body: string; replyTo: number | null; at: number;
  /** What is being replied to, as it looked when the person wrote this (only to draw the waiting bubble). */
  quote?: OutboxQuote;
  /** The members this message @mentions. */
  mentions?: number[];
  /** The link whose preview card goes with this message (asked from the server while it was being written). */
  preview?: string;
  /** Set when the server refused it (or it kept failing): it waits for the person to retry or discard. */
  failed?: string;
}
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const valid = (x: any): x is OutboxItem =>
  !!x && typeof x === 'object' && typeof x.cid === 'string' && !!x.cid && Number.isInteger(x.circle) && typeof x.body === 'string' && !!x.body.trim()
  && typeof x.at === 'number' && (x.replyTo === null || Number.isInteger(x.replyTo)) && (x.failed === undefined || typeof x.failed === 'string');

export function createOutbox(storage: Store | null, userId: number) {
  const key = `thikra_outbox_v2_${userId}`;
  let memory: OutboxItem[] = [];      // the truth when storage cannot be used; otherwise a copy of the last read
  let usable = !!storage;
  const load = (): OutboxItem[] => {
    if (!usable) return memory;
    try {
      const raw = JSON.parse(storage!.getItem(key) ?? '[]');
      memory = Array.isArray(raw) ? raw.filter(valid) : [];
    } catch (e) {
      if (!(e instanceof SyntaxError)) usable = false;   // reading is forbidden: keep going in memory. (A damaged value is just "empty".)
      else memory = [];
    }
    return memory;
  };
  const save = (items: OutboxItem[]) => {
    memory = items;
    if (!usable) return;
    try { if (items.length) storage!.setItem(key, JSON.stringify(items)); else storage!.removeItem(key); }
    catch { usable = false; /* storage full or forbidden: the outbox still works until the tab closes */ }
  };
  const list = (circle: number) => load().map((i, n) => ({ i, n })).filter(x => x.i.circle === circle).sort((x, y) => x.i.at - y.i.at || x.n - y.n).map(x => x.i);
  const change = (cid: string, fn: (i: OutboxItem) => OutboxItem) => save(load().map(i => (i.cid === cid ? fn(i) : i)));
  return {
    /** Everything waiting in this chat, oldest first (failed ones included). */
    list,
    /** What should go out by itself in this chat: everything not marked failed, oldest first. */
    pending: (circle: number) => list(circle).filter(i => !i.failed),
    /** The chats that have something waiting. */
    circles: () => [...new Set(load().map(i => i.circle))],
    has: (cid: string) => load().some(i => i.cid === cid),
    add(item: OutboxItem) { const items = load(); if (!items.some(i => i.cid === item.cid)) save([...items, item]); },
    /** The server has it (or the person discarded it). */
    done(cid: string) { const items = load(); if (items.some(i => i.cid === cid)) save(items.filter(i => i.cid !== cid)); },
    fail(cid: string, code: string) { change(cid, i => ({ ...i, failed: code })); },
    retry(cid: string) { change(cid, ({ failed: _failed, ...rest }) => rest); },
    /** Signing out or deleting the account: nothing unsent stays behind on this device. */
    clear() { save([]); },
  };
}
export type Outbox = ReturnType<typeof createOutbox>;
