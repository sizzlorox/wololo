import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDuration } from '../src/duration.js';

test('seconds and minutes', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('5m'), 300_000);
});
