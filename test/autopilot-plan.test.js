import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.js';
import { GREENFIELD_AGENT, greenfield, BIN, git, prompts, repo, scratch, setup, tasks, wololo } from './helpers/autopilot-fixture.js';

test('autopilot --plan splits a goal into small board tasks and builds them one at a time with fresh agents', () => {
  setup({ contextWindow: 32000 });
  const r = wololo(['autopilot', '--goal', 'Build the alpha/beta module', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /2\/2 task\(s\) landed/);
  assert.ok(existsSync(join(repo, 'alpha.js')) && existsSync(join(repo, 'beta.js')));

  const done = tasks('done');
  assert.deepEqual(done.map((/** @type {{title: string}} */ t) => t.title), ['Add alpha', 'Add beta']);
  assert.equal(new Set(done.map((/** @type {{group: string}} */ t) => t.group)).size, 1, 'one coordinator group per plan');

  const ps = prompts();
  const planner = ps.find((p) => p.includes('You are the planner'));
  assert.match(planner, /32k-token context window/);
  const builders = ps.filter((p) => p.includes('You are the builder'));
  assert.equal(builders.length, 2, 'one fresh builder per task');
  assert.match(builders[1], /Already done:[\s\S]*Add alpha/, 'the second builder is told what the first one landed');
  assert.match(builders[1], /Build the alpha\/beta module/, 'every builder sees the overall goal');
  assert.match(builders[0], /32k-token context window/);
});

test('a plan stops at the first task that cannot land; --group resumes where it stopped', () => {
  const r = wololo(['autopilot', '--goal', 'STUCK plan', '--plan', '--max', '2']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /stopped at "BREAK the build"/);
  assert.equal(tasks('blocked').length, 1);
  assert.match(r.out, new RegExp(`task release ${tasks('blocked')[0].id}`), 'says exactly how to retry it');
  assert.match(r.out, /why: autopilot: did not converge/, 'says why it blocked');
  const todo = tasks('todo');
  assert.deepEqual(todo.map((/** @type {{title: string}} */ t) => t.title), ['Add gamma'], 'later tasks are left for a resume');

  // A human fixes the environment, unblocks the task, and fire-and-forget resumes the rest of the plan.
  git(['rm', '-q', 'broken.js']);
  git(['commit', '-qm', 'human: remove debugger']);
  const blocked = tasks('blocked')[0];
  wololo(['task', 'done', blocked.id, '--note', 'fixed by hand']);
  const resumed = wololo(['autopilot', '--group', blocked.group]);
  assert.equal(resumed.code, 0, resumed.out + resumed.err);
  assert.ok(existsSync(join(repo, 'gamma.js')));
  assert.equal(tasks('todo').length, 0);
});

test('autopilot stops early when the fixer keeps failing on the same error instead of burning every iteration', () => {
  setup({ maxIterations: 10, stuckAfter: 2 });
  const r = wololo(['autopilot', '--goal', 'BREAK everything']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /stuck: the same gate failure survived 2 fix attempt\(s\)/);
  const fixers = prompts().filter((p) => p.includes('You are the fixer'));
  assert.equal(fixers.length, 2);
  assert.match(fixers[1], /previous fix attempt did not change this failure/i);
});

test('autopilot detects verifiers ping-ponging between the same states', () => {
  writeFileSync(join(repo, 'TOGGLE'), '');
  setup({ maxIterations: 10 });
  const r = wololo(['autopilot']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /stuck: verifiers returned the code to a state already seen/);
  assert.ok(prompts().filter((p) => p.includes('You are a verifier')).length < 10);
});

test('the context budget caps gate output handed to agents', async () => {
  const { failureBudget, clip } = await import('../src/features/autopilot/budget.js');
  assert.equal(failureBudget(undefined), 12_000);
  assert.equal(failureBudget(32_000), 12_800);
  const clipped = clip(`${'x'.repeat(50_000)}\nthe real error`, 1000);
  assert.ok(clipped.length <= 1000);
  assert.match(clipped, /the real error$/, 'keeps the end, where failures are');
});

test('mcp.tools limits the tools an agent loads, to save context', () => {
  setup({}, { mcp: { tools: ['gate', 'task note'] } });
  const out = wololo(['mcp'], `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`).out;
  const names = JSON.parse(out.trim().split('\n')[0]).result.tools.map((/** @type {{name: string}} */ t) => t.name);
  assert.deepEqual(names.sort(), ['wololo_gate', 'wololo_task_note']);
});

test('when the planner agent fails, the error says how and shows its output', () => {
  writeFileSync(join(scratch, 'agent.cjs'), 'console.error("not logged in: run omp /login"); process.exit(3);');
  const r = wololo(['autopilot', '--goal', 'anything', '--plan']);
  assert.notEqual(r.code, 0);
  assert.match(r.out + r.err, /exited 3/);
  assert.match(r.out + r.err, /not logged in: run omp \/login/);
});

test('autopilot refuses up front when the agent CLI is not installed', () => {
  setup({ command: undefined, agent: 'claude' });
  const which = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const PATH = [dirname(process.execPath), dirname(which)].join(delimiter);
  const r = spawnSync(process.execPath, [BIN, 'autopilot', '--goal', 'anything', '--plan'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH, WOLOLO_HOME: scratch } });
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /claude.*not found on PATH/);
});

