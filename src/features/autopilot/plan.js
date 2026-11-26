import { existsSync, rmSync } from 'node:fs';
import { ensureDir, readJson } from '../../core/files.js';
import { statePath } from '../../core/state.js';
import { shortHash, slugify, tail, truncate } from '../../core/text.js';
import { readTasks, unlock, writeTask } from '../board/store.js';
import { contextRules, overflowHint, stepSize, windowLabel } from './budget.js';
import { loadConfig } from '../../core/config.js';
import { detect } from '../init/detect.js';
import { allSteps } from '../verify/command.js';
import { log, runLoop } from './loop.js';
import { MAX_SPLIT_DEPTH, splitTask } from './split.js';
import { commands as boardCommands } from '../board/command.js';
import { count, setStatus } from './status.js';
import { plannerPrompt } from './prompts.js';
import { agentArgv } from './argv.js';
import { runAgent } from './agent.js';
import { learn } from '../learn/learn.js';
import { tasteSample } from './taste.js';

const MAX_TASKS = 30;

/**
 * Ask a planner agent to split the goal into small ordered steps, and put them on the board as one group.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} agent
 * @param {string} goal
 * @returns {Promise<{ ok: true, group: string, count: number } | { ok: false, error: string }>}
 */
export async function plan(ctx, agent, goal) {
  const { config, root } = ctx;
  const path = statePath(root, 'plan.json');
  ensureDir(statePath(root));
  rmSync(path, { force: true });
  log(`planner: ${goal.split('\n')[0]}`);
  const window = config.autopilot.contextWindow;
  /** @param {boolean} blind */
  const attempt = async (blind) => {
    const argv = agentArgv(config, agent, plannerPrompt(config.bin, goal, path, { window: windowLabel(window), maxTasks: MAX_TASKS, rules: contextRules(window), blind, size: stepSize(window), parallel: config.autopilot.workers ?? 1 }), { root });
    return { argv, r: await runAgent(ctx, argv, 'planner', log) };
  };
  let { argv, r } = await attempt(false);
  if (!existsSync(path) && (r.timedOut || overflowHint(`${r.stdout}\n${r.stderr}`, config.autopilot))) {
    log(`planner ran out of ${r.timedOut ? 'time' : 'context'}; retrying once, planning from the goal alone`);
    ({ argv, r } = await attempt(true));
  }
  if (!existsSync(path)) {
    const output = tail(`${r.stdout}\n${r.stderr}`, 20).trim() || '(no output)';
    const overflow = overflowHint(output, config.autopilot);
    const hint = overflow ? `\n${overflow}` : '';
    return { ok: false, error: `the planner did not write ${path}; ${argv[0]} exited ${r.code}:\n${output}${hint}` };
  }
  const raw = readJson(path, /** @type {any} */ (null));
  const steps = Array.isArray(raw?.tasks) ? raw.tasks.filter((/** @type {any} */ t) => typeof t?.title === 'string' && t.title.trim()) : [];
  if (!steps.length) return { ok: false, error: `${path} has no tasks (expected {"tasks": [{"title", "body"}]})` };
  if (steps.length > MAX_TASKS) return { ok: false, error: `the planner made ${steps.length} tasks (max ${MAX_TASKS}); split the goal yourself` };

  const now = new Date().toISOString();
  const group = `plan-${slugify(goal).slice(0, 24)}-${shortHash(goal + now)}`;
  const id = (/** @type {number} */ i) => `${group}-${String(i + 1).padStart(2, '0')}`;
  // Without deps from the planner, each step needs the one before it: the safe, serial reading.
  const declared = steps.some((/** @type {any} */ s) => Array.isArray(s.deps));
  steps.forEach((/** @type {{ title: string, body?: string, deps?: unknown, touches?: unknown }} */ s, /** @type {number} */ i) => {
    const title = truncate(s.title, 120);
    const deps = declared
      ? (Array.isArray(s.deps) ? s.deps : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= i).map((n) => id(n - 1))
      : i ? [id(i - 1)] : [];
    const touches = Array.isArray(s.touches) ? s.touches.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : [];
    writeTask(root, {
      id: id(i),
      title,
      deps,
      touches,
      group,
      body: typeof s.body === 'string' ? s.body : '',
      status: 'todo',
      queue: [],
      notes: [],
      seq: i + 1,
      goal,
      created: now,
      updated: now,
    });
  });
  return { ok: true, group, count: steps.length };
}

/**
 * A builder could not finish its step: split it into smaller steps, or block it once splitting has not helped.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} agent
 * @param {import('../board/store.js').Task} task
 * @param {{ split: string, context: boolean }} why
 */
export async function splitOrBlock(ctx, agent, task, why) {
  const what = why.context ? `ran out of context (${why.split})` : `did not finish (${why.split})`;
  const depth = task.splitDepth ?? 0;
  /** @param {string} reason */
  const block = async (reason) => {
    log(`task ${task.id}: ${reason}`);
    await board['task block'].run({ id: task.id, on: 'human', reason: `autopilot: ${reason}` }, ctx);
  };
  if (depth >= MAX_SPLIT_DEPTH) {
    const state = why.context ? 'still too big for the context window' : 'still not finished';
    return block(`${state} after ${depth} split(s) (last: ${why.split}); split it by hand, or give the model a bigger context or more time (autopilot.agentTimeoutMinutes)`);
  }
  log(`builder ${what} on "${task.title}": splitting it into smaller steps`);
  const steps = await splitTask(ctx, agent, task, what);
  if (!steps.length) await block(`the builder ${what} and the splitter wrote no smaller steps; split it by hand`);
}

const board = Object.fromEntries(boardCommands.map((c) => [c.name, c]));

