process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_SMS_ALLOWED_CODES = '966, 962';
process.env.THIKRA_SMS_DAILY_CAP = '4';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twilioProvider, providerFromEnv, allowedCountry, takeDailyBudget, resetDailyBudget, otpText, SmsError } from './sms.ts';
const { app, setSmsProvider } = await import('./index.ts');

test('Twilio adapter: the request has the right address, credentials and fields; failures become SmsError', async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const ok = twilioProvider({ TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM: '+15005550006' } as any,
    (async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response('{}', { status: 201 }); }) as any);
  await ok.send('+966500000001', 'hello');
  assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from('AC123:secret').toString('base64')}`);
  const form = calls[0].init.body as URLSearchParams;
  assert.deepEqual([form.get('To'), form.get('From'), form.get('Body')], ['+966500000001', '+15005550006', 'hello']);

  const viaService = twilioProvider({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG9' } as any,
    (async (_u: any, init: any) => { calls.push({ url: '', init }); return new Response('{}', { status: 201 }); }) as any);
  await viaService.send('+9625', 'x');
  const f2 = calls.at(-1)!.init.body as URLSearchParams;
  assert.deepEqual([f2.get('MessagingServiceSid'), f2.get('From')], ['MG9', null]);

  const rejected = twilioProvider({ TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_FROM: '+1' } as any, (async () => new Response('no', { status: 400 })) as any);
  await assert.rejects(rejected.send('+1', 'x'), (e: any) => e instanceof SmsError && e.code === 'sms_failed');
  const down = twilioProvider({ TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_FROM: '+1' } as any, (async () => { throw new Error('ECONNRESET'); }) as any);
  await assert.rejects(down.send('+1', 'x'), (e: any) => e instanceof SmsError);
});

test('configuration mistakes fail loudly at start, not at the first customer', () => {
  assert.throws(() => providerFromEnv({ THIKRA_SMS_PROVIDER: 'carrier-pigeon' } as any), /unknown/);
  assert.throws(() => providerFromEnv({ THIKRA_SMS_PROVIDER: 'twilio' } as any), /TWILIO_ACCOUNT_SID/);
  assert.equal(providerFromEnv({} as any).name, 'console');
});

test('cost protection helpers: allowed countries and the daily cap', () => {
  assert.equal(allowedCountry('+966500000001', ['966']), true);
  assert.equal(allowedCountry('+971500000001', ['966', '962']), false);
  assert.equal(allowedCountry('+971500000001', []), true, 'an empty list allows everyone');
  resetDailyBudget();
  const noon = new Date('2026-10-19T12:00:00Z');
  assert.deepEqual([1, 2, 3].map(() => takeDailyBudget(3, noon)), [true, true, true]);
  assert.equal(takeDailyBudget(3, noon), false, 'the 4th is refused');
  assert.equal(takeDailyBudget(3, new Date('2026-10-20T00:01:00Z')), true, 'a new day starts again');
  resetDailyBudget();
  assert.match(otpText('123456', 'ar'), /123456/);
  assert.match(otpText('123456', 'en'), /Thekra code: 123456/);
});

test('with a real-style provider the code goes by SMS only: never in the response; failures leave no usable code; countries and the daily cap apply', async () => {
  resetDailyBudget();
  const sent: Array<{ to: string; text: string }> = [];
  let fail = false;
  setSmsProvider({ name: 'fake', async send(to, text) { if (fail) throw new SmsError('sms_failed', 'down'); sent.push({ to, text }); } });
  const req = (phone: string) => app.request('/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, lang: 'en' }) });
  const verify = (phone: string, code: string) => app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code, name: 'Test' }) });

  const r1 = await req('+966500000401');
  const j1 = await r1.json() as any;
  assert.equal(r1.status, 200);
  assert.equal(j1.devCode, undefined, 'the code is never in the response');
  assert.equal(sent.length, 1);
  const code = sent[0].text.match(/(\d{6})/)![1];
  assert.equal(sent[0].to, '+966500000401');
  assert.match(sent[0].text, /Thekra code/, 'in the language the app asked for');
  assert.equal((await verify('+966500000401', code)).status, 200, 'the SMS code logs in');

  assert.equal((await req('+971500000402')).status, 403, 'a country that is not on the list gets nothing (and costs nothing)');
  assert.equal(sent.length, 1);

  fail = true;
  const bad = await req('+966500000403');
  assert.equal(bad.status, 502);
  assert.equal((await bad.json() as any).error, 'sms_failed');
  assert.equal((await verify('+966500000403', '123456')).status, 400, 'no valid code exists after a failed send');
  fail = false;

  // daily cap is 4: three more allowed (one already used + one failed counted), then 503
  const results: number[] = [];
  for (let i = 0; i < 4; i++) results.push((await req(`+96650000050${i}`)).status);
  assert.ok(results.includes(503), `the daily cap stops sending (${results.join(',')})`);
  setSmsProvider(null);
});

// ---- any provider with an HTTP API, wired by configuration alone ---------------------------------------------------------
// Regional SMS providers share no standard: one wants JSON, the next a query string, the next a form. Waiting for each one's
// spec to write an adapter means waiting to launch, so the shape of the request is configuration.

const { httpProvider, providerFromEnv: pick } = await import('./sms.ts');

const http = (env: Record<string, string>, answer = { status: 200, body: 'ok' }) => {
  const seen: Array<{ url: string; method: string; headers: any; body: string | undefined }> = [];
  const f = (async (url: any, init: any) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return new Response(answer.body, { status: answer.status });
  }) as typeof fetch;
  return { p: httpProvider({ THIKRA_SMS_PROVIDER: 'http', ...env } as any, f), seen };
};

test('an HTTP provider sends exactly the request its configuration describes', async () => {
  const { p, seen } = http({
    THIKRA_SMS_URL: 'https://sms.example.test/v1/send',
    THIKRA_SMS_HEADERS: '{"Authorization":"Bearer secret-token"}',
    THIKRA_SMS_BODY: '{"to":"{to}","local":"{to_digits}","message":"{text}","sender":"Thekra"}',
  });
  await p.send('+971500112233', 'Thekra code: 123456');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://sms.example.test/v1/send');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers.authorization, 'Bearer secret-token');
  assert.equal(seen[0].headers['content-type'], 'application/json', 'JSON unless the configuration says otherwise');
  assert.deepEqual(JSON.parse(seen[0].body!), { to: '+971500112233', local: '971500112233', message: 'Thekra code: 123456', sender: 'Thekra' });
});

test('a GET-style provider puts the number and message in the URL, percent-encoded', async () => {
  // Plenty of regional APIs are a single GET. The Arabic message must survive the trip intact.
  const { p, seen } = http({
    THIKRA_SMS_URL: 'https://sms.example.test/send?user=u&pass=p&to={to_digits}&body={text}',
    THIKRA_SMS_METHOD: 'get',
  });
  await p.send('+966501234567', 'رمز ذكرى: 445566');
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].body, undefined, 'a GET carries no body');
  const u = new URL(seen[0].url);
  assert.equal(u.searchParams.get('to'), '966501234567');
  assert.equal(u.searchParams.get('body'), 'رمز ذكرى: 445566', 'the Arabic text arrives as written');
  assert.ok(!seen[0].url.includes(' '), 'nothing is left unencoded in a URL');
});

test('a form-style provider gets a form, and the message cannot break out of a field', async () => {
  const { p, seen } = http({
    THIKRA_SMS_URL: 'https://sms.example.test/send',
    THIKRA_SMS_HEADERS: '{"content-type":"application/x-www-form-urlencoded"}',
    THIKRA_SMS_BODY: 'to={to}&text={text}',
  });
  // A message carrying an ampersand would, unescaped, become an extra field: a way to change the request from its content.
  await p.send('+971500112233', 'code 1&admin=true');
  const q = new URLSearchParams(seen[0].body!);
  assert.equal(q.get('to'), '+971500112233');
  assert.equal(q.get('text'), 'code 1&admin=true', 'the whole message is one field');
  assert.equal(q.get('admin'), null, 'the message cannot add a field of its own');
});

test('a message with quotes cannot break a JSON body', async () => {
  const { p, seen } = http({
    THIKRA_SMS_URL: 'https://sms.example.test/send',
    THIKRA_SMS_BODY: '{"to":"{to}","message":"{text}"}',
  });
  await p.send('+971500112233', 'code "99"\nnew line');
  const parsed = JSON.parse(seen[0].body!);          // would throw if the quotes leaked through
  assert.equal(parsed.message, 'code "99"\nnew line');
});

test('a provider that answers 200 with a failure in the body is not treated as sent', async () => {
  // Otherwise every code would be swallowed silently and nobody could sign in.
  const good = http({ THIKRA_SMS_URL: 'https://x.test/s', THIKRA_SMS_BODY: '{"to":"{to}"}', THIKRA_SMS_OK: '"status":"queued"' }, { status: 200, body: '{"status":"queued","id":"1"}' });
  await good.p.send('+971500112233', 'x');
  const bad = http({ THIKRA_SMS_URL: 'https://x.test/s', THIKRA_SMS_BODY: '{"to":"{to}"}', THIKRA_SMS_OK: '"status":"queued"' }, { status: 200, body: '{"status":"rejected","error":"no credit"}' });
  await assert.rejects(() => bad.p.send('+971500112233', 'x'), (e: any) => e instanceof SmsError && e.code === 'sms_failed');
  // and an outright error status still fails
  const err = http({ THIKRA_SMS_URL: 'https://x.test/s', THIKRA_SMS_BODY: '{"to":"{to}"}' }, { status: 401, body: 'denied' });
  await assert.rejects(() => err.p.send('+971500112233', 'x'), (e: any) => e instanceof SmsError && e.code === 'sms_failed');
});

test('a half-written SMS configuration is refused at startup, not at the first sign-in', () => {
  // The worst moment to discover a typo is when a real person is waiting for a code.
  assert.throws(() => httpProvider({ THIKRA_SMS_PROVIDER: 'http' } as any), /THIKRA_SMS_URL/);
  assert.throws(() => httpProvider({ THIKRA_SMS_PROVIDER: 'http', THIKRA_SMS_URL: 'https://x.test' } as any), /THIKRA_SMS_BODY/);
  assert.throws(() => httpProvider({ THIKRA_SMS_PROVIDER: 'http', THIKRA_SMS_URL: 'https://x.test', THIKRA_SMS_METHOD: 'PUT' } as any), /POST or GET/);
  assert.throws(() => httpProvider({ THIKRA_SMS_PROVIDER: 'http', THIKRA_SMS_URL: 'https://x.test', THIKRA_SMS_BODY: 'x', THIKRA_SMS_HEADERS: 'not json' } as any), /JSON object/);
  assert.throws(() => httpProvider({ THIKRA_SMS_PROVIDER: 'http', THIKRA_SMS_URL: 'https://x.test', THIKRA_SMS_BODY: 'x', THIKRA_SMS_HEADERS: '["a"]' } as any), /JSON object/);
  // a GET needs no body
  assert.equal(httpProvider({ THIKRA_SMS_PROVIDER: 'http', THIKRA_SMS_URL: 'https://x.test?to={to}', THIKRA_SMS_METHOD: 'GET' } as any).name, 'http');
});

test('the provider is chosen by name, and an unknown name is refused loudly', () => {
  assert.equal(pick({} as any).name, 'console', 'development default');
  assert.equal(pick({ THIKRA_SMS_PROVIDER: '' } as any).name, 'console');
  assert.equal(pick({ THIKRA_SMS_PROVIDER: ' HTTP ', THIKRA_SMS_URL: 'https://x.test', THIKRA_SMS_BODY: '{}' } as any).name, 'http', 'case and spacing are forgiven');
  assert.equal(pick({ THIKRA_SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1' } as any).name, 'twilio');
  assert.throws(() => pick({ THIKRA_SMS_PROVIDER: 'dreamsoft' } as any), /unknown THIKRA_SMS_PROVIDER/);
});
