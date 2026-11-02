import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhatsApp } from './whatsapp.ts';

test('Android export: system lines are skipped and multi-line messages are joined', () => {
  const chat = parseWhatsApp([
    '12/05/2024, 14:32 - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
    '12/05/2024, 14:35 - ماما: الحمدلله رزقنا بمولود',
    'جديد اسمه أحمد',
    '13/05/2024, 09:10 - Khaled: <Media omitted>',
  ].join('\n'));
  assert.equal(chat.format, 'android');
  assert.equal(chat.dateOrder, 'dmy');
  assert.equal(chat.skippedSystem, 1);
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[0].sender, 'ماما');
  assert.equal(chat.messages[0].text, 'الحمدلله رزقنا بمولود\nجديد اسمه أحمد');
  assert.equal(chat.messages[0].date, '2024-05-12');
  assert.equal(chat.messages[0].time, '14:35');
  assert.equal(chat.messages[1].kind, 'media');
  assert.deepEqual(chat.range, { from: '2024-05-12', to: '2024-05-13' });
});

test('iPhone export: brackets, invisible marks, seconds, month-first dates and PM', () => {
  const chat = parseWhatsApp([
    '‎[5/28/24, 2:32:10 PM] Ali: Hello there',
    '‎[5/29/24, 9:05:00 AM] Sara: ‎<attached: 00000012-PHOTO-2024-05-29-09-05-00.jpg>',
    '‎[5/29/24, 12:10:00 AM] Sara: midnight',
  ].join('\n'));
  assert.equal(chat.format, 'ios');
  assert.equal(chat.dateOrder, 'mdy');
  assert.equal(chat.messages[0].date, '2024-05-28');
  assert.equal(chat.messages[0].time, '14:32');
  assert.equal(chat.messages[1].kind, 'media');
  assert.equal(chat.messages[1].file, '00000012-PHOTO-2024-05-29-09-05-00.jpg');
  assert.equal(chat.messages[2].time, '00:10', '12 AM is just after midnight');
});

test('Arabic digits, the Arabic comma and the sa/ma markers are understood', () => {
  const chat = parseWhatsApp('١٢‏/٠٥‏/٢٠٢٤، ٢:٣٥ م - خالد: تخرجت بنتي اليوم\n١٣/٠٥/٢٠٢٤، ٩:٠٥ ص - سارة: صباح الخير');
  assert.equal(chat.messages[0].date, '2024-05-12');
  assert.equal(chat.messages[0].time, '14:35');
  assert.equal(chat.messages[1].time, '09:05');
  assert.equal(chat.messages[0].text, 'تخرجت بنتي اليوم');
});

test('voice notes and deleted messages are recognised', () => {
  const chat = parseWhatsApp([
    '12/05/2024, 14:32 - أبو سعد: PTT-20240512-WA0003.opus (file attached)',
    '12/05/2024, 14:33 - أبو سعد: تم حذف هذه الرسالة',
    '12/05/2024, 14:34 - أبو سعد: IMG-20240512-WA0004.jpg (file attached)',
  ].join('\n'));
  assert.deepEqual(chat.messages.map(m => m.kind), ['voice', 'deleted', 'media']);
  assert.equal(chat.messages[0].file, 'PTT-20240512-WA0003.opus');
});

test('year-first dates, and day-first as the default when every date is ambiguous', () => {
  assert.equal(parseWhatsApp('2024/05/12 14:32 - A: x y z').messages[0].date, '2024-05-12');
  const ambiguous = parseWhatsApp('03/04/2024, 10:00 - A: hello there');
  assert.equal(ambiguous.dateOrder, 'dmy');
  assert.equal(ambiguous.messages[0].date, '2024-04-03');
});

test('senders are counted, busiest first', () => {
  const chat = parseWhatsApp('12/05/2024, 10:00 - A: one\n12/05/2024, 10:01 - B: two\n12/05/2024, 10:02 - B: three');
  assert.deepEqual(chat.senders, [{ name: 'B', count: 2 }, { name: 'A', count: 1 }]);
});

test('text that is not a chat export yields nothing', () => {
  const chat = parseWhatsApp('هذا ليس ملف محادثة\nولا سطر فيه تاريخ');
  assert.equal(chat.messages.length, 0);
  assert.equal(chat.format, 'unknown');
  assert.equal(chat.range, null);
});

test('an invalid date does not break the message before it', () => {
  const chat = parseWhatsApp('12/05/2024, 10:00 - A: first line\n45/45/2024, 10:00 - still the same message');
  assert.equal(chat.messages.length, 1);
  assert.match(chat.messages[0].text, /still the same message/);
});
