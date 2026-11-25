import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jpegHasApp1, kindOf, stripPng } from './metadata.ts';

const u8 = (...parts: Array<number[] | string>) => new Uint8Array(parts.flatMap(p => (typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: string) => u8(be32(data.length), type, data, [0, 0, 0, 0]);
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (...chunks: Uint8Array[]) => u8(SIG, ...chunks.map(c => [...c]));
const text = (b: Uint8Array) => String.fromCharCode(...b);

test('a PNG loses its EXIF and text chunks (where GPS and XMP live) and keeps its pixels', () => {
  const src = png(chunk('IHDR', 'header-bytes!'), chunk('eXIf', 'GPS 25.2048N 55.2708E'), chunk('iTXt', 'XMP:location=Dubai'), chunk('iCCP', 'colour-profile'), chunk('IDAT', 'pixels'), chunk('IEND', ''));
  const out = text(stripPng(src));
  assert.ok(!out.includes('GPS') && !out.includes('Dubai'), 'no location left');
  for (const kept of ['IHDR', 'header-bytes!', 'iCCP', 'IDAT', 'pixels', 'IEND']) assert.ok(out.includes(kept), `${kept} kept`);
  assert.equal(kindOf(stripPng(src)), 'png');
});

test('a PNG with nothing to remove comes back byte for byte; anything else is not touched', () => {
  const clean = png(chunk('IHDR', 'h'), chunk('IDAT', 'p'), chunk('IEND', ''));
  assert.deepEqual(stripPng(clean), clean);
  const jpeg = u8([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2]);
  assert.equal(stripPng(jpeg), jpeg);
  const broken = u8(SIG, be32(9999), 'IHDR');
  assert.equal(stripPng(broken), broken, 'a damaged file is left as it is');
});

test('a JPEG carrying EXIF or XMP is recognised (the app re-draws every camera photo, so none is sent with it)', () => {
  const withExif = u8([0xff, 0xd8], [0xff, 0xe0, 0, 4, 0, 0], [0xff, 0xe1, 0, 8], 'Exif\0\0', [0xff, 0xda, 0, 2]);
  const without = u8([0xff, 0xd8], [0xff, 0xe0, 0, 4, 0, 0], [0xff, 0xdb, 0, 4, 0, 0], [0xff, 0xda, 0, 2]);
  assert.equal(jpegHasApp1(withExif), true);
  assert.equal(jpegHasApp1(without), false);
  assert.equal(kindOf(withExif), 'jpeg');
});
