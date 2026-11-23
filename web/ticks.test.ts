import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickOf } from './src/ticks.ts';

const msg = (seq?: number, pending = false) => ({ seq, pending });
const who = (deliveredSeq: number, readSeq: number | null) => ({ deliveredSeq, readSeq });

test('a message still leaving this device shows as pending', () => {
  assert.equal(tickOf(msg(undefined, true), [who(9, 9)]), 'pending');
  assert.equal(tickOf(msg(undefined), [who(9, 9)]), 'pending', 'no seq yet: the server has not confirmed it');
});

test('sent until EVERYONE else has received it; read only when EVERYONE else has read it', () => {
  assert.equal(tickOf(msg(5), [who(4, 4), who(5, 5)]), 'sent', 'one person has not received it');
  assert.equal(tickOf(msg(5), [who(5, 4), who(7, 7)]), 'delivered', 'all received, one has not read');
  assert.equal(tickOf(msg(5), [who(5, 5), who(7, 7)]), 'read');
});

test('someone whose reads are not shared (null) keeps it at delivered forever, however far they have read', () => {
  assert.equal(tickOf(msg(5), [who(9, null), who(9, 9)]), 'delivered');
  assert.equal(tickOf(msg(5), [who(9, null)]), 'delivered');
});

test('alone in the chat: nobody to deliver to, so it stays at sent', () => {
  assert.equal(tickOf(msg(5), []), 'sent');
});
