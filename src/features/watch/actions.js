import { spawn, spawnSync } from '../../core/proc.js';
import { openSync } from 'node:fs';
import { ensureDir } from '../../core/files.js';
import { statePath } from '../../core/state.js';
import { commands as boardCommands } from '../board/command.js';
import { readTask, writeTask } from '../board/store.js';
import { goalBlocker } from '../guard/tools.js';

const board = Object.fromEntries(boardCommands.map((c) => [c.name, c]));

/**
 * Start `wololo <args>` in the background, detached from this terminal, so closing watch leaves it running.
 * Output goes to .wololo/state/autopilot.out.
 * @param {string} root
 * @param {string[]} args
 * @param {string} [entry]  wololo's entry script; process.argv[1] is it whether run from a checkout or via npx
 */
export function launch(root, args, entry = process.argv[1]) {
  ensureDir(statePath(root));
  const out = openSync(statePath(root, 'autopilot.out'), 'a');
  const child = spawn(process.execPath, [entry, ...args], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, WOLOLO_DETACHED: '1' } });
  child.unref();
}

/** Stop a run and the agent it spawned. @param {number} pid */
function stop(pid) {
  if (process.platform === 'win32') return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']).status === 0;
  try {
    process.kill(-pid, 'SIGTERM'); // detached runs lead their own process group
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * The task the cursor is on: the chosen one if it is still in the plan, else the first blocked, else the first open.
 * @param {import('./render.js').View} v
 */
export function selectedTask(v) {
  return v.tasks.find((t) => t.id === v.selected) ?? v.tasks.find((t) => t.status === 'blocked') ?? v.tasks.find((t) => t.status !== 'done') ?? v.tasks.at(-1);
}

/**
 * The keys that make sense for what the view shows, in display order.
 * @param {import('./render.js').View} v
 * @returns {{ key: string, label: string }[]}
 */
export function keys(v) {
  const group = v.group ?? v.status?.group;
  const t = selectedTask(v);
  const open = v.tasks.some((x) => x.status !== 'done');
  /** @type {{ key: string, label: string }[]} */
  const k = [];
  if (t) k.push({ key: '↑↓', label: 'select' }, { key: 'enter', label: 'details' });
  if (t && !t.splitInto?.length && (t.status === 'blocked' || (t.status === 'done' && !v.alive))) k.push({ key: 'r', label: t.status === 'blocked' ? 'retry' : 'redo' });
  else if (group && open && !v.alive) k.push({ key: 'r', label: 'resume' });
  // a claimed step is only skippable once its run is gone (it crashed or was stopped)
  if (t && (t.status === 'todo' || t.status === 'blocked' || (t.status === 'claimed' && !v.alive))) k.push({ key: 's', label: 'skip' });
  if (group) k.push({ key: 'a', label: 'add step' });
  if ((v.groups?.length ?? 0) > 1) k.push({ key: 'g', label: 'next plan' });
  k.push(v.alive ? { key: 'x', label: 'stop' } : { key: 'n', label: 'new goal' });
  k.push({ key: 'q', label: 'quit' });
  return k;
}

/**
 * Do what a key means. Returns a one-line message for the footer.
 * Board edits apply at once; a run is only started when none is running.
 * @param {string} key
 * @param {import('./render.js').View} v
 * @param {import('../../core/types.js').Ctx & { launch?: (args: string[]) => void }} ctx
 * @param {string} [text]  what was typed after `n` (a goal) or `a` (a step title)
 * @returns {Promise<string>}
 */
export async function act(key, v, ctx, text) {
  if (!keys(v).some((k) => k.key === key)) return '';
  const run = ctx.launch ?? ((/** @type {string[]} */ args) => launch(ctx.root, args));
  const group = v.group ?? v.status?.group ?? '';
  const t = selectedTask(v);
  const resume = () => {
    if (v.alive) return '';
    run(['autopilot', '--group', group]);
    return `; resuming ${group}`;
  };
  if (key === 'x') return v.status && stop(v.status.pid) ? 'stopped the run' : 'could not stop the run';
  if (key === 'n') {
    if (!text?.trim()) return '';
    // check here, before launching: a run that stops at once in the background looked like nothing happened
    const blocked = goalBlocker(ctx.root, text.trim(), ctx.config.autopilot.agent);
    if (blocked) return blocked;
    run(['autopilot', '--goal', text.trim(), '--plan']);
    return `started: ${text.trim()}`;
  }
  if (key === 'r') {
    if (t && !t.splitInto?.length && (t.status === 'blocked' || t.status === 'done')) {
      const was = t.status;
      await board['task release'].run({ id: t.id }, ctx);
      return `${was === 'blocked' ? 'retrying' : 'redoing'} "${t.title}"${resume()}`;
    }
    return resume().slice(2);
  }
  if (key === 's' && t) {
    const was = t.status;
    await board['task done'].run({ id: t.id, note: 'skipped from watch' }, ctx);
    return `skipped "${t.title}"${was === 'blocked' && v.tasks.some((x) => x.id !== t.id && x.status !== 'done') ? resume() : ''}`;
  }
  if (key === 'a') {
    if (!text?.trim()) return '';
    const added = await board['task add'].run({ title: text.trim(), group, force: true }, ctx);
    if (!added.ok) return added.summary;
    // Slot it in right after the selected step: plans build in seq order.
    const at = t ? v.tasks.indexOf(t) : v.tasks.length - 1;
    const here = v.tasks[at]?.seq ?? 0;
    const next = v.tasks.slice(at + 1).find((x) => (x.seq ?? 0) > here)?.seq;
    const task = /** @type {import('../board/store.js').Task} */ (readTask(ctx.root, /** @type {any} */ (added.data).id));
    writeTask(ctx.root, { ...task, seq: next === undefined ? here + 1 : (here + next) / 2, goal: v.tasks.find((x) => x.goal)?.goal, notes: [`${new Date().toISOString()} added from watch`] });
    return `added "${text.trim()}"${t ? ` after "${t.title}"` : ''}`;
  }
  return '';
}
