process.env.THIKRA_DEV = '1';   // these tests sign in with the on-screen code, which only exists in explicit development mode
// Voice calls (trial): signalling over the live socket, the ICE route, and the chat record. See docs/superpowers/specs/2026-11-19-calls-design.md.
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));
process.env.THIKRA_CALL_RING_MS = '45000';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';

const { app, startServer } = await import('./index.ts');
const { all, run } = await import('./db.ts');

const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
after(() => { server.close(); server.closeAllConnections?.(); });

let n = 0;
async function login(phone: string, name: string) {
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  return res.headers.get('set-cookie')!.split(';')[0];
}
const api = async (path: string, cookie: string, body?: unknown, method = body ? 'POST' : 'GET') => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() as any };
};
async function connect(cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  const frames: any[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', d => { frames.push(JSON.parse(String(d))); waiters.splice(0).forEach(w => w()); });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const next = async (pred: (f: any) => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    for (;;) {
      const f = frames.find(pred);
      if (f) return f;
      if (Date.now() > end) throw new Error('timed out waiting for a frame; got ' + JSON.stringify(frames));
      await new Promise<void>(r => { waiters.push(r); setTimeout(r, 30); });
    }
  };
  const quiet = async (pred: (f: any) => boolean, ms = 250) => { await new Promise(r => setTimeout(r, ms)); assert.equal(frames.find(pred), undefined, 'unexpected frame ' + JSON.stringify(frames.find(pred))); };
  await next(f => f.t === 'hello');
  return { ws, frames, next, quiet, send: (o: unknown) => ws.send(JSON.stringify(o)) };
}
type Conn = Awaited<ReturnType<typeof connect>>;

