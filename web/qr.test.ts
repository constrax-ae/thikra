// The picture (QR code) of the link and of the safety number: made on the device by `uqr` (MIT) and read, where the browser has no BarcodeDetector, by `jsqr` (Apache-2.0).
// This test makes real pictures and reads them back with the fallback reader, so the two libraries are proven to agree on what we print.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { qrMatrix, qrSvg } from './src/e2ee/qr.ts';

function raster(m: boolean[][], scale = 6, quiet = 4) {
  const n = m.length + quiet * 2, size = n * scale, px = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
  return { px, size };
}
const texts = ['tamtim-link:1:12:' + 'A'.repeat(43) + ':' + 'B'.repeat(16) + ':' + 'C'.repeat(22), 'tamtim-safety:1:' + '0123456789'.repeat(6), 'tamtim-link:1:7:abc_-xyz'];

test('a picture made by our generator is read back exactly by the fallback reader', () => {
  for (const t of texts) {
    const { px, size } = raster(qrMatrix(t));
    const got = jsQR(px, size, size, { inversionAttempts: 'dontInvert' });
    assert.equal(got?.data, t);
  }
});

test('the svg is a real picture of the same matrix and carries no text of the payload', () => {
  const svg = qrSvg(texts[0]);
  assert.match(svg, /^<svg[^>]+viewBox=/);
  assert.equal(svg.includes('tamtim'), false);
  assert.equal(svg.includes('AAAA'), false);
});

test('a picture that is not ours reads as nothing we accept', async () => {
  const { parseLinkPayload, parseSafetyPayload } = await import('./src/e2ee/qr.ts');
  assert.equal(parseLinkPayload('hello'), null);
  assert.equal(parseLinkPayload('tamtim-link:1:x:AAAA'), null);
  assert.deepEqual(parseLinkPayload(texts[0]), { deviceId: 12, pub: 'A'.repeat(43), tag: 'B'.repeat(16), secret: 'C'.repeat(22) });
  assert.equal(parseSafetyPayload('tamtim-safety:1:12'), null);
  assert.equal(parseSafetyPayload(texts[1]), '0123456789'.repeat(6));
});
