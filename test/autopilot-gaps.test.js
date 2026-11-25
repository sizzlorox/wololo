import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, prompts, repo, scratch, setup, tasks, wololo } from './helpers/autopilot-fixture.js';

// The planner under-plans (only alpha). The gap reviewer reports what the goal still needs,
// as decided by the REVIEW env var: "gamma" (a real gap until gamma.js exists), "repeat" (only
// gaps already done) or "endless" (a new gap every round).
const GAP_AGENT = `
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\\n');
// A builder asked for work that already exists commits nothing; that is not a crash.
const commit = (m) => execSync('git add -A && (git diff --cached --quiet || git commit -qm "' + m + '")');
if (prompt.includes('You are the planner')) {
  fs.writeFileSync(/Write the plan to (\\S+)/.exec(prompt)[1], JSON.stringify({ tasks: [{ title: 'Add alpha', body: 'alpha.js' }] }));
} else if (prompt.includes('You are the builder')) {
  const m = /Add (\\w+)/.exec(prompt.split('Implement this feature:')[1]);
  if (m) { fs.writeFileSync(m[1] + '.js', 'export const ' + m[1] + ' = 1;\\n'); commit('feat: ' + m[1]); }
} else if (prompt.includes('You are the gap reviewer')) {
  const path = /Write your findings to (\\S+)/.exec(prompt)[1];
  const mode = fs.readFileSync('REVIEW', 'utf8').trim();
  const n = fs.readdirSync('.').filter((f) => f.endsWith('.js')).length;
  const gaps = mode === 'gamma' ? (fs.existsSync('gamma.js') ? [] : [{ title: 'Add gamma', body: 'gamma.js, the goal asks for it' }])
    : mode === 'repeat' ? [{ title: 'add alpha ', body: 'again' }]
    : [{ title: 'Add x' + n, body: 'more' }];
  fs.writeFileSync(path, JSON.stringify({ tasks: gaps }));
}
`;

/** @param {string} mode @param {Record<string, any>} [autopilot] */
function gaps(mode, autopilot = {}) {
  writeFileSync(join(scratch, 'agent.cjs'), GAP_AGENT);
  writeFileSync(join(repo, 'REVIEW'), mode);
  setup(autopilot);
}

const reviews = () => prompts().filter((p) => p.includes('You are the gap reviewer'));

test('after a plan lands, a gap reviewer checks the goal and the missing work is planned and built', () => {
  gaps('gamma');
  writeFileSync(join(repo, 'villagers.js'), '// TODO: villagers should eat\nexport const v = 1;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'stub']);
  const r = wololo(['autopilot', '--goal', 'Build alpha and gamma', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(existsSync(join(repo, 'gamma.js')), 'the gap was built');
  assert.match(r.out + r.err, /gap review 1: 1 gap\(s\): Add gamma/);
  assert.match(r.out + r.err, /gap review 2: the goal is met/);
  assert.deepEqual(tasks('done').map((/** @type {{title: string}} */ t) => t.title), ['Add alpha', 'Add gamma'], 'gaps join the same group, after the plan');

  const first = reviews()[0];
  assert.match(first, /Build alpha and gamma/, 'the reviewer sees the goal');
  assert.match(first, /Add alpha/, 'and what landed');
  assert.match(first, /villagers\.js:1:.*TODO: villagers should eat/, 'unfinished markers are found by a tool, not left to the agent');
});

test('the gap review cannot loop: repeats of landed work are ignored, and rounds are capped', () => {
  gaps('repeat');
  const repeat = wololo(['autopilot', '--goal', 'Build alpha', '--plan']);
  assert.equal(repeat.code, 0, repeat.out + repeat.err);
  assert.match(repeat.out + repeat.err, /gap review 1: nothing new \(1 repeat\(s\) of landed work ignored\); the goal is met/);
  assert.equal(tasks('done').length, 1);

  gaps('endless', { gapRounds: 2 });
  const endless = wololo(['autopilot', '--goal', 'Build alpha forever', '--plan']);
  assert.equal(endless.code, 0, endless.out + endless.err);
  assert.equal(reviews().length, 1 + 2, 'one review in the first run, two in the capped one');
  assert.match(endless.out + endless.err, /gap review stopped after 2 round\(s\) \(autopilot\.gapRounds\)/);
});

test('autopilot.gapRounds 0 turns the gap review off, and a reviewer that writes nothing does not fail the run', () => {
  gaps('gamma', { gapRounds: 0 });
  const off = wololo(['autopilot', '--goal', 'Build alpha', '--plan']);
  assert.equal(off.code, 0, off.out + off.err);
  assert.equal(reviews().length, 0);

  setup({ gapRounds: 1, command: [process.execPath, '-e', 'process.argv[1].includes("You are the planner") && require("fs").writeFileSync(/Write the plan to (\\S+)/.exec(process.argv[1])[1], JSON.stringify({tasks:[{title:"Noop"}]}))', '{prompt}'] });
  const silent = wololo(['autopilot', '--goal', 'Noop', '--plan']);
  assert.equal(silent.code, 0, silent.out + silent.err);
  assert.match(silent.out + silent.err, /gap reviewer wrote no findings; treating the plan as complete/);
});
