import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const wc = (args, input) => spawnSync(process.execPath, ['bin/wc.js', ...args], { input, encoding: 'utf8' });

test('words by default', () => {
  assert.equal(wc([], 'one two  three\n').stdout, '3\n');
  assert.equal(wc([], '').stdout, '0\n');
});

test('--lines', () => {
  assert.equal(wc(['--lines'], 'a\nb\n').stdout, '2\n');
  assert.equal(wc(['--lines'], 'a\nb').stdout, '2\n');
  assert.equal(wc(['--lines'], '').stdout, '0\n');
  assert.equal(wc(['--lines'], '\n\n').stdout, '2\n');
});

test('--chars counts code points', () => {
  assert.equal(wc(['--chars'], 'héllo').stdout, '5\n');
  assert.equal(wc(['--chars'], '👍🏽a').stdout, '3\n');
});

test('unknown flags: usage on stderr, exit 2', () => {
  const r = wc(['--bogus'], 'x');
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /usage/i);
});
