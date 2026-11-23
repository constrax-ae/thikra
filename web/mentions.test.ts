import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionQuery, pickMention, mentionedIds, splitMentions } from './src/mentions.ts';

const members = [{ id: 1, name: 'سارة' }, { id: 2, name: 'سارة أحمد' }, { id: 3, name: 'Ali' }, { id: 4, name: 'خالد' }];

test('typing "@" opens the picker, and what follows narrows it; the caret decides which "@" is meant', () => {
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
  assert.deepEqual(mentionQuery('يا @سا', 6), { start: 3, query: 'سا' });
  assert.deepEqual(mentionQuery('hi @al and more', 6), { start: 3, query: 'al' }, 'the caret is right after "al"');
  assert.equal(mentionQuery('hi @al and more', 15), null, 'the caret has moved on past a space');
  assert.equal(mentionQuery('mail me at a@b', 14), null, 'an "@" inside a word is an address, not a mention');
  assert.equal(mentionQuery('no at sign', 5), null);
  assert.equal(mentionQuery('@' + 'x'.repeat(40), 41), null, 'too long to be a name being typed');
  assert.equal(mentionQuery('line\n@', 6)?.start, 5);
});

test('picking a name writes it in with a space after, and puts the caret after it', () => {
  assert.deepEqual(pickMention('يا @سا', 6, 3, 'سارة'), { text: 'يا @سارة ', caret: 9 });
  assert.deepEqual(pickMention('hi @al and more', 6, 3, 'Ali'), { text: 'hi @Ali  and more', caret: 8 });
});

test('who is mentioned is read from the text when sending: delete the name and the mention is gone', () => {
  assert.deepEqual(mentionedIds('يا @خالد و @Ali تعالوا', members), [3, 4]);
  assert.deepEqual(mentionedIds('يا خالد', members), [], 'a name without "@" is just a name');
  assert.deepEqual(mentionedIds('@سارة أحمد شوفي', members), [2], 'the longest matching name wins, not both');
  assert.deepEqual(mentionedIds('@سارة شوفي', members), [1]);
  assert.deepEqual(mentionedIds('@Alice', members), [], 'a longer word that only starts like a name is not that person');
  assert.deepEqual(mentionedIds('@Ali, come', members), [3], 'punctuation after the name is fine');
  assert.deepEqual(mentionedIds('@خالد @خالد', members), [4], 'once');
});

test('a shown message is split so the names can be highlighted, using only the mentions the server stored', () => {
  assert.deepEqual(splitMentions('يا @خالد تعال', [{ id: 4, name: 'خالد' }]), [{ text: 'يا ' }, { text: '@خالد', id: 4 }, { text: ' تعال' }]);
  assert.deepEqual(splitMentions('@خالد', []), [{ text: '@خالد' }], 'typed by hand without picking: plain text');
  assert.deepEqual(splitMentions('no mentions', [{ id: 4, name: 'خالد' }]), [{ text: 'no mentions' }]);
  assert.deepEqual(splitMentions('@سارة أحمد و @سارة', [{ id: 1, name: 'سارة' }, { id: 2, name: 'سارة أحمد' }]),
    [{ text: '@سارة أحمد', id: 2 }, { text: ' و ' }, { text: '@سارة', id: 1 }]);
  assert.deepEqual(splitMentions('', [{ id: 4, name: 'خالد' }]), []);
});
