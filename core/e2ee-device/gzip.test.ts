// The phone compresses backups with fflate, the browser with CompressionStream: each must open the other's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'fflate';
import { gzip, gunzip } from './backup.ts';

test('phone gzip and browser gzip open each other', async () => {
  const data = new TextEncoder().encode('ذكرى '.repeat(5000) + JSON.stringify({ k: [1, 2, 3] }));
  assert.deepEqual(gunzipSync(await gzip(data)), data);      // browser-made, phone-opened
  assert.deepEqual(await gunzip(gzipSync(data)), data);      // phone-made, browser-opened
});
