import { existsSync, rmSync } from 'node:fs';
import { ensureDir, readJson } from '../../core/files.js';
import { statePath } from '../../core/state.js';
import { truncate } from '../../core/text.js';
import { readTasks, writeTask } from '../board/store.js';
import { runAgent } from './agent.js';
import { agentArgv } from './argv.js';
import { contextRules } from './budget.js';
import { log } from './loop.js';
import { order } from './plan.js';

/**
 * A plan made before parallel mode (or steps a gap review added) says nothing about deps or which
 * files each step changes, so every step would run alone. Ask an agent once to fill that in.
 * Whatever it leaves out stays serial: the step needs the one before it and may touch anything.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} agent
 * @param {string} group
 * @returns {Promise<number>} how many steps were annotated
 */
export async function annotate(ctx, agent, group) {
  const { root, config } = ctx;
  const open = readTasks(root)
    .filter((t) => t.group === group && t.status !== 'done')
    .sort((a, b) => order(a) - order(b));
  const bare = open.filter((t) => !t.touches?.length);
  if (!bare.length) return 0;
  const all = readTasks(root).filter((t) => t.group === group);
  const path = statePath(root, 'annotate.json');
  ensureDir(statePath(root));
  rmSync(path, { force: true });
  log(`annotator: ${bare.length} step(s) of ${group} do not say what they need or change; asking once so they can run in parallel`);
  const prompt = annotatorPrompt({
    goal: truncate(all.find((t) => t.goal)?.goal ?? group, 400),
    done: all.filter((t) => t.status === 'done' && !t.splitInto).map((t) => t.title),
    open: open.map((t) => ({ id: t.id, title: t.title, body: truncate(t.body ?? '', 300) })),
    path,
    workers: config.autopilot.workers ?? 1,
    rules: contextRules(config.autopilot.contextWindow),
  });
  await runAgent(ctx, agentArgv(config, agent, prompt, { root }), 'annotator', log);
  /** @type {Map<string, { deps?: unknown, touches?: unknown }>} */
  const given = new Map((readJson(path, /** @type {any} */ ({}))?.tasks ?? []).filter((/** @type {any} */ a) => typeof a?.id === 'string').map((/** @type {any} */ a) => [a.id, a]));
  if (!existsSync(path)) log('the annotator wrote nothing; the steps stay serial');
  let n = 0;
  open.forEach((t, i) => {
    if (t.touches?.length) return;
    const a = given.get(t.id);
    const touches = Array.isArray(a?.touches) ? a.touches.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
    // only earlier open steps: no self, no unknown ids, no cycles; done steps are met already
    const earlier = new Set(open.slice(0, i).map((x) => x.id));
    const deps = touches.length && Array.isArray(a?.deps) ? [...new Set(a.deps.filter((d) => typeof d === 'string' && earlier.has(d)))] : i ? [open[i - 1].id] : [];
    writeTask(root, { ...t, deps, touches });
    if (touches.length) n++;
  });
  log(`annotator: ${n}/${bare.length} step(s) now say what they need and change`);
  return n;
}

/**
 * @param {{ goal: string, done: string[], open: { id: string, title: string, body: string }[], path: string, workers: number, rules?: string[] }} p
 */
export function annotatorPrompt(p) {
  return [
    'You are the annotator in an autopilot loop. Do not write any code and do not commit.',
    '',
    `Goal: ${p.goal}`,
    `Already built: ${p.done.length ? p.done.join('; ') : 'nothing yet'}`,
    '',
    `These steps are not built yet. Up to ${p.workers} will be built at the same time, each by its own agent on its own branch, then merged. For each step, find out from the repo (search, do not read everything):`,
    '- "deps": ids of the steps below that it really needs built first (only steps listed before it); [] if none.',
    '- "touches": the files or dirs it will change (e.g. "src/sim/economy.ts", "tests/sim/"). Steps whose touches overlap never run at once; shared files like a manifest or main entry point count.',
    '',
    ...p.open.map((t) => `- ${t.id}: ${t.title}${t.body ? ` — ${t.body.replace(/\s+/g, ' ')}` : ''}`),
    '',
    ...(p.rules ?? []),
    `Write them to ${p.path} as JSON: {"tasks": [{"id": "${p.open[0]?.id ?? 'step-id'}", "deps": [], "touches": ["src/area/"]}]}`,
  ].join('\n');
}
