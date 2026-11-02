process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { one } = await import('./db.ts');
const { otpText } = await import('./sms.ts');
const { normLang, textLang, isLang, LANGS } = await import('./lib/lang.ts');

test('the sign-in code is worded in the person\'s language; a language without a template gets English, never Arabic', () => {
  assert.equal(otpText('123456', 'ar'), 'رمز ذكرى: 123456. لا تشاركه مع أحد.');
  assert.equal(otpText('123456', 'en'), 'Thekra code: 123456. Do not share it with anyone.');
  assert.match(otpText('123456', 'fr'), /Code Thekra : 123456/);
  assert.match(otpText('123456', 'es'), /Código de Thekra: 123456/);
  assert.match(otpText('123456', 'zh'), /验证码：123456/);
  assert.match(otpText('123456', 'tl'), /Huwag itong ibahagi/);
  assert.match(otpText('123456', 'hi'), /कोड: 123456/);
  assert.match(otpText('123456', 'ur'), /کوڈ: 123456/);
  assert.equal(otpText('123456', 'xx'), otpText('123456', 'en'));
  assert.equal(otpText('123456'), otpText('123456', 'ar'));
  for (const l of LANGS) assert.ok(otpText('111111', l).includes('111111'), l);
});

test('language codes: only the ones we speak are accepted; long texts are Arabic for Arabic and English for everyone else', () => {
  assert.deepEqual([...LANGS], ['ar', 'en', 'ur', 'hi', 'tl', 'fr', 'ml', 'bn', 'fa', 'tr', 'es', 'ru', 'zh', 'de', 'it', 'pt', 'nl', 'pl', 'uk', 'el', 'sv']);
  assert.equal(isLang('fr'), true); assert.equal(isLang('ja'), false); assert.equal(isLang(undefined), false);
  assert.equal(normLang('ur'), 'ur'); assert.equal(normLang('ja'), 'ar'); assert.equal(normLang('ja', 'en'), 'en');
  assert.equal(textLang('ar'), 'ar'); assert.equal(textLang('fr'), 'en'); assert.equal(textLang('ur'), 'en'); assert.equal(textLang(undefined), 'ar');
});

test('a new person signs up in the language the app was in; an unknown code falls back to Arabic', async () => {
  const join = async (phone: string, lang: string) => {
    const req = await app.request('/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, lang }) });
    const code = (await req.json() as any).devCode as string;
    const v = await app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code, name: 'T', lang }) });
    assert.equal(v.status, 200);
    return one('SELECT lang FROM users WHERE phone = ?', phone)!.lang;
  };
  assert.equal(await join('+971500990301', 'fr'), 'fr');
  assert.equal(await join('+971500990302', 'ur'), 'ur');
  assert.equal(await join('+971500990303', 'klingon'), 'ar');
});

test('push notices are worded in the person\'s language, and a chat notice is stored as a code, not as words', async () => {
  const { words, quotaText } = await import('./lib/texts.ts');
  assert.equal(words('de').msg, 'Neue Nachricht'); assert.equal(words('ur').support, 'ذکرا ٹیم نے آپ کے پیغام کا جواب دیا ہے');
  assert.equal(words('xx').msg, 'New message', 'unknown language: English'); assert.equal(words(undefined).msg, 'رسالة جديدة');
  for (const l of LANGS) { const w = words(l); assert.ok(w.msg && w.photo && w.support, l); assert.ok(quotaText(l, 'Fam', 100).includes('Fam') && quotaText(l, 'Fam', 80).includes('80'), l); }
  const { systemMessage } = await import('./lib/helpers.ts');
  const c = one('SELECT id FROM circles LIMIT 1');
  if (c) { const id = systemMessage(c.id, 'joined', { name: 'Sara' }); assert.equal(one('SELECT body FROM messages WHERE id = ?', id)!.body, 'sys:{"k":"joined","a":{"name":"Sara"}}'); }
});
