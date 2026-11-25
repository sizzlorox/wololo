import { git } from './git.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { matchAny } from './glob.js';

/** @param {string} p */
export function toPosix(p) {
  return p.split(sep).join('/');
}

/**
 * @param {string} path
 * @returns {string | undefined}
 */
export function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Atomic write (temp + rename) so concurrent agents never read half-written state.
 * @param {string} path
 * @param {string} content
 */
export function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  // Windows refuses a rename for a moment while antivirus, the indexer or a reader holds either
  // file (EPERM/EBUSY/EACCES): retry, then write in place rather than lose the write.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw e;
      if (attempt < 5) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        continue;
      }
      writeFileSync(path, content);
      rmSync(tmp, { force: true });
      return;
    }
  }
}

/**
 * @template T
 * @param {string} path
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(path, fallback) {
  const text = readText(path);
  if (text === undefined) return fallback;
  return JSON.parse(text);
}

/**
 * @param {string} path
 * @param {unknown} value
 */
export function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} path
 * @param {unknown} value
 */
export function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

/**
 * @param {string} path
 * @returns {any[]}
 */
export function readJsonl(path) {
  const text = readText(path);
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn line from a crashed writer must not poison the whole log.
    }
  }
  return out;
}

/** @param {string} dir */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/**
 * Repo files, relative and posix. Uses git when available so .gitignore is respected.
 * @param {string} root
 * @param {string[]} ignore
 */
export function listFiles(root, ignore) {
  const listed = git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
  const files =
    listed.status === 0
      ? listed.stdout.split('\0').filter(Boolean)
      : walk(root, root);
  return files.filter((f) => !matchAny(f, ignore) && existsSync(join(root, f))).sort();
}

/**
 * @param {string} root
 * @param {string} dir
 * @returns {string[]}
 */
export function walk(root, dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(root, full));
    else if (e.isFile()) out.push(toPosix(relative(root, full)));
  }
  return out;
}

/**
 * Files changed in the working tree (staged, unstaged, untracked).
 * @param {string} root
 */
export function changedFiles(root) {
  const r = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (r.status !== 0) return [];
  return r.stdout
    .split('\0')
    .filter(Boolean)
    .filter((e) => /^.. /.test(e))
    .map((e) => e.slice(3))
    .filter((f) => existsSync(join(root, f)));
}
