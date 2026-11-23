// From what a device decrypted to what the chat screen draws. The screen already knows how to draw a `Message` (text, voice note, card, files, a poll, reactions, "edited");
// this file builds exactly that from the server's row (who, when, which number) and the decrypted payload, plus the "ledger" of control messages (edits, reactions, votes).

import type { Attachment, Card, Message } from '../api';
import type { FileRef, Payload } from './payload';

/** What control messages did to messages, per chat. Every entry remembers the seq of the control message that made it, so the newest wins and replaying one changes nothing. */
export interface Ledger {
  react: Record<string, Record<string, { e: string | null; s: number; rv: number }>>;
  vote: Record<string, Record<string, { o: number[]; s: number; rv: number }>>;
  edit: Record<string, Record<string, { text: string; s: number; rv: number; at: string }>>;
}
export const emptyLedger = (): Ledger => ({ react: {}, vote: {}, edit: {} });
/** Two ledgers of the same chat (this device's and one handed over): per message and per person the newer control message wins. */
export function mergeLedger(a: Ledger | undefined, b: Ledger): Ledger {
  const out: Ledger = a ? JSON.parse(JSON.stringify(a)) : emptyLedger();
  const bad = (k: string) => k === '__proto__' || k === 'constructor' || k === 'prototype';
  for (const kind of ['react', 'vote', 'edit'] as const) for (const [target, people] of Object.entries(b[kind] ?? {})) {
    if (bad(target) || !people || typeof people !== 'object') continue;
    for (const [uid, e] of Object.entries(people as Record<string, { s: number }>)) {
      if (bad(uid) || !e || typeof e.s !== 'number') continue;
      const own = Object.prototype.hasOwnProperty;
      const bucket = out[kind] as any;
      const m = own.call(bucket, target) ? bucket[target] : (bucket[target] = {});
      if (!own.call(m, uid) || m[uid].s < e.s) m[uid] = e;
    }
  }
  return out;
}

/** The server's row for an encrypted message (what GET /api/circles/:id/messages returns), as far as the screen needs it. */
export type Row = Record<string, any> & { id: number; userId: number | null };

/** Apply one control message to the ledger. `row` is the control message's own row. Returns true if it changed anything. */
export function applyControl(led: Ledger, row: Row, p: Payload): boolean {
  const uid = String(row.userId ?? 0), seq = row.seq ?? 0, rv = row.rev ?? 0;
  if (p.t === 'react') {
    const m = (led.react[p.target] ??= {}), old = m[uid];
    if (old && old.s >= seq) return false;
    m[uid] = { e: p.emoji, s: seq, rv }; return true;
  }
  if (p.t === 'vote') {
    const m = (led.vote[p.target] ??= {}), old = m[uid];
    if (old && old.s >= seq) return false;
    m[uid] = { o: p.options, s: seq, rv }; return true;
  }
  if (p.t === 'edit') {
    if (row.target !== p.target) return false;   // the plain header must name the same message as the encrypted one
    const m = (led.edit[p.target] ??= {}), old = m[uid];
    if (old && old.s >= seq) return false;
    m[uid] = { text: p.text, s: seq, rv, at: String(row.createdAt ?? '') }; return true;
  }
  return false;
}

const kindOf = (f: FileRef): Attachment['kind'] => f.kind;
function attachmentsOf(row: Row, files: FileRef[]): Attachment[] {
  const stored: any[] = Array.isArray(row.attachments) ? row.attachments : [];
  const out: Attachment[] = [];
  for (const f of files) {
    const s = stored[f.i];
    if (!s) continue;
    out.push({ id: s.id, kind: kindOf(f), mime: f.mime, name: f.name, size: f.size, w: f.w, h: f.h, thumb: null, enc: { k: f.k, hash: f.hash, ...(f.thumb ? { thumb: f.thumb } : {}) } });
  }
  return out;
}

/** The message as the screen draws it. `quote` is the text of the message this one answers, if this device has it. */
export function render(row: Row, p: Payload, led: Ledger, quote?: { text: string; card: Card['type'] | null }): Message {
  const id = String(row.id);
  const edit = led.edit[id]?.[String(row.userId ?? 0)];
  let rev = row.rev ?? 0;
  const reactions: Array<{ u: number; e: string }> = [];
  for (const [u, r] of Object.entries(led.react[id] ?? {})) { if (r.e) reactions.push({ u: Number(u), e: r.e }); rev = Math.max(rev, r.rv); }
  if (edit) rev = Math.max(rev, edit.rv);
  const base: Message = {
    id: row.id, seq: row.seq, rev, userId: row.userId, author: row.author ?? null, kind: 'text', body: '', transcript: null, hasAudio: 0, archiveStatus: 'none', score: null, category: null, reason: null,
    createdAt: row.createdAt, deleted: row.deleted ? 1 : 0, deletedBy: row.deletedBy ?? null, replyToId: row.replyToId ?? null, editedAt: edit ? (row.editedAt ?? edit.at) : row.editedAt ?? null,
    forwardCount: row.forwardCount ?? 0, mentions: row.mentions ?? [], playedBy: row.playedBy ?? [], expiresAt: row.expiresAt ?? null, expired: !!row.expired,
    viewOnce: row.viewOnce ?? null, reactions, encrypted: true, attachments: [],
    replyTo: row.replyTo ? { ...row.replyTo, text: quote?.text ?? '', card: quote?.card ?? null } : null,
  };
  switch (p.t) {
    case 'text': return { ...base, body: edit ? edit.text : p.text, card: p.card ?? null };
    case 'media': return { ...base, body: edit ? edit.text : p.text, attachments: attachmentsOf(row, p.files) };
    case 'voice': return { ...base, kind: 'voice', hasAudio: 1, audioMs: p.ms, waveform: p.wave, attachments: attachmentsOf(row, [p.file]) };
    case 'poll': {
      // One person's vote, as counted: only options that exist, no repeats, and one option in a single-choice poll (a hostile member could otherwise vote for everything).
      const votes: Record<string, { o: number[]; s: number; rv: number }> = {};
      for (const [u, v] of Object.entries(led.vote[id] ?? {})) {
        const o = [...new Set(v.o.filter(x => Number.isInteger(x) && x >= 0 && x < p.options.length))];
        votes[u] = { ...v, o: p.multiple ? o : o.slice(0, 1) };
      }
      for (const v of Object.values(votes)) rev = Math.max(rev, v.rv);
      return {
        ...base, rev, body: p.text,
        poll: { multiple: p.multiple, closed: false, voters: Object.values(votes).filter(v => v.o.length).length,
          options: p.options.map((text, i) => ({ id: i, text, voters: Object.entries(votes).filter(([, v]) => v.o.includes(i)).map(([u]) => Number(u)) })) },
      };
    }
    default: return base;   // a control message is never drawn
  }
}

/** The one line a chat list or a quoted reply shows for a payload. */
export function lineOf(p: Payload): { kind: string; text: string } {
  switch (p.t) {
    case 'text': return { kind: p.card && p.card.type !== 'link' ? p.card.type : 'text', text: p.text.slice(0, 120) };
    case 'media': return { kind: p.files[0]?.kind === 'image' ? 'image' : p.files[0]?.kind === 'video' ? 'video' : 'file', text: p.text.slice(0, 120) };
    case 'voice': return { kind: 'voice', text: '' };
    case 'poll': return { kind: 'text', text: p.text.slice(0, 120) };
    default: return { kind: 'text', text: '' };
  }
}
