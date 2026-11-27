// A second layer against cross-site request forgery (the session cookie is SameSite=Lax; this does not rely on that alone):
// a browser request that changes something, or opens the live socket, must come from this site's own address.
process.env.THIKRA_DEV = '1';
process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_PUBLIC_URL = 'https://tamtim.example.com/';
delete process.env.THIKRA_TRUST_PROXY;
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const { app, startServer } = await import('./index.ts');
const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
after(() => { server.close(); server.closeAllConnections?.(); });

const send = (path: string, o: { method?: string; origin?: string; cookie?: string; body?: unknown; host?: string; headers?: Record<string, string> } = {}) =>
  app.request(`http://${o.host ?? 'localhost:8787'}${path}`, {
    method: o.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(o.origin ? { origin: o.origin } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers },
    body: o.method === 'GET' ? undefined : JSON.stringify(o.body ?? {}),
  });

async function login(phone: string, name: string) {
  const { devCode } = await (await send('/api/auth/request', { body: { phone } })).json() as any;
  return (await send('/api/auth/verify', { body: { phone, code: devCode, name } })).headers.get('set-cookie')!.split(';')[0];
}

test('a state-changing request from another site is refused, even with a valid cookie', async () => {
  const cookie = await login('+966500071001', 'ناصر');
  for (const origin of ['https://evil.example', 'http://localhost:9999', 'null', 'https://tamtim.example.com.evil.example', 'not a url']) {
    const r = await send('/api/circles', { cookie, origin, body: { name: 'x' } });
    assert.equal(r.status, 403, origin); assert.equal((await r.json() as any).error, 'bad_origin', origin);
  }
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await send('/api/circles/1', { method, cookie, origin: 'https://evil.example' })).status, 403, method);
  assert.equal((await send('/api/circles', { method: 'GET', cookie })).status, 200);
  const all = await (await send('/api/circles', { method: 'GET', cookie })).json() as any[];
  assert.equal(all.length, 0, 'the refused request created nothing');
});

test('the same host, and the public address in THIKRA_PUBLIC_URL, are allowed; so is a request with no Origin', async () => {
  const cookie = await login('+966500071002', 'سارة');
  const ok = (r: Response) => r.status >= 200 && r.status < 300;
  assert.ok(ok(await send('/api/circles', { cookie, origin: 'http://localhost:8787', body: { name: 'a' } })), 'same host');
  assert.ok(ok(await send('/api/circles', { cookie, origin: 'https://tamtim.example.com', body: { name: 'b' } })), 'the configured public address (behind a proxy the Host differs)');
  assert.ok(ok(await send('/api/circles', { cookie, body: { name: 'c' } })), 'no Origin: the phone app and scripts do not send one; a browser always does for a cross-site POST');
  assert.equal((await send('/api/auth/request', { origin: 'https://evil.example', body: { phone: '+966500071003' } })).status, 403, 'even sign-in cannot be driven from another site');
});

test('the live socket refuses a browser page from another site, and accepts the same site or no Origin', async () => {
  const cookie = await login('+966500071004', 'خالد');
  const open = (origin?: string) => new Promise<string>(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, ...(origin ? { origin } : {}) } });
    ws.once('open', () => { ws.close(); res('open'); });
    ws.once('unexpected-response', (_q, r) => res(String(r.statusCode)));
    ws.once('error', () => res('error'));
  });
  assert.equal(await open('https://evil.example'), '403');
  assert.equal(await open(`http://127.0.0.1:${port}`), 'open');
  assert.equal(await open('https://tamtim.example.com'), 'open');
  assert.equal(await open(), 'open');
});
