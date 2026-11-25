// Shared fixture for autopilot tests: a scratch git repo per test, wololo initialised, and a fake headless agent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, beforeEach } from 'node:test';

export const BIN = resolve('bin/wololo.js');
/** @type {string} */
export let repo;
export const scratch = mkdtempSync(join(tmpdir(), 'wololo-plan-home-'));
export const LOG = join(scratch, 'prompts.jsonl');

/** @param {string[]} args @param {string} [input] */
export const wololo = (args, input) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8', input, env: { ...process.env, WOLOLO_HOME: scratch, PROMPT_LOG: LOG } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
/** @param {string[]} args */
export const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

// Stand-in for a headless agent. The planner writes a plan file; builders create one file per task
// (or break the build when the task says BREAK); a TOGGLE verifier flips a file forever (ping-pong).
export const FAKE_AGENT = `
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\\n');
const commit = (m) => execSync('git add -A && git commit -qm "' + m + '"');
if (prompt.includes('You are the planner')) {
  const path = /Write the plan to (\\S+)/.exec(prompt)[1];
  const tasks = prompt.includes('STUCK')
    ? [{ title: 'Add alpha', body: 'alpha.js' }, { title: 'BREAK the build', body: 'boom' }, { title: 'Add gamma', body: 'gamma.js' }]
    : [{ title: 'Add alpha', body: 'alpha.js exports alpha' }, { title: 'Add beta', body: 'beta.js exports beta' }];
  fs.writeFileSync(path, JSON.stringify({ tasks }));
} else if (prompt.includes('You are the builder')) {
  const m = /Add (\\w+)/.exec(prompt.split('Implement this feature:')[1]);
  if (prompt.split('Implement this feature:')[1].includes('BREAK')) {
    fs.writeFileSync('broken.js', 'function f() {\\n  debugger;\\n}\\n');
    commit('wip');
  } else if (m) {
    fs.writeFileSync(m[1] + '.js', 'export const ' + m[1] + ' = 1;\\n');
    commit('feat: ' + m[1]);
  }
} else if (prompt.includes('You are a verifier') && fs.existsSync('TOGGLE')) {
  const cur = fs.existsSync('toggle.txt') ? fs.readFileSync('toggle.txt', 'utf8') : '';
  fs.writeFileSync('toggle.txt', cur === 'A' ? 'B' : 'A');
  commit('verifier: toggle');
}
`;

/** @param {Record<string, any>} [autopilot] @param {Record<string, any>} [extra] */
export function setup(autopilot = {}, extra = {}) {
  const config = JSON.parse(readFileSync(join(repo, 'wololo.config.json'), 'utf8'));
  config.autopilot = { ...config.autopilot, command: [process.execPath, join(scratch, 'agent.cjs'), '{prompt}'], verifiers: 1, hillClimb: 0, ...autopilot };
  writeFileSync(join(repo, 'wololo.config.json'), `${JSON.stringify({ ...config, ...extra }, null, 2)}\n`);
  wololo(['sync']);
  git(['add', '-A']);
  git(['commit', '-qm', 'config']);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wololo-plan-'));
  writeFileSync(join(scratch, 'agent.cjs'), FAKE_AGENT);
  writeFileSync(LOG, '');
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }));
  assert.equal(wololo(['init', '--bin', `node ${BIN}`, '--harness', 'claude', '--ci', 'none']).code, 0);
  setup();
});

after(() => rmSync(scratch, { recursive: true, force: true }));

export const prompts = () => readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
/** @param {string} status */
export const tasks = (status) => JSON.parse(wololo(['task', 'list', '--status', status, '--json']).out).data;

// Greenfield: no project, no verify steps. Only a scaffold step can make the gate passable.
export const GREENFIELD_AGENT = `
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\\n');
const commit = (m) => execSync('git add -A && git commit -qm "' + m + '"');
if (prompt.includes('You are the planner')) {
  fs.writeFileSync(/Write the plan to (\\S+)/.exec(prompt)[1], JSON.stringify({ tasks: [{ title: 'Research villagers', body: 'notes' }, { title: 'Add alpha', body: 'alpha.js' }] }));
} else if (prompt.includes('You are the builder')) {
  const step = prompt.split('Implement this feature:')[1];
  if (step.includes('Scaffold the project')) {
    fs.writeFileSync('package.json', JSON.stringify({ name: 'g', scripts: { test: 'node -e "process.exit(0)"' } }));
    commit('scaffold');
  } else if (step.includes('Research')) {
    fs.mkdirSync('docs/notes', { recursive: true });
    fs.writeFileSync('docs/notes/villagers.md', '# villagers\\n');
    commit('research');
  } else if (/Add (\\w+)/.test(step)) {
    const n = /Add (\\w+)/.exec(step)[1];
    fs.writeFileSync(n + '.js', 'export const ' + n + ' = 1;\\n');
    commit('feat: ' + n);
  }
}`;

/** An empty folder: no package.json and no verify steps. */
export const greenfield = () => {
  writeFileSync(join(scratch, 'agent.cjs'), GREENFIELD_AGENT);
  rmSync(join(repo, 'package.json'));
  setup({}, { verify: { steps: [], timeoutSec: 60 } });
};
