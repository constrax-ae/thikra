process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-handoff-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');

const call = async (cookie: string | undefined, path: string, body?: unknown) => {
  const res = await app.request(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
};
let n = 0;
async function signUp(name: string) {
  const phone = `+9665${String(4_000_000 + n++).padStart(8, '0')}`;
  const code = (await call(undefined, '/api/auth/request', { phone })).json.devCode;
  const v = await app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code, name }) });
  return v.headers.get('set-cookie')!.split(';')[0];
}
await signUp('first');   // the first person becomes the owner in development: keep that out of the way

test('the phone app opens the family story in the browser through a one-time handoff link', async () => {
  const me = await signUp('me');
  const circle = (await call(me, '/api/circles', { name: 'Family' })).json.id;

  // The browser has no session of its own: the book refuses it directly.
  assert.equal((await app.request(`/api/circles/${circle}/book?year=2026`)).status, 401);

  const link = (await call(me, `/api/circles/${circle}/book-link`, { year: 2026, lang: 'en' })).json.url as string;
  assert.match(link, /^\/api\/auth\/handoff\/[a-f0-9]{48}$/);

  // Opening it gives the browser its own session and sends it to the book…
  const r = await app.request(link);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/api/circles/${circle}/book?year=2026&lang=en`);
  const browser = r.headers.get('set-cookie')!.split(';')[0];
  const book = await app.request(r.headers.get('location')!, { headers: { cookie: browser } });
  assert.equal(book.status, 200);
  assert.match(await book.text(), /<!doctype html>/i);

  // …once only.
  assert.equal((await app.request(link)).status, 410);
});

test('a handoff link is only issued for a circle the person belongs to', async () => {
  const owner = await signUp('owner'), stranger = await signUp('stranger');
  const circle = (await call(owner, '/api/circles', { name: 'Theirs' })).json.id;
  assert.equal((await call(stranger, `/api/circles/${circle}/book-link`, { year: 2026 })).status, 404);
  assert.equal((await call(undefined, `/api/circles/${circle}/book-link`, { year: 2026 })).status, 401);
  assert.equal((await app.request('/api/auth/handoff/not-a-token')).status, 400);
});
