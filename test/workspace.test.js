import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const BIN = resolve('bin/wololo.js');
const home = mkdtempSync(join(tmpdir(), 'wololo-ws-home-'));
after(() => rmSync(home, { recursive: true, force: true }));

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
/** @param {string} cwd @param {string[]} args */
const wololo = (cwd, args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, WOLOLO_HOME: home, PROMPT_LOG: join(home, 'prompts.jsonl') } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

// The planner plans a fullstack step and one per repo. Builders write into each repo they touch and
// commit there, like an agent working across frontend/ and backend/ would.
const AGENT = String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const prompt = process.argv[2];
fs.appendFileSync(process.env.PROMPT_LOG, JSON.stringify(prompt) + '\n');
const commitIn = (repo, msg) => execSync('git -C ' + repo + ' add -A && git -C ' + repo + ' commit -qm "' + msg + '"');
if (prompt.includes('You are the planner')) {
  const path = /Write the plan to (\S+)/.exec(prompt)[1];
  fs.writeFileSync(path, JSON.stringify({ tasks: [
    { title: 'Add login end to end', body: 'login', deps: [], touches: ['frontend/login.js', 'backend/auth.js'] },
    { title: 'Add a frontend banner', body: 'banner', deps: [], touches: ['frontend/banner.js'] },
    { title: 'Add a backend health route', body: 'health', deps: [], touches: ['backend/health.js'] },
  ] }));
} else if (prompt.includes('You are the builder')) {
  const goal = prompt.split('Implement this feature:')[1];
  if (/login/.test(goal)) {
    fs.writeFileSync('frontend/login.js', 'login form\n'); commitIn('frontend', 'feat: login form');
    fs.writeFileSync('backend/auth.js', 'auth route\n'); commitIn('backend', 'feat: auth route');
  } else if (/banner/.test(goal)) { fs.writeFileSync('frontend/banner.js', 'banner\n'); commitIn('frontend', 'feat: banner'); }
  else if (/health/.test(goal)) { fs.writeFileSync('backend/health.js', 'ok\n'); commitIn('backend', 'feat: health'); }
}
`;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'wololo-ws-'));
  for (const r of ['frontend', 'backend']) {
    const d = join(root, r);
    mkdirSync(d);
    git(d, ['init', '-q', '-b', 'master']);
    git(d, ['config', 'user.email', 't@t']);
    git(d, ['config', 'user.name', 't']);
    writeFileSync(join(d, 'README.md'), `${r}\n`);
    git(d, ['add', '-A']);
    git(d, ['commit', '-qm', `init ${r}`]);
  }
  git(join(root, 'backend'), ['branch', 'develop']); // the backend integrates on develop
  writeFileSync(join(home, 'agent.cjs'), AGENT);
  assert.equal(wololo(root, ['init', '--yes', '--harness', 'claude', '--ci', 'none', '--bin', `node ${BIN}`]).code, 0);
  const config = JSON.parse(readFileSync(join(root, 'wololo.config.json'), 'utf8'));
  config.verify = { ...config.verify, steps: [{ name: 'workspace', run: 'node -e 0' }] };
  config.autopilot = {
    ...config.autopilot,
    command: [process.execPath, join(home, 'agent.cjs'), '{prompt}'],
    workers: 2, verifiers: 0, gapRounds: 0, hillClimb: 0,
    repos: { frontend: { verify: [{ name: 'test', run: 'node -e "process.exit(require(\'fs\').existsSync(\'broken\')?1:0)"' }] }, backend: { base: 'develop', verify: [{ name: 'test', run: 'node -e 0' }] } },
  };
  writeFileSync(join(root, 'wololo.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

test('workspace: a fullstack plan builds in parallel across frontend and backend, each repo branched from its own base, never on master or develop', () => {
  const root = workspace();
  const fe = join(root, 'frontend');
  const be = join(root, 'backend');
  const masters = { fe: git(fe, ['rev-parse', 'master']).stdout, be: git(be, ['rev-parse', 'master']).stdout, dev: git(be, ['rev-parse', 'develop']).stdout };

  const r = wololo(root, ['autopilot', '--goal', 'Add login', '--plan']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.err, /frontend: master is protected: created branch feature\/add-login from master/);
  assert.match(r.err, /backend: master is protected: created branch feature\/add-login from develop/, 'the backend branches from develop');
  assert.match(r.out, /3\/3 step\(s\) landed/);

  // the work is on the feature branch in each repo
  for (const [d, files] of /** @type {const} */ ([[fe, ['login.js', 'banner.js']], [be, ['auth.js', 'health.js']]])) {
    assert.equal(git(d, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'feature/add-login');
    for (const f of files) assert.ok(existsSync(join(d, f)), `${f} merged`);
  }
  assert.match(git(be, ['log', '--format=%s', 'feature/add-login']).stdout, /init backend/);
  assert.equal(git(be, ['merge-base', '--is-ancestor', 'develop', 'feature/add-login']).status, 0, 'cut from develop');
  // protected branches untouched
  assert.equal(git(fe, ['rev-parse', 'master']).stdout, masters.fe);
  assert.equal(git(be, ['rev-parse', 'master']).stdout, masters.be);
  assert.equal(git(be, ['rev-parse', 'develop']).stdout, masters.dev);
  // per-repo verify ran, named by repo
  const verified = wololo(root, ['verify']).out;
  assert.match(verified, /PASS frontend: test/);
  assert.match(verified, /PASS backend: test/);
  // every step's worktrees and branches are cleaned up in both repos
  for (const d of [fe, be]) {
    assert.equal(git(d, ['worktree', 'list']).stdout.trim().split('\n').length, 1, `${d} worktrees`);
    assert.equal(git(d, ['branch', '--list', 'wololo/*']).stdout.trim(), '', `${d} step branches`);
  }
});

test('workspace: a failing check in one repo is named, and blocks the gate', () => {
  const root = workspace();
  writeFileSync(join(root, 'frontend', 'broken'), 'x');
  const v = wololo(root, ['verify']);
  assert.notEqual(v.code, 0);
  assert.match(v.out, /verify failed: frontend: test/);
  assert.match(wololo(root, ['gate']).out, /BLOCKED/);
});

test('workspace: init finds each repo\'s test command and records it as that repo\'s verify steps', () => {
  const root = mkdtempSync(join(tmpdir(), 'wololo-ws-init-'));
  for (const r of ['frontend', 'backend']) {
    const d = join(root, r);
    mkdirSync(d);
    git(d, ['init', '-q']);
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: r, scripts: { test: 'node -e 0' } }));
  }
  const r = wololo(root, ['init', '--yes', '--harness', 'claude', '--ci', 'none']);
  assert.equal(r.code, 0, r.out + r.err);
  const repos = JSON.parse(readFileSync(join(root, 'wololo.config.json'), 'utf8')).autopilot.repos;
  assert.deepEqual(Object.keys(repos).sort(), ['backend', 'frontend']);
  assert.ok(repos.frontend.verify.some((/** @type {any} */ s) => /test/.test(s.run)));
  const v = wololo(root, ['verify']).out;
  assert.match(v, /PASS frontend: /);
  assert.match(v, /PASS backend: /);
});

test('workspace: one agent (serial) builds a fullstack goal on a feature branch in each repo', () => {
  const root = workspace();
  const config = JSON.parse(readFileSync(join(root, 'wololo.config.json'), 'utf8'));
  config.autopilot.workers = 1;
  writeFileSync(join(root, 'wololo.config.json'), JSON.stringify(config));
  const r = wololo(root, ['autopilot', '--goal', 'Add login end to end']);
  assert.equal(r.code, 0, r.out + r.err);
  for (const [repo, file] of [['frontend', 'login.js'], ['backend', 'auth.js']]) {
    const d = join(root, repo);
    assert.equal(git(d, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'feature/add-login-end-to-end');
    assert.ok(existsSync(join(d, file)));
    assert.equal(git(d, ['status', '--porcelain']).stdout.trim(), '', `${repo} is clean`);
  }
  assert.doesNotMatch(git(join(root, 'frontend'), ['log', '--format=%s', 'master']).stdout, /login/, 'master untouched');
});

test('workspace: a repo with master and develop and no base set is refused, naming the setting; nothing is guessed', () => {
  const root = workspace();
  const config = JSON.parse(readFileSync(join(root, 'wololo.config.json'), 'utf8'));
  delete config.autopilot.repos.backend.base;
  writeFileSync(join(root, 'wololo.config.json'), JSON.stringify(config));
  const r = wololo(root, ['autopilot', '--goal', 'Add login', '--plan']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out + r.err, /backend: it has master and develop: set which one features start from in autopilot.repos.backend.base/);
  assert.equal(git(join(root, 'backend'), ['branch', '--list', 'feature/*']).stdout.trim(), '', 'no branch was made');
});

test('workspace: doctor, garden and bottleneck count each repo\'s verify steps and see the repos', () => {
  const root = workspace();
  const config = JSON.parse(readFileSync(join(root, 'wololo.config.json'), 'utf8'));
  config.verify.steps = []; // only the repos verify
  writeFileSync(join(root, 'wololo.config.json'), JSON.stringify(config));
  const d = wololo(root, ['doctor']);
  assert.match(d.out, /✓ 2 verify step\(s\) \(0 fast\): backend 1, frontend 1/);
  assert.match(d.out, /✓ workspace of 2 git repos: backend, frontend/);
  assert.doesNotMatch(wololo(root, ['garden']).out, /no verify steps/);
  assert.doesNotMatch(wololo(root, ['bottleneck']).out, /no verify steps/);
});
