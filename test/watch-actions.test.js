import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, keys, selectedTask } from '../src/features/watch/actions.js';
import { readTasks, writeTask } from '../src/features/board/store.js';
import { details } from '../src/features/watch/render.js';
import { repo, setup, wololo } from './helpers/autopilot-fixture.js';

const tasks = () => readTasks(repo).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

/** @param {any} status @param {any[]} t @param {Record<string, any>} [more] */
const v = (status, t = [], more = {}) => /** @type {any} */ ({ status, tasks: t, alive: false, ...more });
const task = (/** @type {string} */ id, /** @type {string} */ status, extra = {}) => ({ id, title: id, status, ...extra });
const names = (/** @type {any} */ view) => keys(view).map((k) => k.key).join(' ');

test('watch offers only the keys that make sense for the selected task and the run', () => {
  assert.equal(names(v(null)), 'n q', 'no run yet: start one');
  const plan = [task('a', 'done'), task('b', 'blocked'), task('c', 'todo')];
  assert.equal(selectedTask(v({ group: 'g' }, plan))?.id, 'b', 'the cursor starts on the blocked step');
  assert.equal(names(v({ group: 'g' }, plan)), '↑↓ enter r s a n q', 'blocked: retry or skip it');
  assert.equal(keys(v({ group: 'g' }, plan, { selected: 'a' })).find((k) => k.key === 'r')?.label, 'redo', 'a landed step can be redone');
  assert.equal(names(v({ group: 'g' }, plan, { selected: 'a' })), '↑↓ enter r a n q', 'a landed step cannot be skipped');
  assert.equal(keys(v({ group: 'g' }, plan, { selected: 'c' })).find((k) => k.key === 'r')?.label, 'resume');
  assert.equal(names(v({ group: 'g' }, plan, { selected: 'c', alive: true })), '↑↓ enter s a x q', 'running: no resume, no new goal, but stop');
  assert.equal(names(v({ group: 'g' }, [task('a', 'done', { splitInto: ['a1'] })])), '↑↓ enter a n q', 'a split parent is not redone');
  assert.match(names(v({ group: 'g' }, plan, { groups: ['g', 'h'] })), / g /, 'several plans: switch between them');
  const crashed = [task('a', 'claimed')];
  assert.match(names(v({ group: 'g' }, crashed)), / s /, 'a step a dead run left claimed can be skipped');
  assert.doesNotMatch(names(v({ group: 'g' }, crashed, { alive: true })), / s /, 'but not the one being built');
});

test('retry, redo and skip act on the selected step only; add slots a step after it; new starts a planned goal', async () => {
  setup();
  ['First step', 'Second step', 'Third step'].forEach((title, i) => {
    wololo(['task', 'add', title, '--group', 'g', '--force']);
    const t = /** @type {any} */ (readTasks(repo).find((x) => x.title === title));
    writeTask(repo, { ...t, seq: i + 1, goal: 'a village' });
  });
  const [first, second, third] = tasks();
  wololo(['task', 'done', first.id]);
  wololo(['task', 'block', second.id, '--on', 'human', '--reason', 'did not converge']);
  wololo(['task', 'block', third.id, '--on', 'human']);
  /** @type {string[][]} */
  const launched = [];
  const ctx = /** @type {any} */ ({ root: repo, launch: (/** @type {string[]} */ args) => launched.push(args) });
  const view = (/** @type {any} */ more = {}) => v({ state: 'stopped', group: 'g' }, tasks(), more);

  assert.match(await act('r', view({ selected: second.id }), ctx), /retrying "Second step"; resuming g/);
  assert.deepEqual(tasks().map((t) => t.status), ['done', 'todo', 'blocked'], 'only the selected step is released');
  assert.deepEqual(launched.at(-1), ['autopilot', '--group', 'g']);

  assert.equal(await act('r', view({ selected: second.id, alive: true }), ctx), '', 'a todo step has nothing to retry while running');
  const before = launched.length;
  assert.equal(await act('s', view({ selected: third.id, alive: true }), ctx), 'skipped "Third step"', 'board edits while running start nothing');
  assert.equal(launched.length, before);
  assert.match(tasks()[2].notes.at(-1) ?? '', /skipped from watch/);

  assert.match(await act('r', view({ selected: first.id }), ctx), /redoing "First step"/);
  assert.equal(tasks()[0].status, 'todo');

  assert.match(await act('a', view({ selected: first.id }), ctx, 'Add a mill'), /added "Add a mill" after "First step"/);
  assert.deepEqual(tasks().map((t) => t.title), ['First step', 'Add a mill', 'Second step', 'Third step'], 'slotted in after the selection');
  assert.equal(tasks()[1].goal, 'a village', 'the new step carries the plan goal to its builder');

  await act('n', v(null), ctx, 'Add a church');
  assert.deepEqual(launched.at(-1), ['autopilot', '--goal', 'Add a church', '--plan']);
});

test('details shows why a step is blocked and its notes, newest last, within the screen', () => {
  const t = /** @type {any} */ ({ id: 'x', title: 'Day/night', status: 'blocked', blockedOn: 'human', body: 'Create src/time/mod.rs', notes: Array.from({ length: 50 }, (_, i) => `note ${i}`), group: 'g' });
  const out = details(t, 80, 20);
  assert.match(out, /Day\/night/);
  assert.match(out, /blocked on human/);
  assert.match(out, /Create src\/time\/mod\.rs/);
  assert.match(out, /note 49/, 'latest note shown');
  assert.doesNotMatch(out, /note 0\b/, 'old notes trimmed to fit');
  assert.ok(out.split('\n').length <= 20);
});

test('a status that lost its plan name still resumes the newest plan', async () => {
  const { view } = await import('../src/features/watch/view.js');
  const { setStatus } = await import('../src/features/autopilot/status.js');
  setup();
  const now = new Date().toISOString();
  writeTask(repo, { id: 'p-01', title: 'Step', group: 'plan-z', body: '', status: 'todo', queue: [], notes: [], seq: 1, created: now, updated: now });
  setStatus(repo, { pid: 999999, state: 'running' }); // a dead run whose status has no group, as an older merger left it
  const v = view(repo, { width: 0, height: 0, color: false });
  assert.equal(v.group, 'plan-z');
  assert.match(keys(v).map((k) => `${k.key} ${k.label}`).join(' | '), /r resume/);
});
