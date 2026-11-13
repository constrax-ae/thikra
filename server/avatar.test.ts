process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-avatar-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { one } = await import('./db.ts');

const json = (cookie: string | undefined, path: string, body?: unknown, method?: string) =>
  app.request(path, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
let n = 0;
async function signUp(name: string) {
  const phone = `+9665${String(6_000_000 + n++).padStart(8, '0')}`;
  const code = (await (await json(undefined, '/api/auth/request', { phone })).json() as any).devCode;
  const v = await json(undefined, '/api/auth/verify', { phone, code, name });
  return { cookie: v.headers.get('set-cookie')!.split(';')[0], id: Number(one('SELECT id FROM users WHERE phone = ?', phone)!.id) };
}
await signUp('first');

// A real 1x1 PNG: the server decides what a file is from its bytes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const upload = (cookie: string, bytes: Buffer, name = 'me.png', type = 'image/png') => {
  const f = new FormData(); f.append('file', new File([new Uint8Array(bytes)], name, { type }));
  return app.request('/api/me/avatar', { method: 'POST', headers: { cookie }, body: f });
};

test('a profile picture: set by its owner, seen by family, not by strangers, and removable', async () => {
  const sara = await signUp('Sara'), ahmed = await signUp('Ahmed'), stranger = await signUp('Stranger');
  const circle = (await (await json(sara.cookie, '/api/circles', { name: 'Family' })).json() as any).id;
  const code = (await (await json(sara.cookie, `/api/circles/${circle}`)).json() as any).inviteCode;
  await json(ahmed.cookie, '/api/circles/join', { code });

  assert.equal((await upload(sara.cookie, PNG)).status, 200);
  const me = await (await json(sara.cookie, '/api/me')).json() as any;
  assert.ok(me.avatar_at, '/me says there is a picture, and when it was set');
  const members = (await (await json(ahmed.cookie, `/api/circles/${circle}`)).json() as any).members;
  assert.ok(members.find((m: any) => m.id === sara.id).avatarAt, 'members carry it, so the apps know to show it');

  const seen = await app.request(`/api/users/${sara.id}/avatar`, { headers: { cookie: ahmed.cookie } });
  assert.equal(seen.status, 200);
  assert.equal(seen.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await seen.arrayBuffer()).equals(PNG));
  assert.equal((await app.request(`/api/users/${sara.id}/avatar`, { headers: { cookie: stranger.cookie } })).status, 404, 'no shared circle, no picture');

  assert.equal((await upload(sara.cookie, Buffer.from('not an image at all'), 'x.png')).status, 400, 'a non-image named .png is refused');
  assert.equal((await json(sara.cookie, '/api/me/avatar', undefined, 'DELETE')).status, 200);
  assert.equal((await app.request(`/api/users/${sara.id}/avatar`, { headers: { cookie: ahmed.cookie } })).status, 404);
});

test('a profile picture is erased with the account, but never because the same photo was deleted from a chat', async () => {
  const lina = await signUp('Lina'), omar = await signUp('Omar');
  const circle = (await (await json(lina.cookie, '/api/circles', { name: 'Fam' })).json() as any).id;
  const code = (await (await json(lina.cookie, `/api/circles/${circle}`)).json() as any).inviteCode;
  await json(omar.cookie, '/api/circles/join', { code });

  // Omar's picture is also a photo Lina sends in the chat (stored once); Lina deletes her message.
  assert.equal((await upload(omar.cookie, PNG)).status, 200);
  const f = new FormData(); f.append('file', new File([new Uint8Array(PNG)], 'p.png', { type: 'image/png' })); f.append('client_msg_id', 'p1');
  const sent = await app.request(`/api/circles/${circle}/attachments`, { method: 'POST', headers: { cookie: lina.cookie }, body: f });
  const mid = (await sent.json() as any).id;
  await json(lina.cookie, `/api/messages/${mid}`, undefined, 'DELETE');
  assert.equal((await app.request(`/api/users/${omar.id}/avatar`, { headers: { cookie: lina.cookie } })).status, 200, 'his picture survives');

  // Omar deletes his account: the picture's file goes too.
  const hash = one('SELECT avatar_hash FROM users WHERE id = ?', omar.id)!.avatar_hash;
  assert.equal((await json(omar.cookie, '/api/me', undefined, 'DELETE')).status, 200);
  assert.equal(one('SELECT 1 AS x FROM blobs WHERE hash = ?', hash), undefined);
});