/** Two people with a private chat. */
async function pair() {
  const tag = String(1000000 + ++n * 7919 + Math.floor(Math.random() * 1000)).slice(-7);
  const a = { phone: `+9665${tag}1`, cookie: '', id: 0, name: 'ناصر' };
  const b = { phone: `+9665${tag}2`, cookie: '', id: 0, name: 'سارة' };
  a.cookie = await login(a.phone, a.name);
  b.cookie = await login(b.phone, b.name);
  a.id = (await api('/api/me', a.cookie)).json.id;
  b.id = (await api('/api/me', b.cookie)).json.id;
  const { json: d } = await api('/api/direct', a.cookie, { phone: b.phone });
  return { a, b, circle: (d.id ?? d.circleId) as number };
}
const callIdOf = () => `call-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const notices = (circle: number) => all("SELECT body FROM messages WHERE circle_id = ? AND kind = 'system' ORDER BY id", circle).map(r => JSON.parse(String(r.body).slice(4)) as { k: string; a: any });
const SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n';

test('an offer rings the other person, the answer comes back, candidates pass both ways, hang up ends it and leaves a record', async () => {
  const { a, b, circle } = await pair();
  const ca = await connect(a.cookie), cb = await connect(b.cookie);
  const call = callIdOf();
  ca.send({ t: 'call_offer', call, circle, sdp: SDP });
  const inc = await cb.next(f => f.t === 'call_incoming' && f.call === call);
  assert.equal(inc.circle, circle); assert.equal(inc.from.id, a.id); assert.equal(inc.from.name, a.name); assert.equal(inc.sdp, SDP); assert.equal(inc.ring_ms, 45000);
  ca.send({ t: 'call_ice', call, candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } });   // before the answer: held
  await new Promise(r => setTimeout(r, 100));
  assert.equal(cb.frames.some(f => f.t === 'call_ice'), false, 'nothing is handed over before the callee answers');
  cb.send({ t: 'call_answer', call, sdp: 'answer-sdp' });
  assert.equal((await ca.next(f => f.t === 'call_answer')).sdp, 'answer-sdp');
  assert.equal((await cb.next(f => f.t === 'call_ice')).candidate.sdpMid, '0');   // the held one arrives once answered
  cb.send({ t: 'call_ice', call, candidate: { candidate: 'candidate:2' } });
  assert.equal((await ca.next(f => f.t === 'call_ice')).candidate.candidate, 'candidate:2');
  ca.send({ t: 'call_ice', call, candidate: null });
  assert.equal((await cb.next(f => f.t === 'call_ice' && f.candidate === null)).call, call);
  await new Promise(r => setTimeout(r, 1100));
  cb.send({ t: 'call_end', call });
  const end = await ca.next(f => f.t === 'call_end');
  assert.equal(end.reason, 'ended'); assert.equal(end.call, call);
  await cb.next(f => f.t === 'call_end');   // the one who hung up is told too, so both screens close the same way
  const last = notices(circle).at(-1)!;
  assert.equal(last.k, 'callEnded'); assert.ok(last.a.secs >= 1);
  ca.ws.close(); cb.ws.close();
});

test('the call record is an ordinary message: it syncs with a seq and shows in the history', async () => {
  const { a, b, circle } = await pair();
  const ca = await connect(a.cookie), cb = await connect(b.cookie);
  const call = callIdOf();
  ca.send({ t: 'call_offer', call, circle, sdp: SDP });
  await cb.next(f => f.t === 'call_incoming');
  ca.send({ t: 'call_end', call });   // the caller gives up
  assert.equal((await cb.next(f => f.t === 'call_end')).reason, 'cancelled');
  const msg = await cb.next(f => f.t === 'msg' && f.m.kind === 'system');
  assert.deepEqual(JSON.parse(msg.m.body.slice(4)), { k: 'callMissed', a: { name: a.name } });
  const hist = await api(`/api/circles/${circle}/messages`, b.cookie);
  assert.ok(hist.json.some((m: any) => m.kind === 'system' && m.body.includes('callMissed')));
  ca.ws.close(); cb.ws.close();
});

test('declining tells the caller and leaves a "declined" line', async () => {
  const { a, b, circle } = await pair();
  const ca = await connect(a.cookie), cb = await connect(b.cookie);
  const call = callIdOf();
  ca.send({ t: 'call_offer', call, circle, sdp: SDP });
  await cb.next(f => f.t === 'call_incoming');
  cb.send({ t: 'call_end', call, reason: 'decline' });
  assert.equal((await ca.next(f => f.t === 'call_end')).reason, 'declined');
  await ca.next(f => f.t === 'msg' && f.m.kind === 'system');
  assert.deepEqual(notices(circle).at(-1), { k: 'callDeclined', a: { name: b.name } });
  ca.ws.close(); cb.ws.close();
});

test('someone who is in a call is busy: the caller is told, the callee gets a missed-call line, the first call is untouched', async () => {
  const { a, b, circle } = await pair();
  const tag = String(Date.now()).slice(-7);
  const c = { phone: `+9665${tag}3`, cookie: '' };
  c.cookie = await login(c.phone, 'منى');
  const { json: d2 } = await api('/api/direct', c.cookie, { phone: b.phone });
  const circle2 = (d2.id ?? d2.circleId) as number;
  const ca = await connect(a.cookie), cb = await connect(b.cookie), cc = await connect(c.cookie);
  const first = callIdOf();
  ca.send({ t: 'call_offer', call: first, circle, sdp: SDP });
  await cb.next(f => f.t === 'call_incoming');
  cb.send({ t: 'call_answer', call: first, sdp: 'x' });
  await ca.next(f => f.t === 'call_answer');
  const second = callIdOf();
  cc.send({ t: 'call_offer', call: second, circle: circle2, sdp: SDP });
  assert.equal((await cc.next(f => f.t === 'call_end' && f.call === second)).reason, 'busy');
  assert.equal(cb.frames.some(f => f.t === 'call_incoming' && f.call === second), false);
  assert.equal(notices(circle2).at(-1)!.k, 'callMissed');
  // and the person already in a call cannot start another
  cb.send({ t: 'call_offer', call: callIdOf(), circle: circle2, sdp: SDP });
  assert.equal((await cb.next(f => f.t === 'call_end' && f.reason === 'in_call')).reason, 'in_call');
  cc.send({ t: 'call_ice', call: first, candidate: { candidate: 'x' } });   // a stranger to the call cannot inject into it
  await ca.quiet(f => f.t === 'call_ice');
  ca.send({ t: 'call_end', call: first });
  await cb.next(f => f.t === 'call_end' && f.call === first);
  ca.ws.close(); cb.ws.close(); cc.ws.close();
});

test('nobody answers: both sides get a timeout and a missed-call line', async () => {
  process.env.THIKRA_CALL_RING_MS = '300';
  try {
    const { a, b, circle } = await pair();
    const ca = await connect(a.cookie), cb = await connect(b.cookie);
    const call = callIdOf();
    ca.send({ t: 'call_offer', call, circle, sdp: SDP });
    await cb.next(f => f.t === 'call_incoming');
    assert.equal((await ca.next(f => f.t === 'call_end', 3000)).reason, 'timeout');
    assert.equal((await cb.next(f => f.t === 'call_end', 3000)).reason, 'timeout');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(notices(circle).at(-1)!.k, 'callMissed');
    cb.send({ t: 'call_answer', call, sdp: 'late' });   // too late: nothing happens
    await ca.quiet(f => f.t === 'call_answer');
    ca.ws.close(); cb.ws.close();
  } finally { process.env.THIKRA_CALL_RING_MS = '45000'; }
});

test('the callee has the app closed: the caller is told at once and the missed call is recorded', async () => {
  const { a, circle } = await pair();
  const ca = await connect(a.cookie);
  ca.send({ t: 'call_offer', call: callIdOf(), circle, sdp: SDP });
  assert.equal((await ca.next(f => f.t === 'call_end')).reason, 'offline');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(notices(circle).at(-1)!.k, 'callMissed');
  ca.ws.close();
});

test('closing the page in the middle of a call hangs up for the other side', async () => {
  const { a, b, circle } = await pair();
  const ca = await connect(a.cookie), cb = await connect(b.cookie);
  const call = callIdOf();
  ca.send({ t: 'call_offer', call, circle, sdp: SDP });
  await cb.next(f => f.t === 'call_incoming');
  cb.send({ t: 'call_answer', call, sdp: 'x' });
  await ca.next(f => f.t === 'call_answer');
  cb.ws.terminate();
  assert.equal((await ca.next(f => f.t === 'call_end')).reason, 'lost');
  // and the same while still ringing: the caller leaves, the callee's sheet closes
  const p2 = await pair();
  const c1 = await connect(p2.a.cookie), c2 = await connect(p2.b.cookie);
  const call2 = callIdOf();
  c1.send({ t: 'call_offer', call: call2, circle: p2.circle, sdp: SDP });
  await c2.next(f => f.t === 'call_incoming');
  c1.ws.terminate();
  assert.equal((await c2.next(f => f.t === 'call_end')).reason, 'cancelled');
  ca.ws.close(); c2.ws.close();
});

test('with two tabs both ring and the first to answer wins; the other is told to stop', async () => {
  const { a, b, circle } = await pair();
  const ca = await connect(a.cookie), t1 = await connect(b.cookie), t2 = await connect(b.cookie);
  const call = callIdOf();
  ca.send({ t: 'call_offer', call, circle, sdp: SDP });
  await t1.next(f => f.t === 'call_incoming'); await t2.next(f => f.t === 'call_incoming');
  t1.send({ t: 'call_answer', call, sdp: 'one' });
  await ca.next(f => f.t === 'call_answer');
  await t2.next(f => f.t === 'call_taken' && f.call === call);
  t2.send({ t: 'call_answer', call, sdp: 'two' });   // the slower tab cannot answer a second time
  ca.send({ t: 'call_ice', call, candidate: { candidate: 'c' } });
  await t1.next(f => f.t === 'call_ice');
  await t2.quiet(f => f.t === 'call_ice');
  assert.equal(ca.frames.filter(f => f.t === 'call_answer').length, 1);
  // closing the tab that did not answer does not end the call
  t2.ws.close();
  await ca.quiet(f => f.t === 'call_end');
  ca.ws.close(); t1.ws.close();
});

test('who may call: strangers, groups and family circles are refused', async () => {
  const { a, b, circle } = await pair();
  const tag = String(Date.now()).slice(-7);
  const e = await login(`+9665${tag}9`, 'غريب');
  const ce = await connect(e);
  const ca = await connect(a.cookie), cb = await connect(b.cookie);
  ce.send({ t: 'call_offer', call: callIdOf(), circle, sdp: SDP });
  assert.equal((await ce.next(f => f.t === 'call_end')).reason, 'not_allowed');
  await cb.quiet(f => f.t === 'call_incoming');
  const { json: g } = await api('/api/circles', a.cookie, { name: 'عائلة' });
  const { json: inv } = await api(`/api/circles/${g.id}`, a.cookie);
  await api('/api/circles/join', b.cookie, { code: inv.inviteCode });
  ca.send({ t: 'call_offer', call: callIdOf(), circle: g.id, sdp: SDP });
  assert.equal((await ca.next(f => f.t === 'call_end')).reason, 'not_allowed');
  await cb.quiet(f => f.t === 'call_incoming');
  ca.send({ t: 'call_offer', call: 'x', circle, sdp: SDP });            // an id that is too short
  ca.send({ t: 'call_offer', call: callIdOf(), circle, sdp: 'z'.repeat(20000) });   // an SDP that is too big
  ca.send({ t: 'call_offer', call: callIdOf(), circle: 'abc', sdp: SDP });
  await cb.quiet(f => f.t === 'call_incoming');
  assert.ok(ca.frames.filter(f => f.t === 'call_end' && f.reason === 'bad_request').length >= 2);
  ca.ws.close(); cb.ws.close(); ce.ws.close();
});

test('a block in either direction refuses the call', async () => {
  const { a, b, circle } = await pair();
  const ca = await connect(a.cookie), cb = await connect(b.cookie);
  await api(`/api/users/${b.id}/block`, a.cookie, { on: true });
  ca.send({ t: 'call_offer', call: callIdOf(), circle, sdp: SDP });
  assert.equal((await ca.next(f => f.t === 'call_end')).reason, 'blocked');
  cb.send({ t: 'call_offer', call: callIdOf(), circle, sdp: SDP });
  assert.equal((await cb.next(f => f.t === 'call_end')).reason, 'blocked');
  assert.equal(notices(circle).filter(x => x.k.startsWith('call')).length, 0, 'a refused call leaves no record');
  await api(`/api/users/${b.id}/block`, a.cookie, { on: false });
  ca.ws.close(); cb.ws.close();
});

test('a frozen chat cannot be used for a call', async () => {
  const { a, b, circle } = await pair();
  const ca = await connect(a.cookie), cb = await connect(b.cookie);
  run("UPDATE circles SET frozen_at = datetime('now') WHERE id = ?", circle);
  ca.send({ t: 'call_offer', call: callIdOf(), circle, sdp: SDP });
  assert.equal((await ca.next(f => f.t === 'call_end')).reason, 'frozen');
  await cb.quiet(f => f.t === 'call_incoming');
  run('UPDATE circles SET frozen_at = NULL WHERE id = ?', circle);
  ca.ws.close(); cb.ws.close();
});

test('at most 10 call attempts per person in 10 minutes', async () => {
  const { a, b, circle } = await pair();
  const ca = await connect(a.cookie), cb = await connect(b.cookie);
  for (let i = 0; i < 10; i++) {
    const call = callIdOf();
    ca.send({ t: 'call_offer', call, circle, sdp: SDP });
    await cb.next(f => f.t === 'call_incoming' && f.call === call);
    ca.send({ t: 'call_end', call });
    await cb.next(f => f.t === 'call_end' && f.call === call);
  }
  ca.send({ t: 'call_offer', call: callIdOf(), circle, sdp: SDP });
  assert.equal((await ca.next(f => f.t === 'call_end' && f.reason === 'rate_limited')).reason, 'rate_limited');
  ca.ws.close(); cb.ws.close();
});

test('GET /api/calls/ice: STUN only without a relay; with one, short-lived TURN credentials by the standard scheme', async () => {
  const { a } = await pair();
  assert.equal((await app.request('/api/calls/ice')).status, 401);
  const plain = await api('/api/calls/ice', a.cookie);
  assert.equal(plain.status, 200);
  assert.equal(plain.json.turn, false);
  assert.ok(plain.json.iceServers.length >= 1 && plain.json.iceServers.every((s: any) => [].concat(s.urls).every((u: string) => u.startsWith('stun:')) && !s.credential));
  process.env.THIKRA_TURN_URLS = 'turn:turn.example.com:3478?transport=udp, turns:turn.example.com:443?transport=tcp';
  process.env.THIKRA_TURN_SECRET = 'shared-secret-for-test';
  process.env.THIKRA_TURN_TTL = '600';
  try {
    const before = Math.floor(Date.now() / 1000);
    const r = await api('/api/calls/ice', a.cookie);
    assert.equal(r.json.turn, true); assert.equal(r.json.ttl, 600);
    const t = r.json.iceServers.find((s: any) => s.credential);
    assert.deepEqual(t.urls, ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:443?transport=tcp']);
    const [expiry, uid] = t.username.split(':');
    assert.ok(Number(expiry) >= before + 600 && Number(expiry) <= before + 602);
    assert.equal(uid, String((await api('/api/me', a.cookie)).json.id));
    assert.equal(t.credential, createHmac('sha1', 'shared-secret-for-test').update(t.username).digest('base64'));
    assert.equal(JSON.stringify(r.json).includes('shared-secret-for-test'), false, 'the secret never leaves the server');
  } finally { delete process.env.THIKRA_TURN_URLS; delete process.env.THIKRA_TURN_SECRET; delete process.env.THIKRA_TURN_TTL; }
  let last = 200;
  for (let i = 0; i < 31 && last === 200; i++) last = (await api('/api/calls/ice', a.cookie)).status;
  assert.equal(last, 429, 'rate limited');
});

test('review: a tab that lost the race to answer cannot end the winner\'s call', async () => {
  const { a, b, circle } = await pair();
  const ca = await connect(a.cookie), t1 = await connect(b.cookie), t2 = await connect(b.cookie);
  const call = callIdOf();
  ca.send({ t: 'call_offer', call, circle, sdp: SDP });
  await t1.next(f => f.t === 'call_incoming'); await t2.next(f => f.t === 'call_incoming');
  t1.send({ t: 'call_answer', call, sdp: 'one' });
  await ca.next(f => f.t === 'call_answer');
  t2.send({ t: 'call_answer', call, sdp: 'two' });
  await t2.next(f => f.t === 'call_taken' && f.call === 2 || f.t === 'call_taken');   // the loser is told even if it answered at the same moment
  t2.send({ t: 'call_end', call, reason: 'failed' });
  await ca.quiet(f => f.t === 'call_end');
  ca.send({ t: 'call_end', call }); ca.ws.close(); t1.ws.close(); t2.ws.close();
});

test('review: when the callee\'s last page closes while it rings, the call ends and nobody stays busy', async () => {
  const { a, b, circle } = await pair();
  const ca = await connect(a.cookie), cb = await connect(b.cookie);
  const call = callIdOf();
  ca.send({ t: 'call_offer', call, circle, sdp: SDP });
  await cb.next(f => f.t === 'call_incoming');
  cb.ws.terminate();
  assert.equal((await ca.next(f => f.t === 'call_end')).reason, 'offline');
  const cb2 = await connect(b.cookie);   // the callee is free again
  ca.send({ t: 'call_offer', call: callIdOf(), circle, sdp: SDP });
  await cb2.next(f => f.t === 'call_incoming');
  ca.ws.close(); cb2.ws.close();
});
