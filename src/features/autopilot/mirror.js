import { copyFileSync, existsSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Never mirrored: repos get worktrees; these are per checkout or huge. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target']);

/**
 * A workspace step folder holds a worktree per repo. Give it the workspace's own files too, so the
 * agent working there sees what it would at the workspace root: AGENTS.md, CLAUDE.md, .mcp.json,
 * .claude/, .omp/, docs/. Folders are linked (junctions: no admin rights needed on Windows), files
 * are copied. removeWorktree unlinks the links before deleting the folder.
 * @param {string} root  the workspace
 * @param {string} dir   the step folder
 * @param {string[]} repos  folders that are repos: they already have worktrees here
 */
export function mirrorWorkspace(root, dir, repos) {
  for (const name of readdirSync(root)) {
    if (SKIP.has(name) || repos.includes(name) || name === 'wololo.config.json') continue; // the config is read through WOLOLO_CONFIG
    const from = join(root, name);
    const to = join(dir, name);
    if (existsSync(to)) continue;
    try {
      if (statSync(from).isDirectory()) symlinkSync(from, to, 'junction');
      else copyFileSync(from, to);
    } catch {
      // not worth stopping a step for
    }
  }
}