test('a context overflow says to set autopilot.contextWindow', () => {
  writeFileSync(join(scratch, 'agent.cjs'), 'console.error("request (33888 tokens) exceeds the available context size (32768 tokens)"); process.exit(1);');
  const r = wololo(['autopilot', '--goal', 'anything', '--plan']);
  assert.match(r.out + r.err, /autopilot\.contextWindow/);
});

test('the default agent argv gets the context window (dry run shows omp trimmed for 32k)', () => {
  setup({ command: undefined, agent: 'omp', contextWindow: 32768 });
  const r = wololo(['autopilot', '--goal', 'anything', '--plan', '--dry-run', '--json']);
  const plan = JSON.parse(r.out).data.plan;
  assert.ok(plan[0].includes('--tools'), plan[0].join(' '));
  assert.equal(plan[0][plan[0].indexOf('--thinking') + 1], 'low', 'long thinking fills the output cap on a small window');
});

test('omp: autopilot.thinking overrides the level, and a tool-free run keeps MCP tools out', () => {
  const omp = ADAPTERS.omp.headless;
  assert.ok(omp);
  const off = omp('x', { contextWindow: 32768, thinking: 'off' });
  assert.equal(off[off.indexOf('--thinking') + 1], 'off');
  assert.ok(!omp('x', { contextWindow: 200_000 }).includes('--thinking'), 'big windows keep the user\'s default');
  // omp --no-tools drops only built-ins and inlines every MCP server's tools (measured: a user's
  // global MCP servers sent 237k tokens). An allowlist with bash folds MCP tools into bash commands.
  const bare = omp('x', { contextWindow: 32768, tools: false });
  assert.equal(bare[bare.indexOf('--tools') + 1], 'bash', bare.join(' '));
  assert.ok(bare.includes('--no-skills') && !bare.includes('--no-tools'), bare.join(' '));
});

test('on a small window omp compacts early: sync writes a compaction overlay and headless omp loads it', () => {
  setup({ command: undefined, agent: 'omp', contextWindow: 32768 }, { harnesses: ['claude', 'omp'] });
  wololo(['sync']);
  const overlay = readFileSync(join(repo, '.omp', 'wololo-small-window.yml'), 'utf8');
  const num = (/** @type {string} */ k) => Number(new RegExp(`${k}: (\\d+)`).exec(overlay)?.[1]);
  assert.ok(num('thresholdTokens') > 0 && num('thresholdTokens') <= 32768 * 0.65, overlay);
  assert.ok(num('keepRecentTokens') < 32768 / 4, 'omp keeps 20k recent tokens by default, too much for 32k');
  const plan = JSON.parse(wololo(['autopilot', '--goal', 'anything', '--plan', '--dry-run', '--json']).out).data.plan;
  assert.equal(plan[0][plan[0].indexOf('--config') + 1], '.omp/wololo-small-window.yml');

  setup({ command: undefined, agent: 'omp', contextWindow: 200000 }, { harnesses: ['claude', 'omp'] });
  wololo(['sync']);
  assert.equal(existsSync(join(repo, '.omp', 'wololo-small-window.yml')), false, 'big windows use omp defaults');
});

