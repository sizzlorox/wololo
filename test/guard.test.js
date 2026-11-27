import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/core/config.js';
import { assertions, compare, contractOf, scriptsRun } from '../src/features/guard/contract.js';
import { ratchet, raise, readLock } from '../src/features/guard/lock.js';

const BIN = join(process.cwd(), 'bin', 'wololo.js');

/** A small node project with a test runner, a verify script and a test, under git. */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'wololo-guard-'));
  const w = (/** @type {string} */ f, /** @type {string} */ s) => {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), s);
  };
  w('package.json', JSON.stringify({ name: 'p', type: 'module', scripts: { test: 'node --test', check: 'npm run test' } }));
  w('verify.mjs', "if (1 + 1 !== 2) process.exit(1);\n");
  w('vitest.config.ts', 'export default {};\n');
  w('tests/a.test.js', "import assert from 'node:assert';\nimport { test } from 'node:test';\ntest('a', () => { assert.equal([1].length, 1); assert.ok([].length === 0); });\n");
  w('wololo.config.json', JSON.stringify({ project: 'p', harnesses: [], ci: { provider: 'none', setup: [] }, verify: { steps: [{ name: 'test', run: 'npm run check' }, { name: 'min', run: 'node verify.mjs' }] } }));
  w('.gitignore', '.wololo/state/\n');
  const g = (/** @type {string[]} */ a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g(['init', '-q']);
  spawnSync(process.execPath, [BIN, 'sync'], { cwd: root });
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return { root, w, ctx: () => /** @type {any} */ ({ root, config: loadConfig(root) }) };
}

const empty = { steps: {}, files: {}, scripts: {}, tests: {}, minScore: 0.8 };

