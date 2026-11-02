import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLang } from './src/i18n.tsx';

test('language: the saved choice wins; else the first device language we speak; else English (like WhatsApp)', () => {
  assert.equal(pickLang('en', ['ar-AE']), 'en', 'a person who chose English keeps English on an Arabic phone');
  assert.equal(pickLang('ar', ['en-US']), 'ar');
  assert.equal(pickLang(null, ['ar-AE', 'en-US']), 'ar');
  assert.equal(pickLang(null, ['en-GB']), 'en');
  assert.equal(pickLang(undefined, ['ja-JP', 'ar-SA']), 'ar', 'the first language in the list that we speak (Japanese is not available)');
  assert.equal(pickLang(null, ['fr-FR', 'ar-SA']), 'fr');
  assert.equal(pickLang(null, ['ur-PK', 'hi-IN']), 'ur');
  assert.equal(pickLang(null, ['zh-CN', 'en']), 'zh'); assert.equal(pickLang(null, ['ja-JP', 'es-MX']), 'es'); assert.equal(pickLang(null, ['fa-IR']), 'fa'); assert.equal(pickLang(null, ['de-AT']), 'de'); assert.equal(pickLang(null, ['sv-SE', 'en']), 'sv');
  assert.equal(pickLang(null, ['hi-IN']), 'hi');
  assert.equal(pickLang(null, ['fil-PH']), 'tl', 'Filipino is reported as fil by some devices and tl by others');
  assert.equal(pickLang(null, ['tl']), 'tl');
  assert.equal(pickLang(null, ['ja-JP', 'ko-KR']), 'en', 'no language we speak: English');
  assert.equal(pickLang('xx', ['AR']), 'ar', 'a stale saved value is ignored; case does not matter');
  assert.equal(pickLang(null, []), 'en');
});

// ---- the language packs ----
import { readFileSync } from 'node:fs';
import { dict, overlay, SUPPORTED, LANG_INFO } from './src/i18n.tsx';

const flat = (v: any, p = '', out: Record<string, string> = {}) => { if (typeof v === 'string') out[p] = v; else if (Array.isArray(v)) v.forEach((x, i) => flat(x, `${p}[${i}]`, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) flat(x, p ? `${p}.${k}` : k, out); return out; };
const EN = flat(dict.en), ph = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join();
const PACKS = SUPPORTED.filter(l => LANG_INFO[l].machine);

test('every machine-translation pack only translates texts that exist, keeps every {placeholder}, covers the user-facing screens, and carries the legal notice', () => {
  assert.deepEqual(PACKS.sort(), ['bn', 'de', 'el', 'es', 'fa', 'fr', 'hi', 'it', 'ml', 'nl', 'pl', 'pt', 'ru', 'sv', 'tl', 'tr', 'uk', 'ur', 'zh']);
  for (const lang of PACKS) {
    const pack: Record<string, string> = JSON.parse(readFileSync(new URL(`./src/lang/${lang}.json`, import.meta.url), 'utf8'));
    const keys = Object.keys(pack);
    assert.ok(keys.length >= 600, `${lang}: ${keys.length} texts`);
    for (const k of keys) {
      assert.ok(k in EN, `${lang}: "${k}" is not a text of the app`);
      assert.equal(typeof pack[k], 'string'); assert.ok(pack[k].trim(), `${lang}: ${k} is empty`);
      assert.equal(ph(pack[k]), ph(EN[k]), `${lang}: ${k} lost or changed a placeholder`);
    }
    assert.ok(pack.legalNote?.length > 40, `${lang}: legal notice missing`);
    for (const must of ['loginTitle', 'sendCode', 'verify', 'tabChats', 'tabMemory', 'tabYou', 'send', 'typeMessage', 'sealedDisclosure', 'confirmDelete', 'errors.generic', 'errors.network']) assert.ok(must in pack, `${lang}: ${must} is not translated`);
  }
});

test('overlaying a pack changes texts only: the structure of the dictionary is untouched, and what a pack lacks stays English', () => {
  for (const lang of PACKS) {
    const pack: Record<string, string> = JSON.parse(readFileSync(new URL(`./src/lang/${lang}.json`, import.meta.url), 'utf8'));
    const t = overlay(dict.en, pack);
    const a = flat(t), keys = Object.keys(a);
    assert.deepEqual(keys, Object.keys(EN), `${lang}: same keys, same order`);
    assert.equal(a['errors.generic'], pack['errors.generic']);
    const missing = keys.filter(k => !(k in pack));
    assert.ok(missing.every(k => a[k] === EN[k]), `${lang}: a missing text must stay English`);
  }
  assert.equal(flat(overlay(dict.en, { 'no.such.key': 'x', 'errors': 'not a leaf' } as any))['errors.generic'], EN['errors.generic'], 'a pack cannot add or break structure');
});

test('the admin and operations screens are not in the packs (staff use Arabic or English, with English underneath)', () => {
  for (const lang of PACKS) {
    const pack: Record<string, string> = JSON.parse(readFileSync(new URL(`./src/lang/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of Object.keys(pack)) assert.ok(!/^(adm[A-Z]|pp[A-Z]|cap[A-Z]|op[A-Z]|sec[A-Z]|pm[A-Z]|an[A-Z])/.test(k), `${lang}: ${k} is an admin text`);
  }
});

test('a chat notice is written in the reader\'s language, older Arabic ones show as they were, and every pack has every notice', async () => {
  const { systemText } = await import('./src/i18n.tsx');
  const body = 'sys:' + JSON.stringify({ k: 'deathAgent', a: { who: 'Ali', n: 3, u: 'd' } });
  assert.match(systemText(body, dict.en as any), /Ali has passed away.*after 3 days/);
  assert.match(systemText(body, dict.ar as any), /ستُفتح رسائله المختومة بعد 3 أيام/);
  assert.equal(systemText('انضم فلان', dict.en as any), 'انضم فلان');
  for (const lang of PACKS) {
    const pack: Record<string, string> = JSON.parse(readFileSync(new URL(`./src/lang/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of Object.keys(EN).filter(k => k.startsWith('sys.'))) assert.ok(pack[k], `${lang}: ${k}`);
  }
});
