process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-voice-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { one } = await import('./db.ts');

const json = async (cookie: string | undefined, path: string, body: unknown) =>
  (await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
let n = 0;
async function signUp(name: string) {
  const phone = `+9665${String(5_000_000 + n++).padStart(8, '0')}`;
  const code = (await (await json(undefined, '/api/auth/request', { phone })).json() as any).devCode;
  const v = await json(undefined, '/api/auth/verify', { phone, code, name });
  return v.headers.get('set-cookie')!.split(';')[0];
}
await signUp('first');

const voice = (cookie: string, circle: number, type: string, bytes = 2048) => {
  const form = new FormData();
  form.append('audio', new File([new Uint8Array(bytes).fill(7)], 'voice.m4a', { type }));
  form.append('duration', '2500');
  return app.request(`/api/circles/${circle}/voice`, { method: 'POST', headers: { cookie }, body: form });
};

test('a voice note from an iPhone (audio/x-m4a) is accepted and stored as audio/mp4', async () => {
  const me = await signUp('me');
  const circle = (await (await json(me, '/api/circles', { name: 'Family' })).json() as any).id;
  const r = await voice(me, circle, 'audio/x-m4a');
  assert.equal(r.status, 201);
  const id = (await r.json() as any).id;
  assert.equal(one('SELECT mime FROM media WHERE message_id = ?', id)!.mime, 'audio/mp4');
});

test('a type that is not audio is still refused', async () => {
  const me = await signUp('me2');
  const circle = (await (await json(me, '/api/circles', { name: 'Family' })).json() as any).id;
  assert.equal((await voice(me, circle, 'image/png')).status, 400);
  assert.equal((await voice(me, circle, 'audio/x-m4a', 0)).status, 400);
});

test('a voice note plays on an iPhone: byte ranges are answered, and the session may come in x-thikra-session', async () => {
  const me = await signUp('player');
  const circle = (await (await json(me, '/api/circles', { name: 'Family' })).json() as any).id;
  const id = (await (await voice(me, circle, 'audio/x-m4a', 4096)).json() as any).id;

  // iOS's player first asks for two bytes, then the rest in ranges.
  const r = await app.request(`/api/messages/${id}/audio`, { headers: { cookie: me, range: 'bytes=0-1' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 0-1/4096');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('content-type'), 'audio/mp4');
  assert.equal((await r.arrayBuffer()).byteLength, 2);

  // The same session in its own header (what the phone's media player sends).
  const token = me.slice(me.indexOf('=') + 1);
  assert.equal((await app.request(`/api/messages/${id}/audio`, { headers: { 'x-thikra-session': token } })).status, 200);
  assert.equal((await app.request(`/api/messages/${id}/audio`, { headers: { 'x-thikra-session': 'nope' } })).status, 401);
});

test('a stale cookie (iOS swaps in its own) does not shut out a valid session in x-thikra-session', async () => {
  const me = await signUp('stale');
  const token = me.slice(me.indexOf('=') + 1);
  const r = await app.request('/api/me', { headers: { cookie: 'thikra_session=an-old-session-ios-kept', 'x-thikra-session': token } });
  assert.equal(r.status, 200);
  assert.equal((await app.request('/api/me', { headers: { cookie: 'thikra_session=an-old-session-ios-kept' } })).status, 401);
});
