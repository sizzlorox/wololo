import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { git, prompts, repo, scratch, setup, wololo } from './helpers/autopilot-fixture.js';

// Parallel autopilot recovering from crashes, stops and what Windows and git leave behind.

test('resuming after a crash: a step that landed on its branch but was never merged gets merged', async () => {
  const { writeTask } = await import('../src/features/board/store.js');
  setup({ workers: 2, gapRounds: 0, verifiers: 0 });
  const now = new Date().toISOString();
  writeTask(repo, { id: 'g-01', title: 'Add alpha', group: 'g', body: '', status: 'done', queue: [], notes: [], seq: 1, deps: [], touches: ['alpha.js'], created: now, updated: now });
  git(['checkout', '-q', '-b', 'wololo/g-01']);
  writeFileSync(join(repo, 'alpha.js'), 'export const alpha = 1;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'feat: alpha']);
  git(['checkout', '-q', '-']);
  assert.ok(!existsSync(join(repo, 'alpha.js')));
  const r = wololo(['autopilot', '--group', 'g']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(existsSync(join(repo, 'alpha.js')), 'merged on resume');
  assert.equal(git(['branch', '--list', 'wololo/*']).stdout.trim(), '');
});

test('uncommitted changes in the main checkout do not stall merges: they are committed first, untracked files are left alone', () => {
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
if (prompt.includes('You are the planner')) {
  const path = /Write the plan to (\S+)/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ tasks: [{ title: 'Add p', body: 'p', deps: [], touches: ['p.js'] }, { title: 'Add q', body: 'q', deps: [], touches: ['q.js'] }] }));
} else if (prompt.includes('You are the builder')) {
  const m = /Add (\w+)/.exec(prompt.split('Implement this feature:')[1]);
  fs.writeFileSync(m[1] + '.js', '1\n');
  execSync('git add -A && git commit -qm "feat: ' + m[1] + '"');
}
`);
  setup({ workers: 2, gapRounds: 0, verifiers: 0 });
  // what the TUI's Config tab does mid-run: an uncommitted edit to a tracked file; plus a stray untracked file
  const cfg = JSON.parse(readFileSync(join(repo, 'wololo.config.json'), 'utf8'));
  writeFileSync(join(repo, 'wololo.config.json'), `${JSON.stringify({ ...cfg, autopilot: { ...cfg.autopilot, maxIterations: 4 } }, null, 2)}\n`);
  writeFileSync(join(repo, 'notes.txt'), 'mine\n');
  const r = wololo(['autopilot', '--goal', 'p and q', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(existsSync(join(repo, 'p.js')) && existsSync(join(repo, 'q.js')), 'both merged');
  assert.match(git(['log', '--format=%s']).stdout, /autopilot: commit uncommitted changes in the main checkout before merging/);
  assert.equal(JSON.parse(git(['show', 'HEAD:wololo.config.json']).stdout).autopilot.maxIterations, 4, 'the settings change was kept, committed');
  assert.match(git(['status', '--porcelain']).stdout, /\?\? notes\.txt/, 'an untracked file the merge does not touch stays untracked');
});

test('overwritten: the files git names when it refuses to start a merge', async () => {
  const { overwritten } = await import('../src/features/autopilot/parallel.js');
  const stderr = 'error: The following untracked working tree files would be overwritten by merge:\n\tassets/a.png\n\tdata/sim.json\nPlease move or remove them before you merge.\nAborting\n';
  assert.deepEqual(overwritten(stderr), ['assets/a.png', 'data/sim.json']);
  assert.deepEqual(overwritten('CONFLICT (content): Merge conflict in x.js\n'), []);
});

test('resuming after a stop mid-merge: the worktree\'s half-done merge and scratch files are cleared, then it merges', async () => {
  const { writeTask } = await import('../src/features/board/store.js');
  setup({ workers: 2, gapRounds: 0, verifiers: 0 });
  const now = new Date().toISOString();
  writeTask(repo, { id: 'g-01', title: 'Add alpha', group: 'g', body: '', status: 'done', queue: [], notes: [], seq: 1, deps: [], touches: ['alpha.js'], created: now, updated: now });
  // the step's branch, in its worktree, as parallel autopilot leaves it
  const trees = join(dirname(repo), `.${basename(repo)}-wololo-worktrees`);
  const dir = join(trees, 'g-01');
  git(['worktree', 'add', '-q', '-b', 'wololo/g-01', dir]);
  const wt = (/** @type {string[]} */ args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  writeFileSync(join(dir, 'shared.txt'), 'from alpha\n');
  writeFileSync(join(dir, 'alpha.js'), '1\n');
  wt(['add', '-A']);
  wt(['commit', '-qm', 'feat: alpha']);
  // main moved on with a conflicting change; a merger started merging main into the worktree and was stopped
  writeFileSync(join(repo, 'shared.txt'), 'from main\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'main: shared']);
  wt(['merge', 'master']);
  wt(['merge', 'main']);
  writeFileSync(join(dir, 'theirs.txt'), 'merger scratch\n');
  assert.equal(wt(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status, 0, 'a merge is in progress in the worktree');

  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
if (process.argv[2].includes('You are the merger')) {
  fs.writeFileSync('shared.txt', 'from main\nfrom alpha\n');
  execSync('git add -A && git commit -q --no-edit');
}
`);
  const r = wololo(['autopilot', '--group', 'g']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out + r.err, /cleared an unfinished merge/);
  assert.ok(existsSync(join(repo, 'alpha.js')), 'merged into main');
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'from main\nfrom alpha\n');
  assert.ok(!existsSync(join(repo, 'theirs.txt')), 'the interrupted merger\'s scratch file never reached main');
});

