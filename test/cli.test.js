import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const BIN = resolve('bin/wololo.js');
/** @type {string} */
let repo;
/** @type {string} */
let home;

/**
 * @param {string[]} args
 * @param {{ input?: string }} [opts]
 */
function wololo(args, opts = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, input: opts.input ?? '', encoding: 'utf8', env: { ...process.env, WOLOLO_HOME: home, WOLOLO_TRANSCRIPTS: join(home, 'none') } });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

/** @param {string[]} args */
const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'wololo-cli-'));
  home = mkdtempSync(join(tmpdir(), 'wololo-home-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }));
  writeFileSync(join(repo, 'package-lock.json'), '{}');
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('init seeds .wololo and wires every harness', () => {
  const r = wololo(['init', '--bin', `node ${BIN}`]);
  assert.equal(r.code, 0, r.out + r.err);
  for (const f of ['wololo.config.json', '.wololo/rubric.json', '.wololo/skills/verify-app/SKILL.md', '.wololo/rules/god-files.json', 'AGENTS.md', 'CLAUDE.md', '.mcp.json', '.claude/settings.json', '.codex/config.toml', '.github/hooks/wololo.json', '.cursor/mcp.json', '.gemini/settings.json', 'opencode.json', '.github/workflows/wololo.yml'])
    assert.ok(existsSync(join(repo, f)), `missing ${f}`);
  const config = JSON.parse(readFileSync(join(repo, 'wololo.config.json'), 'utf8'));
  assert.ok(config.verify.steps.some((/** @type {{run: string}} */ s) => s.run.includes('test')));
  assert.equal(wololo(['sync', '--check']).code, 0);
  assert.equal(wololo(['rule', 'test']).code, 0);
});

test('check and post-edit hook block rule violations with the fix', () => {
  // wololo-ignore tautological-tests: fixture string the hook must reject
  writeFileSync(join(repo, 'bad.test.js'), "test('x', () => {\n  expect(true).toBe(true);\n});\n");
  const check = wololo(['check', 'bad.test.js', '--json']);
  assert.equal(check.code, 1);
  assert.ok(JSON.stringify(check.json()).includes('tautological-tests'));

  const hook = wololo(['hook', 'claude', 'post-edit'], { input: JSON.stringify({ tool_input: { file_path: join(repo, 'bad.test.js') } }) });
  assert.equal(hook.code, 2);
  assert.match(hook.err, /tautological-tests/);

  writeFileSync(join(repo, 'bad.test.js'), "test('x', () => {\n  expect(add(1, 2)).toBe(3);\n});\n");
  assert.equal(wololo(['hook', 'claude', 'post-edit'], { input: JSON.stringify({ tool_input: { file_path: 'bad.test.js' } }) }).code, 0);
});

test('rule add refuses rules whose examples do not hold', () => {
  const bad = wololo(['rule', 'add', 'no-console', '--pattern', 'console\\.log', '--files', '**/*.js', '--why', 'noise', '--fix', 'use the logger', '--bad', 'print("x")']);
  assert.notEqual(bad.code, 0);
  const good = wololo(['rule', 'add', 'no-console', '--pattern', 'console\\.log', '--files', 'src/**/*.js', '--why', 'noise', '--fix', 'use the logger', '--bad', 'console.log(1)', '--good', 'log.info(1)']);
  assert.equal(good.code, 0, good.out + good.err);
  assert.ok(existsSync(join(repo, '.wololo/rules/no-console.json')));
});

test('queue clusters repeated findings and the board refuses double claims', () => {
  wololo(['queue', 'add', 'agent skipped failing login test', '--kind', 'mistake']);
  wololo(['queue', 'add', 'agent skipped failing login test again', '--kind', 'mistake']);
  const patterns = wololo(['queue', 'patterns', '--json']).json();
  assert.ok(patterns.data.clusters?.length ?? patterns.data.length);

  const added = wololo(['task', 'add', 'Fix login flow', '--group', 'auth', '--json']).json();
  const id = added.data.id ?? added.data.task?.id;
  assert.ok(id);
  assert.notEqual(wololo(['task', 'add', 'Fix the login flow', '--group', 'auth']).code, 0, 'near-duplicate refused');
  assert.equal(wololo(['task', 'claim', id, '--agent', 'a']).code, 0);
  assert.notEqual(wololo(['task', 'claim', id, '--agent', 'b']).code, 0);
});

test('gate passes on a clean repo, review samples commits, autopilot dry-runs', () => {
  rmSync(join(repo, 'bad.test.js'));
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  const gate = wololo(['gate', '--judge', 'intent=1', '--judge', 'craft=1']);
  assert.equal(gate.code, 0, gate.out + gate.err);

  const sample = wololo(['review', 'sample', '--rate', '1', '--json']).json();
  assert.ok(sample.ok);
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(wololo(['review', 'record', sha, '--verdict', 'fix-env', '--note', 'missing rule']).code, 0);
  assert.match(wololo(['queue', 'list']).out, /missing rule|mistake/);

  const dry = wololo(['autopilot', '--agent', 'claude', '--dry-run']);
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.match(dry.out, /claude/);
  assert.equal(wololo(['doctor']).code === 0 || wololo(['doctor']).code === 1, true);
});
