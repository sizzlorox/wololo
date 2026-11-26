import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeWorktree } from '../src/core/worktree.js';

test('removeWorktree never throws when Windows still holds the folder (a process is running in it)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wololo-wt-'));
  const git = (/** @type {string[]} */ args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(root, 'a'), 'x');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  const dir = `${root}-wt`;
  git(['worktree', 'add', '-q', '-b', 'w', dir]);
  // a lingering tool (vitest, tsc, a language server) with its working directory in the worktree
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir });
  await new Promise((r) => setTimeout(r, 300));
  try {
    assert.doesNotThrow(() => removeWorktree(root, dir));
  } finally {
    holder.kill();
    await new Promise((r) => holder.on('close', r));
  }
  removeWorktree(root, dir); // once released, it goes
  assert.ok(!existsSync(dir));
});
