import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const BIN = resolve('bin/wololo.js');
/** @type {string} */
let repo;
/** @type {string} */
let scratch;

/** @param {string[]} args */
const wololo = (args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, WOLOLO_HOME: scratch } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
/** @param {string[]} args */
const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

// A stand-in for `claude -p`: the builder writes the feature and commits; fixers and verifiers find nothing.
const FAKE_AGENT = `
const { appendFileSync, writeFileSync } = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\\n');
if (prompt.includes('You are the builder') && prompt.includes('BREAK')) {
  writeFileSync('broken.js', 'function f() {\\n  debugger;\\n}\\n');
  execSync('git add -A && git commit -qm "wip"');
} else if (prompt.includes('You are the builder') && prompt.includes('NITPICK')) {
  writeFileSync('clock.js', 'export const step = (t, dt) => t + dt;\\n');
  writeFileSync('nitpick', '0');
  execSync('git add -A && git commit -qm "feat: clock"');
} else if (prompt.includes('You are a verifier') && require('node:fs').existsSync('nitpick')) {
  // A verifier that always finds one more edge case: commits a change every run.
  const n = Number(require('node:fs').readFileSync('nitpick', 'utf8')) + 1;
  writeFileSync('nitpick', String(n));
  execSync('git add -A && git commit -qm "fix: edge case ' + n + '"');
} else if (prompt.includes('You are the builder')) {
  writeFileSync('feature.js', 'export const greet = (n) => \`hello \${n}\`;\\n');
  execSync('git add -A && git commit -qm "feat: greet"');
}
`;

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'wololo-autopilot-'));
  scratch = mkdtempSync(join(tmpdir(), 'wololo-autopilot-home-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }));
  assert.equal(wololo(['init', '--bin', `node ${BIN}`, '--harness', 'claude', '--ci', 'none']).code, 0);
  const agent = join(scratch, 'agent.cjs');
  writeFileSync(agent, FAKE_AGENT);
  process.env.PROMPT_LOG = join(scratch, 'prompts.jsonl');
  const config = JSON.parse(readFileSync(join(repo, 'wololo.config.json'), 'utf8'));
  config.autopilot.command = [process.execPath, agent, '{prompt}'];
  writeFileSync(join(repo, 'wololo.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const prompts = () => readFileSync(/** @type {string} */ (process.env.PROMPT_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('autopilot --task builds the feature from the board, lands it and closes the task', () => {
  const added = JSON.parse(wololo(['task', 'add', 'Add a greet helper', '--body', 'greet(name) returns "hello <name>"', '--json']).out);
  const id = added.data.id ?? added.data.task?.id;

  const r = wololo(['autopilot', '--task', id]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /landed/);

  const builder = prompts().find((p) => p.includes('You are the builder'));
  assert.ok(builder, 'a builder agent ran');
  assert.match(builder, /Add a greet helper/);
  assert.match(builder, /greet\(name\) returns "hello <name>"/);
  assert.ok(prompts().indexOf(builder) === 0, 'builder runs before verifiers');

  assert.match(readFileSync(join(repo, 'feature.js'), 'utf8'), /hello/);
  const task = JSON.parse(wololo(['task', 'list', '--status', 'done', '--json']).out).data.find((/** @type {{id: string}} */ t) => t.id === id);
  assert.equal(task.status, 'done');
  assert.ok(task.notes.some((/** @type {string} */ n) => /autopilot/.test(n)));
});

test('autopilot --goal and --task are mutually exclusive, and unknown tasks are refused', () => {
  assert.notEqual(wololo(['autopilot', '--task', 'nope']).code, 0);
  assert.notEqual(wololo(['autopilot', '--task', 'x', '--goal', 'y']).code, 0);
});

test('autopilot --goal --dry-run shows the builder prompt without spawning agents', () => {
  const before = prompts().length;
  const r = wololo(['autopilot', '--goal', 'Add a farewell helper', '--dry-run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /builder/);
  assert.match(r.out, /Add a farewell helper/);
  assert.equal(prompts().length, before);
});

test('autopilot blocks the task on a human when the gate never goes green', () => {
  const added = JSON.parse(wololo(['task', 'add', 'BREAK the build on purpose', '--json']).out);
  const id = added.data.id ?? added.data.task?.id;
  const r = wololo(['autopilot', '--task', id, '--max', '2']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /did not converge/);
  assert.ok(prompts().some((p) => p.includes('You are the fixer') && p.includes('no-debugger')), 'fixer saw the gate failure');
  const task = JSON.parse(wololo(['task', 'list', '--status', 'blocked', '--json']).out).data.find((/** @type {{id: string}} */ t) => t.id === id);
  assert.equal(task?.blockedOn, 'human');
});

test('autopilot lands a green task when verifiers keep finding things past --max, instead of blocking on a human', () => {
  git(['rm', '-q', '--ignore-unmatch', 'broken.js']); // left red by the BREAK test
  git(['commit', '-qm', 'drop broken']);
  const base = git(['rev-parse', 'HEAD']).stdout.trim();
  const added = JSON.parse(wololo(['task', 'add', 'NITPICK clock', '--json']).out);
  const id = added.data.id ?? added.data.task?.id;
  const r = wololo(['autopilot', '--task', id, '--max', '2']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /landed/);
  assert.match(r.out, /verifiers still finding/);
  const task = JSON.parse(wololo(['task', 'list', '--status', 'done', '--json']).out).data.find((/** @type {{id: string}} */ t) => t.id === id);
  assert.equal(task?.status, 'done');
  const verifier = prompts().filter((p) => p.includes('You are a verifier')).at(-1);
  assert.ok(verifier?.includes(`git diff ${base}`), 'verifier is scoped to the task diff, not the latest commit');
  rmSync(join(repo, 'nitpick'));
  git(['commit', '-qam', 'cleanup']);
});
