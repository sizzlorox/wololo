import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('counts words', () => {
  const r = spawnSync(process.execPath, ['bin/wc.js'], { input: 'one two  three\n', encoding: 'utf8' });
  assert.equal(r.stdout, '3\n');
});
