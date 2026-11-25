import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const BIN = resolve('bin/wololo.js');
/** @type {string} */
let host;
/** @type {string} */
let scratch;

/** @param {string[]} args @param {string} [cwd] */
const wololo = (args, cwd = host) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, WOLOLO_HOME: scratch } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

/** @param {string} root @param {Record<string, string>} files */
const write = (root, files) => {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
};

const HIDDEN = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add } from '../src/math.js';
test('adds', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});
`;

// Stand-in for a coding agent: it gets the answer right only when the harness's instructions (AGENTS.md) are present,
// so a working bench must report a gap between the arms. It also logs whether it could see the hidden tests.
const FAKE_AGENT = `
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
appendFileSync(process.env.BENCH_LOG, JSON.stringify({ hidden: existsSync('hidden'), agents: existsSync('AGENTS.md'), builder: process.argv[2].includes('You are the builder') }) + '\\n');
const body = existsSync('AGENTS.md') ? 'a + b' : 'a - b';
writeFileSync('src/math.js', 'export const add = (a, b) => ' + body + ';\\n');
`;

before(() => {
  host = mkdtempSync(join(tmpdir(), 'wololo-bench-'));
  scratch = mkdtempSync(join(tmpdir(), 'wololo-bench-home-'));
  const agent = join(scratch, 'agent.cjs');
  writeFileSync(agent, FAKE_AGENT);
  process.env.BENCH_LOG = join(scratch, 'agent.jsonl');
  write(host, {
    'wololo.config.json': JSON.stringify({ autopilot: { agent: 'claude', command: [process.execPath, agent, '{prompt}'], verifiers: 1, maxIterations: 2 } }),
    'bench/add/task.json': JSON.stringify({ prompt: 'Implement add(a, b) in src/math.js so it returns the sum.', check: 'node --test hidden/math.test.js' }),
    'bench/add/repo/package.json': JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'node -e "process.exit(0)"' } }),
    'bench/add/repo/src/math.js': "export const add = () => { throw new Error('todo'); };\n",
    'bench/add/hidden/math.test.js': HIDDEN,
    'bench/add/solution/src/math.js': 'export const add = (a, b) => a + b;\n',
  });
});

after(() => {
  rmSync(host, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const agentLog = () => readFileSync(/** @type {string} */ (process.env.BENCH_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('bench validate: the hidden check must fail on the starting repo and pass with the reference solution', () => {
  const ok = wololo(['bench', 'validate']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /add/);

  write(host, { 'bench/vacuous/task.json': JSON.stringify({ prompt: 'anything', check: 'node -e "process.exit(0)"' }), 'bench/vacuous/repo/README.md': 'x\n' });
  const bad = wololo(['bench', 'validate']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /vacuous.*passes before any change/);
  rmSync(join(host, 'bench/vacuous'), { recursive: true });
});

test('bench run measures the gap between arms, scored by hidden tests the agent never saw', () => {
  const r = wololo(['bench', 'run', '--arms', 'bare,wololo', '--trials', '2', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const { arms, results } = JSON.parse(r.out).data;
  assert.equal(results.length, 4);
  const arm = (/** @type {string} */ name) => arms.find((/** @type {{arm: string}} */ a) => a.arm === name);
  assert.equal(arm('bare').n, 2);
  assert.equal(arm('bare').passRate, 0);
  assert.equal(arm('wololo').passRate, 1);
  assert.equal(arm('wololo').delta, 1);
  assert.ok(arm('wololo').ci[0] > 0 && arm('wololo').ci[1] <= 1, 'wilson interval is a proper interval');
  assert.ok(results.every((/** @type {{changed: string[]}} */ t) => t.changed.includes('src/math.js')));

  const log = agentLog();
  assert.equal(log.length, 4);
  assert.ok(log.every((e) => !e.hidden), 'hidden tests are never visible to the agent');
  assert.equal(log.filter((e) => e.agents).length, 2, 'only the wololo arm has the harness installed');
});

test('bench report re-reads the latest run; the autopilot arm drives wololo autopilot --goal', () => {
  const report = wololo(['bench', 'report']);
  assert.equal(report.code, 0, report.out + report.err);
  assert.match(report.out, /bare\s+2\s+0%/);
  assert.match(report.out, /wololo\s+2\s+100%/);

  const r = wololo(['bench', 'run', '--arms', 'autopilot', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(JSON.parse(r.out).data.arms[0].passRate, 1);
  assert.ok(agentLog().some((e) => e.builder), 'autopilot ran a builder agent');
});

test('bench new scaffolds a task that validate rejects until it has a real check', () => {
  const r = wololo(['bench', 'new', 'todo-feature']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(existsSync(join(host, 'bench/todo-feature/task.json')));
  assert.ok(existsSync(join(host, 'bench/todo-feature/hidden')));
  const v = wololo(['bench', 'validate', '--task', 'todo-feature']);
  assert.notEqual(v.code, 0);
});

test('statistics and parsers: Wilson intervals, Newcombe delta, test-count parsing across runners', async () => {
  const { wilson, diffInterval } = await import('../src/features/bench/stats.js');
  const { hiddenFraction, parseCost } = await import('../src/features/bench/trial.js');
  const [lo, hi] = wilson(2, 2);
  assert.ok(Math.abs(lo - 0.342) < 0.001 && hi === 1);
  assert.ok(Math.abs(wilson(5, 10)[0] - 0.237) < 0.001);
  const [dlo, dhi] = diffInterval(2, 2, 0, 2);
  assert.ok(dlo > 0 && dhi <= 1, 'a 2/2 vs 0/2 gap is significant');
  assert.ok(diffInterval(1, 2, 1, 2)[0] < 0, 'equal arms are not significant');

  assert.equal(hiddenFraction('ℹ tests 4\nℹ pass 3\nℹ fail 1\n', false), 0.75);
  assert.equal(hiddenFraction('# pass 2\n# fail 0\n', true), 1);
  assert.equal(hiddenFraction('Tests:       1 failed, 3 passed, 4 total', false), 0.75);
  assert.equal(hiddenFraction('==== 2 failed, 6 passed in 0.12s ====', false), 0.75);
  assert.equal(hiddenFraction('Segmentation fault', false), 0);
  assert.equal(parseCost('{"type":"result","total_cost_usd":0.4213}'), 0.4213);
  assert.equal(parseCost('done'), null);
});

test("this repo's starter suite is valid: every hidden check fails on the starting code and passes with the solution", () => {
  const r = wololo(['bench', 'validate', resolve('bench')]);
  assert.equal(r.code, 0, r.out + r.err);

  const empty = mkdtempSync(join(tmpdir(), 'wololo-bench-empty-'));
  const plan = wololo(['bench', 'run', '--dry-run'], empty);
  rmSync(empty, { recursive: true, force: true });
  assert.equal(plan.code, 0, plan.out + plan.err);
  assert.match(plan.out, /parse-duration bare #1/, 'projects without bench/ fall back to the starter suite');
});
