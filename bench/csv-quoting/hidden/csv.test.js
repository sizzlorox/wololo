import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toCsv } from '../src/csv.js';

test('CRLF between records', () => {
  assert.equal(toCsv([['a', 'b'], ['c', 'd']]), 'a,b\r\nc,d');
});

test('quotes fields with separators, quotes and newlines', () => {
  assert.equal(toCsv([['x,y', 'say "hi"', 'line1\nline2', 'cr\rhere']]), '"x,y","say ""hi""","line1\nline2","cr\rhere"');
});

test('null, undefined, numbers and booleans', () => {
  assert.equal(toCsv([[null, undefined, 0, false, 1.5]]), ',,0,false,1.5');
});

test('empty input', () => {
  assert.equal(toCsv([]), '');
  assert.equal(toCsv([['']]), '');
});
