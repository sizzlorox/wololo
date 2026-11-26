import { spawn } from '../../core/proc.js';
import { git, gitOut } from '../../core/git.js';
import { heads, listRepos, repoDir, resetTo } from '../../core/repos.js';
import { mirrorWorkspace } from './mirror.js';
import { removeWorktree } from '../../core/worktree.js';
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
import { overwritten, pickReady, waitReasons } from './schedule.js';

export { overlaps, overwritten, pickReady, waitReasons };
import { annotate } from './annotate.js';
import { addSeam, afterSeam, hotspot } from './seam.js';
import { ensureBranch, protectedHere, repoBases } from './branch.js';

export { hotspot };
import { learn } from '../learn/learn.js';
import { tasteSample } from './taste.js';
import { count, readStatus, setStatus } from './status.js';

const board = Object.fromEntries(boardCommands.map((c) => [c.name, c]));
/** Merge attempts (merger agent, then retry) before a step is blocked on a human. */
const MERGE_ATTEMPTS = 2;

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
  // Steps merge into the checked-out branch. On a detached HEAD, make one for this plan, named
  // the way the repo names branches (feature/…, fix/…), so the work lands somewhere you can find.
  const goal = all().find((t) => t.goal)?.goal ?? group;
  const on = ensureBranch(root, goal, { key: group, patterns: ctx.config.autopilot.protectedBranches, bases: repoBases(ctx.config) });
  if ('error' in on) return { ok: false, summary: `parallel autopilot never merges into a protected branch: ${on.error}` };
  if (on.created || on.switched) log(`steps merge into ${on.branch}`);
  // One repo, or each repo of a workspace (frontend/, backend/): every step gets a worktree per repo.
  const repos = listRepos(root);
  const mainOf = (/** @type {string} */ r) => gitOut(repoDir(root, r), ['rev-parse', '--abbrev-ref', 'HEAD']);
  const mains = () => repos.map((r) => (r === '.' ? mainOf(r) : `${mainOf(r)} (${r})`)).join(', ');
  const main = mains();
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
  /** The folder a step's worker runs in. @param {string} id */
  const dirOf = (id) => join(trees, rootId(id));
  /** A step's worktree of one repo: the step folder itself for a single repo. @param {string} id @param {string} r */
  const wt = (id, r) => (r === '.' ? dirOf(id) : join(dirOf(id), r));
  const branchExists = (/** @type {string} */ r, /** @type {string} */ b) => git(repoDir(root, r), ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).status === 0;
  /** The step's branch has commits its repo's branch does not. @param {string} r @param {string} b */
  const ahead = (r, b) => branchExists(r, b) && Number(gitOut(repoDir(root, r), ['rev-list', '--count', `HEAD..${b}`])) > 0;

  /** A merged step's worktrees, folder and branches go. @param {string} id */
  const removeStep = (id) => {
    for (const r of repos) {
      removeWorktree(repoDir(root, r), wt(id, r));
      git(repoDir(root, r), ['branch', '-D', branchOf(id)]);
    }
    if (repos[0] !== '.') removeWorktree(root, dirOf(id)); // the step folder: unlinks the mirrored workspace files first
  };

  /**
   * Reset a step's worktree to its branch when an interrupted merge (or merger) left it mid-way.
   * @param {string} dir
   */
  const clearUnfinishedMerge = (dir) => {
    if (!existsSync(join(dir, '.git'))) return;
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
    for (const r of repos) {
      const d = repoDir(root, r);
      const mine = paths.filter((p) => r === '.' || p.startsWith(`${r}/`)).map((p) => (r === '.' ? p : p.slice(r.length + 1)));
      if (mine.length) git(d, ['add', '--', ...mine]);
      const dirty = git(d, ['status', '--porcelain', '--untracked-files=no']).stdout.split('\n').filter(Boolean);
      if (!dirty.length) continue;
      const where = r === '.' ? 'the main checkout' : `${r}`;
      const c = git(d, ['commit', '-q', '-a', '--no-verify', '-m', `autopilot: commit uncommitted changes in ${where} before merging "${title}"`]);
      if (c.status === 0) {
        log(`committed ${dirty.length} uncommitted file(s) in ${where} before merging ${title}: ${dirty.map((l) => l.slice(3)).slice(0, 6).join(', ')}${dirty.length > 6 ? ', …' : ''}`);
        post(root, group, { from: 'wololo', title: 'wololo', text: `committed ${dirty.length} uncommitted file(s) in ${where} before merging "${title}"` });
      }
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
  for (const t of all()) if (t.status === 'done' && !t.splitInto && repos.some((r) => ahead(r, branchOf(t.id)))) unmerged.push(t.id);
  // ...and a merger stopped while merging main into a step's worktree leaves conflicts and scratch
  // files there. The step's own work is all committed on its branch: go back to that, merge again.
  for (const id of unmerged) for (const r of repos) clearUnfinishedMerge(wt(id, r));

  /** @param {import('../board/store.js').Task} t */
  const start = (t) => {
    const dir = dirOf(t.id);
    const branch = branchOf(t.id);
    for (const r of repos) {
      const w = wt(t.id, r);
      // A folder left behind is not a worktree: Windows can keep a removed worktree's folder (a process
      // still had a file open), and a worker started in it works outside git, in the main checkout.
      if (existsSync(w) && gitOut(w, ['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) {
        log(`${w} is left over and is not the ${branch} worktree; recreating it`);
        removeWorktree(repoDir(root, r), w);
      }
      if (existsSync(w)) continue;
      mkdirSync(r === '.' ? trees : dir, { recursive: true });
      const res = branchExists(r, branch) ? git(repoDir(root, r), ['worktree', 'add', w, branch]) : git(repoDir(root, r), ['worktree', 'add', '-b', branch, w, 'HEAD']);
      if (res.status !== 0) {
        log(`could not create a worktree for ${t.id}${r === '.' ? '' : ` in ${r}`}: ${tail(res.stderr, 3)}`);
        void board['task block'].run({ id: t.id, on: 'human', reason: `autopilot: could not create its git worktree: ${tail(res.stderr, 2)}` }, ctx);
        return;
      }
      // Installed dependencies are not in git: share them instead of reinstalling per worktree.
      const deps = join(repoDir(root, r), 'node_modules');
      if (existsSync(deps) && !existsSync(join(w, 'node_modules'))) symlinkSync(deps, join(w, 'node_modules'), 'junction');
    }
    if (repos[0] !== '.') mirrorWorkspace(root, dir, repos);
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
    /** What went wrong on the last attempt, for the human who has to finish it. */
    let last = '';
    for (let attempt = 0; attempt <= MERGE_ATTEMPTS; attempt++) {
      const guard = protectedHere(root, ctx.config.autopilot.protectedBranches);
      if (guard) {
        state(guard);
        log(`${t.title}: ${guard}`);
        break;
      }
      state(attempt ? `merging (attempt ${attempt + 1})` : 'merging');
      // Uncommitted work in the main checkout (a settings change, files a build regenerated) is
      // committed first, so neither the merge nor undoing it can touch it.
      snapshot(t.title);
      const before = heads(root);
      /** @type {{ conflicts: string[], failures?: string } | null} */
      let problem = null;
      let refused = '';
      for (const r of repos.filter((x) => ahead(x, branch))) {
        const d = repoDir(root, r);
        const merge = () => git(d, ['merge', '--no-ff', '--no-edit', '-m', `Merge "${t.title}" (autopilot, parallel)`, branch]);
        let m = merge();
        // git refuses to start when the branch adds a file that exists untracked here: include those files too
        const blocking = overwritten(m.stderr ?? '');
        if (m.status !== 0 && blocking.length) {
          snapshot(t.title, blocking.map((f) => (r === '.' ? f : `${r}/${f}`)));
          m = merge();
        }
        if (m.status === 0) continue;
        if (git(d, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status !== 0) {
          refused = `${r === '.' ? '' : `${r}: `}${tail(m.stderr ?? '', 2)}`;
          break;
        }
        const conflicts = git(d, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean).map((f) => (r === '.' ? f : `${r}/${f}`));
        git(d, ['merge', '--abort']);
        problem = { conflicts };
        break;
      }
      if (refused || problem) resetTo(root, before); // a step lands in every repo or in none
      if (problem) last = problem.conflicts.length ? `conflicts in ${problem.conflicts.slice(0, 5).join(', ')}${problem.conflicts.length > 5 ? ', …' : ''}` : `the merged result fails the gate (${(problem.failures ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join('; ').slice(0, 160)})`;
      if (refused) last = `git would not start the merge: ${refused}`;
      if (refused) {
        // the merge never started and committing local changes did not help: nothing an agent can fix
        state(`could not start the merge: ${refused}`);
        log(`could not start merging ${t.title}: ${refused}`);
        break;
      }
      if (!problem) {
        state('gate on the merged result');
        const gate = await runGate(ctx);
        if (!gate.ok) {
          resetTo(root, before); // uncommitted work was committed before the merge: this only undoes the merge
          problem = { conflicts: [], failures: clip(gateFailures(gate), failureBudget(ctx.config.autopilot.contextWindow)) };
        }
      }
      if (!problem) {
        removeStep(id);
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
      const landed = repos.flatMap((r) => gitOut(repoDir(root, r), ['log', '--format=%s', `${branch}..HEAD`]).split('\n').filter(Boolean)).slice(0, 10);
      /** @type {string[]} */
      const conflicts = [];
      for (const r of repos) {
        const w = wt(id, r);
        clearUnfinishedMerge(w);
        const inTree = git(w, ['merge', '--no-edit', mainOf(r)]);
        if (inTree.status !== 0) conflicts.push(...git(w, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean).map((f) => (r === '.' ? f : `${r}/${f}`)));
      }
      const wctx = { ...ctx, root: dir };
      await runAgent(wctx, agentArgv(ctx.config, opts.agent, mergerPrompt(ctx.config.bin, { title: t.title, main: mains(), conflicts, failures: problem.failures, landed }), { root: dir }), `merger · ${t.title}`, log);
      const unfinished = repos.filter((r) => git(wt(id, r), ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0);
      if (unfinished.length) {
        for (const r of unfinished) git(wt(id, r), ['merge', '--abort']);
        continue; // the merger did not finish the merge: the next attempt starts over
      }
      // gate green in the worktree before trying main again (fixer loop, no verifiers)
      await runLoop(wctx, { agent: opts.agent, focuses: [], max: opts.max });
    }
    recordEvent(root, { type: 'merge', ok: false, task: id });
    await board['task block'].run({ id, on: 'human', reason: `autopilot: could not merge into ${main}${last ? `: ${last}` : ''}. Tried ${MERGE_ATTEMPTS + 1} times, a merger agent in between. The work is kept on ${branch} (worktree ${dir}): merge it by hand, or press r to build the step again` }, ctx);
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
