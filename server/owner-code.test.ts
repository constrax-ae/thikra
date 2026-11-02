import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
process.env.THIKRA_ADMIN_PHONES = '+971500770001';
process.env.THIKRA_OWNER_CODE = '482913';
const { checkOtp } = await import('./lib/auth.ts');
const { app } = await import('./index.ts');

const request = (phone: string) => app.request('/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone }) });

test('an admin number signs in with the fixed owner code; other numbers cannot use it', async () => {
  assert.equal((await request('+971500770001')).status, 200);
  assert.equal(checkOtp('+971500770001', '000000'), 'wrong_code');
  assert.equal(checkOtp('+971500770001', '482913'), 'ok');
  assert.equal((await request('+971500770002')).status, 200);
  assert.equal(checkOtp('+971500770002', '482913'), 'wrong_code');
});

test('without a requested code the owner code does nothing', () => {
  assert.equal(checkOtp('+971500770001', '482913'), 'code_expired');
});
