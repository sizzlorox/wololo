import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { git, gitOut } from '../../core/git.js';
import { rotate } from '../../core/rotate.js';
import { statePath } from '../../core/state.js';
import { readTasks } from '../board/store.js';

const MB = 1024 * 1024;
const HOUR = 3600_000;

/**
 * Housekeeping for .wololo/state and parallel worktrees: bounded, idempotent, and never touches
 * work that is running or not merged.
 * - logs over maxLogMB rotate (log → log.1 … log.3, oldest dropped)
 * - transcripts are capped by total size, oldest first (usage records stay: they are tiny)
 * - temp files older than an hour, locks nobody holds, finished workers' files go
 * - worktrees and wololo/* branches already merged into the current branch go
 * @param {string} root
 * @param {{ dryRun?: boolean, maxRunsMB?: number, maxLogMB?: number, worktrees?: boolean }} [opts]
 * @returns {{ freed: number, actions: string[] }}
 */
export function clean(root, opts = {}) {
  const { dryRun = false, maxRunsMB = 100, maxLogMB = 5, worktrees = true } = opts;
  /** @type {string[]} */
  const actions = [];
  let freed = 0;
  const size = (/** @type {string} */ f) => {
    try {
      return statSync(f).size;
    } catch {
      return 0;
    }
  };
  /** @param {string} f @param {string} why */
  const remove = (f, why) => {
    const n = statSync(f).isDirectory() ? 0 : size(f);
    actions.push(`${dryRun ? 'would remove' : 'removed'} ${f.slice(root.length + 1) || f} (${why})`);
    freed += n;
    if (!dryRun) rmSync(f, { recursive: true, force: true });
  };
  const ls = (/** @type {string} */ dir) => (existsSync(dir) ? readdirSync(dir) : []);
  const state = statePath(root);

  // logs: rotate, keeping 3 older generations (log.1 newest)
  const logs = ['autopilot.log', 'autopilot.out', 'agent-stream.log', 'events.jsonl'].map((f) => join(state, f)).concat(ls(join(state, 'workers')).filter((f) => f.endsWith('.log')).map((f) => join(state, 'workers', f)));
  for (const f of logs) {
    if (size(f) <= maxLogMB * MB) continue;
    actions.push(`${dryRun ? 'would rotate' : 'rotated'} ${f.slice(root.length + 1)} (${(size(f) / MB).toFixed(1)}MB → ${basename(f)}.1)`);
    if (!dryRun) freed += rotate(f, maxLogMB * MB);
  }

  // transcripts: newest first, until the size cap
  const runsDir = join(state, 'runs');
  let total = 0;
  for (const f of ls(runsDir).filter((x) => x.endsWith('.jsonl')).sort().reverse()) {
    total += size(join(runsDir, f));
    if (total > maxRunsMB * MB) remove(join(runsDir, f), `transcripts over ${maxRunsMB}MB`);
  }

  // stale temp files, anywhere in state
  /** @param {string} dir @returns {string[]} */
  const tmps = (dir) => ls(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tmps(p) : f.endsWith('.tmp') ? [p] : [];
  });
  for (const f of tmps(state)) if (Date.now() - statSync(f).mtimeMs > HOUR) remove(f, 'stale temp file');

  // locks and worker files for steps no one is building
  const tasks = new Map(readTasks(root).map((t) => [t.id, t]));
  for (const f of ls(join(state, 'board')).filter((x) => x.endsWith('.lock'))) {
    const t = tasks.get(f.slice(0, -5));
    if (!t || t.status !== 'claimed') remove(join(state, 'board', f), 'lock nobody holds');
  }
  for (const f of ls(join(state, 'workers'))) {
    const t = tasks.get(f.replace(/\.(log|json)$/, ''));
    if (!t || t.status === 'done') remove(join(state, 'workers', f), 'finished worker');
  }
  for (const f of ls(join(state, 'inbox')).filter((x) => /\.(cursor|warned\.json)$/.test(x))) {
    const t = tasks.get(f.replace(/\.(cursor|warned\.json)$/, ''));
    if (!t || t.status === 'done') remove(join(state, 'inbox', f), 'finished worker');
  }

  // merged worktrees and branches
  if (worktrees) {
    if (!dryRun) git(root, ['worktree', 'prune']);
    const trees = join(dirname(root), `.${basename(root)}-wololo-worktrees`);
    for (const branch of gitOut(root, ['branch', '--list', 'wololo/*', '--format=%(refname:short)']).split('\n').filter(Boolean)) {
      if (git(root, ['merge-base', '--is-ancestor', branch, 'HEAD']).status !== 0) continue; // unmerged work: never
      const id = branch.slice('wololo/'.length);
      const dir = join(trees, id);
      // A step that just started has a branch with no commits yet: "merged" to git, but running.
      // Only a finished (or removed) step's worktree goes, and never one with uncommitted files.
      const t = tasks.get(id);
      if (t && t.status !== 'done') continue;
      if (existsSync(dir) && gitOut(dir, ['status', '--porcelain'])) continue;
      actions.push(`${dryRun ? 'would remove' : 'removed'} merged worktree and branch ${branch}`);
      if (dryRun) continue;
      if (existsSync(dir)) git(root, ['worktree', 'remove', '--force', dir]);
      git(root, ['branch', '-D', branch]);
    }
  }
  return { freed, actions };
}
