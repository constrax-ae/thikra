import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEmail, normalizeEmail } from './email.ts';

test('an empty address is allowed: the field is optional', () => {
  for (const s of ['', '   ']) assert.equal(isEmail(s), true, JSON.stringify(s));
});

test('ordinary addresses are accepted', () => {
  for (const s of ['a@b.co', 'rizwan@example.com', 'First.Last@sub.example.co.uk', 'me+family@gmail.com']) {
    assert.equal(isEmail(s), true, s);
  }
});

test('addresses real people have are not rejected for being unusual', () => {
  // Every clever pattern turns somebody's real address away. These are all valid.
  for (const s of ["o'brien@example.com", 'user@example.technology', 'a.very.long.name@example.museum']) {
    assert.equal(isEmail(s), true, s);
  }
});

test('typos are caught', () => {
  for (const s of ['nope', 'no@domain', '@example.com', 'a@@b.com', 'a b@example.com', 'a@.com', 'a@b..com', 'a@b.', '.a@b.co', 'a.@b.co']) {
    assert.equal(isEmail(s), false, s);
  }
});

test('an absurdly long address is refused', () => {
  assert.equal(isEmail('a'.repeat(250) + '@example.com'), false);
});

test('storage is case- and space-insensitive', () => {
  assert.equal(normalizeEmail('  Rizwan@Example.COM '), 'rizwan@example.com');
});
