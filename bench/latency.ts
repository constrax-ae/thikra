// Measures how fast a message really gets from one person to another, against the targets in docs/MASTER-PLAN.md §6.
//
//   pnpm bench                       start a server here, measure the current design (clients poll every 3 s)
//   pnpm bench --mode ws             measure the live WebSocket gateway instead (receivers are pushed messages)
//   pnpm bench --poll-ms 1000        what the number would be if clients polled faster
//   pnpm bench --base-url http://host:8787   measure a server that is already running
//   pnpm bench --data-dir /some/folder        where the throwaway database goes (default: the system temp folder)
//
// What it measures, honestly: this runs on loopback, so network time is zero. It isolates the server's own cost and,
// above all, the DESIGN: how long a message waits before the receiver's client even asks for it. A real network only adds to these numbers.
// Two strategies on the same harness: `polling` (the old design) and `ws` (the gateway, server/ws.ts).

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const MODE = arg('mode', 'polling') as 'polling' | 'ws';
const POLL_MS = Number(arg('poll-ms', '3000'));
const RECEIVERS = Number(arg('receivers', '8'));
const DATA_DIR = arg('data-dir', tmpdir());
const SEND_EVERY_MS = 400;
const REQUESTS_PER_POLL = 2; // the web client asks for deletions, then for new messages, every cycle
const MESSAGES = 24;
const TARGET_DELIVERY_P95_MS = 300; // MASTER-PLAN §6
const TARGET_WRITE_P95_MS = 50;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
};
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: Math.max(...xs) });
const round = (v: number) => Math.round(v * 10) / 10;

// ---- server and users ---------------------------------------------------------------------------

