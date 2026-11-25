import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { defaultConfig } from '../src/core/config.js';
import { appDefaults } from '../src/features/init/interview.js';
import { commands } from '../src/features/init/command.js';

const init = commands[0];
/** @type {string[]} */
const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** @param {Record<string, unknown>} pkg */
function repo(pkg) {
  const root = mkdtempSync(join(tmpdir(), 'wololo-interview-'));
  dirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  return root;
}

/**
 * Answers by question substring; unmatched questions take the suggested default. Records every question asked.
 * @param {Record<string, string | string[]>} script
 */
function scripted(script) {
  /** @type {{ q: string, d?: string }[]} */
  const asked = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  /** @param {string} q @param {string} [d] */
  const prompt = async (q, d) => {
    asked.push({ q, d });
    const key = Object.keys(queues).find((k) => q.includes(k) && queues[k].length);
    return key ? /** @type {string} */ (queues[key].shift()) : d ?? '';
  };
  return { prompt, asked };
}

/** @param {string} root @param {Partial<import('../src/core/types.js').Ctx>} extra */
const ctxFor = (root, extra = {}) => ({ cwd: root, root, config: defaultConfig(root), hasConfig: false, env: {}, readStdin: async () => '', ...extra });

test('interactive init writes the answers into the verify-app skill and config', async () => {
  const root = repo({ name: 'shop', scripts: { dev: 'vite', test: 'vitest' }, devDependencies: { vite: '5' } });
  const { prompt, asked } = scripted({
    'Which agents': 'claude, codex',
    'Golden path': ['Checkout: add item, pay with test card, see order #', ''],
  });
  const r = await init.run({ ci: 'none' }, ctxFor(root, { prompt }));
  assert.equal(r.ok, true, r.summary);

  const config = JSON.parse(readFileSync(join(root, 'wololo.config.json'), 'utf8'));
  assert.deepEqual(config.harnesses, ['claude', 'codex']);

  const skill = readFileSync(join(root, '.wololo/skills/verify-app/SKILL.md'), 'utf8');
  assert.match(skill, /`npm run dev`/, 'accepted the detected start command');
  assert.match(skill, /localhost:5173/, 'vite port suggested');
  assert.match(skill, /1\. Checkout: add item, pay with test card, see order #/);
  assert.doesNotMatch(skill, /TODO\(wololo\)/);
  assert.match(readFileSync(join(root, '.claude/skills/verify-app/SKILL.md'), 'utf8'), /Checkout/, 'answers are synced to harnesses');
  assert.ok(!r.details?.some((d) => d.startsWith('next: finish') && d.includes('verify-app')), 'no nag once filled');
  assert.ok(asked.some((a) => a.q.includes('start the app') && a.d === 'npm run dev'));
});

test('unanswered sections keep TODO(wololo) and init still nags', async () => {
  const root = repo({ name: 'lib' });
  const { prompt } = scripted({ 'Which agents': 'claude', 'start the app': '', 'drive it': '', 'logs': '' });
  const r = await init.run({ ci: 'none' }, ctxFor(root, { prompt }));
  const skill = readFileSync(join(root, '.wololo/skills/verify-app/SKILL.md'), 'utf8');
  assert.match(skill, /TODO\(wololo\)/);
  assert.ok(r.details?.some((d) => d.startsWith('next: finish') && d.includes('verify-app')));
});

test('asks for verify commands when none are detected', async () => {
  const root = repo({ name: 'bare' });
  const { prompt } = scripted({ 'Which agents': 'claude', 'runs your tests': 'make test', 'fast check': 'make lint' });
  await init.run({ ci: 'none' }, ctxFor(root, { prompt }));
  const config = JSON.parse(readFileSync(join(root, 'wololo.config.json'), 'utf8'));
  assert.deepEqual(config.verify.steps, [{ name: 'check', run: 'make lint', fast: true }, { name: 'test', run: 'make test' }]);
});

test('--yes and non-interactive runs never ask', async () => {
  const root = repo({ name: 'quiet', scripts: { test: 'x' } });
  const { prompt, asked } = scripted({});
  await init.run({ ci: 'none', yes: true }, ctxFor(root, { prompt }));
  assert.equal(asked.length, 0);
  const other = repo({ name: 'pipe', scripts: { test: 'x' } });
  const r = await init.run({ ci: 'none' }, ctxFor(other));
  assert.equal(r.ok, true);
});

test('appDefaults suggests how to start and drive common stacks', () => {
  assert.equal(appDefaults(repo({ scripts: { start: 'node server.js' }, dependencies: { express: '4' } })).drive.startsWith('curl http://localhost:3000'), true);
  assert.equal(appDefaults(repo({ bin: { tool: 'cli.js' } })).start, 'node cli.js');
});

test('autopilot drives the harness you chose, also when re-running init on an existing config', async () => {
  const root = repo({ name: 'pick', scripts: { test: 'x' } });
  await init.run({ ci: 'none', yes: true, harness: ['omp'] }, ctxFor(root));
  const read = () => JSON.parse(readFileSync(join(root, 'wololo.config.json'), 'utf8'));
  assert.equal(read().autopilot.agent, 'omp');

  const config = read();
  config.harnesses = ['claude'];
  config.autopilot.agent = 'claude';
  writeFileSync(join(root, 'wololo.config.json'), JSON.stringify(config));
  const r = await init.run({ ci: 'none', yes: true, harness: ['omp'] }, ctxFor(root));
  assert.deepEqual(read().harnesses, ['claude', 'omp']);
  assert.equal(read().autopilot.agent, 'omp');
  assert.ok(r.details?.some((d) => d.includes('autopilot.agent = omp')), 'init says what it changed');
});

test('rust projects get cargo verify steps with room for a cold build (Bevy takes a while)', async () => {
  const { detect } = await import('../src/features/init/detect.js');
  const root = mkdtempSync(join(tmpdir(), 'wololo-rust-'));
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "sim"\n');
  const steps = detect(root).steps;
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(steps.map((s) => s.name), ['fmt', 'clippy', 'test']);
  for (const s of steps.filter((x) => x.name !== 'fmt')) assert.ok((s.timeoutSec ?? 0) >= 3600, `${s.name} timeoutSec ${s.timeoutSec}`);
});
