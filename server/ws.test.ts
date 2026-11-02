process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const { app, startServer } = await import('./index.ts');
const { all } = await import('./db.ts');

const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
after(() => { server.close(); server.closeAllConnections?.(); });

async function login(phone: string, name: string) {
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  return res.headers.get('set-cookie')!.split(';')[0];
}
const api = async (path: string, cookie: string, body?: unknown) => {
  const res = await app.request(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() as any };
};

/** A client socket that records every frame and lets a test wait for one. */
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
      await new Promise<void>(r => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return { ws, frames, next, send: (o: unknown) => ws.send(JSON.stringify(o)) };
}

async function family() {
  const tag = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
  const a = await login(`+9665${tag}1`, 'ناصر');
  const b = await login(`+9665${tag}2`, 'سارة');
  const { json: c } = await api('/api/circles', a, { name: 'عائلة' });
  const { json: inv } = await api(`/api/circles/${c.id}`, a);
  await api('/api/circles/join', b, { code: inv.inviteCode });
  return { a, b, circle: c.id as number };
}

test('a connection without a session is refused', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const err = await new Promise<Error>(r => ws.once('error', r));
  assert.match(err.message, /401/);
});

test('a sent message is acknowledged with its seq and pushed live to the other member', async () => {
  const { a, b, circle } = await family();
  const sender = await connect(a);
  const receiver = await connect(b);
  sender.send({ t: 'send', circle, client_msg_id: 'c1', body: 'مرحبا' });
  const ack = await sender.next(f => f.t === 'ack');
  assert.equal(ack.client_msg_id, 'c1');
  assert.equal(ack.duplicate, false);
  const pushed = await receiver.next(f => f.t === 'msg');
  assert.equal(pushed.m.body, 'مرحبا');
  assert.equal(pushed.m.seq, ack.seq);
  sender.ws.close(); receiver.ws.close();
});

test('I3: retrying the same client_msg_id creates one message, not two', async () => {
  const { a, circle } = await family();
  const c = await connect(a);
  for (let i = 0; i < 3; i++) c.send({ t: 'send', circle, client_msg_id: 'same', body: 'مرة واحدة' });
  await new Promise(r => setTimeout(r, 300));
  const acks = c.frames.filter(f => f.t === 'ack');
  assert.equal(acks.length, 3);
  assert.equal(new Set(acks.map(f => f.id)).size, 1);
  assert.equal(acks.filter(f => f.duplicate).length, 2);
  assert.equal(all("SELECT id FROM messages WHERE circle_id = ? AND kind = 'text'", circle).length, 1);
  // the HTTP route shares the same dedupe
  const http = await api(`/api/circles/${circle}/messages`, a, { body: 'مرة واحدة', client_msg_id: 'same' });
  assert.equal(http.status, 200);
  assert.equal(http.json.id, acks[0].id);
  c.ws.close();
});

test('I1+I2: seq is unique, gap-free and strictly increasing per circle, even with concurrent senders on both transports', async () => {
  const { a, b, circle } = await family();
  const ca = await connect(a), cb = await connect(b);
  const N = 30;
  await Promise.all([
    ...Array.from({ length: N }, (_, i) => ca.send({ t: 'send', circle, client_msg_id: `a${i}`, body: `a${i}` })),
    ...Array.from({ length: N }, (_, i) => cb.send({ t: 'send', circle, client_msg_id: `b${i}`, body: `b${i}` })),
    ...Array.from({ length: N }, (_, i) => api(`/api/circles/${circle}/messages`, a, { body: `h${i}`, client_msg_id: `h${i}` })),
  ]);
  await ca.next(f => f.t === 'ack' && f.client_msg_id === `a${N - 1}`);
  await cb.next(f => f.t === 'ack' && f.client_msg_id === `b${N - 1}`);
  await new Promise(r => setTimeout(r, 200));
  const seqs = all("SELECT seq FROM messages WHERE circle_id = ? AND kind = 'text' ORDER BY seq", circle).map(r => r.seq);
  assert.equal(seqs.length, N * 3);
  // the circle also has system messages (joins); the sequence over ALL messages must be 1..n
  const every = all('SELECT seq FROM messages WHERE circle_id = ? ORDER BY seq', circle).map(r => r.seq);
  assert.deepEqual(every, every.map((_, i) => i + 1));
  ca.ws.close(); cb.ws.close();
});

