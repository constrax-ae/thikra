import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callingCode, flagEmoji, formatTyped, guessCountry, listCountries, normalizePhone } from './phone.ts';

test('every way of writing a Saudi number becomes one canonical form', () => {
  const canonical = '+966500000010';
  for (const input of ['+966 50 000 0010', '+966-500-000-010', '00966500000010', '966500000010', '+٩٦٦٥٠٠٠٠٠٠١٠', ' +966 (50) 000 0010 ']) {
    assert.equal(normalizePhone(input), canonical, input);
  }
});

test('numbers from other countries keep their own country code', () => {
  assert.equal(normalizePhone('+1 202 555 0123'), '+12025550123');
  assert.equal(normalizePhone('+44 7911 123456'), '+447911123456');
  assert.equal(normalizePhone('+971 50 123 4567'), '+971501234567');
  assert.equal(normalizePhone('+20 100 123 4567'), '+201001234567');
});

test('things that cannot be a phone number are refused', () => {
  for (const bad of ['', 'abc', '123', '+1', '+999 123', null, undefined, '+966 5']) assert.equal(normalizePhone(bad), null, String(bad));
});

test('the time zone says where the person is, and beats the language', () => {
  assert.equal(guessCountry({ timeZone: 'Asia/Riyadh', languages: ['en-US'] }), 'SA');
  assert.equal(guessCountry({ timeZone: 'Asia/Dubai' }), 'AE');
  assert.equal(guessCountry({ timeZone: 'America/New_York', languages: ['ar-SA'] }), 'US');
});

test('without a known time zone, a region in the device language is used, then the fallback', () => {
  assert.equal(guessCountry({ timeZone: 'Pacific/Nowhere', languages: ['en', 'ar-KW'] }), 'KW');
  assert.equal(guessCountry({ languages: ['ar'] }), 'SA');
  assert.equal(guessCountry({ languages: ['ar'], fallback: 'EG' }), 'EG');
  assert.equal(guessCountry({ languages: ['xx-ZZ'] }), 'SA', 'an unknown region is ignored');
});

test('the country list covers the world, in the requested language, sorted', () => {
  const ar = listCountries('ar');
  assert.ok(ar.length > 200);
  const sa = ar.find(c => c.code === 'SA')!;
  assert.equal(sa.dial, '966');
  assert.match(sa.name, /السعودية/);
  assert.equal(listCountries('en').find(c => c.code === 'SA')!.name, 'Saudi Arabia');
  const names = ar.map(c => c.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'ar')));
});

test('flags and calling codes', () => {
  assert.equal(flagEmoji('SA'), '🇸🇦');
  assert.equal(callingCode('US'), '1');
  assert.equal(callingCode('AE'), '971');
});

test('digits are grouped as they are typed, with or without the local leading zero', () => {
  assert.equal(formatTyped('557898998', 'AE'), '55 789 8998');
  assert.equal(formatTyped('5578', 'AE'), '55 78');
  assert.equal(formatTyped('0557898998', 'AE'), '055 789 8998');
  assert.equal(formatTyped('500000010', 'SA'), '50 000 0010');
  assert.equal(formatTyped('2025550123', 'US'), '202 555 0123');
  assert.equal(formatTyped('7911123456', 'GB'), '7911 123456');
  assert.equal(formatTyped('', 'AE'), '');
});

test('a number typed with a plus keeps its country code, and letters are ignored', () => {
  assert.equal(formatTyped('+966500000010', 'AE'), '+966 50 000 0010');
  assert.equal(formatTyped('55 abc 789-8998', 'AE'), '55 789 8998');
});

test('what the box shows is read back as the same number', () => {
  for (const [digits, country] of [['557898998', 'AE'], ['500000010', 'SA'], ['2025550123', 'US']] as const) {
    assert.equal(normalizePhone(`+${callingCode(country)}${digits}`), normalizePhone(`+${callingCode(country)}${formatTyped(digits, country)}`));
  }
});
