import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, editForm, form } from '../src/features/tui/input.js';
import { listDetail, windowOf, wrap } from '../src/features/tui/layout.js';
import { items } from '../src/features/tui/screens/health.js';
import { argvFor } from '../src/features/tui/screens/commands.js';
import { flatten, parseValue } from '../src/features/tui/screens/config.js';
import { setAt } from '../src/features/tui/settings.js';
import { spark } from '../src/features/tui/screens/usage.js';
import { painter, width } from '../src/features/watch/widgets.js';

test('decode splits a chunk into keys: arrows, enter, esc, typed text; unknown escapes are dropped', () => {
  assert.deepEqual(decode('\x1b[A\x1b[Bab\r'), ['up', 'down', 'a', 'b', 'enter']);
  assert.deepEqual(decode('\x1b'), ['esc']);
  assert.deepEqual(decode('\x1b[Z\t\x7f\x03'), ['backtab', 'tab', 'backspace', 'ctrl-c']);
  assert.deepEqual(decode('\x1b[99;5uX'), ['X'], 'unknown CSI sequences vanish instead of typing garbage');
  assert.deepEqual(decode('\x1b[5~\x1b[6~'), ['pgup', 'pgdn']);
});

test('forms: type, move between fields, required fields block submit, esc cancels', () => {
  let f = form('t', [{ name: 'a', label: 'A', required: true }, { name: 'b', label: 'B', value: 'x' }]);
  let r = editForm(f, 'enter');
  r = editForm(r.form, 'enter');
  assert.equal(r.submit, undefined);
  assert.equal(r.form.error, 'A is required');
  assert.equal(r.form.at, 0, 'jumps back to the missing field');
  for (const k of ['h', 'i', 'x', 'backspace']) r = editForm(r.form, k);
  r = editForm(r.form, 'tab');
  r = editForm(r.form, 'y');
  r = editForm(r.form, 'enter');
  assert.deepEqual(r.submit, { a: 'hi', b: 'xy' });
  assert.equal(editForm(f, 'esc').cancel, true);
});

test('layout: wrap keeps words and indentation, the list window follows the cursor, panes fit the width', () => {
  assert.deepEqual(wrap('  one two three four', 12), ['  one two', '  three four']);
  assert.deepEqual(windowOf(100, 50, 10), { from: 45, to: 55 });
  assert.deepEqual(windowOf(5, 4, 10), { from: 0, to: 5 });
  const c = painter(true);
  for (const w of [60, 100, 160]) {
    const lines = listDetail({ title: 'T', rows: Array.from({ length: 50 }, (_, i) => `row ${i} ${'x'.repeat(200)}`), at: 30, detailTitle: 'D', detail: ['y'.repeat(500)] }, w, 20, c);
    assert.ok(lines.length <= 20, `${lines.length} ≤ 20 at ${w}`);
    for (const l of lines) assert.ok(width(l) <= w, `fits ${w}`);
    assert.ok(lines.some((l) => l.includes('row 30')), 'the selected row is visible');
  }
});

test('health: a result splits into selectable parts with their indented output', () => {
  const parts = items(['PASS adapters', 'FAIL verify', '    FAIL test\n    expected 1 got 2', '✗ not a git repo']);
  assert.deepEqual(parts.map((p) => p.head), ['PASS adapters', 'FAIL verify', '✗ not a git repo']);
  assert.deepEqual(parts[1].lines, ['FAIL test', 'expected 1 got 2']);
});

test('commands: form values become argv', () => {
  const cmd = /** @type {any} */ ({ name: 'queue resolve', args: [{ name: 'ids', variadic: true }], options: { drop: { type: 'boolean' }, kind: { type: 'string' }, tagList: { type: 'string[]' } } });
  assert.deepEqual(argvFor(cmd, { 'arg:ids': 'a b', drop: 'y', kind: '', tagList: 'x,y' }), ['queue', 'resolve', 'a', 'b', '--drop', '--tag-list', 'x,y']);
  assert.deepEqual(argvFor(cmd, { drop: 'n' }), ['queue', 'resolve'], 'no is no flag; blanks are left out');
});

test('config: flatten to dotted leaves, set and unset paths, typed values', () => {
  assert.deepEqual(flatten({ a: { b: 1, c: [1] }, d: 'x', e: {} }), [['a.b', 1], ['a.c', [1]], ['d', 'x'], ['e', {}]]);
  assert.deepEqual(setAt({}, 'autopilot.maxIterations', 8), { autopilot: { maxIterations: 8 } });
  assert.deepEqual(setAt({ autopilot: { maxIterations: 8 }, x: 1 }, 'autopilot.maxIterations', undefined), { x: 1 }, 'emptied parents are pruned');
  assert.equal(parseValue('8'), 8);
  assert.equal(parseValue('true'), true);
  assert.deepEqual(parseValue('["a"]'), ['a']);
  assert.equal(parseValue('claude'), 'claude');
});

