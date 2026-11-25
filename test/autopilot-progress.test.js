import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { GREENFIELD_AGENT, prompts, repo, scratch, setup, wololo } from './helpers/autopilot-fixture.js';

test('a hung agent is killed (with its children) after autopilot.agentTimeoutMinutes, and the loop moves on', () => {
  const hang = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const prompt = process.argv[2];
if (prompt.includes('You are the builder')) {
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(join(scratch, 'kid.pid'))}, String(kid.pid));
  console.log('compiling bevy...');
  setInterval(() => {}, 1000);
}`;
  writeFileSync(join(scratch, 'agent.cjs'), hang);
  setup({ agentTimeoutMinutes: 0.03 });
  const started = Date.now();
  const r = wololo(['autopilot', '--goal', 'Add alpha', '--max', '1']);
  assert.ok(Date.now() - started < 30_000, 'did not hang');
  assert.match(r.out + r.err, /timed out after .*compiling bevy/s, 'says it timed out and what it was doing');
  const kid = Number(readFileSync(join(scratch, 'kid.pid'), 'utf8'));
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try {
      process.kill(kid, 0);
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)']);
    } catch {
      alive = false;
    }
  }
  if (alive) process.kill(kid, 'SIGKILL');
  assert.equal(alive, false, 'grandchild processes die with the agent');
  assert.match(readFileSync(join(repo, '.wololo', 'state', 'autopilot.log'), 'utf8'), /compiling bevy/, 'full agent output is kept on disk');
});

test('the log says when each task lands and skips verifiers for a docs-only step', () => {
  writeFileSync(join(scratch, 'agent.cjs'), GREENFIELD_AGENT);
  const r = wololo(['autopilot', '--goal', 'A villager sim', '--plan', '--max', '2']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /task plan-\S+-01 landed/);
  assert.match(r.err, /task plan-\S+-02 landed/);
  assert.match(r.err, /docs-only change.*skipping verifiers/);
  assert.equal(prompts().filter((p) => p.includes('You are a verifier')).length, 1, 'only the code step is fuzzed');
});

test('a red gate names what failed, not just which part', () => {
  const r = wololo(['autopilot', '--goal', 'STUCK plan', '--plan', '--max', '2']);
  assert.match(r.err, /gate red \(constraints: [^)]*broken\.js/);
});

test('the heartbeat shows real progress (files, commits) instead of the agent spinner, and a timeout says what happens next', () => {
  const hang = `
const fs = require('node:fs');
if (process.argv[2].includes('You are the builder')) {
  fs.writeFileSync('wip.txt', 'half done');
  console.log('Working...');
  setInterval(() => {}, 1000);
}`;
  writeFileSync(join(scratch, 'agent.cjs'), hang);
  setup({ agentTimeoutMinutes: 0.03 });
  process.env.WOLOLO_HEARTBEAT_MS = '400';
  try {
    const r = wololo(['autopilot', '--goal', 'Add alpha', '--max', '1']);
    assert.match(r.err, /builder still running \(0m\): 1 uncommitted file\(s\), no commits yet/);
    assert.match(r.err, /timed out .*The task goes on: the gate decides what happens next/);
  } finally {
    delete process.env.WOLOLO_HEARTBEAT_MS;
  }
});

// The first builder commits half the work then hangs; a continued builder finishes it.
const HALF_DONE_AGENT = (/** @type {string} */ mode) => `
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\\n');
if (prompt.includes('You are the planner')) {
  fs.writeFileSync(/Write the plan to (\\S+)/.exec(prompt)[1], JSON.stringify({ tasks: [{ title: 'Add part 1 and part 2' }] }));
} else if (prompt.includes('You are the builder')) {
  if (${JSON.stringify(mode)} === 'finish' && prompt.includes('did not finish')) {
    fs.writeFileSync('part2.js', 'export const b = 2;\\n');
    execSync('git add -A && git commit -qm "feat: part 2"');
  } else {
    if (!fs.existsSync('part1.js')) { fs.writeFileSync('part1.js', 'export const a = 1;\\n'); execSync('git add -A && git commit -qm "feat: part 1"'); }
    setInterval(() => {}, 1000);
  }
}`;

test('a builder that runs out of time does not land its task on a green gate: a fresh builder continues it', () => {
  writeFileSync(join(scratch, 'agent.cjs'), HALF_DONE_AGENT('finish'));
  setup({ agentTimeoutMinutes: 0.03, verifiers: 0 });
  const r = wololo(['autopilot', '--goal', 'Add part 1 and part 2', '--verifiers', '0']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /builder did not finish \(timed out after 0\.03m\); a fresh builder continues it \(1\/2\)/);
  const builders = prompts().filter((p) => p.includes('You are the builder'));
  assert.equal(builders.length, 2);
  assert.match(builders[1], /did not finish[\s\S]*feat: part 1/, 'the next builder is told what already landed');
  assert.ok(readFileSync(join(repo, 'part2.js'), 'utf8'));
});

test('a builder that never finishes is continued, then split, and blocks when it cannot be split, instead of landing half-built work', () => {
  writeFileSync(join(scratch, 'agent.cjs'), HALF_DONE_AGENT('never'));
  setup({ agentTimeoutMinutes: 0.03, stuckAfter: 1 });
  const r = wololo(['autopilot', '--goal', 'Add part 1 and part 2', '--plan']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /stopped at .*\n {2}why: autopilot: the builder did not finish \(timed out after 0\.03m\) and the splitter wrote no smaller steps/);
  assert.equal(prompts().filter((p) => p.includes('You are the builder')).length, 2, 'continued once (stuckAfter) before splitting');
  assert.equal(prompts().filter((p) => p.includes('You are the splitter')).length, 1);
  assert.equal(prompts().filter((p) => p.includes('You are a verifier')).length, 0, 'no verifiers on unfinished work');
});

test('an agent that stalls (no output, no file changes) is killed early, and a failing model server is named', () => {
  const stall = `
