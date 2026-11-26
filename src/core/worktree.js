// The one way to remove a git worktree (rule: worktree-via-core).
import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.js';

/**
 * Remove a worktree without touching what its links point to.
 *
 * Parallel worktrees link node_modules to the main repo's (a junction on Windows), and
 * `git worktree remove --force` follows junctions: it emptied the main repo's node_modules on
 * every merge. So links are unlinked first; then git removes the worktree, and whatever Windows
 * left behind goes too (fs.rmSync does not follow junctions).
 * @param {string} root  the main repo
 * @param {string} dir   the worktree
 */
export function removeWorktree(root, dir) {
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (lstatSync(p).isSymbolicLink()) unlinkSync(p); // junctions report as symbolic links
      } catch {
        // gone already
      }
    }
  }
  git(root, ['worktree', 'remove', '--force', dir]);
  rmSync(dir, { recursive: true, force: true });
  git(root, ['worktree', 'prune']);
}
