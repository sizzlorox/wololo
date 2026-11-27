// One repo, or a workspace: a folder that is not a repo but holds repos (e.g. frontend/ and backend/).
// Autopilot asks git questions through here, so both look the same to it. Paths and commit subjects
// from a workspace are prefixed with their repo ("frontend/src/login.tsx", "backend: feat: auth").
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { git, gitOut } from './git.js';
import { shortHash } from './text.js';

/** Folders never searched for repos. */
const SKIP = new Set(['node_modules', '.git', '.wololo', 'dist', 'build', 'target', 'vendor', '.venv']);

/**
 * The repos autopilot works in: ['.'] when root is a repo, else the child folders that are repos
 * (one level down), sorted. [] when there are none.
 * @param {string} root
 */
export function listRepos(root) {
  // a .git (folder, or a worktree's file) here or above answers without starting git; the TUI asks every frame
  for (let d = resolve(root); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return ['.'];
    if (dirname(d) === d) break;
  }
  if (!existsSync(root)) return [];
  const children = readdirSync(root)
    .filter((d) => !SKIP.has(d) && !d.startsWith('.'))
    .filter((d) => {
      try {
        return statSync(join(root, d)).isDirectory() && existsSync(join(root, d, '.git'));
      } catch {
        return false;
      }
    })
    .sort();
  // neither: git may still know better (GIT_DIR set, a .git it reaches some other way)
  return children.length || git(root, ['rev-parse', '--show-toplevel']).status !== 0 ? children : ['.'];
}

/** @param {string} root */
export const isWorkspace = (root) => {
  const r = listRepos(root);
  return r.length > 0 && r[0] !== '.';
};

/** @param {string} root @param {string} repo */
export const repoDir = (root, repo) => (repo === '.' ? root : join(root, repo));

/** @param {string} repo @param {string} path */
const prefixed = (repo, path) => (repo === '.' ? path : `${repo}/${path}`);

/**
 * Where every repo is now: a sha for one repo, a JSON map for a workspace. Opaque to callers.
 * @param {string} root
 */
export function heads(root) {
  const repos = listRepos(root);
  if (repos.length === 1 && repos[0] === '.') return gitOut(root, ['rev-parse', 'HEAD']);
  return JSON.stringify(Object.fromEntries(repos.map((r) => [r, gitOut(repoDir(root, r), ['rev-parse', 'HEAD'])])));
}

/** @param {string} base @returns {Record<string, string>} */
export function parseBase(base) {
  if (!base) return {};
  if (base.startsWith('{')) {
    try {
      return JSON.parse(base);
    } catch {
      return {};
    }
  }
  return { '.': base };
}

/**
 * Everything as it is now (committed trees plus uncommitted changes), as one hash: changes in any
 * repo change it, and restoring an earlier state restores the hash.
 * @param {string} root
 */
export function snapshot(root) {
  return shortHash(listRepos(root).map((r) => {
    const d = repoDir(root, r);
    return `${r}\n${gitOut(d, ['rev-parse', 'HEAD^{tree}'])}${gitOut(d, ['status', '--porcelain'])}${gitOut(d, ['diff', 'HEAD'])}`;
  }).join('\n'));
}

/**
 * Uncommitted files, `git status --short` style ("XY path"), paths prefixed by repo. .wololo is left out.
 * @param {string} root
 */
export function dirty(root) {
  return listRepos(root).flatMap((r) =>
    gitOut(repoDir(root, r), ['status', '--short', '--untracked-files=all', '--', '.', ':(exclude).wololo'])
      .split('\n')
      .filter(Boolean)
      .map((l) => `${l.slice(0, 3)}${prefixed(r, l.slice(3))}`),
  );
}

/**
 * Commit subjects since `base`, newest first per repo, prefixed by repo in a workspace.
 * @param {string} root @param {string} base
 */
export function commitsSince(root, base) {
  const b = parseBase(base);
  return Object.entries(b).flatMap(([r, sha]) =>
    gitOut(repoDir(root, r), ['log', '--format=%s', `${sha}..HEAD`])
      .split('\n')
      .filter(Boolean)
      .map((s) => (r === '.' ? s : `${r}: ${s}`)),
  );
}

/**
 * Files changed since `base`, committed or not (untracked included), prefixed by repo.
 * @param {string} root @param {string} base
 */
export function changedSince(root, base) {
  const b = parseBase(base);
  return Object.entries(b).flatMap(([r, sha]) => {
    const d = repoDir(root, r);
    const files = [...gitOut(d, ['diff', '--name-only', sha]).split('\n'), ...gitOut(d, ['ls-files', '--others', '--exclude-standard']).split('\n')].filter(Boolean);
    return [...new Set(files)].map((f) => prefixed(r, f));
  });
}

/**
 * Commit each repo's changes (.wololo/state excluded). Returns the repos that got a commit.
 * @param {string} root @param {string} message
 */
export function commitAll(root, message) {
  const done = [];
  for (const r of listRepos(root)) {
    const d = repoDir(root, r);
    if (!gitOut(d, ['status', '--porcelain', '--', '.', ':(exclude).wololo/state'])) continue;
    git(d, ['add', '-A', '--', '.', ':(exclude).wololo/state']);
    if (git(d, ['commit', '-q', '--no-verify', '-m', message]).status === 0) done.push(r);
  }
  return done;
}

/**
 * Put every repo back to `base` (a heads() value), dropping changes since. For undoing an attempt.
 * @param {string} root @param {string} base
 */
export function resetTo(root, base) {
  for (const [r, sha] of Object.entries(parseBase(base))) {
    const d = repoDir(root, r);
    git(d, ['reset', '-q', '--hard', sha]);
    git(d, ['clean', '-fdq']); // .wololo/state is gitignored: clean leaves it
  }
}

/** How to see the change since `base`, for a prompt. @param {string} base */
export function diffHint(base) {
  const b = parseBase(base);
  const entries = Object.entries(b);
  if (entries.length === 1 && entries[0][0] === '.') return `\`git diff ${entries[0][1]}\``;
  return entries.map(([r, sha]) => `in ${r}: \`git diff ${sha.slice(0, 12)}\``).join(', ');
}
