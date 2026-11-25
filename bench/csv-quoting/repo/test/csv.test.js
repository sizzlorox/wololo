import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toCsv } from '../src/csv.js';

test('plain fields', () => {
  assert.equal(toCsv([['a', 'b'], ['c', 'd']]).split(/\r?\n/)[1], 'c,d');
});
