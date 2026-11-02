// T-04 / invariant I4: "an acknowledged message is never lost", proven by really killing the server.
// A real server process on a real database file is SIGKILLed in the middle of a burst of sends, restarted on the same
// file, and checked: every message that was acknowledged before the kill must still exist with the same seq, a retry of
// any message (acknowledged or not) must not create a second copy, and seq must be gap-free afterwards.
//   THIKRA_CRASH_ROUNDS=<n> (default 4)

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'thikra-crash-'));
const port = 19000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ROUNDS = Number(process.env.THIKRA_CRASH_ROUNDS ?? 4);

const logFd = openSync(join(dir, 'server.log'), 'a');
let child: ChildProcess | undefined;
async function start() {
  child = spawn('node', ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), THIKRA_DB: join(dir, 'crash.db'), THIKRA_BLOBS: join(dir, 'blobs') },
    stdio: ['ignore', logFd, logFd],
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('the server did not start');
}
const kill = async () => { child!.kill('SIGKILL'); await new Promise(r => child!.once('exit', r)); };

async function api(cookie: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { res, json: await res.json().catch(() => null) };
}

/** Everything in the circle, paged by seq exactly as a client syncs. */
async function everything(cookie: string, circle: number) {
  const out: any[] = [];
  for (;;) {
    const { json } = await api(cookie, `/circles/${circle}/messages?after_seq=${out.at(-1)?.seq ?? 0}`);
    out.push(...json);
    if (json.length < 200) return out;
  }
}

test(`I4: acknowledged messages survive SIGKILL (${ROUNDS} rounds)`, async () => {
  await start();
  try {
    const phone = `+9665${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const { json: otp } = await api('', '/auth/request', { phone });
    const { res: v } = await api('', '/auth/verify', { phone, code: otp.devCode, name: 'Crash' });
    const cookie = v.headers.get('set-cookie')!.split(';')[0];
    const { json: circle } = await api(cookie, '/circles', { name: 'crash' });

    const acked = new Map<string, { id: number; seq: number }>();
    const everSent = new Set<string>();
    let killsDuringSend = 0;

    for (let round = 0; round < ROUNDS; round++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
      await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
      ws.on('error', () => {});
      ws.on('message', d => { const f = JSON.parse(String(d)); if (f.t === 'ack') acked.set(f.client_msg_id, { id: f.id, seq: f.seq }); });

      // A burst of sends; the kill lands at a random moment inside it.
      const killAt = 40 + Math.random() * 260;
      const t0 = Date.now();
      let i = 0;
      const sender = setInterval(() => {
        for (let k = 0; k < 5; k++) {
          const cid = `r${round}-${i++}`;
          everSent.add(cid);
          try { ws.send(JSON.stringify({ t: 'send', circle: circle.id, client_msg_id: cid, body: cid })); } catch { /* socket closing */ }
        }
      }, 5);
      await sleep(killAt);
      if (Date.now() - t0 < 2000) killsDuringSend++;
      await kill();
      clearInterval(sender);
      ws.terminate();

      await start();
      // 1. Everything acknowledged before the kill is still there, with the same seq.
      const all = await everything(cookie, circle.id);
      const bySeq = new Map<number, any>(all.map((m: any) => [m.seq, m]));
      for (const [cid, a] of acked) {
        const m = bySeq.get(a.seq);
        assert.ok(m && m.id === a.id && m.body === cid, `round ${round}: acknowledged ${cid} (seq ${a.seq}) was lost or changed after the crash`);
      }
      // 2. The client retries everything it ever sent (it cannot know which were stored): no copies, same seq for those that were.
      const before = all.filter((m: any) => m.kind === 'text').length;
      const ids = [...everSent];
      const retries: Awaited<ReturnType<typeof api>>[] = [];
      for (let k = 0; k < ids.length; k += 20) { // in small batches: hundreds of simultaneous connections is a different test
        retries.push(...await Promise.all(ids.slice(k, k + 20).map(cid => api(cookie, `/circles/${circle.id}/messages`, { body: cid, client_msg_id: cid }))));
      }
      for (const r of retries) assert.ok(r.res.status === 200 || r.res.status === 201, `retry failed with ${r.res.status}`);
      for (const [cid, a] of acked) {
        const r = retries[ids.indexOf(cid)];
        assert.equal(r.json.seq, a.seq, `round ${round}: retry of ${cid} got a different seq`);
        assert.equal(r.res.status, 200, 'a retry of a stored message must be recognised as a duplicate');
      }
      // 3. Totals: exactly one stored message per client id ever sent, and seq is 1..n.
      const after = await everything(cookie, circle.id);
      const texts = after.filter((m: any) => m.kind === 'text');
      assert.equal(texts.length, everSent.size, `round ${round}: ${texts.length} stored for ${everSent.size} client ids (lost or duplicated)`);
      assert.ok(texts.length >= before);
      assert.deepEqual(after.map((m: any) => m.seq), after.map((_: any, k: number) => k + 1), `round ${round}: seq is not 1..n`);
    }
    assert.ok(acked.size > 0, 'nothing was ever acknowledged, so the test proved nothing');
    assert.ok(killsDuringSend >= 1);
    console.log(`  ${ROUNDS} kills, ${everSent.size} messages sent, ${acked.size} acknowledged, none lost, none duplicated`);
  } catch (e) {
    console.log('--- server log ---\n' + readFileSync(join(dir, 'server.log'), 'utf8').slice(-1500));
    throw e;
  } finally {
    child?.kill('SIGKILL');
  }
});
