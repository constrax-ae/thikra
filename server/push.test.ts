// Notifications (Web Push) without touching a real push service: the network is replaced by a fake that records what would be sent.
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
const { setTransport, vapidPublicKey } = await import('./push.ts');
const { run, one } = await import('./db.ts');
const server = startServer(0);
await new Promise(r => server.once('listening', r));
const port = (server.address() as { port: number }).port;
after(() => { server.close(); server.closeAllConnections?.(); });

const sent: Array<{ endpoint: string; payload: any }> = [];
let failWith: number | null = null;
setTransport(async (sub, payload) => {
  if (failWith) throw Object.assign(new Error('gone'), { statusCode: failWith });
  sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
});
const settle = () => new Promise(r => setTimeout(r, 80));

let n = 0;
async function login(name: string) {
  const phone = `+9665${String(3_000_000 + n++).padStart(8, '0')}`;
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { devCode } = await (await post('/api/auth/request', { phone })).json() as any;
  const res = await post('/api/auth/verify', { phone, code: devCode, name });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, id: (await (await app.request('/api/me', { headers: { cookie } })).json() as any).id as number };
}
const call = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
const sub = (id: string) => ({ endpoint: `https://push.example.test/${id}`, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });
async function pair() {
  const a = await login('سارة'), b = await login('خالد');
  const circle = (await call(a.cookie, '/api/circles', 'POST', { name: 'العائلة' })).json.id as number;
  await call(b.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${circle}`)).json.inviteCode });
  return { a, b, circle };
}
const say = (who: { cookie: string }, circle: number, body: string) => call(who.cookie, `/api/circles/${circle}/messages`, 'POST', { body });

test('subscribing needs a login and a real https endpoint; the server key is stable', async () => {
  const a = await login('م');
  assert.equal((await app.request('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await call(a.cookie, '/api/push/subscribe', 'POST', { endpoint: 'http://insecure.test/x', keys: { p256dh: 'x', auth: 'y' } })).status, 400);
  assert.equal((await call(a.cookie, '/api/push/subscribe', 'POST', { endpoint: 'https://ok.test/x' })).status, 400);
  assert.equal((await call(a.cookie, '/api/push/subscribe', 'POST', sub('one'))).status, 200);
  assert.equal((await call(a.cookie, '/api/push/status')).json.devices, 1);
  const key = (await call(a.cookie, '/api/push/key')).json.key;
  assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal(vapidPublicKey(), key, 'the same key every time (it is stored)');
  await call(a.cookie, '/api/push/subscribe', 'DELETE', { endpoint: sub('one').endpoint });
  assert.equal((await call(a.cookie, '/api/push/status')).json.devices, 0);
});

test('a message notifies the other members\' devices, never the sender; the text is the preview unless they turned it off', async () => {
  const { a, b, circle } = await pair();
  await call(a.cookie, '/api/push/subscribe', 'POST', sub('a-phone'));
  await call(b.cookie, '/api/push/subscribe', 'POST', sub('b-phone'));
  await call(b.cookie, '/api/push/subscribe', 'POST', sub('b-laptop'));
  sent.length = 0;
  await say(a, circle, 'العشاء عند الجدة الليلة');
  await settle();
  assert.deepEqual(sent.map(s => s.endpoint).sort(), [sub('b-laptop').endpoint, sub('b-phone').endpoint], 'both of B\'s devices, not A\'s');
  assert.equal(sent[0].payload.title, 'العائلة');
  assert.equal(sent[0].payload.body, 'سارة: العشاء عند الجدة الليلة');
  assert.equal(sent[0].payload.circle, circle);
  // previews off: nothing of the text leaves the server
  await call(b.cookie, '/api/me', 'PATCH', { push_preview: false });
  sent.length = 0;
  await say(a, circle, 'سر لا يظهر');
  await settle();
  assert.ok(sent.length >= 1);
  assert.ok(sent.every(s => !JSON.stringify(s.payload).includes('سر لا يظهر')), 'the text is not in the notification');
  assert.equal(sent[0].payload.body, 'رسالة جديدة');
});

test('no notification for a muted chat, for someone with the app on screen, or for a system message; mute can expire', async () => {
  const { a, b, circle } = await pair();
  await call(b.cookie, '/api/push/subscribe', 'POST', sub('b2'));
  // muted
  await call(b.cookie, `/api/circles/${circle}/prefs`, 'PATCH', { muted: true, muteHours: 8 });
  sent.length = 0; await say(a, circle, 'مكتومة'); await settle();
  assert.equal(sent.length, 0, 'muted for 8 hours');
  const row = (await call(b.cookie, '/api/circles')).json.find((x: any) => x.id === circle);
  assert.equal(row.muted, true);
  assert.ok(row.mutedUntil);
  // the mute runs out
  run("UPDATE chat_prefs SET muted_until = datetime('now', '-1 minute') WHERE user_id = ? AND circle_id = ?", b.id, circle);
  assert.equal((await call(b.cookie, '/api/circles')).json.find((x: any) => x.id === circle).muted, false, 'an expired mute is no longer a mute');
  sent.length = 0; await say(a, circle, 'بعد انتهاء الكتم'); await settle();
  assert.equal(sent.length, 1);
  // looking at the app: a visible socket suppresses it; hidden does not
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: b.cookie } });
  await new Promise<void>(r => ws.once('open', () => r()));
  ws.send(JSON.stringify({ t: 'visible', on: true })); await settle();
  sent.length = 0; await say(a, circle, 'وهو يحدّق في الشاشة'); await settle();
  assert.equal(sent.length, 0, 'visible: no push');
  ws.send(JSON.stringify({ t: 'visible', on: false })); await settle();
  sent.length = 0; await say(a, circle, 'ذهب للخلفية'); await settle();
  assert.equal(sent.length, 1, 'hidden: push');
  ws.close(); await settle();
  // a system message ("X joined") never notifies
  sent.length = 0;
  const c = await login('ثالث');
  await call(c.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${circle}`)).json.inviteCode });
  await settle();
  assert.equal(sent.length, 0);
});