const prompt = process.argv[2];
if (prompt.includes('You are the builder')) {
  console.error('Retrying (1/10): Engine protocol predict stream returned an error: {"code":500,"message":"got exception: speculative batch index 2 is not inside the current sub-batch [0, 2)","type":"server_error"}');
  setInterval(() => process.stdout.write('Working...\\n'), 200);
}`;
  writeFileSync(join(scratch, 'agent.cjs'), stall);
  setup({ stallMinutes: 0.02, stuckAfter: 1 });
  const started = Date.now();
  const r = wololo(['autopilot', '--goal', 'Add alpha']);
  assert.ok(Date.now() - started < 30_000, 'killed long before the 45m limit');
  assert.equal(r.code, 1);
  assert.match(r.err, /builder stalled: no progress for 0\.02m/);
  assert.match(r.err, /the model server keeps failing: .*speculative batch/);
  assert.match(r.err, /speculative decoding/i, 'says what to change on the server');
});

test('an agent stuck compacting (overflow, compact, overflow…) is killed at once and a fresh builder continues', () => {
  const loop = `
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\\n');
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
if (prompt.includes('You are the builder')) {
  if (prompt.includes('did not finish')) {
    fs.writeFileSync('alpha.js', 'export const a = 1;\\n');
    execSync('git add -A && git commit -qm "feat: alpha"');
  } else {
    fs.writeFileSync('wip.js', 'export const w = 1;\\n');
    emit({ type: 'tool_execution_start', toolName: 'read', args: { path: 'src/building/mod.rs' } });
    setInterval(() => {
      emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}' } });
      emit({ type: 'auto_compaction_start', reason: 'overflow' });
      emit({ type: 'auto_compaction_end' });
    }, 100);
  }
}`;
  writeFileSync(join(scratch, 'agent.cjs'), loop);
  setup({ agentTimeoutMinutes: 5, stallMinutes: 5, verifiers: 0 });
  const started = Date.now();
  const r = wololo(['autopilot', '--goal', 'Add alpha', '--verifiers', '0']);
  assert.ok(Date.now() - started < 30_000, 'killed long before the stall or time limit');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /builder is stuck in a compaction loop: \d+ compactions with no work in between/);
  assert.match(r.err, /builder did not finish \(stuck in a compaction loop\); a fresh builder continues it/);
  const builders = prompts().filter((p) => p.includes('You are the builder'));
  assert.equal(builders.length, 2);
  assert.match(builders[1], /did not finish \(stuck in a compaction loop\)/);
  assert.match(builders[1], /line ranges/, 'the fresh builder is told how to stay inside the window');
});

test('a landed step commits what the gate verified, so the next builder does not inherit a dirty tree', () => {
  const lazy = `
const fs = require('node:fs');
if (process.argv[2].includes('You are the builder')) fs.writeFileSync('alpha.js', 'export const alpha = 1;\\n');`;
  writeFileSync(join(scratch, 'agent.cjs'), lazy);
  setup({ verifiers: 0 });
  const r = wololo(['autopilot', '--goal', 'Add alpha', '--verifiers', '0']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), '', 'nothing left uncommitted');
  assert.match(spawnSync('git', ['log', '-1', '--format=%s', '--name-only'], { cwd: repo, encoding: 'utf8' }).stdout, /Add alpha \(autopilot: landed, gate green\)[\s\S]*alpha\.js/);
  assert.match(r.err, /committed 1 file\(s\) the agents left uncommitted/);
});

test('an agent going in circles (the same reads over and over, no edits) is killed early', () => {
  const circles = `
const fs = require('node:fs');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\\n');
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
if (prompt.includes('You are the builder')) {
  if (prompt.includes('did not finish')) { fs.writeFileSync('alpha.js', 'export const alpha = 1;\\n'); }
  else {
    const reads = ['git diff src/main.rs', 'git diff tests/a.rs | head -60', 'git diff tests/a.rs | tail -40', 'cat tests/b.rs'];
    let n = 0;
    setInterval(() => emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: reads[n++ % reads.length] } }), 20);
  }
}`;
  writeFileSync(join(scratch, 'agent.cjs'), circles);
  setup({ agentTimeoutMinutes: 5, stallMinutes: 5, verifiers: 0 });
  const started = Date.now();
  const r = wololo(['autopilot', '--goal', 'Add alpha', '--verifiers', '0']);
  assert.ok(Date.now() - started < 30_000, 'killed long before the time limit');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /builder is going in circles: \d+ tool calls with no edits, \d+ of them repeats \(e\.g\. bash: git diff/);
  assert.match(r.err, /builder did not finish \(going in circles\); a fresh builder continues it/);
});
