import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('package-lock.json does not contain expr-eval (CVE-2026-12866)', () => {
  const lock = readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8');
  assert.ok(!lock.includes('expr-eval'));
});
