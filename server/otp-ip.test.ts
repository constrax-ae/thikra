process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_TRUST_PROXY = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.THIKRA_BLOBS = mkdtempSync(join(tmpdir(), 'thikra-blobs-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');

test('one address cannot ask for more than 30 codes an hour (even with different numbers); others are unaffected', async () => {
  const ask = (phone: string, ip: string) => app.request('/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 10.0.0.1` }, body: JSON.stringify({ phone }) });
  const statuses: number[] = [];
  for (let i = 0; i < 32; i++) statuses.push((await ask(`+9665001${String(10_000 + i)}`, '203.0.113.7')).status);
  assert.equal(statuses.filter(s => s === 200).length, 30);
  assert.deepEqual(statuses.slice(30), [429, 429]);
  assert.equal((await ask('+966500199999', '198.51.100.9')).status, 200, 'a different address is not affected');
});
