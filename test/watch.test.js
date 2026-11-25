import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseLine } from '../src/features/autopilot/activity.js';
import { render } from '../src/features/watch/render.js';
import { BIN, repo, scratch, setup, wololo } from './helpers/autopilot-fixture.js';

const line = (/** @type {any} */ e) => JSON.stringify(e);
/** parseLine without usage, which test/usage.test.js covers. @param {string} l */
const activity = (l) => {
  const { usage, ...rest } = parseLine(l);
  return rest;
};

test('omp and claude event streams become one readable line per action, plus the answer and context use', () => {
  assert.deepEqual(parseLine(line({ type: 'tool_execution_start', toolName: 'bash', toolCallId: '1', args: { command: 'cargo test --quiet' } })), { say: 'bash: cargo test --quiet', kind: 'work', tool: 'bash' });
  assert.deepEqual(parseLine(line({ type: 'tool_execution_start', toolName: 'edit', toolCallId: '2', args: { path: 'src/villager.rs' }, intent: 'add hunger' })), { say: 'edit: src/villager.rs (add hunger)', kind: 'work', tool: 'edit' });
  assert.match(parseLine(line({ type: 'tool_execution_end', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'exit 101' }] } })).say ?? '', /bash failed: exit 101/);
  assert.deepEqual(activity(line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\nAll good' }], usage: { input: 20000, cacheRead: 1000, output: 50 }, stopReason: 'stop' } })), { say: 'says: Done.', text: 'Done.\nAll good', tokens: 21000, kind: 'work' });
  assert.match(parseLine(line({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Context size has been exceeded.' } })).text ?? '', /Context size has been exceeded/, 'errors reach the overflow hint');
  assert.deepEqual(
    activity(line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }], usage: { input: 9000, output: 8192 }, stopReason: 'length' } })),
    { say: 'reply cut off at the output limit (8192 output tokens)', kind: 'compact', cutoff: 8192, tokens: 9000 },
    'a reply cut off at the output cap is not progress',
  );
  assert.deepEqual(parseLine(line({ type: 'auto_compaction_start', reason: 'threshold' })), { say: 'compacting context (threshold)', kind: 'compact' });
  assert.deepEqual(parseLine(line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })), {}, 'token deltas are noise');
  assert.equal(parseLine(line({ type: 'message_start', message: { role: 'assistant', content: [], model: 'nemotron-super' } })).model, 'nemotron-super', 'omp names the model on each message');
  assert.equal(parseLine(line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' })).model, 'claude-opus-5-5', 'claude names it in its init event');

  assert.deepEqual(activity(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.js' } }], usage: { input_tokens: 9000 } } })), { say: 'Read: a.js', tokens: 9000, kind: 'work', tool: 'Read' });
  assert.deepEqual(parseLine(line({ type: 'result', result: 'Finished', is_error: false })), { text: 'Finished' });

  assert.deepEqual(parseLine('Working...'), {}, 'the spinner is not activity');
  assert.deepEqual(parseLine('compiling bevy v0.14'), { say: 'compiling bevy v0.14' }, 'plain agents still show their lines');
});

/** @param {Partial<import('../src/features/autopilot/status.js').Status>} status @param {Partial<import('../src/features/watch/render.js').View>} [over] */
const frame = (status, over = {}) =>
  render({
    status: { pid: 1, started: new Date(0).toISOString(), state: 'running', activity: [], ...status },
    tasks: [],
    alive: true,
    now: 13 * 60_000,
    width: 200,
    height: 40,
    color: false,
    ...over,
  });

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const visible = (/** @type {string} */ s) => s.replace(ANSI, '');
const t = (/** @type {string} */ id, /** @type {any} */ status, extra = {}) => ({ id, title: `Step ${id}`, group: 'g', body: '', status, queue: [], notes: [], created: '', updated: '', ...extra });
const busy = /** @type {any} */ ({
  group: 'g',
  agentCli: 'omp',
  model: 'nemotron-super',
  version: '9.9.9',
  stallMinutes: 20,
  task: { id: '2', title: 'Step 2', started: new Date(5 * 60_000).toISOString() },
  contextWindow: 32768,
  agent: { role: 'fixer', started: new Date(60_000).toISOString(), timeoutMinutes: 45, base: 'x', tokens: 24576, calls: 14, edits: 3, compactions: 1, idleSince: new Date(12.5 * 60_000).toISOString(), error: 'Retrying (1/10): {"code":500}' },
  gate: 'red: verify: FAIL cargo-test',
  gateAt: new Date(10 * 60_000).toISOString(),
  stats: { builder: 3, fixer: 2, verifier: 1, 'gate green': 4, 'gate red': 2, landed: 1, landedMs: 40 * 60_000, split: 1, 'killed: timeout': 1, 'killed: circles': 2 },
  activity: [
    { at: new Date().toISOString(), line: 'bash: cargo test' },
    { at: new Date().toISOString(), line: 'edit: src/villager.rs' },
    { at: new Date().toISOString(), line: '» iteration 2: gate red → fixer' },
  ],
});
const plan = [t('1', 'done'), t('1a', 'done', { splitInto: ['1a-s1'] }), t('1a-s1', 'done', { splitDepth: 1 }), t('2', 'claimed'), t('3', 'todo'), t('4', 'blocked', { blockedOn: 'human' })];

test('watch shows the plan, the agent with gauges, the repo, run stats and a feed, and notices a dead run', () => {
  const out = frame(busy, { tasks: plan, git: '2 uncommitted file(s), no commits yet' });
  assert.match(out, /WOLOLO AUTOPILOT +● running +omp +model nemotron-super +v9\.9\.9 +32\.8k ctx +pid 1 +up 13m/);
  assert.match(out, /Plan · g/);
  assert.match(out, /[█░]{10,} 2\/5 landed · 40%/, 'split parents do not count as steps');
  assert.match(out, /~1h20m left \(40m\/step\)/, 'an ETA from the steps that landed this run');
  assert.match(out, /✓ Step 1\b/);
  assert.match(out, /⑂ Step 1a {2}split into 1/);
  assert.match(out, / {4}✓ Step 1a-s1/, 'sub-steps are indented under their parent');
  assert.match(out, /▶ Step 2 +8m/, 'the current step shows how long it has run');
  assert.match(out, /✗ Step 4 \(blocked on human\)/);

  assert.match(out, /Agent · fixer/);
  assert.match(out, /time +[█░]+ 12m \/ 45m/);
  assert.match(out, /context +[█░]+ 24\.6k \/ 32\.8k 75%/);
  assert.match(out, /idle +[█░]+ 30s \/ 20m/, 'how close the agent is to being killed for stalling');
  assert.match(out, /tools +14 calls · 3 edits · 1 compaction/);
  assert.match(out, /server +Retrying \(1\/10\)/);

  assert.match(out, /Repo/);
  assert.match(out, /git +2 uncommitted file\(s\)/);
  assert.match(out, /gate +✗ red: verify: FAIL cargo-test +3m ago/);

  assert.match(out, /Run/);
  assert.match(out, /agents +builder 3 · fixer 2 · verifier 1/);
  assert.match(out, /gates +4 green · 2 red/);
  assert.match(out, /kills +circles 2 · timeout 1/);
  assert.match(out, /steps +1 landed · 1 split/);

  assert.match(out, /Activity/);
  assert.match(out, /bash: cargo test/);
  assert.match(out, /q quit/);

  assert.match(frame({}, { alive: false }), /✗ not running/);
  assert.match(frame({}, { alive: false }), /killed or crashed; press r to resume/);
  assert.match(render({ status: null, tasks: [], alive: false, now: 0, width: 80, height: 20, color: false }), /no run yet/);
});

test('watch lays panels side by side when wide, stacks them when narrow, and never overflows the terminal', () => {
  const wide = frame(busy, { tasks: plan, width: 160, height: 40 }).split('\n');
  assert.ok(wide.some((l) => /Plan · g/.test(l) && /Agent · fixer/.test(l)), 'plan and agent share a row');
  const narrow = frame(busy, { tasks: plan, width: 80, height: 60 }).split('\n');
  assert.ok(!narrow.some((l) => /Plan/.test(l) && /Agent/.test(l)), 'stacked');
  assert.ok(narrow.findIndex((l) => /Plan · g/.test(l)) < narrow.findIndex((l) => /Agent · fixer/.test(l)));
  for (const [width, height] of [[60, 20], [80, 30], [120, 40], [200, 60]]) {
    for (const color of [false, true]) {
      const lines = frame(busy, { tasks: plan, width, height, color, git: 'x'.repeat(300) }).split('\n');
      assert.ok(lines.length <= height, `${lines.length} lines fit ${height}`);
      for (const l of lines) assert.ok(visible(l).length <= width, `fits ${width}: ${visible(l)}`);
      if (!color) assert.doesNotMatch(lines.join('\n'), ANSI, 'plain when color is off');
    }
  }
});

// A builder that streams omp-style JSON, looks at `wololo watch --once` halfway, then finishes.
const STREAMING_AGENT = `
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
const say = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (prompt.includes('You are the builder')) {
  say({ type: 'tool_execution_start', toolName: 'bash', toolCallId: '1', args: { command: 'cargo test' } });
  say({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking around' }], usage: { input: 20000 }, stopReason: 'toolUse' } });
  sleep(400);
  fs.writeFileSync(process.env.MID, require('node:child_process').execFileSync(process.execPath, [process.env.BIN, 'watch', '--once'], { encoding: 'utf8' }));
  fs.writeFileSync('feature.js', 'export const f = 1;\\n');
  execSync('git add -A && git commit -qm "feat: f"');
  say({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Built the feature.' }], usage: { input: 21000 }, stopReason: 'stop' } });
}
`;

test('autopilot streams what the agent does, and watch shows it live and after the run', () => {
  const mid = join(scratch, 'mid.txt');
  writeFileSync(join(scratch, 'agent.cjs'), `process.env.MID = ${JSON.stringify(mid)}; process.env.BIN = ${JSON.stringify(BIN)};\n${STREAMING_AGENT}`);
  setup({ contextWindow: 32768 });
  const r = wololo(['autopilot', '--goal', 'Add the feature', '--verifiers', '0']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /builder · bash: cargo test/, 'tool calls are echoed as they happen');
  assert.match(r.err, /watch it live: .* watch/);
  assert.match(r.err, /exited 0\nBuilt the feature\./, 'the answer is shown, not raw JSON');
  assert.doesNotMatch(r.err, /"tool_execution_start"/);

  const during = readFileSync(mid, 'utf8');
  assert.match(during, /WOLOLO AUTOPILOT +● running/);
  assert.match(during, /goal +Add the feature/);
  assert.match(during, /Agent · builder/);
  assert.match(during, /context +[█░]+ 20\.0k \/ 32\.8k 61%/);
  assert.match(during, /tools +1 call · 0 edits/);
  assert.match(during, /agents +builder 1/);
  assert.match(during, /bash: cargo test/);

  const after = wololo(['watch', '--once']);
  assert.equal(after.code, 0);
  assert.match(after.out, /WOLOLO AUTOPILOT +✓ landed/);
  assert.match(after.out, /steps +1 landed/);
  assert.match(after.out, /says: Built the feature\./);
  assert.match(readFileSync(join(repo, '.wololo/state/autopilot.log'), 'utf8'), /bash: cargo test/, 'the log is readable too');
});
