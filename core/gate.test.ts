import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate } from './gate.ts';
import { normalize } from './agent.ts';

const dropped = (text: string, reason: string, recent?: string[]) => {
  const r = gate(text, { recent });
  assert.equal(r.pass, false, text);
  assert.equal(r.reason, reason, text);
};

test('structural noise never reaches the AI', () => {
  dropped('😂😂😂', 'no_text');
  dropped('12345', 'no_text');
  dropped('https://example.com/watch?v=abc', 'link_only');
  dropped('جمعة مباركة 🌹', 'chain_message');
  dropped('صباح الخير جمعة مباركة تقبل الله طاعاتكم', 'chain_message');
});

test('a message with no event, question or time signal is dropped', () => {
  dropped('تمام الحمدلله وانتم كيف الحال', 'no_signal');
});

test('death and illness bypass every filter, even inside a chain message', () => {
  assert.deepEqual(gate('توفي جدي الليلة والعزاء غداً').routes, ['archive']);
  const r = gate('اللهم ارحمه جمعة مباركة وعزاء');
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'sensitive');
  assert.equal(gate('الحمدلله على السلامة خرجت من المستشفى').pass, true);
});

test('routes tell consumers what the message is for', () => {
  assert.deepEqual(gate('الحمدلله رزقنا بمولود جديد').routes, ['archive']);
  assert.deepEqual(gate('متى تجي عندنا؟').routes, ['reply']);
  assert.ok(gate('نلتقي بكرة الساعة 8').routes.includes('schedule'));
  assert.deepEqual(gate('ممكن ترسل لي الصور بكرة؟').routes.sort(), ['reply', 'schedule']);
});

test('the same text repeated is treated as noise', () => {
  const t = 'الله يسلمكم يا اهل البيت';
  const recent = [normalize(t), normalize(t)];
  dropped(`${t} وزيادة`, 'no_signal', recent); // different text is judged on its own
  const spam = 'تذكير بموعد الاجتماع الاسبوعي لكل الاعضاء';
  assert.equal(gate(spam).pass, true);
  dropped(spam, 'repeated', [normalize(spam), normalize(spam)]);
});
