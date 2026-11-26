import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isProtected } from '../src/features/autopilot/branch.js';
import { readTasks } from '../src/features/board/store.js';
import { git, repo, scratch, setup, wololo } from './helpers/autopilot-fixture.js';

const head = () => git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
const log = (/** @type {string} */ ref) => git(['log', '--format=%s', ref]).stdout;

test('isProtected: main, master, develop, stage, release and the like; patterns from config', () => {
  for (const b of ['main', 'master', 'develop', 'dev', 'stage', 'staging', 'release', 'release/1.2', 'release-2026', 'prod', 'production', 'trunk', 'hotfix/urgent', 'qa', 'uat']) assert.equal(isProtected(b), true, b);
  for (const b of ['feature/x', 'feat/login', 'fix/crash', 'perf/fast', 'mainline-experiment', 'developer-notes']) assert.equal(isProtected(b), false, b);
  assert.equal(isProtected('team/ship', ['team/*']), true, 'configured patterns');
  assert.equal(isProtected('main', ['team/*']), false, 'the configured list replaces the default');
});

test('a goal started on master branches out: the work lands on a feature branch, master is untouched', () => {
  setup({ verifiers: 0, gapRounds: 0, hillClimb: 0 });
  assert.equal(head(), 'master');
  const before = log('master');
  const r = wololo(['autopilot', '--goal', 'Add a greet helper']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /master is protected: created branch feature\/add-a-greet-helper/);
  assert.equal(head(), 'feature/add-a-greet-helper');
  assert.match(log('HEAD'), /^feat: /, 'the builder commit is on the feature branch');
  assert.equal(log('master'), before, 'nothing was committed to master');
});

test('resuming a plan from master switches back to the plan\'s branch instead of making another', () => {
  setup({ verifiers: 0, gapRounds: 0, hillClimb: 0 });
  assert.equal(wololo(['autopilot', '--goal', 'Add alpha and beta', '--plan']).code, 0);
  const branch = head();
  assert.match(branch, /^feature\//);
  git(['checkout', '-q', 'master']);
  const group = /** @type {string} */ (readTasks(repo).find((t) => t.group.startsWith('plan-'))?.group);
  const r = wololo(['autopilot', '--group', group]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, new RegExp(`switched to ${branch.replace('/', '\\/')}, this plan's branch`));
  assert.equal(head(), branch);
  assert.equal(git(['branch', '--list', 'feature/*']).stdout.trim().split('\n').length, 1, 'no second branch');
});

test('an agent that checks out master mid-run cannot get wololo to commit there', () => {
  // the builder switches to master and leaves its work uncommitted: landing would commit it to master
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
if (process.argv[2].includes('You are the builder')) {
  execSync('git checkout -q master');
  fs.writeFileSync('feature.js', 'export const x = 1;\n');
}
`);
  setup({ verifiers: 0, gapRounds: 0, hillClimb: 0 });
  const before = log('master');
  const r = wololo(['autopilot', '--goal', 'Add a thing']);
  assert.notEqual(r.code, 0);
  assert.match(r.out + r.err, /refusing to commit to master: it is protected/);
  assert.equal(log('master'), before, 'master untouched');
  assert.ok(existsSync(join(repo, 'feature.js')), 'the work is left in the working tree, not lost');
});

test('autopilot.protectedBranches overrides the list', () => {
  setup({ verifiers: 0, gapRounds: 0, hillClimb: 0, protectedBranches: ['ship'] });
  const r = wololo(['autopilot', '--goal', 'Add a greet helper']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(head(), 'master', 'master is not in this repo\'s list: the run stays on it');
});

test('a single repo with master and develop needs autopilot.base; with it, features start from that branch', () => {
  setup({ verifiers: 0, gapRounds: 0, hillClimb: 0 });
  git(['branch', 'develop']);
  const refused = wololo(['autopilot', '--goal', 'Add a greet helper']);
  assert.equal(refused.code, 2);
  assert.match(refused.out + refused.err, /it has master and develop: set which one features start from in autopilot.base/);
  setup({ verifiers: 0, gapRounds: 0, hillClimb: 0, base: 'develop' });
  const r = wololo(['autopilot', '--goal', 'Add a greet helper']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /created branch feature\/add-a-greet-helper from develop/);
});
