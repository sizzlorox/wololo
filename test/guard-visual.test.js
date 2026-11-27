import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/core/config.js';
import { seenByPeople } from '../src/features/guard/coverage.js';
import { judgePrompt } from '../src/features/autopilot/climb.js';
import { runGate } from '../src/features/gate/command.js';
import { git, prompts, repo, wololo } from './helpers/autopilot-fixture.js';

test('steps about what people see are told apart from the rest', () => {
  for (const t of ['Art pass: replace placeholders with PixelLab art', 'Wire renderer to real SimBindings', 'Add an inspector panel to the UI', 'Draw the minimap']) assert.equal(seenByPeople(t), true, t);
  for (const t of ['Add pathfinding with A*', 'Tune food decay per season', 'Save and load the world to JSON']) assert.equal(seenByPeople(t), false, t);
});

test('a visual step fails the gate until a verify step opens the app; then it passes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wololo-visual-'));
  const g = (/** @type {string[]} */ a) => spawnSync('git', a, { cwd: root });
  g(['init', '-q']);
  writeFileSync(join(root, 'wololo.config.json'), JSON.stringify({ project: 'v', harnesses: [], ci: { provider: 'none', setup: [] }, verify: { steps: [{ name: 'ok', run: 'node -e "0"' }] } }));
  const ctx = () => /** @type {any} */ ({ root, config: loadConfig(root) });
  const looked = async (/** @type {boolean} */ visual) => (await runGate(ctx(), { visual })).parts.find((p) => p.name === 'looked');
  assert.equal(await looked(false), undefined, 'not visual: nothing to look at');
  const red = await looked(true);
  assert.equal(red?.ok, false);
  assert.match(red?.detail.join('\n') ?? '', /no verify step opens the app/);
  mkdirSync(join(root, 'site'));
  writeFileSync(join(root, 'wololo.config.json'), JSON.stringify({ project: 'v', harnesses: [], ci: { provider: 'none', setup: [] }, verify: { steps: [{ name: 'ok', run: 'node -e "0"' }, { name: 'app', app: { start: 'node -e "console.log(1)"' } }] } }));
  assert.equal(await looked(true), undefined, 'an app step exists: the gate looks');
});

test('the judge is handed the screenshots and told to look at them as a person would', () => {
  const p = judgePrompt('wololo', 'Art pass', 'abc', [{ id: 'looks', question: 'Does it look right?' }], 'j.json', ['/s/app.png', '/s/cli.txt']);
  assert.match(p, /Open each file and look at it as the person using the app would/);
  assert.match(p, /- \/s\/app\.png\n- \/s\/cli\.txt/);
  assert.doesNotMatch(judgePrompt('wololo', 'x', 'abc', [{ id: 'a' }], 'j.json'), /screenshots/, 'no app check, no screenshots line');
});

test('autopilot adds the default rubric when there is none: without it no judge ever looks', () => {
  const rubric = join(repo, '.wololo', 'rubric.json');
  spawnSync('git', ['rm', '-q', rubric], { cwd: repo });
  git(['commit', '-qm', 'no rubric']);
  assert.ok(!existsSync(rubric));
  const r = wololo(['autopilot', '--goal', 'Add alpha', '--json']);
  assert.match(r.out + r.err, /added the default one/);
  assert.match(readFileSync(rubric, 'utf8'), /"looks"/);
  assert.ok(prompts().some((x) => x.includes('You are the builder')));
});
