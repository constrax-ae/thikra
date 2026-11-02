// A route file registers its routes when it is first imported, and the sign-in check is registered by routes/pin.ts. A library module that imports a route file
// would register those routes BEFORE the check and leave them without a user (found the hard way: support replies returned 500). So: lib never imports routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('no module in server/lib imports a route file', () => {
  const dir = new URL('./lib/', import.meta.url);
  const bad = readdirSync(dir).filter(f => f.endsWith('.ts')).filter(f => /from\s+['"]\.\.\/routes\//.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(bad, []);
});
