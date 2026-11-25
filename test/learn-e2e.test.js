import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRuns } from '../src/features/autopilot/usage.js';
import { listLearned } from '../src/features/learn/store.js';
import { prompts, repo, scratch, setup, wololo } from './helpers/autopilot-fixture.js';

// Builders all repeat the same check-and-orient workflow (with run-specific numbers and paths), then build.
const AGENT = String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
const out = (e) => console.log(JSON.stringify(e));
const call = (name, args) => out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name, arguments: args }], usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 } } });
if (prompt.includes('You are the planner')) {
  const path = /Write the plan to (\S+)/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ tasks: ['alpha', 'beta', 'gamma', 'delta'].map((n) => n + (prompt.includes('four more') ? 'two' : '')).map((n) => ({ title: 'Add ' + n, body: n })) }));
} else if (prompt.includes('You are the skill writer')) {
  const path = /Write (\S+) as JSON/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ kind: 'script', title: 'Check the core quickly', body: 'Run {{script}} first; it prints the failing checks.', files: [], roles: ['builder'], script: 'console.log("core ok");\n' }));
} else if (prompt.includes('You are the builder')) {
  const n = /Add (\w+)/.exec(prompt.split('Implement this feature:')[1])[1];
  call('bash', { command: 'cd ' + process.cwd() + ' && npm test 2>&1 | tail -' + (20 + n.length) });
  call('read', { path: process.cwd() + '/src/core.js:1-' + (40 + n.length) });
  call('bash', { command: 'git status --short' });
  fs.writeFileSync(n + '.js', 'export const ' + n + ' = 1;\n');
  execSync('git add -A && git commit -qm "feat: ' + n + '"');
}
`;

test('autopilot learns a workflow builders keep repeating, adopts it on trial and hands it to the next matching builder', () => {
  writeFileSync(join(scratch, 'agent.cjs'), AGENT);
  setup({ verifiers: 0, gapRounds: 0 });
  const r = wololo(['autopilot', '--goal', 'four helpers', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /noticed a repeated workflow/);

  const [item] = listLearned(repo);
  assert.ok(item, 'a learned skill was adopted');
  assert.equal(item.status, 'trial');
  assert.equal(item.kind, 'script');
  assert.deepEqual(item.trigger.roles, ['builder']);
  assert.deepEqual(item.evidence.calls, ['bash: npm test N>&N | tail -N', 'read: src/core.js', 'bash: git status --short']);
  assert.ok(existsSync(join(repo, '.wololo', 'learned', item.id, 'run.mjs')));

  const builders = prompts().filter((p) => p.includes('You are the builder'));
  assert.equal(builders.length, 4);
  assert.ok(!builders.slice(0, 3).some((p) => p.includes('Check the core quickly')), 'nothing learned yet for the first three');
  assert.match(builders[3], /Learned in this repo[\s\S]*Check the core quickly[\s\S]*Run node ".*run\.mjs" first/, 'the fourth builder gets it, with the script path filled in');
  assert.equal(prompts().filter((p) => p.includes('You are the skill writer')).length, 1, 'one pattern, written down once');

  const delta = readRuns(repo).find((u) => u.role === 'builder' && /** @type {any} */ (u).learned?.length);
  assert.deepEqual(/** @type {any} */ (delta)?.learned, [item.id], 'its usage records which learned skill it got');

  const claude = readFileSync(join(repo, '.claude', 'skills', `learned-${item.id}`, 'SKILL.md'), 'utf8');
  assert.match(claude, /disable-model-invocation: true/, 'Claude Code gets it as a by-hand skill only');
  assert.match(wololo(['gate']).out, /gate: PASS/, 'generated copies stay in sync');
});

test('autopilot.learn = off learns nothing; suggest only queues the workflow', () => {
  writeFileSync(join(scratch, 'agent.cjs'), AGENT);
  setup({ verifiers: 0, gapRounds: 0, learn: 'off' });
  assert.equal(wololo(['autopilot', '--goal', 'four helpers', '--plan']).code, 0);
  assert.equal(listLearned(repo).length, 0);
  assert.equal(prompts().filter((p) => p.includes('You are the skill writer')).length, 0);

  setup({ verifiers: 0, gapRounds: 0, learn: 'suggest' });
  assert.equal(wololo(['autopilot', '--goal', 'four more', '--plan']).code, 0);
  assert.equal(listLearned(repo).length, 0, 'nothing adopted');
  assert.match(wololo(['queue', 'list']).out, /repeated workflow: bash: npm test/);
});