test('compare: growing verification is fine; removing, rewriting or thinning it is a weakening', () => {
  const locked = { ...empty, steps: { test: 'npm test', min: 'node v.mjs' }, files: { 'v.mjs': 'aa' }, scripts: { 'package.json#test': 'vitest run' }, tests: { 'a.test.js': 3 } };
  assert.deepEqual(compare(locked, locked), { weakened: [], added: [] });
  const grown = { ...locked, steps: { ...locked.steps, web: '{}' }, tests: { 'a.test.js': 5, 'b.test.js': 1 } };
  assert.deepEqual(compare(locked, grown).weakened, []);
  assert.deepEqual(compare(locked, grown).added, ['verify step "web"', 'b.test.js']);

  const weakened = (/** @type {any} */ now) => compare(locked, { ...locked, ...now }).weakened.join('\n');
  assert.match(weakened({ steps: { test: 'npm test' } }), /"min" was removed/);
  assert.match(weakened({ steps: { ...locked.steps, test: 'true' } }), /"test" was changed: npm test → true/);
  assert.match(weakened({ files: { 'v.mjs': 'bb' } }), /v\.mjs, part of the gate, was edited/);
  assert.match(weakened({ files: {} }), /v\.mjs, part of the gate, was deleted/);
  assert.match(weakened({ scripts: { 'package.json#test': 'echo ok' } }), /package\.json#test the gate runs was changed: vitest run → echo ok/);
  assert.match(weakened({ tests: {} }), /a\.test\.js was deleted/);
  assert.match(weakened({ tests: { 'a.test.js': 2 } }), /lost assertions: 3 → 2/);
  assert.match(weakened({ minScore: 0.5 }), /minScore was lowered/);
});

test('assertions and scripts are counted the way runners spell them', () => {
  assert.equal(assertions("expect(a).toBe(1); assert.equal(b, 2); assert.ok(c);\n  assert x == 1\nassert_eq!(a, b);"), 5);
  assert.equal(assertions('const expected = 1; // assertion-free'), 0);
  assert.deepEqual(scriptsRun('npm run check && npm t', { check: 'pnpm lint && npm run unit', lint: 'eslint .', unit: 'vitest', test: 'node --test' }), { check: 'pnpm lint && npm run unit', lint: 'eslint .', unit: 'vitest', test: 'node --test' });
});

test('the contract of a real project: its steps, the scripts and files they run, runner configs and tests', () => {
  const p = project();
  const c = contractOf(p.ctx());
  assert.deepEqual(c.steps, { test: 'npm run check', min: 'node verify.mjs' });
  assert.deepEqual(Object.keys(c.scripts).sort(), ['package.json#check', 'package.json#test']);
  assert.deepEqual(Object.keys(c.files).sort(), ['verify.mjs', 'vitest.config.ts']);
  assert.deepEqual(c.tests, { 'tests/a.test.js': 2 });
  rmSync(p.root, { recursive: true, force: true });
});

test('the ratchet: the first run locks, growth raises the lock, weakening fails until a human approves', () => {
  const p = project();
  assert.equal(ratchet(p.ctx()).ok, true, 'no lock yet: today is the baseline');
  assert.ok(readLock(p.root));

  p.w('tests/b.test.js', "import assert from 'node:assert';\nassert.ok(1);\n");
  const grown = raise(p.ctx(), 'test');
  assert.equal(grown.ok, true);
  assert.deepEqual(grown.added, ['tests/b.test.js']);
  assert.ok(readLock(p.root)?.contract.tests['tests/b.test.js'], 'raised: b is locked in now');

  // the shortcuts an agent takes to get green
  p.w('package.json', JSON.stringify({ name: 'p', type: 'module', scripts: { test: 'echo ok', check: 'npm run test' } }));
  p.w('tests/a.test.js', "import { test } from 'node:test';\ntest('a', () => {});\n");
  p.w('verify.mjs', 'process.exit(0);\n');
  const r = ratchet(p.ctx());
  assert.equal(r.ok, false);
  assert.match(r.weakened.join('\n'), /package\.json#test the gate runs was changed: node --test → echo ok/);
  assert.match(r.weakened.join('\n'), /tests\/a\.test\.js lost assertions: 2 → 0/);
  assert.match(r.weakened.join('\n'), /verify\.mjs, part of the gate, was edited/);
  assert.equal(raise(p.ctx(), 'test').ok, false, 'a weaker tree never raises the lock');
  assert.equal(ratchet(p.ctx()).ok, false, 'and stays failing');

  const cli = (/** @type {Record<string, string>} */ env) => spawnSync(process.execPath, [BIN, 'verify', 'approve', '--json'], { cwd: p.root, encoding: 'utf8', env: { ...process.env, ...env } });
  const agent = cli({ WOLOLO_AGENT: '1' });
  assert.notEqual(agent.status, 0, 'an agent cannot approve it');
  assert.match(agent.stdout, /agents cannot approve/);
  assert.equal(ratchet(p.ctx()).ok, false);

  const human = cli({ WOLOLO_AGENT: '' });
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(JSON.parse(human.stdout).details.join('\n'), /lost assertions/, 'approving shows what was accepted');
  assert.equal(ratchet(p.ctx()).ok, true, 'approved: the new contract is the lock');
  assert.equal(readLock(p.root)?.by, 'human');
  rmSync(p.root, { recursive: true, force: true });
});

test('the gate fails on a weakened contract and says how a human accepts it', () => {
  const p = project();
  const gate = () => spawnSync(process.execPath, [BIN, 'gate', '--json'], { cwd: p.root, encoding: 'utf8', env: { ...process.env, WOLOLO_AGENT: '' } });
  const first = gate();
  assert.equal(first.status, 0, first.stdout);
  p.w('wololo.config.json', JSON.stringify({ project: 'p', harnesses: [], ci: { provider: 'none', setup: [] }, verify: { steps: [{ name: 'test', run: 'npm run check' }] } }));
  const r = gate();
  assert.notEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.summary, /ratchet/);
  assert.match(out.details.join('\n'), /"min" was removed[\s\S]*wololo verify approve/);
  assert.ok(readFileSync(join(p.root, 'wololo.config.json'), 'utf8'));
  rmSync(p.root, { recursive: true, force: true });
});

test('coverage: the project grew tests, a build and a page; the gate that only checked one file must run them', async () => {
  const { uncovered, adoptMissing } = await import('../src/features/guard/coverage.js');
  const p = project();
  const steps = (/** @type {any[]} */ s) => p.w('wololo.config.json', JSON.stringify({ project: 'p', harnesses: [], ci: { provider: 'none', setup: [] }, verify: { steps: s } }));
  // like v-sim-v2: the gate began as "the notes file exists"
  steps([{ name: 'notes', run: 'node -e "process.exit(0)"' }]);
  p.w('package.json', JSON.stringify({ name: 'p', type: 'module', scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' }, devDependencies: { vite: '6', vitest: '2' } }));
  p.w('index.html', '<canvas></canvas>');
  const missing = uncovered(p.root, loadConfig(p.root).verify.steps);
  assert.deepEqual(missing.map((s) => s.name), ['test', 'build', 'app']);
  assert.match(JSON.stringify(missing.find((s) => s.app)), /vite --port 5199/);

  const gate = spawnSync(process.execPath, [BIN, 'gate', '--json'], { cwd: p.root, encoding: 'utf8' });
  assert.match(JSON.parse(gate.stdout).details.join('\n'), /FAIL coverage[\s\S]*the project has test \(npm run test\) but the gate does not run it[\s\S]*wololo verify adopt/);

  // a step that runs them through another script covers them; so does running the command itself
  steps([{ name: 'all', run: 'npm run verify' }, { name: 'b', run: 'vite build' }, { name: 'look', app: { url: 'index.html' } }]);
  p.w('package.json', JSON.stringify({ name: 'p', type: 'module', scripts: { dev: 'vite', build: 'vite build', test: 'vitest run', verify: 'npm test' }, devDependencies: { vite: '6' } }));
  assert.deepEqual(uncovered(p.root, loadConfig(p.root).verify.steps), []);

  // adopting adds, never replaces: a taken name gets a suffix
  steps([{ name: 'test', run: 'node verify.mjs' }]);
  assert.deepEqual(adoptMissing(p.root).map((s) => s.name), ['test-2', 'build', 'app']);
  assert.deepEqual(loadConfig(p.root).verify.steps.map((s) => s.name), ['test', 'test-2', 'build', 'app'], 'the existing step is kept');
  assert.deepEqual(adoptMissing(p.root), [], 'nothing twice');
  rmSync(p.root, { recursive: true, force: true });
});

test('detection finds what people look at, whatever the stack', async () => {
  const { detect } = await import('../src/features/init/detect.js');
  const dir = (/** @type {Record<string, string>} */ files) => {
    const d = mkdtempSync(join(tmpdir(), 'wololo-detect-'));
    for (const [f, s] of Object.entries(files)) writeFileSync(join(d, f), s);
    return d;
  };
  const app = (/** @type {Record<string, string>} */ files) => detect(dir(files)).steps.find((s) => s.app)?.app;
  assert.deepEqual(app({ 'Cargo.toml': '[dependencies]\nbevy = "0.14"\n' }), { start: 'cargo run', window: '*', readyMs: 900000 });
  assert.equal(app({ 'Cargo.toml': '[dependencies]\nserde = "1"\n' }), undefined, 'a library or CLI opens no window');
  assert.deepEqual(app({ 'requirements.txt': 'pygame==2.5\n', 'main.py': '' }), { start: 'python main.py', window: '*' });
  assert.deepEqual(app({ 'project.godot': '' }), { start: 'godot --path .', window: '*' });
  assert.deepEqual(app({ 'package.json': JSON.stringify({ devDependencies: { electron: '30' } }) }), { start: 'npm start', window: '*' });
  assert.deepEqual(app({ 'index.html': '<h1>hi</h1>' }), { url: 'index.html' });
});

test('tools: what a goal and its steps need, what is configured, and whether a step really called it', async () => {
  const { mcpMentions, stepTools, missingServers, unusedServers, goalText } = await import('../src/features/guard/tools.js');
  const { recorder } = await import('../src/features/autopilot/transcript.js');
  const { saveRun } = await import('../src/features/autopilot/usage.js');
  assert.deepEqual(mcpMentions('The `pixellab` MCP server is configured. Use the MCP server figma too; via the MCP, nothing.'), ['pixellab', 'figma']);
  assert.deepEqual(stepTools({ title: 'Art pass: PixelLab vertical slice', body: 'manifest' }, ['pixellab']), ['pixellab'], 'the goal\'s tool, named by the step');
  assert.deepEqual(stepTools({ title: 'Pathfinding', tools: ['Postgres'] }, ['pixellab']), ['postgres']);

  const p = project();
  p.w('BRIEF.md', 'Art comes from the `pixellab` MCP server.');
  assert.match(goalText(p.root, 'Read BRIEF.md and build it'), /pixellab/, 'documents the goal points at count');
  const home = mkdtempSync(join(tmpdir(), 'wololo-home-'));
  const was = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = process.env.HOME = home;
  try {
    assert.deepEqual(missingServers(['pixellab'], p.root, 'omp'), ['pixellab']);
    // set up for Claude Code, in another project and in this one: neither is omp's
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { 'D:/elsewhere': { mcpServers: { pixellab: {} } }, [p.root]: { mcpServers: { pixellab: {} } } } }));
    assert.deepEqual(missingServers(['pixellab'], p.root, 'omp'), ['pixellab'], "another CLI's server does not count");
    assert.deepEqual(missingServers(['pixellab'], p.root, 'claude'), [], 'Claude Code has it for this project');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { 'D:/elsewhere': { mcpServers: { pixellab: {} } } } }));
    assert.deepEqual(missingServers(['pixellab'], p.root, 'claude'), ['pixellab'], "another project's server does not count");
    mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
    writeFileSync(join(home, '.omp', 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { PixelLab: { command: 'x' } } }));
    assert.deepEqual(missingServers(['pixellab'], p.root, 'omp'), [], "found in omp's own settings");
  } finally {
    Object.assign(process.env, was);
  }

  const since = Date.now();
  const run = (/** @type {string} */ task, /** @type {string} */ tool) => {
    const rec = recorder(p.root, 'builder', 'go');
    rec.add({ kind: 'call', tool, text: '{}' });
    saveRun(p.root, /** @type {any} */ ({ type: 'agent', id: rec.id, transcript: rec.id, role: 'builder', ts: new Date().toISOString(), task }));
  };
  run('t1', 'write');
  assert.deepEqual(unusedServers(p.root, ['pixellab'], { task: 't1', since }), ['pixellab'], 'wrote files instead');
  run('t2', 'mcp__pixellab__create_character');
  assert.deepEqual(unusedServers(p.root, ['pixellab'], { task: 't1', since }), ['pixellab'], "another step's call does not count");
  assert.deepEqual(unusedServers(p.root, ['pixellab'], { task: 't2', since }), []);
  rmSync(p.root, { recursive: true, force: true });
});
