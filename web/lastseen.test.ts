import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastSeenText } from './src/lastseen.ts';
import { dict } from './src/i18n.tsx';

// The server stores UTC as "YYYY-MM-DD HH:MM:SS"; the reader sees their own clock and calendar.
const utc = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const plain = (s: string) => s.replace(/\s/g, ' ');
const now = new Date(2026, 10, 18, 15, 0, 0);            // 18 Nov 2026, 3 pm, wherever the test runs

test('last seen today, yesterday and earlier, in English with a 12-hour clock', () => {
  assert.equal(plain(lastSeenText(utc(new Date(2026, 10, 18, 9, 30)), now, 'en', dict.en)), 'last seen today at 9:30 AM');
  assert.equal(plain(lastSeenText(utc(new Date(2026, 10, 17, 23, 50)), now, 'en', dict.en)), 'last seen yesterday at 11:50 PM');
  assert.equal(plain(lastSeenText(utc(new Date(2026, 10, 10, 8, 0)), now, 'en', dict.en)), 'last seen Nov 10');
  assert.equal(plain(lastSeenText(utc(new Date(2025, 10, 10, 8, 0)), now, 'en', dict.en)), 'last seen Nov 10, 2025', 'another year shows the year');
});

test('just after midnight, a time from late last night is "yesterday", not "today"', () => {
  const justAfter = new Date(2026, 10, 18, 0, 5);
  assert.match(plain(lastSeenText(utc(new Date(2026, 10, 17, 23, 58)), justAfter, 'en', dict.en)), /^last seen yesterday at 11:58 PM$/);
});

test('in Arabic the sentence is Arabic and carries the time', () => {
  const s = lastSeenText(utc(new Date(2026, 10, 18, 9, 30)), now, 'ar', dict.ar);
  assert.ok(s.startsWith('آخر ظهور اليوم '), s);
  assert.ok(!s.includes('{time}'));
  assert.ok(lastSeenText(utc(new Date(2026, 10, 17, 9, 30)), now, 'ar', dict.ar).startsWith('آخر ظهور أمس '));
});

test('a time slightly in the future (the two clocks differ) reads as today, never as a date or an error', () => {
  assert.match(plain(lastSeenText(utc(new Date(2026, 10, 18, 15, 2)), now, 'en', dict.en)), /^last seen today at 3:0[02] PM$/);
  assert.match(plain(lastSeenText(utc(new Date(2026, 10, 19, 0, 30)), now, 'en', dict.en)), /^last seen today at /);
});

test('a value that is not a date gives an empty line instead of "Invalid Date"', () => {
  assert.equal(lastSeenText('not a date', now, 'en', dict.en), '');
});
