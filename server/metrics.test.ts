process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));
process.env.THIKRA_LOG = '1'; // turn the log on so the test can read it

import { test } from 'node:test';
import assert from 'node:assert/strict';

const logged: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };

const { app } = await import('./index.ts');

const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as object) } });

async function login(phone: string, name: string) {
  const { devCode } = await (await call('/api/auth/request', { method: 'POST', body: JSON.stringify({ phone }) })).json() as any;
  const res = await call('/api/auth/verify', { method: 'POST', body: JSON.stringify({ phone, code: devCode, name }) });
  return res.headers.get('set-cookie')!.split(';')[0];
}

test('/healthz is public and carries no data', async () => {
  const res = await call('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('every response carries a request id, and a supplied one is echoed back', async () => {
  const a = await call('/healthz');
  assert.match(a.headers.get('x-request-id') ?? '', /^[0-9a-f]{12}$/);
  const b = await call('/healthz', { headers: { 'x-request-id': 'bug-report-42' } });
  assert.equal(b.headers.get('x-request-id'), 'bug-report-42');
});

test('metrics: admin-only, shows timings and counters, and never any message content', async () => {
  const admin = await login('+966501230001', 'مشرف');   // the first user of a fresh database is the platform admin
  const member = await login('+966501230002', 'عضو');
  const { id } = await (await call('/api/circles', { method: 'POST', cookie: admin, body: JSON.stringify({ name: 'دائرة' }) })).json() as any;

  const secret = 'سر-العائلة-لا-يخرج-أبداً-9137';
  for (let i = 0; i < 5; i++) await call(`/api/circles/${id}/messages`, { method: 'POST', cookie: admin, body: JSON.stringify({ body: `${secret} ${i}`, client_msg_id: `m${i}` }) });
  await call(`/api/circles/${id}/messages`, { method: 'POST', cookie: admin, body: JSON.stringify({ body: secret, client_msg_id: 'm0' }) }); // a retry

  assert.equal((await call('/api/admin/metrics')).status, 401);
  assert.equal((await call('/api/admin/metrics', { cookie: member })).status, 403);

  const res = await call('/api/admin/metrics', { cookie: admin });
  assert.equal(res.status, 200);
  const text = await res.text();
  const m = JSON.parse(text);
  assert.ok(m.counters.send_ok >= 5, 'sends are counted');
  assert.ok(m.counters.send_duplicate >= 1, 'a retry is counted as a duplicate');
  for (const k of ['store_ms', 'fanout_ms', 'http_ms']) {
    assert.ok(m.latency[k].n > 0, `${k} has samples`);
    assert.ok(m.latency[k].p95 >= m.latency[k].p50, `${k} percentiles are ordered`);
  }
  assert.equal(typeof m.gauges.connections, 'number');

  // Privacy: neither the metrics nor a single log line may contain message text, phone numbers or names.
  // (The dev-only `[otp]` console line is a known prototype hole listed in THREAT-MODEL §4, not part of the structured log.)
  const structured = logged.filter(l => l.startsWith('{'));
  const everything = text + '\n' + structured.join('\n');
  for (const forbidden of [secret, '+966501230001', '966501230002', 'مشرف']) {
    assert.ok(!everything.includes(forbidden), `"${forbidden}" leaked into metrics or logs`);
  }
  assert.ok(logged.some(l => l.includes('"event":"msg"') && l.includes('"seq"')), 'a per-message trace line is logged');
  assert.ok(logged.some(l => l.includes('"event":"http"') && l.includes('/api/circles/:id/messages')), 'access log uses the route pattern, not the raw URL');
  console.log = realLog;
});
