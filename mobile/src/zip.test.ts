import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openZipFrom } from './zip.ts';
import { parseWhatsApp } from '../../core/whatsapp.ts';
import { planAlbum, zipResolver } from '../../core/album.ts';

// The phone's zip reader, run against a real zip (made by the system `zip` tool) instead of a FileHandle.
// A small export like WhatsApp's: the chat text and one photo it names, zipped (deflated) by the system's zip.
const dir = mkdtempSync(join(tmpdir(), 'wa-'));
writeFileSync(join(dir, 'WhatsApp Chat with Family.txt'), '12/03/2024, 10:15 - Sara: Our daughter Layla was born this morning, mother and baby are well\n12/03/2024, 10:16 - Ahmed: Mabrook!\n12/03/2024, 10:17 - Sara: IMG-20240312-WA0001.jpg (file attached)\n');
writeFileSync(join(dir, 'IMG-20240312-WA0001.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000, 'x'), Buffer.from([0xff, 0xd9])]));
execFileSync('zip', ['-q', 'export.zip', 'WhatsApp Chat with Family.txt', 'IMG-20240312-WA0001.jpg'], { cwd: dir });
const path = join(dir, 'export.zip');
test('reads a WhatsApp export zip on the phone: the chat text, the plan, and an inflated photo', async () => {
  const buf = readFileSync(path);
  const z = await openZipFrom({ size: buf.length, readAt: async (a, b) => new Uint8Array(buf.subarray(a, b)), close: () => {} });
  const txt = [...z.entries.values()].find(e => /\.txt$/i.test(e.name))!;
  const chat = parseWhatsApp(await z.text(txt.name));
  assert.equal(chat.messages.length, 3);
  const plan = planAlbum(chat.messages, zipResolver(z.entries.keys()));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].kind, 'image');
  const img = await z.read(plan.items[0].entry);
  assert.equal(img.length, 5006);
  assert.deepEqual([...img.subarray(0, 3)], [0xff, 0xd8, 0xff]);
});
