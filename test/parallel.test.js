import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readEvents } from '../src/core/state.js';
import { overlaps, pickReady } from '../src/features/autopilot/parallel.js';
import { messages } from '../src/features/board/inbox.js';
import { readTasks } from '../src/features/board/store.js';
import { git, prompts, repo, scratch, setup, wololo } from './helpers/autopilot-fixture.js';

/** @param {string} id @param {string} status @param {Record<string, any>} [more] */
const t = (id, status, more = {}) => /** @type {any} */ ({ id, title: id, status, seq: Number(id.replace(/\D/g, '')) || 0, touches: [`src/${id}/`], deps: [], ...more });

test('overlaps: dirs contain files, globs compare by their fixed prefix, undeclared areas overlap everything', () => {
  assert.equal(overlaps(['src/time/'], ['src/time/mod.rs']), true);
  assert.equal(overlaps(['src/time/'], ['src/weather/']), false);
  assert.equal(overlaps(['src/**/*.rs'], ['src/time/']), true);
  assert.equal(overlaps(['Cargo.toml'], ['Cargo.toml']), true);
  assert.equal(overlaps([], ['src/a/']), true, 'a step that did not say what it touches runs alone');
});

test('pickReady: deps landed and merged, no overlap with running or unmerged work, up to the worker limit, in plan order', () => {
  const plan = [t('a1', 'done'), t('b2', 'todo', { deps: ['a1'] }), t('c3', 'todo'), t('d4', 'todo', { deps: ['b2'] }), t('e5', 'todo', { touches: ['src/c3/x.rs'] })];
  assert.deepEqual(pickReady(plan, { running: [], unmerged: [], workers: 3 }).map((x) => x.id), ['b2', 'c3'], 'd4 waits for b2; e5 overlaps c3, which goes first');
  assert.deepEqual(pickReady(plan, { running: [], unmerged: ['a1'], workers: 3 }).map((x) => x.id), ['c3'], 'a dep that landed but is not merged yet is not met');
  assert.deepEqual(pickReady(plan, { running: ['c3'], unmerged: [], workers: 3 }).map((x) => x.id), ['b2'], 'running work is not picked again and blocks overlapping steps');
  assert.deepEqual(pickReady(plan, { running: [], unmerged: [], workers: 1 }).map((x) => x.id), ['b2']);
  assert.deepEqual(pickReady(plan, { running: ['c3', 'b2'], unmerged: [], workers: 2 }), [], 'workers all busy');
});

test('pickReady: a split step counts as landed only when all its parts landed; blocked steps hold only their dependents', () => {
  const plan = [t('a1', 'done', { splitInto: ['a1-s1', 'a1-s2'] }), t('a1-s1', 'done', { seq: 1.1 }), t('a1-s2', 'todo', { deps: ['a1-s1'], seq: 1.2 }), t('b2', 'todo', { deps: ['a1'] }), t('c3', 'blocked'), t('d4', 'todo', { deps: ['c3'] }), t('e5', 'todo')];
  assert.deepEqual(pickReady(plan, { running: [], unmerged: [], workers: 4 }).map((x) => x.id), ['a1-s2', 'e5']);
});

test('pickReady: a step a crashed run left claimed is resumed; one an outside agent claimed is left alone', () => {
  const plan = [t('a1', 'claimed', { agent: 'autopilot:omp' }), t('b2', 'claimed', { agent: 'alice' })];
  assert.deepEqual(pickReady(plan, { running: [], unmerged: [], workers: 4 }).map((x) => x.id), ['a1']);
});

