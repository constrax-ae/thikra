process.env.THIKRA_DB = ':memory:';
process.env.THIKRA_NO_LISTEN = '1';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const work = mkdtempSync(join(tmpdir(), 'thikra-oa-'));
process.env.THIKRA_BLOBS = join(work, 'blobs');
process.env.THIKRA_BACKUPS = join(work, 'backups');

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { app } = await import('./index.ts');
const { buildSpec, operations } = await import('../scripts/openapi.ts');

const notes = JSON.parse(readFileSync(new URL('../docs/api-notes.json', import.meta.url), 'utf8'));
const committed = JSON.parse(readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
const spec = buildSpec(app.routes, notes);

test('docs/openapi.json is exactly what the server registers (run `pnpm openapi` after adding or changing a route)', () => {
  assert.deepEqual(committed, JSON.parse(JSON.stringify(spec)));
});

test('every route the server registers is in the contract, and no note describes a route that is gone', () => {
  const keys = new Set(operations(app.routes).map(o => o.key));
  const inSpec = Object.entries(spec.paths).flatMap(([p, ms]) => Object.keys(ms as object).map(m => `${m.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ':$1')}`));
  assert.deepEqual([...keys].sort(), inSpec.sort());
  assert.deepEqual(Object.keys(notes).filter(k => !keys.has(k)), [], 'stale notes in docs/api-notes.json');
});

test('the core endpoints a mobile client needs are all described (summary and shapes)', () => {
  const core = ['POST /api/auth/request', 'POST /api/auth/verify', 'POST /api/auth/pin', 'GET /api/me', 'GET /api/circles', 'GET /api/circles/:id/messages', 'POST /api/circles/:id/messages', 'POST /api/circles/:id/read', 'POST /api/direct'];
  for (const k of core) assert.ok(notes[k]?.summary, `${k} needs a note`);
  for (const k of ['POST /api/auth/request', 'POST /api/auth/verify', 'POST /api/circles/:id/messages']) assert.ok(notes[k].request && notes[k].response, `${k} needs request and response shapes`);
});

test('the sign-in endpoints are public and every other endpoint needs the session cookie', () => {
  const pub = Object.entries(spec.paths).flatMap(([p, ms]) => Object.entries(ms as Record<string, any>).filter(([, o]) => Array.isArray(o.security) && o.security.length === 0).map(([m]) => `${m.toUpperCase()} ${p}`));
  assert.deepEqual(pub.sort(), ['GET /api/app-config', 'GET /healthz', 'POST /api/stripe/webhook', 'POST /api/auth/logout', 'POST /api/auth/pin', 'POST /api/auth/pin-forgot', 'POST /api/auth/request', 'POST /api/auth/verify'].sort());
});
