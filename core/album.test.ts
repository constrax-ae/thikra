import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhatsApp } from './whatsapp.ts';
import { planAlbum, zipResolver, kindOfFile, defaultAlbumTitle } from './album.ts';

const android = [
  '12/05/2022, 14:32 - Ahmad: IMG-20220512-WA0001.jpg (file attached)',
  '12/05/2022, 14:33 - Ahmad: PTT-20220512-WA0002.opus (file attached)',
  '20/01/2023, 09:10 - Sara: VID-20230120-WA0003.mp4 (file attached)',
  '21/01/2023, 09:11 - Sara: IMG-20230121-WA0004.jpg (file attached)',
  '21/01/2023, 09:12 - Sara: DOC-20230121-WA0005.pdf (file attached)',
  '03/03/2024, 18:00 - Naser: Congratulations on the new baby!',
  '03/03/2024, 18:01 - Naser: IMG-20240303-WA0006.jpg (file attached)',
  '03/03/2024, 18:02 - Naser: PTT-20240303-WA0007.opus (file attached)',
].join('\n');

test('what is in the album: pictures and voices (videos too), counted per year, only files that are really in the export', () => {
  const chat = parseWhatsApp(android);
  const zipNames = ['WhatsApp Chat.txt', 'IMG-20220512-WA0001.jpg', 'PTT-20220512-WA0002.opus', 'VID-20230120-WA0003.mp4', 'media/IMG-20240303-WA0006.jpg', 'PTT-20240303-WA0007.opus'];
  const plan = planAlbum(chat.messages, zipResolver(zipNames));
  assert.deepEqual(plan.range, { from: '2022-05-12', to: '2024-03-03' });
  assert.deepEqual(plan.years.map(y => [y.year, y.image, y.voice, y.video]), [[2022, 1, 1, 0], [2023, 0, 0, 1], [2024, 1, 1, 0]]);
  assert.equal(plan.items.length, 5);
  assert.equal(plan.missing, 1, 'IMG-20230121 is named in the chat but not in the zip');
  assert.equal(plan.notKept, 1, 'the PDF is not album material');
  assert.equal(plan.items.find(i => i.file === 'IMG-20240303-WA0006.jpg')!.entry, 'media/IMG-20240303-WA0006.jpg', 'a file inside a folder is found by its base name');
  assert.deepEqual(plan.items[0], { file: 'IMG-20220512-WA0001.jpg', entry: 'IMG-20220512-WA0001.jpg', kind: 'image', takenAt: '2022-05-12 14:32', day: '2022-05-12', year: 2022, sender: 'Ahmad' });
  assert.equal(plan.years.find(y => y.year === 2024)!.messages, 3);
});

test('an export without media still gives the range and the years, and an empty album', () => {
  const plan = planAlbum(parseWhatsApp(android).messages, () => undefined);
  assert.equal(plan.items.length, 0);
  assert.equal(plan.missing, 6);
  assert.deepEqual(plan.years.map(y => y.year), [2022, 2023, 2024]);
});

test('file kinds by name, matching ignores case and direction marks, and the default album title covers the period', () => {
  assert.deepEqual(['a.JPG', 'a.opus', 'a.m4a', 'a.mp4', 'a.pdf', 'a.heic', 'a.amr', 'a.vcf'].map(kindOfFile), ['image', 'voice', 'voice', 'video', null, null, null, null]);
  assert.equal(zipResolver(['Folder/img-1.JPG'])('‎IMG-1.jpg'), 'Folder/img-1.JPG');
  assert.equal(defaultAlbumTitle({ from: '2019-01-02', to: '2024-03-03' }, 'ar'), 'ألبوم واتساب 2019–2024');
  assert.equal(defaultAlbumTitle({ from: '2024-01-02', to: '2024-03-03' }, 'en'), 'WhatsApp album 2024');
});

test('Arabic exports name their files too (Android "(الملف مرفق)", iPhone "<مرفق: ...>")', () => {
  const chat = parseWhatsApp([
    '12/05/2024، 2:32 م - أحمد: IMG-20240512-WA0001.jpg (الملف مرفق)',
    '[12/05/24, 2:33:10 PM] سارة: \u200e<مرفق: 00000012-PHOTO-2024-05-12-14-33-10.jpg>',
    '[12/05/24, 2:34:10 PM] سارة: \u200e<attached: 00000013-AUDIO-2024-05-12-14-34-10.opus>',
  ].join('\n'));
  const files = chat.messages.map(m => m.file);
  assert.deepEqual(files, ['IMG-20240512-WA0001.jpg', '00000012-PHOTO-2024-05-12-14-33-10.jpg', '00000013-AUDIO-2024-05-12-14-34-10.opus']);
  assert.deepEqual(chat.messages.map(m => m.kind), ['media', 'media', 'voice']);
});
