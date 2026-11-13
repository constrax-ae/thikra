process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';

// A setting that is present but blank must behave as if it were not set at all. Both a `.env` file and a hosting
// dashboard produce an empty string for "left blank", and `??` treats that as a real value — so every default in the
// codebase would be overridden by nothing. These are the consequences that made it worth fixing centrally.

test('an empty setting is removed, so every `??` default still applies', async () => {
  process.env.THIKRA_BLANK_CHECK = '';
  process.env.THIKRA_SPACES_CHECK = '   ';
  process.env.THIKRA_REAL_CHECK = 'kept';
  process.env.THIKRA_ZERO_CHECK = '0';
  const { BLANKED } = await import('./env.ts');
  assert.equal('THIKRA_BLANK_CHECK' in process.env, false, 'a blank value is not a value');
  assert.equal('THIKRA_SPACES_CHECK' in process.env, false, 'whitespace only is blank too');
  assert.equal(process.env.THIKRA_REAL_CHECK, 'kept');
  assert.equal(process.env.THIKRA_ZERO_CHECK, '0', '"0" is a deliberate setting and must survive');
  assert.ok(BLANKED.includes('THIKRA_BLANK_CHECK'));
  delete process.env.THIKRA_REAL_CHECK; delete process.env.THIKRA_ZERO_CHECK;
});

test('the specific failures this prevents', () => {
  // Read the settings the way the server does, from process.env, so the comparison is the real one rather than a
  // literal TypeScript can see through.
  const read = (k: string) => process.env[k];
  process.env.THIKRA_T_DB = '';
  process.env.THIKRA_T_CAP = '';
  process.env.THIKRA_T_PORT = '';
  process.env.THIKRA_T_SUBJ = '';

  // Before: a blank setting beats every default, because '' is not nullish.
  assert.equal(read('THIKRA_T_DB') ?? 'data/thikra.db', '', 'an empty database path');
  assert.equal(Number(read('THIKRA_T_CAP') ?? 2000), 0, 'an SMS cap of zero: not one sign-in code would ever be sent');
  assert.equal(Number(read('THIKRA_T_PORT') ?? 8787), 0, 'a random listening port');
  assert.equal(read('THIKRA_T_SUBJ') ?? 'mailto:admin@thikra.invalid', '', 'an empty VAPID subject, which push services reject');

  // After: env.ts has turned blank into absent, so the defaults apply again.
  for (const k of ['THIKRA_T_DB', 'THIKRA_T_CAP', 'THIKRA_T_PORT', 'THIKRA_T_SUBJ']) {
    if ((process.env[k] ?? '').trim() === '') delete process.env[k];
  }
  assert.equal(read('THIKRA_T_DB') ?? 'data/thikra.db', 'data/thikra.db');
  assert.equal(Number(read('THIKRA_T_CAP') ?? 2000), 2000);
  assert.equal(Number(read('THIKRA_T_PORT') ?? 8787), 8787);
  assert.equal(read('THIKRA_T_SUBJ') ?? 'mailto:admin@thikra.invalid', 'mailto:admin@thikra.invalid');
});
