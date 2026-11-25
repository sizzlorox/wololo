import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readEvents } from '../src/core/state.js';
import { git, prompts, repo, scratch, setup, wololo } from './helpers/autopilot-fixture.js';

// The judge scores intent/craft 0.5 until quality.txt says "polished". The improver's behaviour
// comes from the goal: GOOD polishes, NOGAIN changes something irrelevant, BREAK breaks a rule.
const AGENT = String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
const commit = (m) => execSync('git add -A && git commit -qm "' + m + '"');
if (prompt.includes('You are the judge')) {
  const path = /Write (\S+) as JSON/.exec(prompt)[1];
  const s = fs.existsSync('quality.txt') && fs.readFileSync('quality.txt', 'utf8').includes('polished') ? 1 : 0.5;
  fs.writeFileSync(path, JSON.stringify({ scores: { intent: s, craft: s }, notes: { intent: 'needs a usage example', craft: 'name the helper better' } }));
} else if (prompt.includes('You are the improver')) {
  if (prompt.includes('GOOD')) { fs.writeFileSync('quality.txt', 'polished\n'); commit('polish'); }
  else if (prompt.includes('NOGAIN')) { fs.writeFileSync('junk.txt', 'x\n'); commit('junk'); }
  else if (prompt.includes('BREAK')) { fs.writeFileSync('bad.js', 'function f() {\n  debugger;\n}\n'); commit('bad'); }
} else if (prompt.includes('You are the builder')) {
  fs.writeFileSync('feature.js', 'export const greet = (n) => n;\n');
  commit('feat: greet');
}
`;
const count = (/** @type {string} */ role) => prompts().filter((p) => p.includes(`You are the ${role}`)).length;

test('hill-climb keeps an improvement that raises the score and stops at the target', () => {
  writeFileSync(join(scratch, 'agent.cjs'), AGENT);
  setup({ verifiers: 0, gapRounds: 0, hillClimb: 3 });
  const r = wololo(['autopilot', '--goal', 'Add a greet helper GOOD']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /hill-climb round 1: score 0\.833, weakest (intent|craft) \(0\.5\) → improver/);
  assert.match(r.err, /hill-climb round 1: kept \(0\.833 → 1\)/);
  assert.equal(count('improver'), 1, 'stopped at the target, not after 3 rounds');
  assert.ok(prompts().some((p) => p.includes('You are the improver') && /needs a usage example|name the helper better/.test(p)), 'the improver got the judge\'s note');
  assert.ok(existsSync(join(repo, 'quality.txt')));
  const climb = readEvents(repo, 'climb').at(-1);
  assert.deepEqual([climb.from, climb.to, climb.kept], [0.833, 1, 1]);
});

test('hill-climb undoes a change with no gain and stops', () => {
  writeFileSync(join(scratch, 'agent.cjs'), AGENT);
  setup({ verifiers: 0, gapRounds: 0, hillClimb: 3 });
  assert.equal(wololo(['autopilot', '--goal', 'Add a greet helper NOGAIN']).code, 0);
  assert.equal(count('improver'), 1, 'stops at the first round without a gain');
  assert.ok(!existsSync(join(repo, 'junk.txt')), 'the no-gain change was undone');
});

test('hill-climb undoes a change that breaks the gate', () => {
  writeFileSync(join(scratch, 'agent.cjs'), AGENT);
  setup({ verifiers: 0, gapRounds: 0, hillClimb: 3 });
  const r = wololo(['autopilot', '--goal', 'Add a greet helper BREAK']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /broke the gate; undone/);
  assert.ok(!existsSync(join(repo, 'bad.js')), 'the gate-breaking change was undone');
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']).stdout.trim(), '', 'clean afterwards');
});

test('hillClimb 0 (the default) runs no judge or improver', () => {
  writeFileSync(join(scratch, 'agent.cjs'), AGENT);
  setup({ verifiers: 0, gapRounds: 0 });
  assert.equal(wololo(['autopilot', '--goal', 'Add a greet helper GOOD']).code, 0);
  assert.equal(count('judge') + count('improver'), 0);
});
