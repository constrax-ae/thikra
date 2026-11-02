// F-07: the live path under a bad network. A real server, a real WebSocket client with the app's reconnect-and-sync
// behaviour, and a TCP proxy in between that adds latency and cuts connections at random.
// What must hold: every message a client sent exists exactly once (retries are safe), nothing acknowledged is lost,
// and the receiving client ends with exactly the server's messages in seq order, however often the link broke.
//   THIKRA_NET_SEED=<n> to replay · THIKRA_NET_MS=<ms> to lengthen the run (default 6000)

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import net from 'node:net';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Timeline } from '../core/timeline.ts';

const { app, startServer } = await import('./index.ts');
const { all } = await import('./db.ts');

const server = startServer(0);
await new Promise(r => server.once('listening', r));
const serverPort = (server.address() as { port: number }).port;

const seed = Number(process.env.THIKRA_NET_SEED ?? Date.now() % 1_000_000);
let a = seed >>> 0;
const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- the bad network: latency on every chunk, and random connection cuts ----------------------------------------
const sockets = new Set<net.Socket>();
const proxy = net.createServer(client => {
  const upstream = net.connect(serverPort, '127.0.0.1');
  sockets.add(client); sockets.add(upstream);
  // Latency, but bytes still arrive in order (as on real TCP): each chunk is released no earlier than the one before it.
  const lag = (to: net.Socket) => {
    let releaseAt = 0;
    return (chunk: Buffer) => {
      releaseAt = Math.max(releaseAt, Date.now() + 20 + rnd() * 120);
      setTimeout(() => { if (!to.destroyed) to.write(chunk); }, releaseAt - Date.now());
    };
  };
  client.on('data', lag(upstream)); upstream.on('data', lag(client));
  const drop = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
  client.on('close', drop); upstream.on('close', drop); client.on('error', drop); upstream.on('error', drop);
});
await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
const proxyPort = (proxy.address() as net.AddressInfo).port;
const cutSomething = () => { const all = [...sockets]; if (all.length) all[Math.floor(rnd() * all.length)].destroy(); };

after(() => { proxy.close(); for (const s of sockets) s.destroy(); server.close(); server.closeAllConnections?.(); });

async function login(phone: string, name: string) {
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  return res.headers.get('set-cookie')!.split(';')[0];
}

/** Behaves like web/src/live.ts + CircleView: reconnect with backoff, resend unacknowledged sends, sync from the contiguous prefix. */
class Client {
  timeline = new Timeline<any>();
  acked = new Map<string, { id: number; seq: number }>();
  pending = new Map<string, string>(); // client_msg_id -> body, until acked
  connects = 0;
  private ws?: WebSocket;
  private stopped = false;
  constructor(private cookie: string, private circle: number) { this.connect(); }

  private connect() {
    if (this.stopped) return;
    const ws = this.ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws`, { headers: { cookie: this.cookie } });
    ws.on('open', () => {
      this.connects++;
      ws.send(JSON.stringify({ t: 'sync', circle: this.circle, after_rev: this.timeline.syncedRev }));
      for (const [cid, body] of this.pending) ws.send(JSON.stringify({ t: 'send', circle: this.circle, client_msg_id: cid, body }));
    });
    ws.on('message', d => {
      const f = JSON.parse(String(d));
      if (f.t === 'msg' || f.t === 'update') { this.timeline.add(f.m); if (this.timeline.hasGap) this.sync(); }
      else if (f.t === 'sync') { if (this.timeline.applySync(f.messages, 200)) this.sync(); }
      else if (f.t === 'ack') { this.acked.set(f.client_msg_id, { id: f.id, seq: f.seq }); this.pending.delete(f.client_msg_id); }
    });
    const again = () => { if (!this.stopped) setTimeout(() => this.connect(), 100 + rnd() * 200); };
    ws.on('close', again); ws.on('error', () => ws.terminate());
  }
  sync() { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'sync', circle: this.circle, after_rev: this.timeline.syncedRev })); }
  send(cid: string, body: string) {
    this.pending.set(cid, body);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'send', circle: this.circle, client_msg_id: cid, body }));
  }
  stop() { this.stopped = true; this.ws?.terminate(); }
}

test(`bad network: latency + random cuts, nothing lost or duplicated (seed ${seed})`, async () => {
  const tag = String(Math.floor(rnd() * 1e7)).padStart(7, '0');
  const ownerCookie = await login(`+9665${tag}1`, 'A');
  const otherCookie = await login(`+9665${tag}2`, 'B');
  const created = await (await app.request('/api/circles', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ownerCookie }, body: JSON.stringify({ name: 'net' }) })).json() as any;
  const detail = await (await app.request(`/api/circles/${created.id}`, { headers: { cookie: ownerCookie } })).json() as any;
  await app.request('/api/circles/join', { method: 'POST', headers: { 'content-type': 'application/json', cookie: otherCookie }, body: JSON.stringify({ code: detail.inviteCode }) });
  const circle = created.id as number;

  const sender = new Client(ownerCookie, circle);
  const receiver = new Client(otherCookie, circle);
  const RUN_MS = Number(process.env.THIKRA_NET_MS ?? 6000);
  const end = Date.now() + RUN_MS;
  let n = 0;
  console.log(`  network seed ${seed}, ${RUN_MS} ms (replay with THIKRA_NET_SEED=${seed})`);
  while (Date.now() < end) {
    sender.send(`n${n}`, `message ${n}`); n++;
    if (rnd() < 0.25) cutSomething();
    // Short runs send in a burst (~100 messages); long runs stay under the server's 120/min send limit, which is not what is being tested.
    await sleep(RUN_MS > 8000 ? 550 + rnd() * 200 : 20 + rnd() * 80);
  }

  // The network heals: give both clients time to reconnect, resend and sync.
  const settled = async () => {
    const total = all("SELECT COUNT(*) AS n FROM messages WHERE circle_id = ? AND kind = 'text'", circle)[0].n as number;
    return sender.pending.size === 0 && total === n && receiver.timeline.contiguous === all('SELECT MAX(seq) AS m FROM messages WHERE circle_id = ?', circle)[0].m;
  };
  for (let i = 0; i < 100 && !(await settled()); i++) await sleep(100);

  sender.stop(); receiver.stop(); // stop reconnecting whatever the verdict, or the process never exits
  const rows = all("SELECT id, seq, client_msg_id FROM messages WHERE circle_id = ? ORDER BY seq", circle);
  const texts = rows.filter(r => r.client_msg_id);
  assert.equal(sender.pending.size, 0, 'some sends were never acknowledged');
  assert.equal(texts.length, n, `expected exactly ${n} messages, the server has ${texts.length} (lost or duplicated)`);
  assert.equal(new Set(texts.map(r => r.client_msg_id)).size, n, 'a client_msg_id was stored twice');
  assert.deepEqual(rows.map(r => r.seq), rows.map((_, i) => i + 1), 'seq is not 1..n');
  for (const [cid, p] of sender.acked) assert.equal(rows.find(r => r.client_msg_id === cid)?.seq, p.seq, `ack for ${cid} disagrees with the server`);
  assert.deepEqual(receiver.timeline.ordered.map(m => m.seq), rows.map(r => r.seq), 'the receiver did not converge to the server order');
  console.log(`  ${n} messages sent, ${sender.connects + receiver.connects} connections made, all converged`);
  assert.ok(sender.connects + receiver.connects > 4, 'the proxy never cut a connection, so the test proved nothing');
});
