import { spawn } from '../../core/proc.js';
import { git } from '../../core/git.js';
import { existsSync, mkdirSync, openSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CONFIG_FILE, recordEvent, statePath } from '../../core/state.js';
import { tail } from '../../core/text.js';
import { commands as boardCommands } from '../board/command.js';
import { post } from '../board/inbox.js';
import { readTask, readTasks, unlock } from '../board/store.js';
import { runGate } from '../gate/command.js';
import { runAgent } from './agent.js';
import { agentArgv } from './argv.js';
import { clip, failureBudget } from './budget.js';
import { gateFailures, log, runLoop } from './loop.js';
import { order, scaffoldIfUnverifiable } from './plan.js';
import { mergerPrompt } from './prompts.js';
import { overlaps } from './areas.js';

export { overlaps };
import { annotate } from './annotate.js';
import { addSeam, afterSeam, hotspot } from './seam.js';

export { hotspot };
import { learn } from '../learn/learn.js';
import { tasteSample } from './taste.js';
import { count, readStatus, setStatus } from './status.js';

const board = Object.fromEntries(boardCommands.map((c) => [c.name, c]));
/** Merge attempts (merger agent, then retry) before a step is blocked on a human. */
const MERGE_ATTEMPTS = 2;

/**
 * Which steps to start now: their deps landed and merged (a split step counts once all its parts did),
 * they overlap nothing running or waiting to merge, up to the worker limit, in plan order.
 * @param {import('../board/store.js').Task[]} tasks  one group
 * @param {{ running: string[], unmerged: string[], workers: number }} now
 */
export function pickReady(tasks, now) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  /** @param {string} id @returns {boolean} */
  const landed = (id) => {
    const t = byId.get(id);
    if (!t) return true; // removed from the board
    if (t.status !== 'done' || now.unmerged.includes(id)) return false;
    return (t.splitInto ?? []).every(landed);
  };
  const busy = tasks.filter((t) => now.running.includes(t.id) || now.unmerged.includes(t.id));
  /** @type {import('../board/store.js').Task[]} */
  const picked = [];
  for (const t of [...tasks].sort((a, b) => order(a) - order(b))) {
    if (busy.length + picked.length >= now.workers) break;
    if (now.running.includes(t.id)) continue;
    const open = t.status === 'todo' || (t.status === 'claimed' && t.agent?.startsWith('autopilot:'));
    if (!open || !(t.deps ?? []).every(landed)) continue;
    if ([...busy, ...picked].some((o) => overlaps(t.touches ?? [], o.touches ?? []))) continue;
    picked.push(t);
  }
  return picked;
}


/**
 * Why each open step that will not start now is waiting: an unmerged dep, a shared file, or no free worker.
 * @param {import('../board/store.js').Task[]} tasks
 * @param {{ running: string[], unmerged: string[], workers: number }} now
 * @returns {Record<string, string>} task id → reason
 */
export function waitReasons(tasks, now) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ready = new Set(pickReady(tasks, now).map((t) => t.id));
  const busy = tasks.filter((t) => now.running.includes(t.id) || now.unmerged.includes(t.id));
  /** @param {string} id @returns {boolean} */
  const landed = (id) => {
    const t = byId.get(id);
    return !t || (t.status === 'done' && !now.unmerged.includes(id) && (t.splitInto ?? []).every(landed));
  };
  /** @type {Record<string, string>} */
  const out = {};
  for (const t of tasks) {
    const open = t.status === 'todo' || (t.status === 'claimed' && t.agent?.startsWith('autopilot:'));
    if (!open || ready.has(t.id) || now.running.includes(t.id)) continue;
    const dep = (t.deps ?? []).find((d) => !landed(d));
    if (dep) {
      out[t.id] = `needs ${byId.get(dep)?.title ?? dep} merged`;
      continue;
    }
    const other = busy.find((o) => overlaps(t.touches ?? [], o.touches ?? []));
    if (other) {
      const shared = (t.touches ?? []).find((x) => overlaps([x], other.touches ?? [])) ?? 'files';
      out[t.id] = !t.touches?.length ? `does not say which files it changes, so it runs alone` : `shares ${shared} with ${other.title} (${now.running.includes(other.id) ? 'running' : 'merging'})`;
      continue;
    }
    out[t.id] = 'no free worker';
  }
  return out;
}


