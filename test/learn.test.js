import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect, normalizeCall } from '../src/features/learn/detect.js';
import { decide, matches } from '../src/features/learn/store.js';

test('normalizeCall: worktree and repo paths, cd prefixes, line ranges and numbers are folded so runs compare', () => {
  const roots = ['D:/workspace/v-sim'];
  assert.equal(normalizeCall('bash', '{"command":"cd D:/workspace/v-sim && cargo test --lib time 2>&1 | tail -30"}', roots), 'bash: cargo test --lib time N>&N | tail -N');
  assert.equal(normalizeCall('read', '{"path":"D:/workspace/.v-sim-wololo-worktrees/plan-x-07/src/time/mod.rs:22-114"}', roots), 'read: src/time/mod.rs');
  assert.equal(normalizeCall('Read', '{"file_path":"D:\\\\workspace\\\\v-sim\\\\src\\\\a.rs"}', roots), 'read: src/a.rs');
});

/** @param {string} id @param {string} task @param {string[]} calls */
const run = (id, task, calls, role = 'builder') => ({ id, role, task, calls, turns: 20 });

test('detect: a sequence repeated across runs of different steps; noise, wololo\'s own commands and single runs are ignored', () => {
  const loop = ['bash: cargo test --lib time', 'read: src/time/mod.rs', 'bash: cargo clippy'];
  const runs = [
    run('r1', 't1', ['read: README.md', ...loop, 'edit: src/time/mod.rs']),
    run('r2', 't2', [...loop, 'bash: wololo gate']),
    run('r3', 't3', ['read: src/x.rs', ...loop]),
    run('r4', 't3', ['bash: wololo gate', 'bash: wololo gate']),
    run('r5', 't4', ['bash: wololo gate']),
  ];
  const found = detect(runs);
  assert.equal(found.length, 1, JSON.stringify(found.map((p) => p.calls)));
  assert.deepEqual(found[0].calls, loop, 'the longest sequence, not each of its parts');
  assert.deepEqual(found[0].runs.sort(), ['r1', 'r2', 'r3']);
  assert.equal(found[0].tasks.length, 3);
  assert.deepEqual(detect(runs.slice(0, 2)), [], 'twice is not a pattern');
  assert.deepEqual(detect([run('a', 't1', loop), run('b', 't1', loop), run('c', 't1', loop)]), [], 'one step repeating itself is a retry, not a reusable workflow');
});

const item = (/** @type {any} */ over = {}) => ({ id: 'l1', title: 'Time test loop', status: 'trial', body: 'x', trigger: { roles: ['builder', 'fixer'], files: ['src/time/'] }, evidence: { baselineTurns: 30 }, created: '2026-01-01T00:00:00Z', ...over });

test('matches: role and area must fit; an area is matched by the step\'s touches or by naming it in the step text', () => {
  assert.equal(matches(item(), { role: 'builder', touches: ['src/time/mod.rs'], text: '' }), true);
  assert.equal(matches(item(), { role: 'verifier', touches: ['src/time/'], text: '' }), false, 'wrong role');
  assert.equal(matches(item(), { role: 'builder', touches: ['src/weather/'], text: 'Add rain' }), false, 'other area');
  assert.equal(matches(item(), { role: 'builder', touches: [], text: 'Fix the seasons in src/time' }), true, 'named in the step');
  assert.equal(matches(item({ trigger: { roles: [], files: [] } }), { role: 'verifier', touches: [], text: '' }), true, 'no trigger = everywhere');
  assert.equal(matches(item({ status: 'retired' }), { role: 'builder', touches: ['src/time/'], text: '' }), false);
});

test('decide: kept when matched runs take fewer turns than the runs it was learned from, retired when not, or when it never fires', () => {
  const after = (/** @type {number[]} */ turns, learned = true) => turns.map((t, i) => ({ id: `u${i}`, role: 'builder', ts: '2026-02-01T00:00:00Z', turns: t, learned: learned ? ['l1'] : [] }));
  assert.equal(decide(item(), after([12, 15])), undefined, 'too few matches to judge');
  assert.equal(decide(item(), after([12, 15, 18]))?.status, 'kept');
  assert.equal(decide(item(), after([31, 40, 35]))?.status, 'retired');
  assert.match(decide(item(), after(Array(15).fill(10), false))?.reason ?? '', /never matched/);
  assert.equal(decide(item({ status: 'kept' }), after([99, 99, 99])), undefined, 'a decided item stays decided');
});

test('sync in a parallel worktree uses that checkout\'s learned skills, not the main repo\'s (else the worker\'s gate sees drift)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { listLearned, saveLearned } = await import('../src/features/learn/store.js');
  const main = mkdtempSync(join(tmpdir(), 'wololo-learn-main-'));
  const tree = mkdtempSync(join(tmpdir(), 'wololo-learn-tree-'));
  const prev = process.env.WOLOLO_CONFIG;
  process.env.WOLOLO_CONFIG = join(main, 'wololo.config.json');
  try {
    saveLearned(tree, /** @type {any} */ (item()));
    assert.equal(listLearned(tree).length, 1, 'agents in the worktree get the main repo\'s skills');
    assert.equal(listLearned(tree, true).length, 0, 'sync sees only what this checkout has');
  } finally {
    if (prev === undefined) delete process.env.WOLOLO_CONFIG;
    else process.env.WOLOLO_CONFIG = prev;
  }
});