test('a step whose worktree folder was left behind empty (Windows) gets a real worktree again, not the bare folder', async () => {
  const { mkdirSync } = await import('node:fs');
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
if (prompt.includes('You are the builder')) {
  fs.appendFileSync(${JSON.stringify(join(scratch, 'where.log'))}, execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }));
  fs.writeFileSync('alpha.js', '1\n');
  execSync('git add -A && git commit -qm "feat: alpha"');
}
`);
  setup({ workers: 2, gapRounds: 0, verifiers: 0, hillClimb: 0 });
  const now = new Date().toISOString();
  const { writeTask } = await import('../src/features/board/store.js');
  writeTask(repo, { id: 'g-01', title: 'Add alpha', group: 'g', body: '', status: 'todo', queue: [], notes: [], seq: 1, deps: [], touches: ['alpha.js'], created: now, updated: now });
  const left = join(dirname(repo), `.${basename(repo)}-wololo-worktrees`, 'g-01');
  mkdirSync(left, { recursive: true }); // what a removal Windows could not finish leaves behind
  const r = wololo(['autopilot', '--group', 'g']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /is left over and is not the wololo\/g-01 worktree; recreating it/);
  assert.equal(readFileSync(join(scratch, 'where.log'), 'utf8').trim(), 'wololo/g-01', 'the builder ran on its own branch, not the main checkout');
  assert.ok(existsSync(join(repo, 'alpha.js')), 'and its work was merged');
});

test('a builder killed while waiting on a slow command is blocked with that command named, not split again and again', async () => {
  const { writeTask, readTask } = await import('../src/features/board/store.js');
  // starts the long check, then only waits on it, until the stall limit kills it
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const out = (e) => console.log(JSON.stringify(e));
const call = (name, args) => out({ type: 'tool_execution_start', toolName: name, toolCallId: String(Math.random()), args });
if (process.argv[2].includes('You are the builder')) {
  call('bash', { command: 'npx vitest run tests/sim/m4.test.ts' });
  for (let i = 0; i < 5; i++) call('wait', {});
  setInterval(() => {}, 1000);
}
`);
  setup({ gapRounds: 0, verifiers: 0, hillClimb: 0, stallMinutes: 0.02 });
  const now = new Date().toISOString();
  writeTask(repo, { id: 'g-01', title: 'Run the year-40 check', group: 'g', body: '', status: 'todo', queue: [], notes: [], seq: 1, created: now, updated: now });
  const r = wololo(['autopilot', '--group', 'g']);
  assert.notEqual(r.code, 0);
  const t = readTask(repo, 'g-01');
  assert.equal(t?.status, 'blocked');
  assert.match(t?.notes.at(-1) ?? '', /kept waiting on `npx vitest run tests\/sim\/m4\.test\.ts`, which takes longer than an agent may run/);
  assert.equal(t?.splitInto, undefined, 'not split: a smaller step would wait on the same command');
  assert.equal(prompts().filter((p) => p.includes('You are the splitter')).length, 0);
});

