import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { statePath } from '../src/core/state.js';
import { judgedScores } from '../src/features/autopilot/climb.js';
import { readTasks } from '../src/features/board/store.js';
import { git, prompts, repo, scratch, setup, wololo } from './helpers/autopilot-fixture.js';

// A builder commits a feature; the judge scores every judgment criterion 1.
const AGENT = String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
if (prompt.includes('You are the judge')) {
  const path = /Write (\S+) as JSON/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ scores: { intent: 1, craft: 1, looks: 1 }, notes: {} }));
} else if (prompt.includes('You are the builder')) {
  fs.writeFileSync('feature.js', 'export const greet = (n) => n;\n');
  execSync('git add -A && git commit -qm "feat: greet"');
}
`;

/** gate.requireJudgment on: a step cannot land without the rubric's judgment criteria scored. */
function requireJudgment() {
  const f = join(repo, 'wololo.config.json');
  const c = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, `${JSON.stringify({ ...c, gate: { ...c.gate, requireJudgment: true } }, null, 2)}\n`);
  git(['add', '-A']);
  git(['commit', '-qm', 'require judgment']);
}

test('with gate.requireJudgment, autopilot has the judge score the step and passes those scores to the gate, instead of blocking on "pending judgment"', () => {
  writeFileSync(join(scratch, 'agent.cjs'), AGENT);
  setup({ verifiers: 0, gapRounds: 0, hillClimb: 0, base: 'master' });
  requireJudgment();
  const r = wololo(['autopilot', '--goal', 'Add a greet helper']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /landed/);
  assert.doesNotMatch(r.out + r.err, /stuck: the same gate failure/);
  assert.ok(prompts().some((p) => p.includes('You are the judge')), 'the judge ran');
  assert.ok(!prompts().some((p) => p.includes('You are the fixer') && p.includes('pending judgment')), 'no fixer was sent after a judgment only a judge can give');
});

test('judge scores count only for the exact state they were given for', () => {
  writeFileSync(join(scratch, 'agent.cjs'), AGENT);
  setup({ verifiers: 0, gapRounds: 0, hillClimb: 0, base: 'master' });
  requireJudgment();
  assert.equal(wololo(['autopilot', '--goal', 'Add a greet helper']).code, 0);
  assert.ok(existsSync(statePath(repo, 'judge.json')));
  assert.deepEqual(judgedScores(repo), { intent: 1, craft: 1, looks: 1 }, 'for the state that was judged');
  writeFileSync(join(repo, 'feature.js'), 'export const greet = (n) => `hi ${n}`;\n');
  assert.deepEqual(judgedScores(repo), {}, 'an uncommitted change since: stale');
  git(['commit', '-qam', 'change']);
  assert.deepEqual(judgedScores(repo), {}, 'a new commit since: stale');
});

test('a workspace whose checks are all per repo gets no bogus "scaffold the project" step', async () => {
  const { mkdirSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'wololo-ws-scaffold-'));
  for (const r of ['frontend', 'backend']) {
    const d = join(root, r);
    mkdirSync(d);
    for (const a of [['init', '-q', '-b', 'master'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']]) spawnSync('git', a, { cwd: d });
    writeFileSync(join(d, 'README.md'), r);
    spawnSync('git', ['add', '-A'], { cwd: d });
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: d });
  }
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const prompt = process.argv[2];
if (prompt.includes('You are the planner')) {
  const path = /Write the plan to (\S+)/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ tasks: [{ title: 'Add login', body: 'login' }] }));
}
`);
  const bin = resolve('bin/wololo.js');
  const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, WOLOLO_HOME: scratch } });
  assert.equal(run(['init', '--yes', '--harness', 'claude', '--ci', 'none']).status, 0);
  const f = join(root, 'wololo.config.json');
  const c = JSON.parse(readFileSync(f, 'utf8'));
  c.verify.steps = []; // the workspace checks nothing itself: its repos do
  c.autopilot = { ...c.autopilot, command: [process.execPath, join(scratch, 'agent.cjs'), '{prompt}'], verifiers: 0, gapRounds: 0, hillClimb: 0, repos: { frontend: { verify: [{ name: 'test', run: 'node -e 0' }] }, backend: { verify: [{ name: 'test', run: 'node -e 0' }] } } };
  writeFileSync(f, JSON.stringify(c));
  run(['autopilot', '--goal', 'Add login', '--plan']);
  const titles = readTasks(root).map((t) => t.title);
  assert.ok(titles.includes('Add login'), 'the plan was made');
  assert.ok(!titles.some((t) => /Scaffold the project/.test(t)), `no scaffold step: ${titles.join('; ')}`);
});

test('with gate.requireJudgment, parallel merges have the merged result judged instead of blocking each step', () => {
  writeFileSync(join(scratch, 'agent.cjs'), String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
if (prompt.includes('You are the planner')) {
  const path = /Write the plan to (\S+)/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ tasks: [{ title: 'Add alpha', body: 'a', deps: [], touches: ['alpha.js'] }, { title: 'Add beta', body: 'b', deps: [], touches: ['beta.js'] }] }));
} else if (prompt.includes('You are the judge')) {
  const path = /Write (\S+) as JSON/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ scores: { intent: 1, craft: 1, looks: 1 }, notes: {} }));
} else if (prompt.includes('You are the builder')) {
  const n = /Add (\w+)/.exec(prompt.split('Implement this feature:')[1])[1];
  fs.writeFileSync(n + '.js', '1\n');
  execSync('git add -A && git commit -qm "feat: ' + n + '"');
}
`);
  setup({ workers: 2, verifiers: 0, gapRounds: 0, hillClimb: 0, base: 'master' });
  requireJudgment();
  const r = wololo(['autopilot', '--goal', 'alpha and beta', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /2\/2 step\(s\) landed/);
  assert.ok(existsSync(join(repo, 'alpha.js')) && existsSync(join(repo, 'beta.js')));
});
