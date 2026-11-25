import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, prompts, repo, scratch, setup, tasks, wololo } from './helpers/autopilot-fixture.js';

// A builder given a BIG step leaves half its work on disk and then loops compacting (its context no
// longer fits). The splitter answers from the SPLIT env file: "two" (two small steps) or "endless"
// (always another BIG step, so the depth cap has to stop it).
const SPLIT_AGENT = `
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\\n');
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
const commit = (m) => execSync('git add -A && (git diff --cached --quiet || git commit -qm "' + m + '")');
if (prompt.includes('You are the planner')) {
  fs.writeFileSync(/Write the plan to (\\S+)/.exec(prompt)[1], JSON.stringify({ tasks: [{ title: 'Add building', body: 'BIG: placement and construction' }] }));
} else if (prompt.includes('You are the splitter')) {
  const mode = fs.readFileSync('SPLIT', 'utf8').trim();
  if (mode === 'two') {
    // Tool-free: the answer is the reply, JSON in prose.
    console.log('Here is the split:\\n' + JSON.stringify({ tasks: [{ title: 'Add footprint', body: 'footprint.js' }, { title: 'Add construction', body: 'construction.js' }] }) + '\\nDone.');
  } else if (mode === 'endless') {
    console.log(JSON.stringify({ tasks: [{ title: 'Add part' + Date.now(), body: 'BIG again' }] }));
  }
} else if (prompt.includes('You are the builder')) {
  const step = prompt.split('Implement this feature:')[1];
  if (step.includes('Get the uncommitted work building')) {
    commit('wip builds');
  } else if (step.includes('BIG')) {
    fs.writeFileSync('wip.js', 'export const half = 1;\\n');
    setInterval(() => { emit({ type: 'auto_compaction_start', reason: 'overflow' }); emit({ type: 'auto_compaction_end' }); }, 50);
  } else {
    const m = /Add (\\w+)/.exec(step);
    fs.writeFileSync(m[1] + '.js', 'export const x = 1;\\n');
    commit('feat: ' + m[1]);
  }
}
`;

/** @param {string} mode */
function split(mode) {
  writeFileSync(join(scratch, 'agent.cjs'), SPLIT_AGENT);
  writeFileSync(join(repo, 'SPLIT'), mode);
  setup({ gapRounds: 0, verifiers: 0, contextWindow: 32000 });
}

