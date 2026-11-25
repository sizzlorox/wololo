import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultConfig } from '../src/core/config.js';
import { agentArgv } from '../src/features/autopilot/argv.js';

/** @param {Record<string, string>} [models] */
const config = (models) => {
  const c = defaultConfig('/tmp/x');
  return { ...c, autopilot: { ...c.autopilot, ...(models ? { models } : {}) } };
};

test('each harness gets its own model flag from autopilot.models; no model set = no flag', () => {
  assert.deepEqual(agentArgv(config({ claude: 'opus' }), 'claude', 'p').slice(-5, -3), ['--model', 'opus']);
  assert.ok(agentArgv(config({ omp: 'local-gpu/nemotron-super' }), 'omp', 'p').includes('--model=local-gpu/nemotron-super'));
  assert.ok(agentArgv(config({ codex: 'gpt-5.2' }), 'codex', 'p').join(' ').includes('--model gpt-5.2'));
  assert.ok(!agentArgv(config({ omp: 'x' }), 'claude', 'p').includes('--model'), 'another harness\'s model is not used');
  assert.ok(!agentArgv(config(), 'claude', 'p').includes('--model'));
  assert.ok(!agentArgv(config({ amp: 'some-model' }), 'amp', 'p').includes('some-model'), 'amp has no model flag');
});

test('with root, the model is read from wololo.config.json at launch: a change mid-run applies to the next agent', () => {
  const root = mkdtempSync(join(tmpdir(), 'wololo-argv-'));
  const write = (/** @type {any} */ autopilot) => writeFileSync(join(root, 'wololo.config.json'), JSON.stringify({ autopilot }));
  write({ agent: 'claude', models: { claude: 'haiku' } });
  const started = config({ claude: 'opus' }); // what the run loaded when it started
  assert.ok(agentArgv(started, 'claude', 'p', { root }).includes('haiku'));
  write({ agent: 'claude' });
  assert.ok(!agentArgv(started, 'claude', 'p', { root }).includes('--model'), 'cleared back to the default');
  writeFileSync(join(root, 'wololo.config.json'), '{ broken');
  assert.ok(agentArgv(started, 'claude', 'p', { root }).includes('opus'), 'a file mid-edit keeps the run\'s config');
});