test('attachments and voice show what they are; gone devices are forgotten', async () => {
  const { a, b, circle } = await pair();
  await call(b.cookie, '/api/push/subscribe', 'POST', sub('b3'));
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(1)])]), 'p.jpg'); fd.append('thumb', new Blob([]), 'n');
  sent.length = 0;
  await app.request(`/api/circles/${circle}/attachments`, { method: 'POST', headers: { cookie: a.cookie }, body: fd });
  await settle();
  assert.equal(sent[0].payload.body, 'سارة: 📷 صورة');
  // a 410 from the push service removes the dead device so we stop trying
  failWith = 410;
  await say(a, circle, 'للجهاز الميت'); await settle();
  failWith = null;
  assert.equal(one('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?', sub('b3').endpoint)!.n, 0);
});

test('a view-once or disappearing message never puts its content in a notification', async () => {
  const { a, b, circle } = await pair();
  await call(b.cookie, '/api/push/subscribe', 'POST', sub('b-hide'));
  // disappearing timer on (an ordinary group): the text must not appear, the chat still notifies
  const g = (await call(a.cookie, '/api/circles', 'POST', { name: 'مجموعة', kind: 'group' })).json.id as number;
  await call(b.cookie, '/api/circles/join', 'POST', { code: (await call(a.cookie, `/api/circles/${g}`)).json.inviteCode });
  await call(a.cookie, `/api/circles/${g}/disappearing`, 'PUT', { seconds: 86400 });
  sent.length = 0;
  await say(a, g, 'نص يختفي'); await settle();
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(sent[0].payload).includes('نص يختفي'), 'no disappearing text in the push');
  assert.ok(!JSON.stringify(sent[0].payload).includes('سارة'), 'nor the sender, in a chat where the text is hidden');
  assert.equal(sent[0].payload.body, 'رسالة جديدة');
  // a view-once photo with a caption: neither the caption nor "photo" leaks
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(1)])]), 'p.jpg'); fd.append('view_once', '1'); fd.append('caption', 'سري جداً');
  sent.length = 0;
  await app.request(`/api/circles/${circle}/attachments`, { method: 'POST', headers: { cookie: a.cookie }, body: fd }); await settle();
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(sent[0].payload).includes('سري جداً') && !JSON.stringify(sent[0].payload).includes('صورة'));
  // an ordinary message in a chat without the timer still shows its text
  sent.length = 0; await say(a, circle, 'عادية'); await settle();
  assert.equal(sent[0].payload.body, 'سارة: عادية');
});

test('a locked chat says only "new message" and not even its name', async () => {
  const { a, b, circle } = await pair();
  await call(b.cookie, '/api/push/subscribe', 'POST', sub('b-lock'));
  await call(b.cookie, `/api/circles/${circle}/prefs`, 'PATCH', { locked: true });
  sent.length = 0; await say(a, circle, 'خاص بالقفل'); await settle();
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(sent[0].payload).includes('خاص بالقفل'));
  assert.equal(sent[0].payload.title, 'Tamtim', 'not even the chat name');
});