/** @param {import('../board/store.js').Task} t */
export const order = (t) => t.seq ?? 0;

const SCAFFOLD_TITLE = 'Scaffold the project so it can be verified';
const SCAFFOLD_BODY = [
  'There is no project yet, so nothing can be verified and no step can land.',
  "Create the minimal project the goal needs (language, engine, build file) with one passing smoke test, runnable with the stack's standard test command (cargo test, npm test, pytest, go test).",
  'Do not build features. wololo detects package.json, Cargo.toml, pyproject.toml and go.mod and adopts their verify steps.',
].join('\n');

/**
 * With no verify steps and no recognisable project the gate can never pass, so every step would
 * block. Put a scaffold step first, and reopen steps autopilot blocked: the missing verification
 * was at least part of why. Deterministic; no agent decides this.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} group
 * @param {import('../board/store.js').Task[]} tasks
 * @param {boolean} reopen  only when a run starts: within a run, a block stands
 */
export function scaffoldIfUnverifiable(ctx, group, tasks, reopen) {
  let config;
  try {
    config = loadConfig(ctx.root);
  } catch {
    return;
  }
  if (allSteps({ ...ctx, config }).length || detect(ctx.root).steps.length) return;
  const now = new Date().toISOString();
  const id = `${group}-00`;
  if (!tasks.some((t) => t.id === id)) {
    const goal = tasks.find((t) => t.goal)?.goal;
    writeTask(ctx.root, { id, title: SCAFFOLD_TITLE, group, body: SCAFFOLD_BODY, status: 'todo', queue: [], notes: [], seq: 0, goal, created: now, updated: now });
    log(`no project to verify yet: added "${SCAFFOLD_TITLE}" as the first step`);
  }
  if (!reopen) return;
  for (const t of tasks) {
    if (t.status !== 'blocked' || !t.notes.at(-1)?.includes('blocked: autopilot:')) continue;
    writeTask(ctx.root, { ...t, status: 'todo', blockedOn: undefined, agent: undefined, notes: [...t.notes, `${now} reopened: it was blocked while nothing could be verified`], updated: now });
  }
}

/**
 * Build a group's tasks in order, each with fresh agents. Stops at the first task that cannot land:
 * later steps depend on earlier ones. Safe to rerun: done tasks are skipped, interrupted ones resumed.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} group
 * @param {Omit<import('./loop.js').LoopOpts, 'goal' | 'task' | 'handoff'>} opts
 * @returns {Promise<import('../../core/types.js').Result>}
 */
export async function drain(ctx, group, opts) {
  const all = () => readTasks(ctx.root).filter((t) => t.group === group).sort((a, b) => order(a) - order(b) || a.created.localeCompare(b.created));
  if (!all().length) return { ok: false, summary: `no tasks in group ${group}` };
  const details = [];
  for (let pass = 0; ; pass++) {
    scaffoldIfUnverifiable(ctx, group, all(), pass === 0);
    const tasks = all();
    const blocked = tasks.find((t) => t.status === 'blocked');
    if (blocked) {
      const why = blocked.notes.findLast((n) => n.includes(' blocked: '))?.split(' blocked: ')[1];
      const summary = [
        `stopped at "${blocked.title}" (blocked on ${blocked.blockedOn})`,
        ...(why ? [`  why: ${why}`] : []),
        `  retry it: ${ctx.config.bin} task release ${blocked.id}`,
        `  or skip:  ${ctx.config.bin} task done ${blocked.id} --note "<what you did>"`,
        `  then:     ${ctx.config.bin} autopilot --group ${group}`,
      ].join('\n');
      return { ok: false, summary, details, data: { group } };
    }
    // A crashed run leaves its own claim behind; resume it. Claims by other agents are theirs.
    const next = tasks.find((t) => t.status === 'todo' || (t.status === 'claimed' && t.agent?.startsWith('autopilot:')));
    if (!next) {
      const done = tasks.filter((t) => t.status === 'done').length;
      return { ok: done === tasks.length, summary: `${done}/${tasks.length} task(s) landed in ${group}`, details, data: { group } };
    }
    if (next.status === 'claimed') unlock(ctx.root, next.id);
    const handoff = {
      goal: truncate(next.goal ?? group, 400),
      done: tasks.filter((t) => t.status === 'done' && !t.splitInto).map((t) => t.title),
      next: tasks.filter((t) => order(t) > order(next) && t.status !== 'done').map((t) => t.title),
      task: next.id,
    };
    log(`task ${next.id}: ${next.title}`);
    const taskStarted = Date.now();
    setStatus(ctx.root, { group, task: { id: next.id, title: next.title, started: new Date(taskStarted).toISOString() } });
    const r = await runLoop(ctx, { ...opts, goal: [next.title, next.body].filter(Boolean).join('\n\n'), task: next, handoff, split: true });
    if (r.data?.split) {
      await splitOrBlock(ctx, opts.agent, next, /** @type {{ split: string, context: boolean }} */ (r.data));
      continue;
    }
    if (r.ok) {
      count(ctx.root, 'landed');
      count(ctx.root, 'landedMs', Date.now() - taskStarted);
      await learn(ctx, opts.agent, log);
      tasteSample(ctx.root, log);
    } else count(ctx.root, 'stopped');
    details.push(`${next.title}: ${r.summary}`);
    log(`task ${next.id} ${r.ok ? 'landed' : 'stopped'}: ${r.summary}`);
    const after = all().find((t) => t.id === next.id);
    if (!r.ok && after && after.status !== 'blocked' && after.status !== 'done') return { ok: false, summary: `could not run "${next.title}": ${r.summary}`, details, data: { group } };
  }
}
