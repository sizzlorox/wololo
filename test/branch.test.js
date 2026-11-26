import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchFor, conventionOf, kindOf } from '../src/features/autopilot/branch.js';

test('kindOf: the goal\'s wording decides feature, bugfix, perf, refactor, docs or test', () => {
  assert.equal(kindOf('Add a farming system with seasons'), 'feature');
  assert.equal(kindOf('Fix the crash when a villager dies mid-haul'), 'bugfix');
  assert.equal(kindOf('Make the tick loop faster; profile and optimize pathfinding'), 'perf');
  assert.equal(kindOf('Refactor settlement.ts into a system registry'), 'refactor');
  assert.equal(kindOf('Update the README and docs for the TUI'), 'docs');
  assert.equal(kindOf('Add tests for the genealogy contract'), 'test');
});

test('conventionOf: separator, type words and their spelling come from existing branches; none = Conventional Branch', () => {
  assert.deepEqual(conventionOf([]), { sep: '/', words: {} });
  assert.deepEqual(conventionOf(['feat/login', 'fix/crash-on-save', 'feat/tui', 'main']), { sep: '/', words: { feature: 'feat', bugfix: 'fix' } });
  assert.deepEqual(conventionOf(['feature-login', 'bugfix-save', 'hotfix-x', 'release-1.2']), { sep: '-', words: { feature: 'feature', bugfix: 'bugfix' } });
  assert.deepEqual(conventionOf(['origin/feature/a', 'origin/feature/b', 'perf/fast-path']), { sep: '/', words: { feature: 'feature', perf: 'perf' } }, 'remote branches count too');
  assert.deepEqual(conventionOf(['wololo/plan-x-01', 'main', 'develop', 'experiment']), { sep: '/', words: {} }, 'wololo\'s own and plain branches say nothing');
});

test('branchFor: kind + slug in the repo\'s style, unique against existing names', () => {
  assert.equal(branchFor('Add a farming system with seasons', []), 'feature/add-a-farming-system-with-seasons');
  assert.equal(branchFor('Fix the crash when a villager dies', ['fix/old', 'feat/x']), 'fix/the-crash-when-a-villager-dies');
  assert.equal(branchFor('Faster pathfinding', ['feature-x']), 'perf-faster-pathfinding', 'kinds the repo never used keep their conventional word');
  assert.equal(branchFor('Add login', ['feature/add-login']), 'feature/add-login-2', 'never reuses a name');
  const long = branchFor('I want a villager sim like banished, but its played by itself, each entity has its own logic', []);
  assert.ok(long.length <= 8 + 48, 'slugs stay short');
  assert.equal(long, 'feature/i-want-a-villager-sim-like-banished-but-its', 'cut at a word boundary');
  assert.equal(branchFor('Fix bug in ui', []), 'bugfix/bug-in-ui', 'a short last word is kept');
});
