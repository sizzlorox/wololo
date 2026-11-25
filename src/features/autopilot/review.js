import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from '../../core/proc.js';
import { ensureDir, readJson } from '../../core/files.js';
import { statePath } from '../../core/state.js';
import { truncate } from '../../core/text.js';
import { readTasks, writeTask } from '../board/store.js';
import { agentArgv } from './argv.js';
import { runAgent } from './agent.js';
import { contextRules, stepSize, windowLabel } from './budget.js';
import { log } from './loop.js';
import { drain } from './plan.js';
import { runParallel } from './parallel.js';
import { gapReviewPrompt } from './prompts.js';

export const DEFAULT_GAP_ROUNDS = 3;
const MAX_GAPS = 10;
const MAX_MARKERS = 20;
const MARKER = 'TODO|FIXME|XXX|unimplemented!|todo!\\(|NotImplementedError|not implemented';

/**
 * Unfinished-work markers in tracked code, found deterministically so the reviewer starts from facts.
 * @param {string} root
 * @returns {string[]} `file:line: text`
 */
export function unfinishedMarkers(root) {
  const r = spawnSync('git', ['grep', '-n', '-I', '-E', MARKER, '--', '.', ':(exclude).wololo', ':(exclude)*.md'], { cwd: root, encoding: 'utf8' });
  return (r.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .slice(0, MAX_MARKERS)
    .map((l) => truncate(l.replace(/\s+/g, ' ').trim(), 160));
}

/** @param {string} title */
const norm = (title) => title.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Ask a reviewer agent what the goal still needs, and append it to the group as new steps.
 * Titles that repeat existing steps are dropped, so a reviewer cannot re-queue landed work forever.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} agent
 * @param {string} group
 * @param {number} round
 * @returns {Promise<number>} steps added
 */
export async function reviewGaps(ctx, agent, group, round) {
  const { config, root } = ctx;
  const tasks = readTasks(root).filter((t) => t.group === group);
  const goal = tasks.find((t) => t.goal)?.goal ?? group;
  const path = statePath(root, 'gaps.json');
  ensureDir(statePath(root));
  rmSync(path, { force: true });
  const window = config.autopilot.contextWindow;
  const done = tasks.filter((t) => t.status === 'done' && !t.splitInto).map((t) => t.title);
  const prompt = gapReviewPrompt(config.bin, goal, done, unfinishedMarkers(root), path, { window: windowLabel(window), maxTasks: MAX_GAPS, rules: contextRules(window), size: stepSize(window) });
  log(`gap review ${round}: checking the goal against what landed`);
  await runAgent(ctx, agentArgv(config, agent, prompt, { root: ctx.root }), 'gap reviewer', log);

  const raw = existsSync(path) ? readJson(path, /** @type {any} */ (null)) : null;
  if (!Array.isArray(raw?.tasks)) {
    log('gap reviewer wrote no findings; treating the plan as complete');
    return 0;
  }
  const known = new Set(tasks.map((t) => norm(t.title)));
  /** @type {{ title: string, body: string }[]} */
  const fresh = [];
  let repeats = 0;
  for (const s of raw.tasks) {
    if (typeof s?.title !== 'string' || !s.title.trim()) continue;
    if (known.has(norm(s.title))) {
      repeats++;
      continue;
    }
    known.add(norm(s.title));
    fresh.push({ title: truncate(s.title.trim(), 120), body: typeof s.body === 'string' ? s.body : '' });
  }
  const added = fresh.slice(0, MAX_GAPS);
  if (!added.length) {
    log(`gap review ${round}: ${repeats ? `nothing new (${repeats} repeat(s) of landed work ignored); ` : ''}the goal is met`);
    return 0;
  }
  const now = new Date().toISOString();
  let seq = Math.floor(Math.max(0, ...tasks.map((t) => t.seq ?? 0)));
  for (const g of added) {
    seq++;
    writeTask(root, { id: `${group}-${String(seq).padStart(2, '0')}`, title: g.title, group, body: g.body, status: 'todo', queue: [], notes: [`${now} added by gap review ${round}`], seq, goal, created: now, updated: now });
  }
  log(`gap review ${round}: ${added.length} gap(s): ${added.map((g) => g.title).join('; ')}`);
  return added.length;
}

/**
 * Build a group, then review it against the goal and build what is missing, until the reviewer
 * finds nothing new or `autopilot.gapRounds` reviews have run.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} group
 * @param {Parameters<typeof drain>[2]} opts
 * @returns {Promise<import('../../core/types.js').Result>}
 */
export async function buildGroup(ctx, group, opts) {
  const rounds = ctx.config.autopilot.gapRounds ?? DEFAULT_GAP_ROUNDS;
  for (let round = 1; ; round++) {
    const r = await ((ctx.config.autopilot.workers ?? 1) > 1 ? runParallel : drain)(ctx, group, opts);
    if (!r.ok) return r;
    if (round > rounds) {
      return rounds ? { ...r, summary: `${r.summary}; gap review stopped after ${rounds} round(s) (autopilot.gapRounds): rerun --group to review again` } : r;
    }
    if (!(await reviewGaps(ctx, opts.agent, group, round))) return r;
  }
}
