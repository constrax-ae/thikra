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

test('production with the console SMS provider still starts, warns, and never prints a phone number or code to the log', async () => {
  const line = startupMode({ NODE_ENV: 'production' }, 'console').line;
  assert.match(line, /WARNING: no SMS provider/);
  assert.doesNotMatch(startupMode({ NODE_ENV: 'production' }, 'twilio').line, /WARNING/, 'a real provider gives no warning');
  const { consoleProvider } = await import('./sms.ts');
  const logged: string[] = [];
  const was = console.log, env = process.env.NODE_ENV;
  console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    process.env.NODE_ENV = 'production';
    await consoleProvider.send('+971501234567', 'Your Tamtim code is 482913');
    process.env.NODE_ENV = 'test';
    await consoleProvider.send('+971501234567', 'Your Tamtim code is 482913');
  } finally { console.log = was; if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env; }
  assert.doesNotMatch(logged[0], /482913|501234/, 'production hides the code and the number');
  assert.match(logged[0], /\+971•+67/);
  assert.match(logged[1], /482913/, 'outside production the log is how a developer signs in');
});
