import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excerpt } from './excerpt.ts';

test('short text is returned whole, with no ellipsis', () => {
  assert.equal(excerpt('My son was born today', 60), 'My son was born today');
});

test('whitespace is collapsed', () => {
  assert.equal(excerpt('My  son\n\nwas   born', 60), 'My son was born');
});

test('a long line never ends mid-word', () => {
  // The bug: a blind slice(0, 60) left entries reading "…congratul".
  const text = 'Our daughter Sara was born this morning, congratulations to my brother and his wife';
  const out = excerpt(text, 60);
  assert.ok(out.length <= 61, `too long: ${out.length}`);
  assert.ok(out.endsWith('…'), out);
  const lastWord = out.slice(0, -1).trim().split(' ').pop()!;
  assert.ok(text.includes(` ${lastWord} `) || text.endsWith(lastWord), `"${lastWord}" is a fragment`);
});

test('Arabic is cut on a word boundary too', () => {
  const text = 'الحمدلله رزقنا بمولود جديد اسمه أحمد يوم الخميس، ألف مبروك لأخوي وزوجته';
  const out = excerpt(text, 40);
  assert.ok(out.endsWith('…'));
  const lastWord = out.slice(0, -1).trim().split(' ').pop()!;
  assert.ok(text.includes(lastWord), `"${lastWord}" is a fragment`);
});

test('a sentence ending late in the window is preferred, with no ellipsis', () => {
  const out = excerpt('My father is home from hospital. We are all very relieved and grateful.', 60);
  assert.equal(out, 'My father is home from hospital.');
});

test('trailing punctuation is not left dangling before the ellipsis', () => {
  const out = excerpt('We moved to Dubai yesterday, with the whole family and all our things', 30);
  assert.ok(!/[\s،,;:-]…$/.test(out), out);
});

test('a single word longer than the limit is still cut', () => {
  const out = excerpt('a'.repeat(100), 20);
  assert.ok(out.length <= 21, `${out.length}`);
});
