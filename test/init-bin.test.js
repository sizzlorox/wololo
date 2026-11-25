import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const BIN = resolve('bin/wololo.js');
/** @param {object | null} pkg */
const binAfterInit = (pkg) => {
  const dir = mkdtempSync(join(tmpdir(), 'wololo-init-bin-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  const r = spawnSync(process.execPath, [BIN, 'init', '--yes', '--harness', 'claude', '--ci', 'none'], { cwd: dir, encoding: 'utf8', env: { ...process.env, WOLOLO_HOME: dir } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(readFileSync(join(dir, 'wololo.config.json'), 'utf8')).bin;
};

test('init calls the global wololo unless the project installs its own (never npx github:, which caches stale versions)', () => {
  assert.equal(binAfterInit(null), 'wololo');
  assert.equal(binAfterInit({ name: 'app' }), 'wololo', 'a package.json alone does not mean wololo is installed in it');
  assert.equal(binAfterInit({ name: 'app', devDependencies: { wololo: 'github:sizzlorox/wololo' } }), 'npx --no-install wololo');
});