test('spark shows how prompt size grew over a run, squeezed to a width', () => {
  assert.equal(spark([1, 2, 4, 8], 10), '▁▂▄█');
  assert.equal(spark(Array.from({ length: 100 }, (_, i) => i), 10).length, 10);
  assert.equal(spark([], 10), '');
});

test('the dashboard shows parallel workers (thinking, tokens), the merge queue and what the agents told each other', async () => {
  const { render } = await import('../src/features/watch/render.js');
  const now = Date.parse('2026-11-25T10:00:00Z');
  const ago = (/** @type {number} */ m) => new Date(now - m * 60_000).toISOString();
  const worker = (/** @type {string} */ role, /** @type {string} */ live) => /** @type {any} */ ({ agent: { role, started: ago(3), timeoutMinutes: 45, base: 'x', calls: 7, usage: { input: 9000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 3 }, live, liveOf: 'thinking' } });
  const status = /** @type {any} */ ({ pid: 1, started: ago(30), state: 'running', group: 'g', activity: [], parallel: { workers: 3, main: 'main', running: [{ id: 'g-02', title: 'Weather', started: ago(3), dir: 'x' }, { id: 'g-03', title: 'Seasons', started: ago(2), dir: 'y' }], queue: [{ id: 'g-01', title: 'Day night', state: 'conflict in 1 file(s): merger agent' }] } });
  const tasks = /** @type {any[]} */ ([{ id: 'g-01', title: 'Day night', status: 'done', group: 'g', notes: [] }, { id: 'g-02', title: 'Weather', status: 'claimed', group: 'g', notes: [] }, { id: 'g-03', title: 'Seasons', status: 'claimed', group: 'g', notes: [] }]);
  const out = render({ status, tasks, alive: true, now, width: 150, height: 50, color: false, workers: [{ id: 'g-02', title: 'Weather', started: ago(3), dir: 'x', status: worker('builder', 'rain should slow walking') }, { id: 'g-03', title: 'Seasons', started: ago(2), dir: 'y', status: worker('verifier (edge cases)', 'what if winter') }], inbox: [{ at: ago(1), from: 'g-02', title: 'Weather', text: 'added Weather::Rain to src/weather/mod.rs' }] });
  assert.match(out, /Workers · 2\/3 → main/);
  assert.match(out, /▶ Weather[\s\S]*builder · 3m · 7 calls · in 9\.0k out 400/);
  assert.match(out, /thinks: rain should slow walking/);
  assert.match(out, /Merge queue[\s\S]*Day night +conflict in 1 file\(s\): merger agent/);
  assert.match(out, /Messages between agents[\s\S]*Weather: added Weather::Rain/);
  assert.equal((out.match(/▶ (Weather|Seasons)/g) ?? []).length >= 4, true, 'both running steps are marked in the plan and the workers panel');
});

test('the header says whether a run builds one step at a time or in parallel', async () => {
  const { render } = await import('../src/features/watch/render.js');
  const head = (/** @type {number} */ workers) => render(/** @type {any} */ ({ status: { pid: 1, started: new Date().toISOString(), state: 'running', activity: [], agentCli: 'omp', workers }, tasks: [], alive: true, now: Date.now(), width: 160, height: 20, color: false })).split('\n')[0];
  assert.match(head(1), /serial \(autopilot\.workers = 1\)/);
  assert.match(head(3), /parallel ×3/);
});

test('usage: a model server that never reports cached tokens shows "not reported", not 0%', async () => {
  const { usage } = await import('../src/features/tui/screens/usage.js');
  const { summarize } = await import('../src/features/autopilot/usage.js');
  const runs = [{ type: 'agent', role: 'builder', ts: new Date().toISOString(), promptChars: 900, turns: 2, input: 139203, output: 731, cacheRead: 0, cacheWrite: 0, cost: 0, contexts: [60000, 79203] }];
  const out = usage.render({ s: summarize(runs), runs, live: null }, { at: 0 }, 140, 40, painter(false)).join('\n');
  assert.match(out, /cache hits +not reported by the model server/);
  assert.doesNotMatch(out, /0% of prompt tokens/);
  assert.match(out, /cache hits +not reported\b/, 'the run detail too');
});
