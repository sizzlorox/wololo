import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedSince, commitAll, commitsSince, diffHint, dirty, heads, listRepos, snapshot } from '../src/core/repos.js';

/** A folder holding two repos, frontend and backend, like a fullstack checkout. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'wololo-ws-'));
  for (const r of ['frontend', 'backend']) {
    mkdirSync(join(root, r));
    const g = (/** @type {string[]} */ a) => spawnSync('git', a, { cwd: join(root, r), encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    writeFileSync(join(root, r, 'README.md'), r);
    g(['add', '-A']);
    g(['commit', '-qm', `init ${r}`]);
  }
  mkdirSync(join(root, 'docs')); // not a repo
  return root;
}

test('listRepos: "." for a repo; the child repos for a folder that only holds repos', () => {
  const root = workspace();
  assert.deepEqual(listRepos(root), ['backend', 'frontend']);
  assert.deepEqual(listRepos(join(root, 'frontend')), ['.']);
  assert.deepEqual(listRepos(mkdtempSync(join(tmpdir(), 'wololo-none-'))), [], 'neither: no repos');
});

test('heads, dirty, changedSince, commitsSince and commitAll work across the repos, paths prefixed by repo', () => {
  const root = workspace();
  const base = heads(root);
  assert.deepEqual(Object.keys(JSON.parse(base)), ['backend', 'frontend'], 'a workspace base names each repo');
  const before = snapshot(root);
  writeFileSync(join(root, 'frontend', 'login.tsx'), 'x');
  writeFileSync(join(root, 'backend', 'auth.ts'), 'y');
  assert.notEqual(snapshot(root), before, 'the snapshot sees changes in any repo');
  assert.deepEqual(dirty(root).map((l) => l.slice(3)).sort(), ['backend/auth.ts', 'frontend/login.tsx']);
  assert.deepEqual(commitAll(root, 'feat: login'), ['backend', 'frontend'], 'committed in the repos that had changes');
  assert.deepEqual(dirty(root), []);
  assert.deepEqual(commitsSince(root, base), ['backend: feat: login', 'frontend: feat: login']);
  assert.deepEqual(changedSince(root, base).sort(), ['backend/auth.ts', 'frontend/login.tsx']);
  assert.match(diffHint(base), /in backend: `git diff [0-9a-f]{7,}`.*in frontend: `git diff [0-9a-f]{7,}`/s);
  assert.deepEqual(commitAll(root, 'nothing'), [], 'clean repos are not committed');
});

test('a single repo keeps plain shas and plain paths', () => {
  const root = join(workspace(), 'frontend');
  const base = heads(root);
  assert.match(base, /^[0-9a-f]{40}$/);
  writeFileSync(join(root, 'a.ts'), 'x');
  commitAll(root, 'feat: a');
  assert.deepEqual(changedSince(root, base), ['a.ts']);
  assert.deepEqual(commitsSince(root, base), ['feat: a']);
  assert.equal(diffHint(base), `\`git diff ${base}\``);
});
