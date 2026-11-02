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
