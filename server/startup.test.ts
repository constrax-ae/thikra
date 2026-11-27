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

test('production refuses to start with the console SMS provider (it prints phone and code to the log), unless development is switched on', () => {
  assert.match(startupMode({ NODE_ENV: 'production' }, 'console').refuse ?? '', /console/);
  assert.match(startupMode({ REPLIT_DEPLOYMENT: '1' }, 'console').refuse ?? '', /THIKRA_SMS_PROVIDER/);
  assert.equal(startupMode({ NODE_ENV: 'production' }, 'twilio').refuse, undefined, 'a real provider is fine');
  assert.equal(startupMode({ NODE_ENV: 'production' }, 'http').refuse, undefined);
  assert.equal(startupMode({}, 'console').refuse, undefined, 'outside production the console provider is the normal one');
  assert.equal(startupMode({ NODE_ENV: 'production', THIKRA_DEV: '1' }, 'console').refuse, undefined, 'the dev flag is the explicit way out');
  assert.equal(startupMode({ NODE_ENV: 'production', THIKRA_SHOW_SIGNIN_CODES: '1' }, 'console').refuse, undefined, 'so is the loud "no SMS provider yet" switch');
});