async function startServer(): Promise<{ base: string; stop: () => void }> {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const dir = mkdtempSync(join(DATA_DIR, 'thikra-bench-'));
  const child: ChildProcess = spawn('node', ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), THIKRA_DB: join(dir, 'bench.db'), THIKRA_BLOBS: join(dir, 'blobs') },
    stdio: 'ignore',
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/me`)).status === 401) return { base, stop: () => child.kill() }; } catch { /* not up yet */ }
    await sleep(100);
  }
  child.kill();
  throw new Error('the server did not start');
}

async function api(base: string, cookie: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, json: await res.json().catch(() => null) };
}

async function signIn(base: string, phone: string, name: string) {
  const { json } = await api(base, '', '/auth/request', { phone });
  const { res } = await api(base, '', '/auth/verify', { phone, code: json.devCode, name });
  return res.headers.get('set-cookie')!.split(';')[0];
}

// ---- measurements -------------------------------------------------------------------------------

/** How long one write takes, one after another and then 20 at a time. */
async function writeLatency(base: string, cookie: string, circle: number) {
  const timed = async (i: number) => {
    const t = performance.now();
    await api(base, cookie, `/circles/${circle}/messages`, { body: `write ${i}` });
    return performance.now() - t;
  };
  const sequential: number[] = [];
  for (let i = 0; i < 150; i++) sequential.push(await timed(i));
  const concurrent: number[] = [];
  for (let round = 0; round < 10; round++) concurrent.push(...(await Promise.all(Array.from({ length: 20 }, (_, i) => timed(1000 + round * 20 + i)))));
  return { sequential: summary(sequential), concurrent20: summary(concurrent) };
}

/** Current design: every client asks the server for new messages every POLL_MS, each with its own phase. */
async function pollingDelivery(base: string, sender: string, receivers: string[], circle: number) {
  const sentAt = new Map<string, number>();
  const seen = new Map<string, number>(); // `${receiver}|${text}` -> when it first arrived
  let running = true;

  const pollers = receivers.map(async (cookie, r) => {
    await sleep(Math.random() * POLL_MS); // clients do not start in sync
    let last = 0;
    while (running) {
      await api(base, cookie, `/circles/${circle}/deletions`);
      const { json } = await api(base, cookie, `/circles/${circle}/messages?after=${last}`);
      const now = performance.now();
      for (const m of json ?? []) {
        last = Math.max(last, m.id);
        const key = `${r}|${m.body}`;
        if (m.kind === 'text' && !seen.has(key)) seen.set(key, now);
      }
      await sleep(POLL_MS);
    }
  });

  for (let i = 0; i < MESSAGES; i++) {
    const text = `delivery ${i}`;
    sentAt.set(text, performance.now());
    await api(base, sender, `/circles/${circle}/messages`, { body: text });
    await sleep(SEND_EVERY_MS);
  }
  await sleep(POLL_MS + 800); // let every client poll once more
  running = false;
  await Promise.race([Promise.all(pollers), sleep(POLL_MS + 500)]);

  const latencies: number[] = [];
  let missing = 0;
  for (const [text, t0] of sentAt) {
    for (let r = 0; r < receivers.length; r++) {
      const t1 = seen.get(`${r}|${text}`);
      if (t1 === undefined) missing++; else latencies.push(t1 - t0);
    }
  }
  return { ...summary(latencies), missing, requestsPerSecondPer1000IdleClients: Math.round((1000 / POLL_MS) * REQUESTS_PER_POLL * 1000) };
}

/** Gateway: receivers hold a socket and are pushed each message; the sender sends over its own socket and waits for the ack. */
async function wsDelivery(base: string, sender: string, receivers: string[], circle: number) {
  const url = base.replace(/^http/, 'ws') + '/ws';
  const open = (cookie: string) => new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(url, { headers: { cookie } });
    ws.once('open', () => res(ws)); ws.once('error', rej);
  });
  const seen = new Map<string, number>();
  const socks = await Promise.all(receivers.map(open));
  socks.forEach((ws, r) => ws.on('message', d => {
    const f = JSON.parse(String(d));
    if (f.t === 'msg' && f.m.kind === 'text') { const k = `${r}|${f.m.body}`; if (!seen.has(k)) seen.set(k, performance.now()); }
  }));
  const tx = await open(sender);
  const acks = new Map<string, number>();
  tx.on('message', d => { const f = JSON.parse(String(d)); if (f.t === 'ack') acks.set(f.client_msg_id, performance.now()); });

  const sentAt = new Map<string, number>();
  const ackLatency: number[] = [];
  for (let i = 0; i < MESSAGES; i++) {
    const text = `delivery ${i}`;
    sentAt.set(text, performance.now());
    tx.send(JSON.stringify({ t: 'send', circle, client_msg_id: `b${i}`, body: text }));
    await sleep(SEND_EVERY_MS);
  }
  await sleep(1000);
  for (let i = 0; i < MESSAGES; i++) { const a = acks.get(`b${i}`); if (a !== undefined) ackLatency.push(a - sentAt.get(`delivery ${i}`)!); }
  socks.forEach(s => s.close()); tx.close();

  const latencies: number[] = [];
  let missing = 0;
  for (const [text, t0] of sentAt) {
    for (let r = 0; r < receivers.length; r++) {
      const t1 = seen.get(`${r}|${text}`);
      if (t1 === undefined) missing++; else latencies.push(t1 - t0);
    }
  }
  // Idle: a ping every 25 s per client, nothing else.
  return { ...summary(latencies), missing, ack: summary(ackLatency), requestsPerSecondPer1000IdleClients: Math.round(1000 / 25) };
}

// ---- run ----------------------------------------------------------------------------------------

const external = arg('base-url', '');
const { base, stop } = external ? { base: external, stop: () => {} } : await startServer();
try {
  const seed = 100 + Math.floor(Math.random() * 800); // distinct phone numbers per run
  const sender = await signIn(base, `+9665${seed}00001`, 'Sender');
  const { json: created } = await api(base, sender, '/circles', { name: 'bench' });
  const circle = created.id as number;
  const { json: detail } = await api(base, sender, `/circles/${circle}`);
  const receivers: string[] = [];
  for (let i = 0; i < RECEIVERS; i++) {
    const cookie = await signIn(base, `+9665${seed}${String(i + 2).padStart(5, '0')}`, `Receiver ${i + 1}`);
    await api(base, cookie, '/circles/join', { code: detail.inviteCode });
    receivers.push(cookie);
  }

  console.log(`Thekra latency benchmark | ${external || 'local server'} | ${RECEIVERS} receivers | ${MODE === 'ws' ? 'live WebSocket gateway' : `clients poll every ${POLL_MS} ms`}\n`);
  const writes = await writeLatency(base, sender, circle);
  console.log('Writing a message (server cost only):');
  console.log(`  one at a time      p50 ${round(writes.sequential.p50)} ms | p95 ${round(writes.sequential.p95)} ms | p99 ${round(writes.sequential.p99)} ms`);
  console.log(`  20 at once         p50 ${round(writes.concurrent20.p50)} ms | p95 ${round(writes.concurrent20.p95)} ms | p99 ${round(writes.concurrent20.p99)} ms`);

  console.log(MODE === 'ws' ? '\nDelivery to the other person (pushed over the socket)...' : '\nDelivery to the other person (waiting for their client to ask), this takes about 15 s...');
  const delivery = MODE === 'ws' ? await wsDelivery(base, sender, receivers, circle) : await pollingDelivery(base, sender, receivers, circle);
  console.log(`  ${delivery.n} deliveries, ${delivery.missing} lost`);
  console.log(`  p50 ${round(delivery.p50)} ms | p95 ${round(delivery.p95)} ms | p99 ${round(delivery.p99)} ms | max ${round(delivery.max)} ms`);
  console.log(`  idle cost: ${delivery.requestsPerSecondPer1000IdleClients} ${MODE === 'ws' ? 'heartbeats' : 'requests'} per second for every 1000 online clients, doing nothing`);

  const checks = [
    { name: `write p95 <= ${TARGET_WRITE_P95_MS} ms`, ok: writes.sequential.p95 <= TARGET_WRITE_P95_MS },
    { name: `delivery p95 <= ${TARGET_DELIVERY_P95_MS} ms`, ok: delivery.p95 <= TARGET_DELIVERY_P95_MS },
    { name: 'no lost message', ok: delivery.missing === 0 },
  ];
  console.log('\nAgainst the targets in MASTER-PLAN §6:');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);

  const out = {
    date: new Date().toLocaleDateString('en-CA'), // local date, YYYY-MM-DD
    design: MODE === 'ws' ? 'websocket gateway' : `polling every ${POLL_MS} ms`,
    environment: { node: process.version, platform: `${process.platform}/${process.arch}`, sqlite: process.env.THIKRA_SQLITE === 'wasm' ? 'wasm' : 'node:sqlite', network: 'loopback (no real network)' },
    receivers: RECEIVERS,
    writes, delivery, checks,
  };
  mkdirSync('bench/results', { recursive: true });
  const file = `bench/results/${out.date}-${MODE === 'ws' ? 'websocket' : `polling-${POLL_MS}ms`}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nSaved ${file}`);
} finally {
  stop();
}
