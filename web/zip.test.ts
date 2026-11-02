import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { openZip } from './src/zip.ts';

const photo = new Uint8Array(5000).map((_, i) => (i * 7) % 251);

test('reads stored and deflated entries from a zip, by name, without unpacking the rest', async () => {
  const zip = zipSync({
    'WhatsApp Chat - Family.txt': [strToU8('12/05/2024, 14:32 - Naser: مرحبا\n'.repeat(200)), { level: 6 }],
    'IMG-20240512-WA0001.jpg': [photo, { level: 0 }],
    'PTT-20240512-WA0002.opus': [photo.slice(0, 900), { level: 9 }],
    'صورة-العائلة.jpg': [photo.slice(0, 100), { level: 0 }],
  });
  const z = await openZip(new Blob([zip]));
  assert.deepEqual([...z.entries.keys()].sort(), ['IMG-20240512-WA0001.jpg', 'PTT-20240512-WA0002.opus', 'WhatsApp Chat - Family.txt', 'صورة-العائلة.jpg'].sort());
  assert.match(await z.text('WhatsApp Chat - Family.txt'), /^12\/05\/2024, 14:32 - Naser: مرحبا/);
  assert.deepEqual(new Uint8Array(await (await z.read('IMG-20240512-WA0001.jpg')).arrayBuffer()), photo);
  assert.deepEqual(new Uint8Array(await (await z.read('PTT-20240512-WA0002.opus')).arrayBuffer()), photo.slice(0, 900));
  assert.equal((await z.read('صورة-العائلة.jpg')).size, 100, 'a non-ASCII file name');
  assert.ok(z.entries.get('WhatsApp Chat - Family.txt')!.method === 8 && z.entries.get('IMG-20240512-WA0001.jpg')!.method === 0);
  await assert.rejects(() => z.read('nope.jpg'), /not in the zip/);
});

test('a zip with a comment and many entries is read, and a file that is not a zip is refused', async () => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < 300; i++) files[`IMG-${i}.jpg`] = photo.slice(0, 64 + i);
  const zip = zipSync(files, { level: 0, comment: 'x'.repeat(500) } as never);
  const z = await openZip(new Blob([zip]));
  assert.equal(z.entries.size, 300);
  assert.equal((await z.read('IMG-299.jpg')).size, 363);
  await assert.rejects(() => openZip(new Blob([strToU8('this is plainly not a zip file at all, just text')])), /not a zip/);
  await assert.rejects(() => openZip(new Blob([strToU8('tiny')])), /not a zip/);
});
