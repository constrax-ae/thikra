// Every admin list must have a ceiling: a screen that works with 50 families must not fall over with 5 million. Reads the route sources and fails on any
// admin GET handler that queries a list (`all(`) without a LIMIT, unless it is on the short list of aggregates that return a handful of rows by construction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const BOUNDED_BY_CONSTRUCTION: Record<string, string> = {
  '/api/admin/stats': 'one row per category (a fixed list)',
  '/api/admin/analytics': 'one row per sealed status',
  '/api/admin/sms': 'one row per country code in the last 14 days (at most a few hundred)',
  '/api/admin/flags': 'a fixed list in code',
  '/api/admin/backups': 'at most the seven kept',
};
test('every admin GET list has a LIMIT (or is bounded by construction)', () => {
  const dir = new URL('./routes/', import.meta.url);
  const offenders: string[] = [];
  for (const f of readdirSync(dir).filter(f => f.startsWith('admin') || f === 'plans.ts' || f === 'support.ts' || f === 'agent.ts')) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const parts = src.split(/\n(?=app\.(?:get|post|patch|delete)\()/);
    for (const block of parts) {
      const m = block.match(/^app\.get\('(\/api\/admin\/[^']*)'/);
      if (!m || !/\ball\(/.test(block) || /LIMIT/i.test(block) || BOUNDED_BY_CONSTRUCTION[m[1]]) continue;
      offenders.push(`${f}: GET ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], 'add a LIMIT (and a cursor) or list the route above with the reason it is small');
});