test('a parallel run: independent steps build at once in worktrees, a dependent step waits for both to merge, and a merger agent reconciles a conflict', async () => {
  // Planner: alpha and beta are independent; gamma needs both. one/two both write shared.txt but
  // (wrongly) declare separate files, so they run together and conflict when the second merges.
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
const commit = (m) => execSync('git add -A && git commit -qm "' + m + '"');
const stamp = (s) => fs.appendFileSync(${JSON.stringify(join(scratch, 'timeline.log'))}, s + ' ' + Date.now() + '\n');
if (prompt.includes('You are the planner')) {
  const path = /Write the plan to (\S+)/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ tasks: [
    { title: 'Add alpha', body: 'alpha', deps: [], touches: ['alpha.js'] },
    { title: 'Add beta', body: 'beta', deps: [], touches: ['beta.js'] },
    { title: 'Add gamma', body: 'gamma', deps: [1, 2], touches: ['gamma.js'] },
    { title: 'Write shared one', body: 'one', deps: [3], touches: ['one.js'] },
    { title: 'Write shared two', body: 'two', deps: [3], touches: ['two.js'] },
  ] }));
} else if (prompt.includes('You are the merger')) {
  const text = fs.readFileSync('shared.txt', 'utf8');
  fs.writeFileSync('shared.txt', text.split('\n').filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join('\n'));
  execSync('git add -A && git commit -q --no-edit');
} else if (prompt.includes('You are the builder')) {
  const goal = prompt.split('Implement this feature:')[1];
  const m = /(Add|Write shared) (\w+)/.exec(goal);
  stamp('start ' + m[2]);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); // sleep so the two builders overlap
  if (m[1] === 'Add') fs.writeFileSync(m[2] + '.js', 'export const ' + m[2] + ' = 1;\n');
  else fs.writeFileSync('shared.txt', 'from ' + m[2] + '\n');
  stamp('end ' + m[2]);
  commit('feat: ' + m[2]);
}
`);
  setup({ workers: 2, gapRounds: 0, verifiers: 0 });
  const r = wololo(['autopilot', '--goal', 'build the things', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /5\/5 step\(s\) landed .*\(2 workers\)/);

  // everything is on main
  for (const f of ['alpha.js', 'beta.js', 'gamma.js']) assert.ok(existsSync(join(repo, f)), `${f} merged`);
  const shared = readFileSync(join(repo, 'shared.txt'), 'utf8');
  assert.match(shared, /from one/);
  assert.match(shared, /from two/, 'the merger kept both sides');

  // alpha and beta ran at the same time; gamma started after both ended
  const at = Object.fromEntries(readFileSync(join(scratch, 'timeline.log'), 'utf8').trim().split('\n').map((l) => [l.split(' ').slice(0, 2).join(' '), Number(l.split(' ')[2])]));
  assert.ok(at['start beta'] < at['end alpha'] && at['start alpha'] < at['end beta'], 'alpha and beta overlapped');
  assert.ok(at['start gamma'] > Math.max(at['end alpha'], at['end beta']), 'gamma waited for its deps');

  // workers knew about each other; the conflict went through a merger; merges were announced
  assert.ok(prompts().some((p) => p.includes('Being built right now by other agents')), 'a builder was told what its siblings build');
  assert.ok(prompts().some((p) => p.includes('You are the merger') && p.includes('shared.txt')), 'a merger saw the conflicting file');
  const merges = readEvents(repo, 'merge');
  assert.equal(merges.filter((e) => e.ok).length, 5);
  assert.ok(merges.some((e) => e.attempts === 2), 'one merge needed a second attempt');
  const group = readTasks(repo)[0].group;
  assert.ok(messages(repo, group).some((m) => /is merged into/.test(m.text)));

  // cleaned up: no worktrees or branches left
  assert.equal(git(['worktree', 'list']).stdout.trim().split('\n').length, 1);
  assert.equal(git(['branch', '--list', 'wololo/*']).stdout.trim(), '');
  assert.ok(!existsSync(join(dirname(repo), `.${basename(repo)}-wololo-worktrees`, `${group}-01`)));
});

test('a merge whose combined result fails the gate is undone on main, fixed by a merger in the worktree, then merged', () => {
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
if (prompt.includes('You are the planner')) {
  const path = /Write the plan to (\S+)/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ tasks: [{ title: 'Add a', body: 'a', deps: [], touches: ['a.flag'] }, { title: 'Add b', body: 'b', deps: [], touches: ['b.flag'] }] }));
} else if (prompt.includes('You are the merger')) {
  fs.writeFileSync('fixed', 'both flags work together\n');
  execSync('git add -A && git commit -qm "fix: a and b together"');
} else if (prompt.includes('You are the builder')) {
  const m = /Add (\w+)/.exec(prompt.split('Implement this feature:')[1]);
  fs.writeFileSync(m[1] + '.flag', '1\n');
  execSync('git add -A && git commit -qm "feat: ' + m[1] + '"');
}
`);
  // the test step fails when both flags exist without the fix: each step alone is green
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: `node -e "const f=require('fs');process.exit(f.existsSync('a.flag')&&f.existsSync('b.flag')&&!f.existsSync('fixed')?1:0)"` } }));
  setup({ workers: 2, gapRounds: 0, verifiers: 0 });
  const r = wololo(['autopilot', '--goal', 'flags', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  for (const f of ['a.flag', 'b.flag', 'fixed']) assert.ok(existsSync(join(repo, f)), `${f} on main`);
  assert.ok(prompts().some((p) => p.includes('You are the merger') && p.includes('fails the gate')), 'the merger was told the merged result fails the gate');
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']).stdout.trim(), '', 'main is clean');
  assert.match(git(['log', '--format=%s']).stdout, /fix: a and b together/);
});

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

