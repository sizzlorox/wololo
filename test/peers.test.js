import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const SCRIPT = resolve('src/features/autopilot/peers/peers.cjs');
const peers = require(SCRIPT);

/** A shared state dir and a worktree, with two running tasks: weather claims src/weather/, time claims src/time/ and Cargo.toml. */
function world() {
  const state = mkdtempSync(join(tmpdir(), 'wololo-peers-state-'));
  const tree = mkdtempSync(join(tmpdir(), 'wololo-peers-tree-'));
  mkdirSync(join(state, 'claims'), { recursive: true });
  writeFileSync(join(state, 'claims', 'g.json'), JSON.stringify({ weather: { title: 'Weather', touches: ['src/weather/'] }, time: { title: 'Day/night', touches: ['src/time/', 'Cargo.toml'] } }));
  const env = { WOLOLO_STATE: state, WOLOLO_GROUP: 'g', WOLOLO_WORKER: 'weather' };
  return { state, tree, env };
}

test('matches: dirs, files, simple globs; paths are taken relative to the worktree', () => {
  assert.equal(peers.matches('src/time/mod.rs', 'src/time/'), true);
  assert.equal(peers.matches('src/time/mod.rs', 'src/time'), true);
  assert.equal(peers.matches('src/timeline.rs', 'src/time'), false, 'a dir prefix is a whole segment');
  assert.equal(peers.matches('Cargo.toml', 'Cargo.toml'), true);
  assert.equal(peers.matches('src/a/b.rs', 'src/**/*.rs'), true);
  assert.equal(peers.matches('src/a/b.ts', 'src/**/*.rs'), false);
});

test('pre: an edit to a file another agent claimed is blocked once; doing it anyway is allowed and announced', () => {
  const { tree, env } = world();
  const target = join(tree, 'src', 'time', 'mod.rs');
  const first = peers.pre('edit', { path: target }, tree, env);
  assert.match(first ?? '', /src\/time\/mod\.rs is being changed by "Day\/night" \(time\)/);
  assert.match(first ?? '', /task note weather/, 'tells it how to coordinate');
  assert.equal(peers.pre('edit', { path: target }, tree, env), '', 'the second try goes through');
  assert.match(peers.post(env.WOLOLO_WORKER === 'weather' ? { ...env, WOLOLO_WORKER: 'time' } : env), /Weather.*also edited src\/time\/mod\.rs/, 'the claimant hears about it');
  assert.equal(peers.pre('edit', { path: join(tree, 'src', 'weather', 'rain.rs') }, tree, env), '', 'its own area');
  assert.equal(peers.pre('read', { path: target }, tree, env), '', 'reads are never blocked');
  assert.equal(peers.pre('edit', { path: target }, tree, { ...env, WOLOLO_WORKER: '' }), '', 'not a worker: does nothing');
});

test('post: new messages from the other agents, each delivered once; its own are skipped', () => {
  const { state, env } = world();
  mkdirSync(join(state, 'inbox'), { recursive: true });
  const line = (/** @type {string} */ from, /** @type {string} */ text) => `${JSON.stringify({ at: 'x', from, title: from === 'time' ? 'Day/night' : 'Weather', text })}\n`;
  writeFileSync(join(state, 'inbox', 'g.jsonl'), line('time', 'renamed Season::Fall to Season::Autumn') + line('weather', 'my own note'));
  const got = peers.post(env);
  assert.match(got, /Messages from the agents building the other steps/);
  assert.match(got, /Day\/night \(time\): renamed Season::Fall to Season::Autumn/);
  assert.doesNotMatch(got, /my own note/);
  assert.equal(peers.post(env), '', 'delivered once');
});

test('the script speaks Claude Code hook JSON: deny before the edit, extra context after a tool', () => {
  const { tree, env } = world();
  const run = (/** @type {string} */ mode, /** @type {any} */ payload) => spawnSync(process.execPath, [SCRIPT, mode], { cwd: tree, input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
  const pre = run('pre', { tool_name: 'Edit', tool_input: { file_path: join(tree, 'Cargo.toml') }, cwd: tree });
  assert.equal(pre.status, 0, pre.stderr);
  const out = JSON.parse(pre.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Cargo\.toml is being changed by "Day\/night"/);
  const post = run('post', { tool_name: 'Read', tool_input: {}, cwd: tree });
  assert.equal(post.stdout.trim(), '', 'nothing new: no output');
  assert.equal(run('pre', { tool_name: 'Edit', tool_input: { file_path: join(tree, 'Cargo.toml') } }).stdout.trim(), '', 'second try: allowed');
});
