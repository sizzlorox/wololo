// wololo-ignore-file no-secrets: fake tokens on purpose, to test the secret detector
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { loadConfig } from '../src/core/config.js';
import { recordEvent } from '../src/core/state.js';
import { readTasks, writeTask } from '../src/features/board/store.js';
import { enqueue, readQueue } from '../src/features/queue/store.js';
import { openTui } from '../src/features/tui/command.js';
import { flatten } from '../src/features/tui/screens/config.js';
import { BIN, repo, setup, wololo } from './helpers/autopilot-fixture.js';

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** A fake terminal: stdin we type into, stdout that keeps the last frame. */
function term(columns = 150, rows = 50) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let frame = '';
  const stdout = {
    columns,
    rows,
    /** @param {string} s */
    write(s) {
      const start = '\x1b[?2026h\x1b[H'; // every frame overwrites the screen from home
      const i = s.lastIndexOf(start);
      if (i >= 0) frame = s.slice(i + start.length);
    },
  };
  return {
    stdin,
    stdout,
    screen: () => frame.replace(ANSI, ''),
    /** @param {string} k */
    type: (k) => stdin.write(k),
    /** @param {RegExp} re @param {number} [ms] */
    async until(re, ms = 20000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (re.test(frame.replace(ANSI, ''))) return;
        await sleep(25);
      }
      assert.fail(`timed out waiting for ${re}; screen:\n${frame.replace(ANSI, '')}`);
    },
  };
}

test('the TUI manages wololo end to end: board, queue, usage, config, health, commands, autopilot', async () => {
  setup();
  const now = new Date().toISOString();
  const task = (/** @type {string} */ id, /** @type {string} */ title, /** @type {any} */ status, /** @type {number} */ seq, more = {}) =>
    writeTask(repo, { id, title, group: 'plan-v', body: `${title} body`, status, queue: [], notes: [], seq, goal: 'a village', created: now, updated: now, ...more });
  task('p-1', 'Day night cycle', 'blocked', 1, { blockedOn: 'human', notes: [`${now} blocked: autopilot: did not converge in 5 iterations`] });
  task('p-2', 'Weather', 'todo', 2);
  enqueue(repo, [{ title: 'flaky pathfinding test', kind: 'mistake', body: 'test_start_equals_goal fails in the full run', source: 'review' }]);
  recordEvent(repo, { type: 'agent', role: 'builder', promptChars: 4000, turns: 3, input: 2000, output: 300, cacheRead: 18000, cacheWrite: 0, cost: 0.12, saved: 0.05, contexts: [6000, 7000, 7000] });

  const t = term();
  const ctx = /** @type {any} */ ({ root: repo, cwd: repo, config: loadConfig(repo), hasConfig: true, env: process.env, readStdin: async () => '' });
  const done = openTui(ctx, { tab: 'board', io: /** @type {any} */ (t), interval: 0.2, entry: BIN });

  // Board: list + details, every tab in the bar
  await t.until(/Day night cycle body/);
  for (const tab of ['Autopilot', 'Transcript', 'Board', 'Queue', 'Review', 'Learned', 'Health', 'Usage', 'Config', 'Commands']) assert.match(t.screen(), new RegExp(tab));
  assert.match(t.screen(), /blocked on human/);
  assert.match(t.screen(), /did not converge/, 'the details pane shows the notes');

  // add a task after the selected one
  t.type('a');
  await t.until(/New task in plan-v/);
  t.type('Add a mill\rgrind grain\r\r');
  await t.until(/created/);
  assert.deepEqual(readTasks(repo).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map((x) => x.title), ['Day night cycle', 'Add a mill', 'Weather'], 'slotted after the selection');

  // retry (release) the blocked one, move it down, delete it
  t.type('r');
  await t.until(/p-1 \[plan-v\] todo/);
  t.type('J');
  await t.until(/moved "Day night cycle" down/);
  assert.deepEqual(readTasks(repo).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map((x) => x.title), ['Add a mill', 'Day night cycle', 'Weather']);
  t.type('d');
  await t.until(/Delete "Day night cycle"/);
  t.type('y');
  await t.until(/removed p-1/);
  assert.equal(readTasks(repo).some((x) => x.id === 'p-1'), false);

  // Queue: read and resolve
  t.type('4');
  await t.until(/test_start_equals_goal fails/);
  t.type('x');
  await t.until(/resolved 1\/1/);
  assert.equal(readQueue(repo)[0].status, 'done');

  // Usage: totals, cache, saved, roles
  t.type('8');
  await t.until(/cache hits/);
  assert.match(t.screen(), /90% of prompt tokens/);
  assert.match(t.screen(), /median turn\s+7\.0k/);
  assert.match(t.screen(), /\$0\.0500/, 'what the cache saved');
  assert.match(t.screen(), /builder\s+1 runs/);

  // Config: edit a setting (validated), then try an invalid value
  t.type('9');
  await t.until(/Settings/);
  const rows = flatten(loadConfig(repo)).filter(([k]) => k !== 'root').map(([k]) => k);
  t.type('\x1b[B'.repeat(rows.indexOf('autopilot.maxIterations')));
  await t.until(/Setting.*\n(.|\n)*autopilot\.maxIterations/);
  t.type('e');
  await t.until(/Edit autopilot\.maxIterations/);
  t.type('\x7f\x7f\x7f9\r');
  await t.until(/autopilot\.maxIterations = 9/);
  assert.equal(JSON.parse(readFileSync(join(repo, 'wololo.config.json'), 'utf8')).autopilot.maxIterations, 9);
  t.type('e');
  await t.until(/Edit autopilot\.maxIterations/);
  t.type('\x7f\x7fabc\r');
  await t.until(/not saved: .*maxIterations: expected number/);
  assert.equal(JSON.parse(readFileSync(join(repo, 'wololo.config.json'), 'utf8')).autopilot.maxIterations, 9, 'an invalid value never reaches the file');

  // Health: run check in a child, read its parts
  t.type('7');
  await t.until(/no check run yet/);
  t.type('c');
  await t.until(/wololo check: check (passed|failed)/);

  // Commands: filter, fill the form, read the result
  t.type('0');
  await t.until(/Usage/);
  t.type('/');
  await t.until(/Filter commands/);
  t.type('queue list\r');
  await t.until(/filter: queue list/);
  t.type('\r');
  await t.until(/wololo queue list/);
  t.type('\r\r');
  await t.until(/\d+ open item\(s\)/);

  // Autopilot: nothing ran here yet, so it offers a new goal
  t.type('1');
  await t.until(/no run yet/);
  assert.match(t.screen(), / n +new goal/);

  t.type('q');
  await done;
  assert.equal(wololo(['task', 'list', '--group', 'plan-v', '--json']).code, 0);
});

