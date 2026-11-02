import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMoment, isReconciliation, momentText, type WindowMessage } from './moments.ts';

const quiet = { members: 6, baselinePer15: 0 };
const long = (s: string) => `${s} وهذا كلام طويل نوعا ما حتى يعتبر نقاشا حقيقيا بين الطرفين في القروب`;

const exchange = (lines: string[]): WindowMessage[] => lines.map((t, i) => ({ userId: i % 2 === 0 ? 1 : 2, text: long(t) }));

test('too few messages is never a moment', () => {
  assert.equal(detectMoment([{ userId: 1, text: 'هههههه' }, { userId: 2, text: '😂' }], quiet), null);
});

test('many members laughing in a short window is a funny moment', () => {
  const win: WindowMessage[] = [
    { userId: 1, text: 'شفتوا وش صار لخالد' }, { userId: 2, text: '😂😂😂' }, { userId: 3, text: 'ههههههه' },
    { userId: 4, text: 'مت من الضحك' }, { userId: 1, text: 'والله صدق' }, { userId: 2, text: 'يا ساتر' },
  ];
  const m = detectMoment(win, quiet);
  assert.equal(m?.kind, 'funny');
  assert.deepEqual(m?.parties.sort(), [2, 3, 4]);
});

test('two people writing at length is a heated debate', () => {
  const m = detectMoment(exchange(['رايي ان نسافر بالسيارة', 'لا الطيارة اريح', 'السيارة ارخص', 'الطيارة اسرع', 'نجرب السيارة', 'ما اظن']), quiet);
  assert.equal(m?.kind, 'debate');
  assert.deepEqual(m?.parties.sort(), [1, 2]);
});

test('tension markers turn a debate into a conflict', () => {
  const m = detectMoment(exchange(['انت غلطان في كل شي', 'كذاب والله', 'لا تكلمني بهالطريقة', 'ما تفهم ابدا', 'قليل ادب', 'اسكت']), quiet);
  assert.equal(m?.kind, 'conflict');
  assert.equal(m?.anonymous, false);
});

test('a sensitive topic: debates are dropped, conflicts lose the names', () => {
  const calm = detectMoment(exchange(['موضوع الميراث لازم نتفاهم', 'اكيد', 'نقسم بالتساوي', 'ما اوافق', 'نشوف المحامي', 'تمام']), quiet);
  assert.equal(calm, null);
  const tense = detectMoment(exchange(['الميراث حقي وانت كذاب', 'اسكت', 'ما تفهم', 'غلطان', 'ما اطيقك', 'ابعد عني']), quiet);
  assert.equal(tense?.kind, 'conflict');
  assert.equal(tense?.anonymous, true);
});

test('a circle that is always busy needs a bigger burst', () => {
  const win = exchange(['انت غلطان', 'كذاب', 'اسكت', 'ما تفهم', 'قليل ادب', 'ابعد عني']);
  assert.equal(detectMoment(win, { members: 6, baselinePer15: 10 }), null);
});

test('reconciliation words are recognised', () => {
  assert.ok(isReconciliation('سامحني يا اخوي ما كان قصدي'));
  assert.ok(isReconciliation('الله يسامحك وتصافينا'));
  assert.equal(isReconciliation('وين نتقابل بكرة'), false);
});

test('conflict wording follows the agreed hint, without cause or blame', () => {
  const open = momentText('conflict', ['خالد', 'سعد'], false, 'open');
  assert.equal(open.text, 'حدث خلاف بين خالد وسعد، وكان الجو متوتراً في القروب. نتمنى أن ينتهي وتعود المحبة.');
  assert.equal(momentText('conflict', ['خالد', 'سعد'], false, 'resolved').title, 'خلاف ثم صلح');
  assert.match(momentText('conflict', ['خالد', 'سعد'], false, 'faded').text, /تعدّت المشكلة/);
  assert.match(momentText('conflict', ['خالد', 'سعد'], true).text, /بين أفراد من العائلة/);
});