/**
 * Files git names when it refuses to start a merge because they would be overwritten.
 * @param {string} stderr
 */
export function overwritten(stderr) {
  const out = [];
  let inList = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/would be overwritten by merge:/.test(line)) inList = true;
    else if (inList && /^\s+\S/.test(line)) out.push(line.trim());
    else inList = false;
  }
  return out;
}

/** Split steps reuse their parent's worktree and branch, so a part continues the parent's work. @param {string} id */
const rootId = (id) => id.replace(/(-s\d+)+$/, '');

/**
 * Build a group's steps several at a time: each in its own git worktree and branch, by its own
 * `wololo autopilot --task` process, merged back into the main branch one at a time through the gate.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} group
 * @param {Omit<import('./loop.js').LoopOpts, 'goal' | 'task' | 'handoff'>} opts
 * @returns {Promise<import('../../core/types.js').Result>}
 */
export async function runParallel(ctx, group, opts) {
  const { root } = ctx;
  const workers = Math.max(1, ctx.config.autopilot.workers ?? 1);
  // Merger agents run here with a worktree as their root; their state must still land in the main repo.
  process.env.WOLOLO_STATE = statePath(root);
  process.env.WOLOLO_CONFIG = join(root, CONFIG_FILE);
  const all = () => readTasks(root).filter((t) => t.group === group).sort((a, b) => order(a) - order(b) || a.created.localeCompare(b.created));
  if (!all().length) return { ok: false, summary: `no tasks in group ${group}` };
  const main = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (!main || main === 'HEAD') return { ok: false, summary: 'parallel autopilot needs a checked-out branch to merge into (HEAD is detached)' };
  const trees = join(dirname(root), `.${basename(root)}-wololo-worktrees`);
  const entry = process.argv[1];

  /** @type {Map<string, { title: string, touches: string[], dir: string, started: string, done: Promise<void> }>} */
  const running = new Map();
  /** Steps that landed on their branch, in the order they finished. @type {string[]} */
  const unmerged = [];
  /** @type {Record<string, string>} */
  const mergeState = {};
  const details = [];

  /** @param {string} id */
  const branchOf = (id) => `wololo/${rootId(id)}`;
  /** @param {string} id */
  const dirOf = (id) => join(trees, rootId(id));
  const branchExists = (/** @type {string} */ b) => git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).status === 0;
  const mergedIntoMain = (/** @type {string} */ b) => git(root, ['merge-base', '--is-ancestor', b, main]).status === 0;

  /**
   * Reset a step's worktree to its branch when an interrupted merge (or merger) left it mid-way.
   * @param {string} dir
   */
  const clearUnfinishedMerge = (dir) => {
    if (!existsSync(dir)) return;
    const merging = git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0;
    const dirty = git(dir, ['status', '--porcelain']).stdout.trim();
    if (!merging && !dirty) return;
    if (merging) git(dir, ['merge', '--abort']);
    git(dir, ['reset', '-q', '--hard', 'HEAD']);
    git(dir, ['clean', '-fdq']);
    log(`cleared an unfinished merge in ${dir}: the step's committed work is kept, the merge starts over`);
  };

  /**
   * Commit the main checkout's uncommitted changes to tracked files (and the given untracked files).
   * @param {string} title  the step about to merge
   * @param {string[]} [paths]
   */
  const snapshot = (title, paths = []) => {
    if (paths.length) git(root, ['add', '--', ...paths]);
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']).stdout.split('\n').filter(Boolean);
    if (!dirty.length) return;
    const r = git(root, ['commit', '-q', '-a', '--no-verify', '-m', `autopilot: commit uncommitted changes in the main checkout before merging "${title}"`]);
    if (r.status === 0) {
      log(`committed ${dirty.length} uncommitted file(s) in the main checkout before merging ${title}: ${dirty.map((l) => l.slice(3)).slice(0, 6).join(', ')}${dirty.length > 6 ? ', …' : ''}`);
      post(root, group, { from: 'wololo', title: 'wololo', text: `committed ${dirty.length} uncommitted file(s) in the main checkout before merging "${title}"` });
    }
  };

  const publish = () => {
    writeFileSync(statePath(root, 'claims', `${group}.json`), JSON.stringify(Object.fromEntries([...running].map(([id, w]) => [id, { title: w.title, touches: w.touches }]))));
    setStatus(root, {
      group,
      parallel: { workers, main, running: [...running].map(([id, w]) => ({ id, title: w.title, started: w.started, dir: w.dir })), queue: unmerged.map((id) => ({ id, title: readTask(root, id)?.title ?? id, state: mergeState[id] ?? 'waiting' })), waiting: waitReasons(all(), { running: [...running.keys()], unmerged, workers }), hotspot: hotspot(all()) },
    });
  };
  mkdirSync(statePath(root, 'claims'), { recursive: true });
  mkdirSync(statePath(root, 'workers'), { recursive: true });

  // A run that stopped mid-way may have left steps landed on their branch but not merged.
  for (const t of all()) if (t.status === 'done' && !t.splitInto && branchExists(branchOf(t.id)) && !mergedIntoMain(branchOf(t.id))) unmerged.push(t.id);
  // ...and a merger stopped while merging main into a step's worktree leaves conflicts and scratch
  // files there. The step's own work is all committed on its branch: go back to that, merge again.
  for (const id of unmerged) clearUnfinishedMerge(dirOf(id));

  /** @param {import('../board/store.js').Task} t */
  const start = (t) => {
    const dir = dirOf(t.id);
    const branch = branchOf(t.id);
    if (!existsSync(dir)) {
      mkdirSync(trees, { recursive: true });
      const r = branchExists(branch) ? git(root, ['worktree', 'add', dir, branch]) : git(root, ['worktree', 'add', '-b', branch, dir, main]);
      if (r.status !== 0) {
        log(`could not create a worktree for ${t.id}: ${tail(r.stderr, 3)}`);
        void board['task block'].run({ id: t.id, on: 'human', reason: `autopilot: could not create its git worktree: ${tail(r.stderr, 2)}` }, ctx);
        return;
      }
      // Installed dependencies are not in git: share them instead of reinstalling per worktree.
      for (const deps of ['node_modules']) if (existsSync(join(root, deps)) && !existsSync(join(dir, deps))) symlinkSync(join(root, deps), join(dir, deps), 'junction');
    }
    if (t.status === 'claimed') unlock(root, t.id);
    const env = {
      ...process.env,
      WOLOLO_WORKER: t.id,
      WOLOLO_GROUP: group,
      WOLOLO_STATE: statePath(root),
      WOLOLO_CONFIG: join(root, CONFIG_FILE),
      WOLOLO_DETACHED: '1',
      // ponytail: one shared cargo build dir (cargo locks it, so builds take turns instead of each worktree compiling everything)
      ...(existsSync(join(root, 'Cargo.toml')) && !process.env.CARGO_TARGET_DIR ? { CARGO_TARGET_DIR: join(root, 'target') } : {}),
    };
    const out = openSync(statePath(root, 'workers', `${t.id}.log`), 'a');
    const args = [entry, 'autopilot', '--task', t.id, '--agent', opts.agent, '--max', String(opts.max), '--verifiers', String(opts.focuses.length)];
    const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ['ignore', out, out], windowsHide: true });
    const started = new Date().toISOString();
    const done = new Promise((resolve) => child.on('close', () => resolve(undefined))).then(() => finished(t.id));
    running.set(t.id, { title: t.title, touches: t.touches ?? [], dir, started, done });
    log(`worker started: ${t.title} (${t.id}) in ${dir}`);
    post(root, group, { from: 'wololo', title: 'wololo', text: `started "${t.title}" (${t.id})${t.touches?.length ? `, changing ${t.touches.join(', ')}` : ''}` });
    publish();
  };

  /** @param {string} id */
  const finished = (id) => {
    running.delete(id);
    // fold the worker's counters into the run's
    const ws = readStatus(root, id);
    for (const [k, n] of Object.entries(ws?.stats ?? {})) count(root, k, n);
    const t = readTask(root, id);
    if (t?.status === 'done' && !t.splitInto) {
      unmerged.push(id);
      log(`worker landed ${t.title} on ${branchOf(id)}; queued to merge`);
    } else log(`worker for ${id} stopped (${t?.status ?? 'gone'}${t?.splitInto ? ', split' : ''})`);
    publish();
  };

  /** @param {string} id @returns {Promise<boolean>} */
  const mergeOne = async (id) => {
    const t = /** @type {import('../board/store.js').Task} */ (readTask(root, id));
    const branch = branchOf(id);
    const dir = dirOf(id);
    /** @param {string} s */
    const state = (s) => {
      mergeState[id] = s;
      publish();
    };
    for (let attempt = 0; attempt <= MERGE_ATTEMPTS; attempt++) {
      state(attempt ? `merging (attempt ${attempt + 1})` : 'merging');
      // Uncommitted work in the main checkout (a settings change, files a build regenerated) is
      // committed first, so neither the merge nor undoing it can touch it.
      snapshot(t.title);
      const merge = () => git(root, ['merge', '--no-ff', '--no-edit', '-m', `Merge "${t.title}" (autopilot, parallel)`, branch]);
      let m = merge();
      // git refuses to start when the branch adds a file that exists untracked here: include those files too
      const blocking = overwritten(m.stderr ?? '');
      if (m.status !== 0 && blocking.length) {
        snapshot(t.title, blocking);
        m = merge();
      }
      const before = git(root, ['rev-parse', 'HEAD^1']).stdout.trim();
      /** @type {{ conflicts: string[], failures?: string } | null} */
      let problem = null;
      if (m.status !== 0 && git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status !== 0) {
        // the merge never started and committing local changes did not help: nothing an agent can fix
        state(`could not start the merge: ${tail(m.stderr ?? '', 2)}`);
        log(`could not start merging ${t.title}: ${tail(m.stderr ?? '', 4)}`);
        break;
      }
      if (m.status !== 0) {
        const conflicts = git(root, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
        git(root, ['merge', '--abort']);
        problem = { conflicts };
      } else {
        state('gate on the merged result');
        const gate = await runGate(ctx);
        if (!gate.ok) {
          git(root, ['reset', '--hard', before]); // uncommitted work was committed before the merge: this only undoes the merge
          problem = { conflicts: [], failures: clip(gateFailures(gate), failureBudget(ctx.config.autopilot.contextWindow)) };
        }
      }
      if (!problem) {
        git(root, ['worktree', 'remove', '--force', dir]);
        git(root, ['branch', '-D', branch]);
        await board['task note'].run({ id, note: `autopilot: merged into ${main}` }, ctx);
        post(root, group, { from: 'wololo', title: 'wololo', text: `"${t.title}" (${id}) is merged into ${main}${t.touches?.length ? ` (changed ${t.touches.join(', ')})` : ''}. If your step uses it, run \`git merge ${main}\` in your worktree.` });
        recordEvent(root, { type: 'merge', ok: true, task: id, attempts: attempt + 1 });
        count(root, 'merged');
        log(`merged ${t.title} into ${main}`);
        return true;
      }
      if (attempt === MERGE_ATTEMPTS) break;
      // Bring main into the branch, in its worktree, and let an agent make both sides work.
      state(problem.conflicts.length ? `conflict in ${problem.conflicts.length} file(s): merger agent` : 'merged result fails the gate: merger agent');
      log(`${t.title}: ${problem.conflicts.length ? `conflicts in ${problem.conflicts.join(', ')}` : 'merged result fails the gate'}; a merger agent reconciles it with ${main}`);
      const landed = git(dir, ['log', '--format=%s', `${branch}..${main}`]).stdout.split('\n').filter(Boolean).slice(0, 10);
      clearUnfinishedMerge(dir);
      const inTree = git(dir, ['merge', '--no-edit', main]);
      const conflicts = inTree.status === 0 ? [] : git(dir, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
      const wctx = { ...ctx, root: dir };
      await runAgent(wctx, agentArgv(ctx.config, opts.agent, mergerPrompt(ctx.config.bin, { title: t.title, main, conflicts, failures: problem.failures, landed }), { root: dir }), `merger · ${t.title}`, log);
      if (existsSync(join(dir, '.git')) && git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0) {
        git(dir, ['merge', '--abort']);
        continue; // the merger did not finish the merge: the next attempt starts over
      }
      // gate green in the worktree before trying main again (fixer loop, no verifiers)
      await runLoop(wctx, { agent: opts.agent, focuses: [], max: opts.max });
    }
    recordEvent(root, { type: 'merge', ok: false, task: id });
    await board['task block'].run({ id, on: 'human', reason: `autopilot: could not merge into ${main} after ${MERGE_ATTEMPTS + 1} attempts; the branch ${branch} and worktree ${dir} are kept` }, ctx);
    log(`could not merge ${t.title}; blocked on a human`);
    return false;
  };

  // steps that never said what they need or change would each run alone
  await annotate(ctx, opts.agent, group);
  const seam = addSeam(root, group);
  if (seam) log(`${seam.touches?.[0]} is changed by most remaining steps, so they would run one at a time; added "${seam.title}" first`);
  for (let pass = 0; ; pass++) {
    scaffoldIfUnverifiable(ctx, group, all(), pass === 0);
    for (const t of pickReady(all(), { running: [...running.keys()], unmerged, workers })) start(t);
    publish();
    if (unmerged.length) {
      const id = unmerged[0];
      const ok = await mergeOne(id);
      unmerged.shift();
      delete mergeState[id];
      const t = readTask(root, id);
      details.push(`${t?.title ?? id}: ${ok ? 'merged' : 'could not merge'}`);
      if (ok) {
        // a seam landed: its dependents list their files again, now against the registry
        if (afterSeam(root, group)) await annotate(ctx, opts.agent, group);
        await learn(ctx, opts.agent, log);
        tasteSample(root, log);
      }
      publish();
      continue;
    }
    if (!running.size) break;
    await Promise.race([...running.values()].map((w) => w.done));
  }

  const tasks = all();
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const done = tasks.filter((t) => t.status === 'done').length;
  setStatus(root, { parallel: { workers, main, running: [], queue: [] } });
  if (blocked.length) {
    const lines = blocked.map((b) => `  ${b.title} (${b.id}): ${b.notes.findLast((n) => n.includes(' blocked: '))?.split(' blocked: ')[1] ?? `blocked on ${b.blockedOn}`}`);
    return { ok: false, summary: [`${done}/${tasks.length} step(s) landed in ${group}; ${blocked.length} blocked:`, ...lines, `  retry or skip them on the TUI's Board tab, then resume the group`].join('\n'), details, data: { group } };
  }
  const left = tasks.filter((t) => t.status !== 'done');
  if (left.length) return { ok: false, summary: `${done}/${tasks.length} step(s) landed in ${group}; ${left.length} can never start (their deps are missing or blocked): ${left.map((t) => t.title).join('; ')}`, details, data: { group } };
  return { ok: true, summary: `${done}/${tasks.length} step(s) landed in ${group} (${workers} workers)`, details, data: { group } };
}
