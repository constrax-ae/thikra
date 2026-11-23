import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTyping, typingLabel } from './src/typing.ts';

const t = { typingOne: ' is typing…', typingMany: 'Several people are typing…', recordingOne: ' is recording audio…' };

test('a person shows as typing for 5 seconds after their last frame, then clears by itself', () => {
  const s = createTyping();
  s.note({ circle: 1, user: 7, name: 'Sara', kind: 'text', on: true }, 1000);
  assert.deepEqual(s.in(1, 5999).map(x => x.user), [7]);
  assert.deepEqual(s.in(1, 6000), []);
  s.note({ circle: 1, user: 7, name: 'Sara', kind: 'text', on: true }, 6000);
  assert.equal(s.in(1, 10_999).length, 1, 'each frame renews the 5 seconds');
  assert.deepEqual(s.in(2, 6000), [], 'another chat is not affected');
});

test('"stopped" and "their message arrived" clear it at once', () => {
  const s = createTyping();
  s.note({ circle: 1, user: 7, name: 'Sara', kind: 'voice', on: true }, 0);
  s.note({ circle: 1, user: 7, on: false }, 10);
  assert.deepEqual(s.in(1, 20), []);
  s.note({ circle: 1, user: 8, name: 'Ali', kind: 'text', on: true }, 0);
  s.clear(1, 8);
  assert.deepEqual(s.in(1, 20), []);
});

test('the line says who and what: typing, recording, or several people', () => {
  const s = createTyping();
  s.note({ circle: 1, user: 7, name: 'Sara', kind: 'voice', on: true }, 0);
  assert.equal(typingLabel(s.in(1, 1), t), 'Sara is recording audio…');
  assert.equal(typingLabel(s.in(1, 1), t, false), 'is recording audio…', 'a one-to-one chat needs no name');
  s.note({ circle: 1, user: 7, name: 'Sara', kind: 'text', on: true }, 2);
  assert.equal(typingLabel(s.in(1, 3), t), 'Sara is typing…', 'switching from recording to typing replaces, not adds');
  s.note({ circle: 1, user: 8, name: 'Ali', kind: 'text', on: true }, 2);
  assert.equal(typingLabel(s.in(1, 3), t), 'Several people are typing…');
  assert.equal(typingLabel([], t), '');
});

test('a frame with a missing or strange kind or name is treated as plain typing by someone unnamed', () => {
  const s = createTyping();
  s.note({ circle: 1, user: 9, on: true, kind: 'dancing' as any }, 0);
  assert.deepEqual(s.in(1, 1), [{ user: 9, name: '', kind: 'text', until: 5000 }]);
  assert.equal(typingLabel(s.in(1, 1), t), 'is typing…');
});