test('on a small window the planner does no research up front: research becomes plan steps', () => {
  setup({ contextWindow: 32768 });
  wololo(['autopilot', '--goal', 'Build the alpha/beta module', '--plan', '--max', '1']);
  const planner = prompts().find((p) => p.includes('You are the planner'));
  assert.match(planner, /do not (browse|research)/i);
  assert.match(planner, /first step/i);
  assert.match(planner, /Search before reading/, 'gets the small-window rules');
  assert.match(planner, /at most 3 files and about 300 lines of new code/, 'step size is a number sized to the window, not "small"');
  assert.match(planner, /at most 150 lines per edit/, 'replies past the output limit get cut off ("incomplete" compaction)');
  const builder = prompts().find((p) => p.includes('You are the builder')) ?? '';
  assert.match(builder, /at most 150 lines per edit/);
});

test('a planner that overflows or times out is retried once, planning from the goal alone', () => {
  const agent = `
const fs = require('node:fs');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\\n');
if (!prompt.includes('You are the planner')) process.exit(0);
if (!prompt.includes('from the goal alone')) {
  console.error('Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded."}');
  process.exit(1);
}
fs.writeFileSync(/Write the plan to (\\S+)/.exec(prompt)[1], JSON.stringify({ tasks: [{ title: 'Add alpha', body: 'alpha.js' }] }));`;
  writeFileSync(join(scratch, 'agent.cjs'), agent);
  setup({ contextWindow: 32768 });
  const r = wololo(['autopilot', '--goal', 'Build alpha', '--plan', '--max', '1']);
  assert.match(r.err, /planner ran out of context.*retrying/i);
  assert.equal(prompts().filter((p) => p.includes('You are the planner')).length, 2);
  assert.match(r.err, /task plan-.*: Add alpha/, 'the retried plan is built');
});

test('small context windows default the MCP server to a handful of tools', () => {
  setup({ contextWindow: 32768 });
  const out = wololo(['mcp'], `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`).out;
  const names = JSON.parse(out.trim().split('\n')[0]).result.tools.map((/** @type {{name: string}} */ t) => t.name);
  assert.ok(names.length <= 6, names.join(','));
  assert.ok(names.includes('wololo_gate'));

  const only = wololo(['mcp', '--tools', 'check'], `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`).out;
  assert.deepEqual(JSON.parse(only.trim().split('\n')[0]).result.tools.map((/** @type {{name: string}} */ t) => t.name), ['wololo_check'], '--tools overrides the config');
});

