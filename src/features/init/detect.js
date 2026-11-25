import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, readText } from '../../core/files.js';

/**
 * Seed verify steps and CI setup steps (raw GitHub Actions step YAML) from what the project already has. Deterministic; no guessing beyond files on disk.
 * @param {string} root
 * @returns {{ steps: import('../../core/config.js').VerifyStep[], setup: string[], stack: string[] }}
 */
export function detect(root) {
  /** @type {import('../../core/config.js').VerifyStep[]} */
  const steps = [];
  /** @type {string[]} */
  const setup = [];
  /** @type {string[]} */
  const stack = [];
  /** @param {string} f */
  const has = (f) => existsSync(join(root, f));

  if (has('package.json')) {
    stack.push('node');
    const pkg = readJson(join(root, 'package.json'), /** @type {any} */ ({}));
    const scripts = pkg.scripts ?? {};
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    setup.push('uses: actions/setup-node@v4\nwith:\n  node-version: 22', `run: ${{ npm: has('package-lock.json') ? 'npm ci' : 'npm install', pnpm: 'npx pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', bun: 'npx bun install' }[pm]}`);
    /** @param {string} s */
    const run = (s) => `${pm} run ${s}`;
    const first = (/** @type {string[]} */ names) => names.find((n) => scripts[n]);
    const lint = first(['lint']);
    const types = first(['typecheck', 'type-check', 'check-types', 'tsc', 'types']);
    const test = first(['test', 'test:unit']);
    const e2e = first(['e2e', 'test:e2e']);
    const build = first(['build']);
    if (lint) steps.push({ name: 'lint', run: run(lint), fast: true });
    if (types) steps.push({ name: 'typecheck', run: run(types), fast: true });
    if (test && !/no test specified/.test(scripts[test])) steps.push({ name: 'test', run: run(test) });
    if (build) steps.push({ name: 'build', run: run(build) });
    if (e2e) steps.push({ name: 'e2e', run: run(e2e) });
  }
  const py = readText(join(root, 'pyproject.toml'));
  if (py !== undefined || has('requirements.txt') || has('setup.py')) {
    stack.push('python');
    const prefix = has('uv.lock') ? 'uv run ' : '';
    if (has('uv.lock')) setup.push('uses: astral-sh/setup-uv@v5', 'run: uv sync');
    if (py?.includes('ruff')) steps.push({ name: 'lint', run: `${prefix}ruff check .`, fast: true });
    if (py?.includes('mypy')) steps.push({ name: 'typecheck', run: `${prefix}mypy .`, fast: true });
    if (py?.includes('pytest') || has('tests') || has('pytest.ini')) steps.push({ name: 'test', run: `${prefix}pytest -q` });
  }
  if (has('Cargo.toml')) {
    stack.push('rust');
    steps.push({ name: 'fmt', run: 'cargo fmt --check', fast: true }, { name: 'clippy', run: 'cargo clippy --all-targets -- -D warnings', timeoutSec: 3600 }, { name: 'test', run: 'cargo test', timeoutSec: 3600 });
  }
  if (has('go.mod')) {
    stack.push('go');
    setup.push('uses: actions/setup-go@v5\nwith:\n  go-version-file: go.mod');
    steps.push({ name: 'vet', run: 'go vet ./...', fast: true }, { name: 'test', run: 'go test ./...' });
  }
  if (!steps.length && has('Makefile')) {
    const mk = readText(join(root, 'Makefile')) ?? '';
    for (const t of ['lint', 'check', 'test']) if (new RegExp(`^${t}:`, 'm').test(mk)) steps.push({ name: t, run: `make ${t}`, fast: t !== 'test' });
  }
  return { steps: dedupe(steps), setup, stack };
}

/** @param {import('../../core/config.js').VerifyStep[]} steps */
function dedupe(steps) {
  const seen = new Set();
  return steps.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}
