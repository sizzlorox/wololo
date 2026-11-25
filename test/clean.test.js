import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { statePath } from '../src/core/state.js';
import { writeTask } from '../src/features/board/store.js';
import { clean } from '../src/features/clean/clean.js';
import { git, repo, setup } from './helpers/autopilot-fixture.js';

const MB = 1024 * 1024;
const old = (/** @type {string} */ f) => utimesSync(f, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000));

test('clean rotates big logs, caps transcripts, removes stale temp files, locks, worker files and merged worktrees', () => {
  setup();
  const s = (/** @type {string[]} */ ...p) => statePath(repo, ...p);
  mkdirSync(s('runs'), { recursive: true });
  mkdirSync(s('workers'), { recursive: true });
  mkdirSync(s('board'), { recursive: true });
  // a log over the cap: keep its newest end
  writeFileSync(s('autopilot.log'), `${'old line\n'.repeat(700_000)}NEWEST LINE\n`);
  // transcripts over the size cap: oldest go first
  for (let i = 0; i < 6; i++) writeFileSync(s('runs', `2026-01-0${i + 1}T00-00-00-000Z-1-builder.jsonl`), `${JSON.stringify({ kind: 'note', text: 'builder', at: '' })}\n${'x'.repeat(4 * MB)}\n`);
  // stale temp file and a lock for a task nobody claims
  writeFileSync(s('autopilot.json.123.tmp'), '{}');
  old(s('autopilot.json.123.tmp'));
  writeFileSync(s('fresh.json.9.tmp'), '{}');
  const now = new Date().toISOString();
  writeTask(repo, { id: 'g-01', title: 'Done step', group: 'g', body: '', status: 'done', queue: [], notes: [], seq: 1, created: now, updated: now });
  writeTask(repo, { id: 'g-02', title: 'Open step', group: 'g', body: '', status: 'claimed', agent: 'autopilot:x', queue: [], notes: [], seq: 2, created: now, updated: now });
  writeFileSync(s('board', 'g-01.lock'), '');
  writeFileSync(s('board', 'g-02.lock'), '');
  writeFileSync(s('workers', 'g-01.log'), 'done worker');
  writeFileSync(s('workers', 'g-02.log'), 'open worker');
  // a merged step's worktree and branch, and an unmerged one
  const trees = join(dirname(repo), `.${basename(repo)}-wololo-worktrees`);
  git(['worktree', 'add', '-q', '-b', 'wololo/g-01', join(trees, 'g-01')]);
  git(['worktree', 'add', '-q', '-b', 'wololo/g-02', join(trees, 'g-02')]);
  writeFileSync(join(trees, 'g-02', 'wip.txt'), 'unmerged work');
  spawnCommit(join(trees, 'g-02'));

  const r = clean(repo, { maxRunsMB: 10, maxLogMB: 5 });
  assert.ok(r.freed >= 16 * MB, `freed ${r.freed}`);
  assert.ok(!existsSync(s('autopilot.log')), 'the big log rotated away');
  assert.match(readFileSync(s('autopilot.log.1'), 'utf8'), /NEWEST LINE\n$/, 'whole, in autopilot.log.1: nothing trimmed');
  const runs = readdirSync(s('runs'));
  assert.equal(runs.length, 2, 'two newest 4MB transcripts fit in 10MB');
  assert.ok(runs.every((f) => /0[56]T/.test(f)), 'the newest are kept');
  assert.ok(!existsSync(s('autopilot.json.123.tmp')) && existsSync(s('fresh.json.9.tmp')), 'only stale temp files');
  assert.ok(!existsSync(s('board', 'g-01.lock')) && existsSync(s('board', 'g-02.lock')), 'only locks nobody holds');
  assert.ok(!existsSync(s('workers', 'g-01.log')) && existsSync(s('workers', 'g-02.log')), 'only finished workers');
  assert.ok(!existsSync(join(trees, 'g-01')), 'the merged worktree is gone');
  assert.equal(git(['branch', '--list', 'wololo/g-01']).stdout.trim(), '', 'and its branch');
  assert.ok(existsSync(join(trees, 'g-02', 'wip.txt')), 'unmerged work is never touched');
  assert.equal(clean(repo, { maxRunsMB: 10, maxLogMB: 5 }).freed, 0, 'idempotent');
});

test('clean --dry-run reports without deleting', () => {
  setup();
  mkdirSync(statePath(repo), { recursive: true });
  writeFileSync(statePath(repo, 'autopilot.json.5.tmp'), '{}');
  old(statePath(repo, 'autopilot.json.5.tmp'));
  const r = clean(repo, { dryRun: true });
  assert.ok(r.actions.some((a) => /autopilot\.json\.5\.tmp/.test(a)));
  assert.ok(existsSync(statePath(repo, 'autopilot.json.5.tmp')));
});

/** @param {string} dir */
function spawnCommit(dir) {
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'wip'], { cwd: dir });
}

test('rotate keeps 3 generations, drops the oldest, and leaves small logs alone', async () => {
  const { rotate } = await import('../src/core/rotate.js');
  setup();
  mkdirSync(statePath(repo), { recursive: true });
  const f = statePath(repo, 'x.log');
  for (let gen = 1; gen <= 5; gen++) {
    writeFileSync(f, `gen ${gen}\n`.repeat(100));
    rotate(f, 10);
  }
  assert.ok(!existsSync(f));
  assert.match(readFileSync(`${f}.1`, 'utf8'), /^gen 5/);
  assert.match(readFileSync(`${f}.3`, 'utf8'), /^gen 3/);
  assert.ok(!existsSync(`${f}.4`), 'only 3 kept');
  writeFileSync(f, 'small');
  assert.equal(rotate(f, 1024), 0);
  assert.ok(existsSync(f), 'under the cap: untouched');
});

test('clean never removes the worktree of a step that is still building, even before its first commit', () => {
  setup();
  const now = new Date().toISOString();
  writeTask(repo, { id: 'g-09', title: 'Running step', group: 'g', body: '', status: 'claimed', agent: 'autopilot:x', queue: [], notes: [], seq: 9, created: now, updated: now });
  writeTask(repo, { id: 'g-10', title: 'Done but dirty', group: 'g', body: '', status: 'done', queue: [], notes: [], seq: 10, created: now, updated: now });
  const trees = join(dirname(repo), `.${basename(repo)}-wololo-worktrees`);
  git(['worktree', 'add', '-q', '-b', 'wololo/g-09', join(trees, 'g-09')]); // no commits yet: "merged" to git
  git(['worktree', 'add', '-q', '-b', 'wololo/g-10', join(trees, 'g-10')]);
  writeFileSync(join(trees, 'g-10', 'leftover.txt'), 'uncommitted');
  clean(repo);
  assert.ok(existsSync(join(trees, 'g-09')), 'a running step\'s worktree stays');
  assert.ok(existsSync(join(trees, 'g-10', 'leftover.txt')), 'uncommitted files are never deleted');
});
