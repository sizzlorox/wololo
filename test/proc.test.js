import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from '../src/core/proc.js';

test('proc keeps child_process call shapes and the caller\'s options (windowsHide is only a default)', async () => {
  const withArgs = spawnSync(process.execPath, ['-e', 'process.stdout.write("a")'], { encoding: 'utf8' });
  assert.equal(withArgs.stdout, 'a');
  const noArgs = spawnSync(`"${process.execPath}" -e "process.stdout.write('b')"`, { shell: true, encoding: 'utf8' });
  assert.equal(noArgs.stdout, 'b', 'spawnSync(command, options) still works');
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("c")']);
  let out = '';
  child.stdout?.on('data', (b) => (out += b));
  await new Promise((r) => child.on('close', r));
  assert.equal(out, 'c');
});
