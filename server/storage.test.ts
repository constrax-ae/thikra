import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localBlobStore } from './storage.ts';

const store = () => localBlobStore(mkdtempSync(join(tmpdir(), 'thikra-store-')));

test('a blob round-trips, and identical bytes get the same key', async () => {
  const s = store();
  const a = await s.put(Buffer.from('ذكرى'));
  const b = await s.put(Buffer.from('ذكرى'));
  assert.equal(a.hash, b.hash);
  assert.equal(a.size, Buffer.from('ذكرى').length);
  assert.equal((await s.get(a.hash))?.toString(), 'ذكرى');
});

test('different bytes get different keys', async () => {
  const s = store();
  assert.notEqual((await s.put(Buffer.from('a'))).hash, (await s.put(Buffer.from('b'))).hash);
});

test('keys that are not a real hash never touch the disk', async () => {
  const s = store();
  assert.equal(await s.get('../../etc/passwd'), null);
  assert.equal(await s.get('a'.repeat(63)), null);
  assert.equal(await s.get('a'.repeat(64)), null); // well-formed but absent
});
