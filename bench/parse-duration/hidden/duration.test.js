import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDuration } from '../src/duration.js';

test('existing units still work', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('5m'), 300_000);
});

test('hours and days', () => {
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1d'), 86_400_000);
});

test('combined units in descending order', () => {
  assert.equal(parseDuration('1d2h30m'), 95_400_000);
  assert.equal(parseDuration('1h0m5s'), 3_605_000);
});

test('malformed input throws RangeError', () => {
  for (const bad of ['', 'h', '5', '5x', '1m1h', '1h1h', '-5m', '1.5h', ' 5m']) assert.throws(() => parseDuration(bad), RangeError, JSON.stringify(bad));
});
