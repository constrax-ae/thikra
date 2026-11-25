import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unreadMark } from './src/unread.ts';
import { type Message } from './src/api.ts';

const ME = 1, OTHER = 2;
let n = 0;
const msg = (seq: number, userId: number | null, extra: Partial<Message> = {}): Message => ({
  id: ++n, seq, userId, author: null, kind: 'text', body: 'x', transcript: null, hasAudio: 0, archiveStatus: 'none',
  score: null, category: null, reason: null, createdAt: '2026-11-24 09:00:00', deleted: 0, deletedBy: null, ...extra,
});

test('the line sits above the first message that arrived after the read mark, and counts what is below it', () => {
  const thread = [msg(8, OTHER), msg(9, ME), msg(10, OTHER), msg(11, OTHER), msg(12, ME), msg(13, OTHER)];
  const mark = unreadMark(thread, 9, ME);
  assert.equal(mark.id, thread[2].id, 'the first of theirs after seq 9');
  assert.equal(mark.count, 3, 'their three messages; my own two are not news to me');
});

test('nothing is drawn when there is nothing new, nor when everything new is mine', () => {
  const read = [msg(4, OTHER), msg(5, OTHER)];
  assert.deepEqual(unreadMark(read, 5, ME), { id: 0, count: 0 });
  const onlyMine = [msg(4, OTHER), msg(5, ME), msg(6, ME)];
  assert.deepEqual(unreadMark(onlyMine, 4, ME), { id: 0, count: 0 });
});

test('a chat nothing was ever read in gets no line: everything in it is new, and a line at the very top says nothing', () => {
  assert.deepEqual(unreadMark([msg(1, OTHER), msg(2, OTHER)], 0, ME), { id: 0, count: 0 });
});

test('a notice is enough to place the line: it is the seq before the first unread one that matters, not who wrote it', () => {
  const thread = [msg(1, null, { kind: 'system', body: 'joined' }), msg(2, OTHER), msg(3, OTHER)];
  const mark = unreadMark(thread, 1, ME);
  assert.equal(mark.id, thread[1].id);
  assert.equal(mark.count, 2);
});

test('without the message before it, the line is not drawn: its place would be a guess', () => {
  // The screen opened on a page that begins at seq 40, but the person had read up to 12: where they stopped is off-screen.
  const page = [msg(40, OTHER), msg(41, OTHER)];
  assert.deepEqual(unreadMark(page, 12, ME), { id: 0, count: 0 });
  // Scrolling up brings the boundary in, and now the line has a place.
  const withBoundary = [msg(12, OTHER), ...page];
  assert.equal(unreadMark(withBoundary, 12, ME).id, page[0].id);
});

test('the chat\'s own notices and messages still on their way are not counted', () => {
  const thread = [
    msg(5, OTHER), msg(6, null, { kind: 'system', body: 'joined' }), msg(7, OTHER),
    msg(0, ME, { pending: true }),
  ];
  const mark = unreadMark(thread, 5, ME);
  assert.equal(mark.count, 1);
  assert.equal(mark.id, thread[2].id);
});