test('the Transcript tab shows a run live: the prompt, thinking as it streams, tool calls and the results sent back, and flags secrets', async (tc) => {
  setup();
  const { writeFileSync } = await import('node:fs');
  const { scratch } = await import('./helpers/autopilot-fixture.js');
  // An omp-style agent: thinks slowly (so the test can watch it stream), calls a tool, gets a result holding a token, replies.
  writeFileSync(join(scratch, 'agent.cjs'), `
const out = (e) => console.log(JSON.stringify(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: process.argv[2] }] } });
  out({ type: 'message_start', message: { role: 'assistant', provider: 'dads-gpu', api: 'openai-completions', model: 'big-model', content: [] } });
  for (const w of ['Let ', 'me ', 'read ', 'the ', 'config']) { out({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: w } }); await sleep(250); }
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me read the config' }, { type: 'toolCall', name: 'read', arguments: { path: '.env' } }] } });
  out({ type: 'message_end', message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'API=1 Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' }] } });
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'All done here.' }] } });
})();
`);
  const t = term(160, 60);
  const ctx = /** @type {any} */ ({ root: repo, cwd: repo, config: loadConfig(repo), hasConfig: true, env: process.env, readStdin: async () => '' });
  const done = openTui(ctx, { tab: 'transcript', io: /** @type {any} */ (t), interval: 0.1, entry: BIN });
  await t.until(/no agent runs yet/);

  const run = (await import('node:child_process')).spawn(process.execPath, [BIN, 'autopilot', '--goal', 'Read the config', '--max', '1'], { cwd: repo, env: { ...process.env, WOLOLO_DETACHED: '1' } });
  tc.after(() => {
    run.kill(); // a failed assertion must not leave the run or the TUI holding the test open
    t.type('q');
  });
  await t.until(/THINKING streaming…[\s\S]*Let me read/, 20000);
  assert.match(t.screen(), /● live/);
  assert.match(t.screen(), /→ PROMPT[\s\S]*You are the builder/);
  assert.match(t.screen(), /sent to +dads-gpu · openai-completions · big-model/);

  await t.until(/← REPLY[\s\S]*All done here\./, 20000);
  assert.match(t.screen(), /← read .*\.env/, 'arguments beside the tool, not raw JSON');
  assert.match(t.screen(), /→ RESULT read .*chars/);
  assert.match(t.screen(), /⚠ 1 possible secret\(s\) sent: bearer token abcdefg…/);
  await new Promise((r) => run.on('close', r));

  t.type('t');
  await t.until(/show thinking/);
  assert.doesNotMatch(t.screen(), /← THINKING/, 't hides thinking');
  t.type('q');
  await done;
});

