import { readJson } from '../../core/files.js';
import { statePath } from '../../core/state.js';
import { truncate } from '../../core/text.js';
import { readTask, readTasks } from '../board/store.js';
import { log, runLoop } from './loop.js';
import { order, splitOrBlock } from './plan.js';
import { count } from './status.js';

/**
 * One step of a parallel run, in its own worktree (this process's cwd). Same loop as a serial step,
 * plus what the other running steps are doing; a step too big to finish is split, like in a serial run.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {import('../board/store.js').Task} task
 * @param {Omit<import('./loop.js').LoopOpts, 'goal' | 'task' | 'handoff'>} opts
 * @returns {Promise<import('../../core/types.js').Result>}
 */
export async function runWorker(ctx, task, opts) {
  const tasks = readTasks(ctx.root).filter((t) => t.group === task.group);
  /** @type {Record<string, { title: string, touches: string[] }>} */
  const claims = readJson(statePath(ctx.root, 'claims', `${task.group}.json`), {});
  const handoff = {
    goal: truncate(task.goal ?? task.group, 400),
    done: tasks.filter((t) => t.status === 'done' && !t.splitInto).map((t) => t.title),
    next: tasks.filter((t) => order(t) > order(task) && t.status !== 'done' && !claims[t.id]).map((t) => t.title),
    task: task.id,
  };
  const peers = { task: task.id, touches: task.touches ?? [], others: Object.entries(claims).filter(([id]) => id !== task.id).map(([id, c]) => ({ id, title: c.title, touches: c.touches })) };
  const started = Date.now();
  const r = await runLoop(ctx, { ...opts, goal: [task.title, task.body].filter(Boolean).join('\n\n'), task, handoff, peers, split: true });
  if (r.data?.split) {
    await splitOrBlock(ctx, opts.agent, /** @type {import('../board/store.js').Task} */ (readTask(ctx.root, task.id) ?? task), /** @type {{ split: string, context: boolean }} */ (r.data));
    return { ok: false, summary: `split "${task.title}"`, data: r.data };
  }
  if (r.ok) {
    count(ctx.root, 'landed');
    count(ctx.root, 'landedMs', Date.now() - started);
  } else count(ctx.root, 'stopped');
  log(`${task.title}: ${r.summary}`);
  return r;
}
