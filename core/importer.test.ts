import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhatsApp } from './whatsapp.ts';
import { buildDraft } from './importer.ts';

const history = [
  '01/03/2023, 08:00 - أبو سعد: صباح الخير جمعة مباركة',
  '01/03/2023, 08:01 - ماما: هلا',
  '02/03/2023, 19:30 - خالد: الحمدلله رزقنا بمولود جديد اسمه أحمد يوم الخميس، ألف مبروك لأخوي',
  '02/03/2023, 19:45 - سارة: مبروك المولود الجديد الله يبارك له ولكم',
  '02/03/2023, 20:00 - ماما: https://example.com/video',
  '15/06/2023, 21:00 - أبو سعد: إنا لله وإنا إليه راجعون، توفي جدي الليلة والعزاء غداً',
  '15/06/2023, 21:05 - أبو سعد: جمعة مباركة',
  '20/08/2023, 10:00 - سارة: <Media omitted>',
  '20/08/2023, 10:05 - سارة: وين نتقابل بكرة؟',
  '21/08/2023, 12:00 - خالد: تخرجت بنتي من الجامعة اليوم والحمدلله',
].join('\n');

test('the draft keeps real events with their real dates, and drops the noise', () => {
  const draft = buildDraft(parseWhatsApp(history).messages, 'medium');
  assert.deepEqual(draft.events.map(e => [e.date, e.category]), [
    ['2023-03-02', 'birth'],
    ['2023-06-15', 'passing'],
    ['2023-08-21', 'graduation'],
  ]);
  assert.equal(draft.stats.messages, 10);
  assert.equal(draft.stats.media, 1);
});

test('congratulations about the same event are merged into one', () => {
  const birth = buildDraft(parseWhatsApp(history).messages).events[0];
  assert.equal(birth.reactions, 1);
  assert.match(birth.summary, /^خالد: /);
});

test('a stricter circle keeps fewer events', () => {
  const messages = parseWhatsApp(history).messages;
  const strict = buildDraft(messages, 'strict').events.map(e => e.category);
  assert.ok(strict.length <= buildDraft(messages, 'medium').events.length);
  assert.ok(strict.includes('passing'), 'a death is never lost');
});

test('the same event a week later is a separate event', () => {
  const text = [
    '01/03/2023, 19:30 - خالد: الحمدلله رزقنا بمولود جديد اسمه أحمد يوم الخميس، ألف مبروك لأخوي',
    '09/03/2023, 19:30 - سعد: الحمدلله رزقنا بمولود جديد اسمه عمر يوم الجمعة، ألف مبروك لأخوي',
  ].join('\n');
  assert.equal(buildDraft(parseWhatsApp(text).messages).events.length, 2);
});

test('an empty or chatter-only history gives an empty draft', () => {
  assert.equal(buildDraft([]).events.length, 0);
  const chatter = '01/03/2023, 08:00 - A: صباح الخير\n01/03/2023, 08:01 - B: هلا\n01/03/2023, 08:02 - A: تمام';
  assert.equal(buildDraft(parseWhatsApp(chatter).messages).events.length, 0);
});