test('sync returns what was missed, by seq, and nothing from circles you are not in', async () => {
  const { a, b, circle } = await family();
  const other = await family();
  for (let i = 0; i < 5; i++) await api(`/api/circles/${circle}/messages`, a, { body: `m${i}` });
  const c = await connect(b);
  c.send({ t: 'sync', circle, after_seq: 0 });
  const all1 = await c.next(f => f.t === 'sync' && f.circle === circle);
  const last = all1.messages.at(-1).seq;
  await api(`/api/circles/${circle}/messages`, a, { body: 'late' });
  c.send({ t: 'sync', circle, after_seq: last });
  const delta = await c.next(f => f.t === 'sync' && f.messages.some((m: any) => m.body === 'late'));
  assert.equal(delta.messages.length, 1);
  c.send({ t: 'sync', circle: other.circle, after_seq: 0 });
  assert.equal((await c.next(f => f.t === 'err')).error, 'not_found');
  c.ws.close();
});

test('an outsider socket never receives a circle\'s messages', async () => {
  const { a, circle } = await family();
  const outsider = await connect(await login('+966500999001', 'غريب'));
  outsider.send({ t: 'join', circle });
  await api(`/api/circles/${circle}/messages`, a, { body: 'سر' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(outsider.frames.filter(f => f.t === 'msg').length, 0);
  outsider.ws.close();
});

test('deleting for everyone pokes connected clients', async () => {
  const { a, b, circle } = await family();
  const c = await connect(b);
  const { json } = await api(`/api/circles/${circle}/messages`, a, { body: 'x' });
  await c.next(f => f.t === 'msg');
  const res = await app.request(`/api/messages/${json.id}`, { method: 'DELETE', headers: { cookie: a } });
  assert.equal(res.status, 200);
  await c.next(f => f.t === 'changed');
  c.ws.close();
});

test('regression (network seed 707933): a retry of a stored message is never refused by the rate limit', async () => {
  const { a, circle } = await family();
  const c = await connect(a);
  c.send({ t: 'send', circle, client_msg_id: 'keep', body: 'first' });
  const first = await c.next(f => f.t === 'ack' && f.client_msg_id === 'keep');
  for (let i = 0; i < 125; i++) c.send({ t: 'send', circle, client_msg_id: `fill${i}`, body: `f${i}` });
  await c.next(f => f.t === 'err' && f.error === 'rate_limited'); // the limit is really exhausted
  c.send({ t: 'send', circle, client_msg_id: 'keep', body: 'first' });
  await new Promise(r => setTimeout(r, 300));
  const again = c.frames.filter(f => f.t === 'ack' && f.client_msg_id === 'keep');
  assert.equal(again.length, 2, 'the retry was refused');
  assert.equal(again[1].duplicate, true);
  assert.equal(again[1].seq, first.seq);
  c.ws.close();
});

test('regression (found by the crash test): a client that missed more than one page catches up from the start, in order, with no hole', async () => {
  const { a, b, circle } = await family();
  for (let i = 0; i < 450; i++) await api(`/api/circles/${circle}/messages`, a, { body: `bulk ${i}` });
  const c = await connect(b);
  const got: number[] = [];
  let after = 0;
  for (let round = 0; round < 10; round++) {
    const before = c.frames.length;
    c.send({ t: 'sync', circle, after_seq: after });
    const f = await c.next(x => x.t === 'sync' && c.frames.indexOf(x) >= before);
    got.push(...f.messages.map((m: any) => m.seq));
    after = got.length ? got[got.length - 1] : after;
    if (!f.more) break;
  }
  assert.ok(got.length >= 450, `only ${got.length} messages arrived`);
  assert.deepEqual(got, got.map((_, i) => i + 1), 'the pages must be the oldest first with no gap');
  c.ws.close();
});
