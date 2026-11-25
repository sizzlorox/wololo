import assert from 'node:assert/strict';
import { test } from 'node:test';
import { range } from '../src/range.js';

test('steps by two', () => {
  assert.deepEqual(range(0, 6, 2).slice(0, 3), [0, 2, 4]);
});
