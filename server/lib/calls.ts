// Voice calls (trial): the signalling relay. See docs/superpowers/specs/2026-11-19-calls-design.md.
// The server never touches the voice: it passes the two browsers' set-up messages (offer, answer, ICE candidates), enforces who may call whom,
// times the ringing out, and writes one line in the chat. Call state lives in memory on THIS node: a call that is not finished when the process
// restarts is simply lost (both pages see their socket drop and hang up).
import { createHmac } from 'node:crypto';
import { one } from '../db.ts';
import { isFrozen, limited, membership, systemMessage } from './helpers.ts';
import { suspension } from './admin.ts';
import { maintenanceNow } from './announce.ts';
import { count } from '../metrics.ts';

export type Sink = (event: unknown) => void;
interface Call {
  id: string; circle: number; caller: number; callee: number; callerSink: Sink; calleeSink?: Sink;
  state: 'ringing' | 'active'; answeredAt?: number; timer?: ReturnType<typeof setTimeout>;
  held: unknown[];              // the caller's candidates that came before the answer
  sent: { caller: number; callee: number };
}
const MAX_SDP = 16 * 1024, MAX_CANDIDATE = 2 * 1024, MAX_CANDIDATES = 80;
const OFFERS = { max: 10, windowMs: 10 * 60_000 };
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const ringMs = () => Math.max(100, Number(process.env.THIKRA_CALL_RING_MS) || 45_000);

const conns = new Map<number, Set<Sink>>();   // person -> their open sockets on this node
const calls = new Map<string, Call>();
const inCall = new Map<number, Call>();       // person -> the call they are in or being rung for

const deliver = (sink: Sink | undefined, e: unknown) => { try { sink?.(e); } catch { /* a dead socket must not stop the other side */ } };
const nameOf = (id: number) => (one('SELECT name FROM users WHERE id = ?', id)?.name as string | undefined) ?? '';

/** Register a person's socket. The returned function runs when it closes: a call that depended on this socket ends (the page was closed mid-call). */
export function attachCalls(userId: number, sink: Sink): () => void {
  let set = conns.get(userId);
  if (!set) conns.set(userId, (set = new Set()));
  set.add(sink);
  return () => {
    set!.delete(sink); if (!set!.size) conns.delete(userId);
    for (const c of [...calls.values()]) {
      if (c.callerSink === sink) end(c, c.state === 'ringing' ? 'cancelled' : 'lost');
      else if (c.calleeSink === sink) end(c, 'lost');
      else if (c.state === 'ringing' && c.callee === userId && !conns.has(userId)) end(c, 'offline');   // nobody is left to ring: the caller is told, and the callee is not stuck "busy"
    }
  };
}

function end(c: Call, reason: string) {
  if (calls.get(c.id) !== c) return;
  calls.delete(c.id);
  clearTimeout(c.timer);
  if (inCall.get(c.caller) === c) inCall.delete(c.caller);
  if (inCall.get(c.callee) === c) inCall.delete(c.callee);
  const e = { t: 'call_end', call: c.id, reason };
  deliver(c.callerSink, e);
  if (c.calleeSink) deliver(c.calleeSink, e); else for (const s of conns.get(c.callee) ?? []) deliver(s, e);
  record(c, reason);
  count(`call_end_${reason}`);
}
/** The one line in the chat. A refused call (blocked, frozen…) leaves none. */
function record(c: Pick<Call, 'circle' | 'caller' | 'callee' | 'answeredAt'>, reason: string) {
  try {
    if (c.answeredAt) return void systemMessage(c.circle, 'callEnded', { secs: Math.max(0, Math.round((Date.now() - c.answeredAt) / 1000)) });
    if (reason === 'declined') return void systemMessage(c.circle, 'callDeclined', { name: nameOf(c.callee) });
    if (['cancelled', 'timeout', 'busy', 'offline'].includes(reason)) systemMessage(c.circle, 'callMissed', { name: nameOf(c.caller) });
  } catch (e) { console.error('[calls record]', e); }
}

