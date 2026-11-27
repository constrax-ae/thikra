import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startupMode } from './lib/mode.ts';

test('start-up says in one line which mode runs, and only explicit development mode is local-only', () => {
  const closed = startupMode({});
  assert.equal(closed.mode, 'closed');
  assert.match(closed.line, /THIKRA_DEV/);
  assert.equal(closed.localOnly, false);

  const dev = startupMode({ THIKRA_DEV: '1' });
  assert.equal(dev.mode, 'development');
  assert.match(dev.line, /DEVELOPMENT MODE.*anyone can sign in as anyone/);
  assert.equal(dev.localOnly, true, 'development mode listens on this computer only');

  const prod = startupMode({ NODE_ENV: 'production' });
  assert.equal(prod.mode, 'production');
  assert.equal(prod.localOnly, false);

  // a published Replit deployment is production too, and the dev flag never switches production into development
  assert.equal(startupMode({ REPLIT_DEPLOYMENT: '1', THIKRA_DEV: '1' }).mode, 'production');
  assert.equal(startupMode({ NODE_ENV: 'production', THIKRA_DEV: '1' }).mode, 'production');
});
