import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { statePath } from '../src/core/state.js';
import { setStatus } from '../src/features/autopilot/status.js';
import { readRuns } from '../src/features/autopilot/usage.js';
import { usage } from '../src/features/tui/screens/usage.js';
import { painter } from '../src/features/watch/widgets.js';
import { BIN, repo, scratch, setup } from './helpers/autopilot-fixture.js';

test('a failed status write never stops the run', () => {
  const root = mkdtempSync(join(tmpdir(), 'wololo-status-'));
  mkdirSync(statePath(root, 'autopilot.json'), { recursive: true }); // a directory where the file goes: every write fails
  assert.doesNotThrow(() => setStatus(root, { phase: 'x' }));
});

test('usage is on disk from the first turn, and a run killed mid-way still counts', async () => {
  // an omp-style agent: one turn of usage, then it hangs until killed
  writeFileSync(join(scratch, 'agent.cjs'), `
console.log(JSON.stringify({ type: 'message_start', message: { role: 'assistant', model: 'claude-sonnet', content: [] } }));
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'planning' }], usage: { input: 5000, output: 120, cacheRead: 20000, cacheWrite: 0 } } }));
setInterval(() => {}, 1000);
`);
  setup();
  const run = spawn(process.execPath, [BIN, 'autopilot', '--goal', 'anything', '--plan'], { cwd: repo, env: { ...process.env, WOLOLO_DETACHED: '1' } });
  const deadline = Date.now() + 20000;
  let live;
  while (Date.now() < deadline && !(live = readRuns(repo).find((r) => r.turns === 1))) await new Promise((r) => setTimeout(r, 100));
  assert.ok(live, 'the planner\'s usage is saved while it runs');
  assert.equal(live.role, 'planner');
  assert.equal(live.cacheRead, 20000);
  assert.equal(live.model, 'claude-sonnet');
  assert.equal(live.live, true);

  run.kill('SIGKILL'); // the whole autopilot dies, as in a crash
  await new Promise((r) => run.on('close', r));
  const [after] = readRuns(repo);
  assert.equal(after.input, 5000, 'still counted after the crash');
  const d = usage.load(/** @type {any} */ ({ root: repo }), {});
  const out = usage.render(d, { at: 0 }, 140, 40, painter(false)).join('\n');
  assert.match(out, /✗ planner/, 'marked as stopped in the list');
  assert.match(out, /· stopped without finishing/, 'and in the detail');
  assert.doesNotMatch(out, /running now/, 'a dead run is not running');
  assert.match(out, /80% of prompt tokens/);
});
