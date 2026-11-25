import assert from 'node:assert/strict';
import { test } from 'node:test';
import { range } from '../src/range.js';

test('end is inclusive', () => {
  assert.deepEqual(range(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(range(0, 6, 2), [0, 2, 4, 6]);
  assert.deepEqual(range(0, 5, 2), [0, 2, 4]);
  assert.deepEqual(range(3, 3), [3]);
});

test('negative steps count down', () => {
  assert.deepEqual(range(5, 1, -2), [5, 3, 1]);
  assert.deepEqual(range(2, -2, -1), [2, 1, 0, -1, -2]);
});

test('step 0 throws; steps away from the end give nothing', () => {
  assert.throws(() => range(1, 5, 0), RangeError);
  assert.deepEqual(range(1, 5, -1), []);
  assert.deepEqual(range(5, 1), []);
});