test('sync bakes the MCP allowlist into the server args, so harness tool caches see a new server', () => {
  setup({ contextWindow: 32768 }, { harnesses: ['claude'] });
  wololo(['sync']);
  const args = JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8')).mcpServers.wololo.args;
  assert.deepEqual(args.slice(-3), ['mcp', '--tools', 'gate,verify,check,task note,queue add']);

  setup({ contextWindow: 200000 }, { harnesses: ['claude'] });
  wololo(['sync']);
  assert.equal(JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8')).mcpServers.wololo.args.at(-1), 'mcp', 'big windows keep every tool');
});

test('a context overflow reports the numbers and what is (not) being trimmed', () => {
  const overflow = 'console.error(JSON.stringify({error:{message:"request (34106 tokens) exceeds the available context size (32768 tokens)",n_prompt_tokens:34106,n_ctx:32768}})); process.exit(1);';
  writeFileSync(join(scratch, 'agent.cjs'), overflow);
  setup({ contextWindow: 32768 });
  let r = wololo(['autopilot', '--goal', 'anything', '--plan']);
  assert.match(r.out + r.err, /34106 tokens.*32768/s);
  assert.match(r.out + r.err, /autopilot\.command.*bypasses/s, 'a custom command skips the adapter trim, say so');

  setup({ command: undefined, agent: 'omp', contextWindow: 65536 });
  const bin = mkdtempSync(join(tmpdir(), 'wololo-fakebin-'));
  writeFileSync(join(bin, 'omp'), `#!/bin/sh\nexec "${process.execPath}" "${join(scratch, 'agent.cjs')}" "$@"\n`, { mode: 0o755 });
  // Windows: an npm-style cmd shim, the shape exec.js resolves without a shell.
  writeFileSync(join(bin, 'agent.cjs'), readFileSync(join(scratch, 'agent.cjs')));
  writeFileSync(join(bin, 'omp.cmd'), `@ECHO off\r\nSET "_prog=${process.execPath}"\r\n"%_prog%" "%~dp0\\agent.cjs" %*\r\n`);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, WOLOLO_HOME: scratch };
  const s = spawnSync(process.execPath, [BIN, 'autopilot', '--goal', 'anything', '--plan'], { cwd: repo, encoding: 'utf8', env });
  assert.match(s.stdout + s.stderr, /contextWindow is 65536 but the model has 32768/);
  rmSync(bin, { recursive: true, force: true });
});


test('with no verify steps, autopilot adopts the ones detected once the builder creates the project', () => {
  const builder = `
const fs = require('node:fs');
if (process.argv[2].includes('You are the builder')) fs.writeFileSync('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }));`;
  writeFileSync(join(scratch, 'agent.cjs'), builder);
  rmSync(join(repo, 'package.json'));
  setup({}, { verify: { steps: [], timeoutSec: 60 } });
  const r = wololo(['autopilot', '--goal', 'Add alpha', '--max', '2']);
  assert.match(r.out + r.err, /verification grew with the project: test/);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, 'wololo.config.json'), 'utf8')).verify.steps.map((/** @type {{name: string}} */ s) => s.name), ['test']);
  assert.match(r.out + r.err, /gate green/, 'the reloaded config is what the gate runs');
});

test('a plan in an empty folder scaffolds a verifiable project first, then builds the steps', () => {
  greenfield();
  const r = wololo(['autopilot', '--goal', 'A villager sim', '--plan', '--max', '2']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /task plan-[\w-]+-00: Scaffold the project/);
  assert.match(r.out, /3\/3 task\(s\) landed/);
  const builders = prompts().filter((p) => p.includes('You are the builder')).map((p) => p.split('Implement this feature:')[1].trim().split('\n')[0]);
  assert.deepEqual(builders, ['Scaffold the project so it can be verified', 'Research villagers', 'Add alpha']);
  assert.ok(!prompts().some((p) => p.includes('You are the fixer')), 'no fixer burned on a gate that could not pass');
});

test('resuming a group that was blocked only because nothing was verifiable scaffolds and reopens it', () => {
  greenfield();
  writeFileSync(join(scratch, 'agent.cjs'), GREENFIELD_AGENT.replace("step.includes('Scaffold the project')", 'false'));
  const first = wololo(['autopilot', '--goal', 'A villager sim', '--plan', '--max', '2']);
  assert.notEqual(first.code, 0);
  const group = /--group (\S+)/.exec(first.out + first.err)?.[1];
  assert.ok(group, first.out + first.err);

  writeFileSync(join(scratch, 'agent.cjs'), GREENFIELD_AGENT);
  const r = wololo(['autopilot', '--group', group, '--max', '2']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /landed/);
});

test('a single goal in an empty folder stops at once instead of running fixers that cannot help', () => {
  greenfield();
  writeFileSync(join(scratch, 'agent.cjs'), GREENFIELD_AGENT.replace("step.includes('Scaffold the project')", 'false'));
  const r = wololo(['autopilot', '--goal', 'Research villagers', '--max', '3']);
  assert.notEqual(r.code, 0);
  assert.match(r.out + r.err, /nothing can be verified yet/);
  assert.ok(!prompts().some((p) => p.includes('You are the fixer')));
});