test('a plan made before parallel mode is annotated once with deps and touches, then built in parallel', async () => {
  const { writeTask } = await import('../src/features/board/store.js');
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
const stamp = (s) => fs.appendFileSync(${JSON.stringify(join(scratch, 'timeline.log'))}, s + ' ' + Date.now() + '\n');
if (prompt.includes('You are the annotator')) {
  const path = /Write them to (\S+)/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ tasks: [
    { id: 'old-01', deps: [], touches: ['x.js'] },
    { id: 'old-02', deps: [], touches: ['y.js'] },
    { id: 'old-03', deps: ['old-01', 'old-02', 'old-03', 'nope'], touches: ['z.js'] },
  ] }));
} else if (prompt.includes('You are the builder')) {
  const m = /Make (\w)/.exec(prompt.split('Implement this feature:')[1]);
  stamp('start ' + m[1]);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  fs.writeFileSync(m[1] + '.js', '1\n');
  stamp('end ' + m[1]);
  execSync('git add -A && git commit -qm "feat: ' + m[1] + '"');
}
`);
  setup({ workers: 2, gapRounds: 0, verifiers: 0 });
  const now = new Date().toISOString();
  ['x', 'y', 'z'].forEach((n, i) => writeTask(repo, { id: `old-0${i + 1}`, title: `Make ${n}`, group: 'old', body: '', status: 'todo', queue: [], notes: [], seq: i + 1, goal: 'xyz', created: now, updated: now }));
  const r = wololo(['autopilot', '--group', 'old']);
  assert.equal(r.code, 0, r.out + r.err);
  const tasks = Object.fromEntries(readTasks(repo).map((t) => [t.id, t]));
  assert.deepEqual(tasks['old-01'].touches, ['x.js']);
  assert.deepEqual(tasks['old-03'].deps, ['old-01', 'old-02'], 'only earlier steps of the plan: no self, no unknown ids');
  const at = Object.fromEntries(readFileSync(join(scratch, 'timeline.log'), 'utf8').trim().split('\n').map((l) => [l.split(' ').slice(0, 2).join(' '), Number(l.split(' ')[2])]));
  assert.ok(at['start y'] < at['end x'] && at['start x'] < at['end y'], 'x and y built at once');
  assert.ok(at['start z'] > Math.max(at['end x'], at['end y']), 'z waited for both');
  assert.equal(prompts().filter((p) => p.includes('You are the annotator')).length, 1, 'annotated once');
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