export async function callFrame(userId: number, sink: Sink, f: any): Promise<void> {
  const id = typeof f?.call === 'string' && ID.test(f.call) ? f.call : null;
  switch (f?.t) {
    case 'call_offer': return offer(userId, sink, id, f).catch(e => {
      console.error('[calls offer]', e);
      deliver(sink, { t: 'call_end', call: id, reason: 'bad_request' });
    });
    case 'call_answer': {
      const c = id ? calls.get(id) : undefined;
      if (c && c.callee === userId && c.state === 'active' && sink !== c.calleeSink) return deliver(sink, { t: 'call_taken', call: c.id });   // a slower tab that answered at the same moment
      if (!c || c.callee !== userId || c.state !== 'ringing' || typeof f.sdp !== 'string' || !f.sdp || f.sdp.length > MAX_SDP) return;
      clearTimeout(c.timer);
      c.state = 'active'; c.answeredAt = Date.now(); c.calleeSink = sink;
      deliver(c.callerSink, { t: 'call_answer', call: c.id, sdp: f.sdp });
      for (const s of conns.get(c.callee) ?? []) if (s !== sink) deliver(s, { t: 'call_taken', call: c.id });
      for (const cand of c.held.splice(0)) deliver(sink, { t: 'call_ice', call: c.id, candidate: cand });
      return;
    }
    case 'call_ice': {
      const c = id ? calls.get(id) : undefined;
      if (!c || (userId !== c.caller && userId !== c.callee)) return;
      const cand = f.candidate;
      if (cand !== null && (typeof cand !== 'object' || JSON.stringify(cand).length > MAX_CANDIDATE)) return;
      const side = userId === c.caller ? 'caller' : 'callee';
      if (side === 'callee' && sink !== c.calleeSink) return;      // only the tab that answered
      if (side === 'caller' && sink !== c.callerSink) return;
      if (++c.sent[side] > MAX_CANDIDATES) return;
      if (side === 'caller') {
        if (c.state === 'ringing') { c.held.push(cand); return; }
        return deliver(c.calleeSink, { t: 'call_ice', call: c.id, candidate: cand });
      }
      return deliver(c.callerSink, { t: 'call_ice', call: c.id, candidate: cand });
    }
    case 'call_end': {
      const c = id ? calls.get(id) : undefined;
      if (!c || (userId !== c.caller && userId !== c.callee)) return;
      if (c.state === 'ringing') return end(c, userId === c.caller ? 'cancelled' : 'declined');
      if (sink !== c.callerSink && sink !== c.calleeSink) return;   // a tab that did not take the call cannot end it
      return end(c, f.reason === 'failed' ? 'failed' : 'ended');
    }
  }
}

async function offer(userId: number, sink: Sink, id: string | null, f: any) {
  const refuse = (reason: string) => deliver(sink, { t: 'call_end', call: typeof f?.call === 'string' ? f.call.slice(0, 64) : null, reason });
  const circle = Number(f.circle);
  if (!id || !Number.isInteger(circle) || typeof f.sdp !== 'string' || !f.sdp || f.sdp.length > MAX_SDP || calls.has(id)) return refuse('bad_request');
  const chat = one("SELECT kind FROM circles WHERE id = ? AND deleted_at IS NULL", circle);
  const other = chat?.kind === 'direct' && membership(circle, userId)
    ? one('SELECT user_id FROM circle_members WHERE circle_id = ? AND user_id != ?', circle, userId)?.user_id as number | undefined : undefined;
  if (!other) return refuse('not_allowed');
  if (maintenanceNow()) return refuse('maintenance');
  if (isFrozen(circle)) return refuse('frozen');
  if (one('SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)', userId, other, other, userId)) return refuse('blocked');
  if (await limited(`call:${userId}`, OFFERS.max, OFFERS.windowMs)) return refuse('rate_limited');
  if (inCall.has(userId)) return refuse('in_call');
  if (calls.has(id)) return refuse('bad_request');   // the id was taken while we waited for the limiter
  const missed = (reason: string) => { refuse(reason); record({ circle, caller: userId, callee: other }, reason); count(`call_end_${reason}`); };
  const ringing = [...(conns.get(other) ?? [])];
  if (!ringing.length || suspension(other)) return missed('offline');
  if (inCall.has(other)) return missed('busy');
  const c: Call = { id, circle, caller: userId, callee: other, callerSink: sink, state: 'ringing', held: [], sent: { caller: 0, callee: 0 } };
  calls.set(id, c); inCall.set(userId, c); inCall.set(other, c);
  const ms = ringMs();
  c.timer = setTimeout(() => end(c, 'timeout'), ms); c.timer.unref?.();
  count('call_offer');
  const inc = { t: 'call_incoming', call: id, circle, from: { id: userId, name: nameOf(userId), avatarAt: (one('SELECT avatar_at FROM users WHERE id = ?', userId)?.avatar_at as string | null | undefined) ?? null }, sdp: f.sdp, ring_ms: ms };
  for (const s of ringing) deliver(s, inc);
}

/** STUN, and TURN with short-lived credentials when configured (the standard TURN REST scheme, as coturn's `use-auth-secret`). */
export function iceServers(userId: number): { iceServers: Array<{ urls: string[]; username?: string; credential?: string }>; ttl: number; turn: boolean } {
  const list = (s: string | undefined) => (s ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const stun = list(process.env.THIKRA_STUN_URLS);
  const out: Array<{ urls: string[]; username?: string; credential?: string }> = [{ urls: stun.length ? stun : ['stun:stun.cloudflare.com:3478'] }];
  const turnUrls = list(process.env.THIKRA_TURN_URLS), secret = process.env.THIKRA_TURN_SECRET?.trim();
  const ttl = Math.max(60, Number(process.env.THIKRA_TURN_TTL) || 3600);
  if (turnUrls.length && secret) {
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${userId}`;
    out.push({ urls: turnUrls, username, credential: createHmac('sha1', secret).update(username).digest('base64') });
  }
  return { iceServers: out, ttl, turn: out.length > 1 };
}