test('the TUI never clears the screen between frames and skips frames that did not change (no flicker)', async () => {
  setup();
  /** @type {string[]} */
  const writes = [];
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const stdout = { columns: 120, rows: 40, write: (/** @type {string} */ s) => writes.push(s) };
  const ctx = /** @type {any} */ ({ root: repo, cwd: repo, config: loadConfig(repo), hasConfig: true, env: process.env, readStdin: async () => '' });
  const done = openTui(ctx, { tab: 'config', io: /** @type {any} */ ({ stdin, stdout }), interval: 0.05, entry: BIN });
  await sleep(600); // ~12 ticks of an idle screen
  stdin.write('q');
  await done;
  const frames = writes.filter((w) => w.includes('\x1b[?2026h'));
  assert.ok(frames.length >= 1 && frames.length <= 2, `${frames.length} frame(s) written for an unchanged screen`);
  assert.ok(!frames.some((f) => f.includes('\x1b[2J')), 'frames overwrite in place, never clear first');
});

test('m on the Autopilot tab picks the agent and its model; saved per harness in the config', async () => {
  setup({ command: undefined, agent: 'claude' });
  const t = term();
  const ctx = /** @type {any} */ ({ root: repo, cwd: repo, config: loadConfig(repo), hasConfig: true, env: process.env, readStdin: async () => '' });
  const done = openTui(ctx, { tab: 'autopilot', io: /** @type {any} */ (t), interval: 0.1, entry: BIN });
  await t.until(/ m +claude: default model/);
  t.type('m');
  await t.until(/Model for autopilot runs \(claude\)/);
  assert.match(t.screen(), /opus \| sonnet \| haiku/, 'Claude\'s aliases are suggested');
  t.type('\t');
  t.type('sonnet\r');
  await t.until(/autopilot\.models\.claude = "sonnet"/);
  await t.until(/ m +claude: sonnet/);
  const cfg = JSON.parse(readFileSync(join(repo, 'wololo.config.json'), 'utf8'));
  assert.equal(cfg.autopilot.models.claude, 'sonnet');
  t.type('m');
  await t.until(/Model for autopilot runs/);
  t.type('\t\x7f\x7f\x7f\x7f\x7f\x7f\r');
  await t.until(/autopilot\.models\.claude reset to default/);
  assert.equal(JSON.parse(readFileSync(join(repo, 'wololo.config.json'), 'utf8')).autopilot.models, undefined, 'clearing it removes the key');
  t.type('q');
  await done;
});

test('review: autopilot samples landed commits; the Review tab shows the diff and records verdicts that feed the queue and trust', async () => {
  const { readReviews } = await import('../src/features/review/store.js');
  setup({ verifiers: 0, gapRounds: 0 });
  const r = wololo(['autopilot', '--goal', 'Add a greet helper']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /sampled \d+ commit\(s\) to review/);
  const pending = readReviews(repo).items.filter((i) => i.status === 'pending');
  assert.ok(pending.length >= 1, 'trust L0 samples every commit');

  const t = term(150, 50);
  const ctx = /** @type {any} */ ({ root: repo, cwd: repo, config: loadConfig(repo), hasConfig: true, env: process.env, readStdin: async () => '' });
  const done = openTui(ctx, { tab: 'review', io: /** @type {any} */ (t), interval: 0.1, entry: BIN });
  await t.until(/trust L0 · sampling 100% of commits · \d+ waiting/);
  assert.match(t.screen(), /diff --git|\+\+\+ b\//, 'the selected commit\'s diff is shown');
  t.type('o');
  await t.until(/→ ok/);
  if (readReviews(repo).items.some((i) => i.status === 'pending')) {
    t.type('e');
    await t.until(/What was wrong in/);
    t.type('helper has no test for empty names\r');
    await t.until(/→ fix-env/);
    assert.match(wololo(['queue', 'list', '--kind', 'mistake']).out, /helper has no test for empty names/, 'a fix-env verdict becomes a mistake to fix in the environment');
  }
  assert.ok(readReviews(repo).items.some((i) => i.status === 'ok'));
  assert.match(wololo(['trust']).out, /\d+ reviews/);
  t.type('q');
  await done;
});