test('a step too big for the context window is split into smaller steps instead of retried at the same size', () => {
  split('two');
  const r = wololo(['autopilot', '--goal', 'Villagers build houses', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /builder ran out of context \(stuck in a compaction loop\) on "Add building": splitting it into smaller steps/);
  assert.match(r.err, /split "Add building" into 2 step\(s\): Add footprint; Add construction/);
  assert.match(r.err, /its context no longer fits the window even after compacting/, 'overflow compactions are the window, not the output cap');
  const ps = prompts();
  assert.equal(ps.filter((p) => p.includes('You are the builder') && p.includes('BIG')).length, 1, 'no same-size retry once the context ran out');
  const splitter = ps.find((p) => p.includes('You are the splitter')) ?? '';
  assert.match(splitter, /Add building[\s\S]*BIG: placement and construction/, 'the splitter sees the step');
  assert.match(splitter, /Villagers build houses/, 'and the goal');
  assert.match(splitter, /wip\.js \(new, 1 line\)/, 'and the half-done work on disk with its size, found by git, not by the agent');
  assert.match(splitter, /Reply with only the JSON/, 'the splitter answers in its reply: it needs no tools');
  assert.match(splitter, /32k-token context window/);
  const footprint = ps.find((p) => p.includes('You are the builder') && p.includes('Add footprint')) ?? '';
  assert.match(footprint, /Later steps \(do NOT build them now\): Add construction/, 'sub-steps run in order, in place of the big one');
  assert.ok(existsSync(join(repo, 'footprint.js')) && existsSync(join(repo, 'construction.js')));
  const done = tasks('done').map((/** @type {{ title: string }} */ t) => t.title);
  assert.deepEqual(done.filter((/** @type {string} */ t) => t !== 'Add building').sort(), ['Add construction', 'Add footprint']);
});

test('splitting stops at a depth cap: a step that stays too big blocks for a human', () => {
  split('endless');
  const r = wololo(['autopilot', '--goal', 'Villagers build houses', '--plan']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /why: autopilot: still too big for the context window after 2 split\(s\)/);
  assert.equal(prompts().filter((p) => p.includes('You are the splitter')).length, 2);
});

test('a splitter that writes nothing does not block the run: wololo splits by the uncommitted work itself', () => {
  split('silent');
  const r = wololo(['autopilot', '--goal', 'Villagers build houses', '--plan']);
  assert.match(r.err, /the splitter wrote no steps; splitting "Add building" by its uncommitted work instead/);
  const first = prompts().find((p) => p.includes('You are the builder') && p.includes('Get the uncommitted work building')) ?? '';
  assert.match(first, /wip\.js/, 'the first step names the half-done files');
  assert.match(first, /revert/, 'and may revert what it cannot fix, so it can always finish');
  assert.ok(prompts().some((p) => p.includes('You are the builder') && p.includes('Finish: Add building')), 'then the rest of the step');
  assert.match(git(['log', '--format=%s']).stdout, /wip builds/);
  assert.equal(r.code, 1, 'the BIG rest still cannot fit and leaves nothing new to split by, so it stops for a human');
  assert.match(r.out, /the splitter wrote no smaller steps/);
});

// Replies cut off at the output cap (omp stopReason "length", then an "incomplete" compaction):
// splitting cannot help, thinking less can. CAPPED says which builder runs are cut off.
const CAP_AGENT = `
const fs = require('node:fs');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\\n');
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
if (prompt.includes('You are the planner')) {
  fs.writeFileSync(/Write the plan to (\\S+)/.exec(prompt)[1], JSON.stringify({ tasks: [{ title: 'Add gather', body: 'gather.js' }] }));
} else if (prompt.includes('You are the builder')) {
  const n = Number(fs.readFileSync('BUILDS', 'utf8')) + 1;
  fs.writeFileSync('BUILDS', String(n));
  if (n <= Number(fs.readFileSync('CAPPED', 'utf8'))) {
    setInterval(() => {
      emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 9000, output: 8192 }, stopReason: 'length' } });
      emit({ type: 'auto_compaction_start', reason: 'incomplete' });
      emit({ type: 'auto_compaction_end' });
    }, 50);
  } else {
    fs.writeFileSync('gather.js', 'export const g = 1;\\n');
    require('node:child_process').execSync('git add gather.js && git commit -qm "feat: gather"');
  }
}
`;

/** @param {number} capped how many builder runs hit the output cap */
function capped(capped) {
  writeFileSync(join(scratch, 'agent.cjs'), CAP_AGENT);
  writeFileSync(join(repo, 'BUILDS'), '0');
  writeFileSync(join(repo, 'CAPPED'), String(capped));
  git(['add', 'BUILDS', 'CAPPED']);
  git(['commit', '-qm', 'fixture']);
  setup({ gapRounds: 0, verifiers: 0, contextWindow: 32000 });
}

test('replies cut off at the output cap are retried with thinking off, not split', () => {
  capped(1);
  const r = wololo(['autopilot', '--goal', 'Villagers gather', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /replies keep hitting the model's output-token limit before it acts \(omp: "compacting context \(incomplete\)", cut off at 8192 output tokens\)[\s\S]*maxTokens/);
  assert.match(r.err, /replies were cut off at the output limit \(8192 output tokens\); retrying with thinking off for the rest of this run/);
  assert.equal(prompts().filter((p) => p.includes('You are the splitter')).length, 0, 'splitting cannot fix the output cap');
});

test('replies still cut off with thinking off stop for a human with the measured cap, without a splitter', () => {
  capped(9);
  const r = wololo(['autopilot', '--goal', 'Villagers gather', '--plan']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /why: autopilot: the builder's replies are cut off at 8192 output tokens even with thinking off/);
  assert.match(r.out, /maxTokens/, 'says where omp sets the output cap');
  assert.equal(prompts().filter((p) => p.includes('You are the splitter')).length, 0);
});
