import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVoiceNote } from './src/voice.ts';

const chat = [
  { id: 1, voice: true }, { id: 2, voice: true }, { id: 3, voice: true },   // a run of three notes
  { id: 4, voice: false },                                                    // a text
  { id: 5, voice: true },
];

test('a run of voice notes plays through, one after the other', () => {
  assert.equal(nextVoiceNote(chat, 1), 2);
  assert.equal(nextVoiceNote(chat, 2), 3);
});

test('anything that is not a voice note stops the run, and so does the end of the chat', () => {
  assert.equal(nextVoiceNote(chat, 3), null, 'the text after note 3 stops it: note 5 does not start by itself');
  assert.equal(nextVoiceNote(chat, 5), null);
  assert.equal(nextVoiceNote(chat, 99), null, 'a note no longer on screen plays nothing');
  assert.equal(nextVoiceNote([], 1), null);
});

import { smoothTime } from './src/voice.ts';

test('the playhead moves on every frame between the browser\'s coarse time updates, at the playback speed', () => {
  let r = smoothTime(null, 1, 0, 1);
  assert.equal(r.time, 1);
  r = smoothTime(r.memo, 1, 16, 1);
  assert.ok(Math.abs(r.time - 1.016) < 1e-9, 'one frame later it has moved on, though the element still says 1');
  r = smoothTime(r.memo, 1, 100, 2);
  assert.ok(Math.abs(r.time - 1.2) < 1e-9, 'at 2x it moves twice as far');
  r = smoothTime(r.memo, 1.25, 260, 1);
  assert.equal(r.time, 1.25, 'a fresh reading from the element is taken as it is');
});

test('a stalled player stops the playhead instead of letting it run away', () => {
  let r = smoothTime(null, 3, 0, 1);
  r = smoothTime(r.memo, 3, 5000, 1);
  assert.ok(Math.abs(r.time - 3.3) < 1e-9, 'never more than 0.3 s ahead of the element');
});