test('every notification carries only what the service worker reads, and a tap target that stays inside the app', async () => {
  const { a, b, circle } = await pair();
  await call(b.cookie, '/api/push/subscribe', 'POST', sub('b-shape'));
  sent.length = 0; await say(a, circle, 'شكل'); await settle();
  assert.deepEqual(Object.keys(sent[0].payload).sort(), ['body', 'circle', 'tag', 'title']);
  assert.equal(sent[0].payload.tag, `circle-${circle}`);
  assert.ok(Number.isInteger(sent[0].payload.circle));
});

test('ending a person\'s sessions (suspend, ban, sign out everywhere) also stops their notifications', async () => {
  const { a, b, circle } = await pair();
  await call(b.cookie, '/api/push/subscribe', 'POST', sub('b-ended'));
  const { endSessions } = await import('./lib/admin.ts');
  endSessions(b.id);
  sent.length = 0; await say(a, circle, 'بعد التعليق'); await settle();
  assert.equal(sent.length, 0);
  assert.equal(one('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', b.id)!.n, 0);
});

test('signing in on a device that holds another person\'s subscription takes it over (so the first person stops getting the second\'s notifications)', async () => {
  const { a, b, circle } = await pair();
  await call(a.cookie, '/api/push/subscribe', 'POST', sub('shared-device'));
  await call(b.cookie, '/api/push/subscribe', 'POST', sub('shared-device'));
  assert.equal((await call(a.cookie, '/api/push/status')).json.devices, 0);
  assert.equal((await call(b.cookie, '/api/push/status')).json.devices, 1);
  // and one person cannot remove another person's device
  await call(a.cookie, '/api/push/subscribe', 'DELETE', { endpoint: sub('shared-device').endpoint });
  assert.equal((await call(b.cookie, '/api/push/status')).json.devices, 1);
});

test('a push service that is broken or unreachable never breaks sending, and the device is kept (only 404 and 410 remove it)', async () => {
  const { a, b, circle } = await pair();
  await call(b.cookie, '/api/push/subscribe', 'POST', sub('b-flaky'));
  for (const code of [500, 429, 413]) {
    failWith = code;
    const r = await say(a, circle, `يعمل رغم الخطأ ${code}`); await settle();
    assert.equal(r.status, 201);
  }
  failWith = null;
  assert.equal(one('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?', sub('b-flaky').endpoint)!.n, 1);
  failWith = 404; await say(a, circle, 'منتهي'); await settle(); failWith = null;
  assert.equal(one('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?', sub('b-flaky').endpoint)!.n, 0, '404 means expired');
});

test('the real sender: the message is encrypted (aes128gcm) and signed with the server key, and a 410 from the service removes the device', async () => {
  const { createServer } = await import('node:https');
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'thikra-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  const { createECDH, randomBytes } = await import('node:crypto');
  const { pushToUser } = await import('./push.ts');
  const seen: Array<{ auth: string; enc: string; len: number }> = [];
  let status = 201;
  const fake = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { seen.push({ auth: String(req.headers.authorization), enc: String(req.headers['content-encoding']), len: Buffer.concat(chunks).length }); res.writeHead(status).end(); });
  });
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
  const port2 = (fake.address() as { port: number }).port;
  setTransport(null);   // the real one
  const tlsWas = process.env.NODE_TLS_REJECT_UNAUTHORIZED; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';   // our own throw-away certificate
  try {
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const u = await login('حقيقي');
    const { saveSubscription } = await import('./push.ts');
    saveSubscription(u.id, { endpoint: `https://127.0.0.1:${port2}/send`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }, 'test');
    const ok = await pushToUser(u.id, { title: 'ت', body: 'نص الرسالة', circle: 1, tag: 't' });
    assert.equal(ok, 1);
    assert.match(seen[0].auth, /^vapid t=.+, k=.+/);
    assert.ok(seen[0].auth.includes(vapidPublicKey()), 'signed with the server\'s own key');
    assert.equal(seen[0].enc, 'aes128gcm');
    assert.ok(seen[0].len > 100);
    status = 410;
    assert.equal(await pushToUser(u.id, { title: 'ت', body: 'ب', circle: 1, tag: 't' }), 0);
    assert.equal(one('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', u.id)!.n, 0, 'expired device removed');
  } finally {
    if (tlsWas === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsWas;
    setTransport(async (s, p) => { if (failWith) throw Object.assign(new Error('gone'), { statusCode: failWith }); sent.push({ endpoint: s.endpoint, payload: JSON.parse(p) }); });
    fake.close();
  }
});
