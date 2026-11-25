// Route every child process through src/core/proc.js, which starts children with windowsHide.
import { posix } from 'node:path';

export const description = "Import spawn/spawnSync from src/core/proc.js instead of node:child_process";

/** Globs (repo-relative) this codemod may touch. */
export const files = ['src/**/*.js'];

/** proc.js itself; omp.js only has the import inside a template for omp's own hook. */
const SKIP = new Set(['src/core/proc.js', 'src/adapters/omp.js']);

/**
 * @param {string} source
 * @param {{ path: string }} info
 */
export function transform(source, info) {
  const path = info.path.replace(/\\/g, '/');
  if (SKIP.has(path)) return undefined;
  let rel = posix.relative(posix.dirname(path), 'src/core/proc.js');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  const next = source.replace(/^(import \{[^}]*\} from )'node:child_process';$/gm, `$1'${rel}';`);
  return next === source ? undefined : next;
}
