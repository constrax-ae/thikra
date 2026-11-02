process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-routes-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');

/** The ordered list of every registered route (middleware included). Order matters in Hono (the first match wins), so splitting the server
 * into modules must not change it. To change it on purpose: UPDATE_ROUTES=1 pnpm test, and review the diff of server/routes.snapshot.json. */
const SNAPSHOT = new URL('./routes.snapshot.json', import.meta.url);
const current = app.routes.map(r => `${r.method} ${r.path}`);

test('the registered routes and their order are exactly the committed snapshot', () => {
  if (process.env.UPDATE_ROUTES === '1' || !existsSync(SNAPSHOT)) { writeFileSync(SNAPSHOT, JSON.stringify(current, null, 1) + '\n'); return; }
  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as string[];
  assert.deepEqual(current, expected);
});