test('merging a step never deletes the main repo\'s node_modules through the worktree\'s link to it', async () => {
  const { mkdirSync } = await import('node:fs');
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
if (prompt.includes('You are the planner')) {
  const path = /Write the plan to (\S+)/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ tasks: [{ title: 'Add alpha', body: 'a', deps: [], touches: ['alpha.js'] }, { title: 'Add beta', body: 'b', deps: [], touches: ['beta.js'] }] }));
} else if (prompt.includes('You are the builder')) {
  const m = /Add (\w+)/.exec(prompt.split('Implement this feature:')[1]);
  fs.writeFileSync(m[1] + '.js', '1\n');
  execSync('git add -A && git commit -qm "feat: ' + m[1] + '"');
}
`);
  setup({ workers: 2, gapRounds: 0, verifiers: 0, hillClimb: 0 });
  writeFileSync(join(repo, '.gitignore'), `${readFileSync(join(repo, '.gitignore'), 'utf8')}\nnode_modules\n`);
  git(['add', '-A']);
  git(['commit', '-qm', 'ignore node_modules']);
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'keep me\n');
  const r = wololo(['autopilot', '--goal', 'alpha and beta', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(existsSync(join(repo, 'alpha.js')) && existsSync(join(repo, 'beta.js')), 'both merged');
  assert.equal(readFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'keep me\n', 'the shared dependencies survived both merges');
});

test('on a detached HEAD, parallel autopilot creates a branch named after the goal in the repo\'s style and merges into it', () => {
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
if (prompt.includes('You are the planner')) {
  const path = /Write the plan to (\S+)/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ tasks: [{ title: 'Add alpha', body: 'a', deps: [], touches: ['alpha.js'] }] }));
} else if (prompt.includes('You are the builder')) {
  fs.writeFileSync('alpha.js', '1\n');
  execSync('git add -A && git commit -qm "feat: alpha"');
}
`);
  setup({ workers: 2, gapRounds: 0, verifiers: 0, hillClimb: 0 });
  git(['branch', 'feat/older-work']); // the repo's convention: feat/
  git(['checkout', '-q', '--detach']);
  const r = wololo(['autopilot', '--goal', 'Add a greeting system', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /HEAD was detached: created branch feat\/add-a-greeting-system/);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'feat/add-a-greeting-system');
  assert.ok(existsSync(join(repo, 'alpha.js')), 'the step merged into the new branch');
});

test('a merge that never succeeds is blocked saying why: which files conflict, and where the work is kept', async () => {
  const { readTask } = await import('../src/features/board/store.js');
  // two steps write the same file; the merger gives up without resolving anything
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
if (prompt.includes('You are the planner')) {
  const path = /Write the plan to (\S+)/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ tasks: [{ title: 'Write one', body: 'a', deps: [], touches: ['one.js'] }, { title: 'Write two', body: 'b', deps: [], touches: ['two.js'] }] }));
} else if (prompt.includes('You are the builder')) {
  const n = /Write (\w+)/.exec(prompt.split('Implement this feature:')[1])[1];
  fs.writeFileSync('shared.txt', 'from ' + n + '\n');
  execSync('git add -A && git commit -qm "feat: ' + n + '"');
}
`);
  setup({ workers: 2, gapRounds: 0, verifiers: 0, hillClimb: 0, base: 'master' });
  const r = wololo(['autopilot', '--goal', 'two writers', '--plan']);
  assert.notEqual(r.code, 0);
  const group = /** @type {string} */ (/plan-[\w-]+/.exec(r.out + r.err)?.[0]);
  const blocked = ['01', '02'].map((n) => readTask(repo, `${group}-${n}`)).find((t) => t?.status === 'blocked');
  assert.ok(blocked, 'one of the two is blocked');
  assert.match(blocked?.blockedWhy ?? '', /could not merge into .*: conflicts in shared\.txt\. Tried 3 times, a merger agent in between\. The work is kept on wololo\//);
});
