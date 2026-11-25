// Route `spawnSync('git', args, { cwd, encoding, maxBuffer })` calls through src/core/git.js.
// Lines that define a local `git` (a helper or a variable named git) are left for a hand edit:
// rewriting them would shadow the import.
import { posix } from 'node:path';

export const description = "Replace spawnSync('git', …) with git(cwd, args) from src/core/git.js";

/** Globs (repo-relative) this codemod may touch. */
export const files = ['src/**/*.js'];

const CALL = /spawnSync\('git', (\[[^\]]*\]|\w+), \{ cwd(?:: (\w+))?(?:, encoding: 'utf8')?(?:, maxBuffer: [^}]+)? \}\)/g;

/**
 * @param {string} source
 * @param {{ path: string }} info
 */
export function transform(source, info) {
  const path = info.path.replace(/\\/g, '/');
  if (path === 'src/core/git.js' || path === 'src/core/proc.js') return undefined;
  let changed = false;
  let next = source
    .split('\n')
    .map((line) => {
      if (/^\s*const git = /.test(line)) return line;
      const out = line.replace(CALL, (_m, args, cwd) => `git(${cwd ?? 'cwd'}, ${args})`);
      if (out !== line) changed = true;
      return out;
    })
    .join('\n');
  if (!changed) return undefined;
  let rel = posix.relative(posix.dirname(path), 'src/core/git.js');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  if (!/import \{[^}]*\bgit\b[^}]*\} from '[^']*core\/git\.js'/.test(next) && !next.includes("from './git.js'")) {
    next = next.replace(/^(import [^\n]+\n)/, `$1import { git } from '${rel}';\n`);
  }
  // drop spawnSync from the proc import once nothing uses it
  if (!/spawnSync\(/.test(next.replace(/^import [^\n]+$/gm, ''))) {
    next = next.replace(/import \{ spawn, spawnSync \} from ('[^']*proc\.js');/, 'import { spawn } from $1;').replace(/^import \{ spawnSync \} from '[^']*proc\.js';\n/m, '');
  }
  return next;
}
