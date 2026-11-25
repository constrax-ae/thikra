import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forget, presets, readReminders, remind, split } from './src/reminders.ts';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, raw: m }; };

test('a reminder is kept per person on this device, one per message, in time order', () => {
  const s = mem();
  remind(1, { circleId: 5, messageId: 10, chat: 'Family', at: 3000 }, s, 0);
  remind(1, { circleId: 5, messageId: 11, chat: 'Family', at: 1000 }, s, 0);
  remind(1, { circleId: 5, messageId: 10, chat: 'Family', at: 2000 }, s, 0);   // the same message again: moved, not doubled
  assert.deepEqual(readReminders(1, s).map(r => [r.messageId, r.at]), [[11, 1000], [10, 2000]]);
  assert.deepEqual(readReminders(2, s), [], 'another person on the same device sees none of them');
  forget(1, '5:11', s);
  assert.deepEqual(readReminders(1, s).map(r => r.messageId), [10]);
});

test('no words of the message are stored, only which chat and message, and when', () => {
  const s = mem();
  remind(1, { circleId: 5, messageId: 10, chat: 'Family', at: 1 }, s, 0);
  assert.deepEqual(Object.keys(readReminders(1, s)[0]).sort(), ['at', 'chat', 'circleId', 'created', 'id', 'messageId']);
});

test('broken or foreign data in storage is ignored, never thrown', () => {
  const s = mem();
  s.setItem('tamtim_reminders_1', '{not json');
  assert.deepEqual(readReminders(1, s), []);
  s.setItem('tamtim_reminders_1', JSON.stringify([{ id: 'x' }, null, 5, { id: '1:2', circleId: 1, messageId: 2, at: 9, chat: 'a', created: 0 }]));
  assert.equal(readReminders(1, s).length, 1);
});

test('due and later', () => {
  const list = [{ id: 'a', circleId: 1, messageId: 1, chat: '', at: 100, created: 0 }, { id: 'b', circleId: 1, messageId: 2, chat: '', at: 300, created: 0 }];
  const { due, later } = split(list, 200);
  assert.deepEqual(due.map(r => r.id), ['a']);
  assert.deepEqual(later.map(r => r.id), ['b']);
});

test('the quick choices: this evening only while it is before 6 pm, tomorrow always at 9', () => {
  const morning = new Date(2026, 10, 23, 10, 0, 0);
  const ks = presets(morning);
  assert.deepEqual(ks.map(p => p.k), ['m20', 'h1', 'h3', 'evening', 'tomorrow']);
  assert.equal(ks[0].at - morning.getTime(), 20 * 60_000);
  assert.equal(new Date(ks[3].at).getHours(), 20);
  const t = new Date(ks[4].at); assert.equal(t.getDate(), 24); assert.equal(t.getHours(), 9);
  assert.deepEqual(presets(new Date(2026, 10, 23, 19, 0)).map(p => p.k), ['m20', 'h1', 'h3', 'tomorrow']);
  assert.equal(new Date(presets(new Date(2026, 10, 30, 22, 0)).at(-1)!.at).getMonth(), 11, 'tomorrow crosses into the next month');
});
