import { spawnSync } from '../../core/proc.js';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { truncate } from '../../core/text.js';
import { unlock, writeTask } from '../board/store.js';
import { runVerify } from '../verify/command.js';
import { agentArgv } from './argv.js';
import { runAgent } from './agent.js';
import { clip, contextRules, failureBudget, stepSize, windowLabel } from './budget.js';
import { dirtyFiles, log } from './loop.js';
import { splitterPrompt } from './prompts.js';
import { count } from './status.js';

/** A step that still cannot be finished after this many splits needs a human (or a bigger model). */
export const MAX_SPLIT_DEPTH = 2;
const MAX_STEPS = 5;

/**
 * The `{"tasks": [...]}` object in an agent's reply, wherever it sits in the prose.
 * @param {string | undefined} text
 * @returns {any[] | null}
 */
export function stepsFrom(text) {
  if (!text) return null;
  const tail = text.slice(-40_000);
  for (const m of tail.matchAll(/\{\s*"tasks"\s*:/g)) {
    for (let end = tail.lastIndexOf('}'); end > (m.index ?? 0); end = tail.lastIndexOf('}', end - 1)) {
      try {
        const o = JSON.parse(tail.slice(m.index, end + 1));
        if (Array.isArray(o?.tasks)) return o.tasks;
      } catch {
        // not this closing brace; try an earlier one
      }
    }
  }
  return null;
}

/**
 * Uncommitted files with their size (`src/a.rs (+40 -3)`, `wip.js (new, 12 lines)`), so the
 * splitter can judge the half-done work without reading it.
 * @param {string} root
 */
export function dirtyWork(root) {
  const numstat = new Map(
    (spawnSync('git', ['diff', '--numstat', 'HEAD', '--', '.', ':(exclude).wololo'], { cwd: root, encoding: 'utf8' }).stdout ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [add, del, path] = l.split('\t');
        return [path, `+${add} -${del}`];
      }),
  );
  return dirtyFiles(root).map((line) => {
    const path = line.slice(3).replace(/^"|"$/g, '');
    if (line.startsWith('??')) {
      try {
        const file = join(root, path);
        const n = statSync(file).size > 1_000_000 ? 0 : readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        return `${path} (new, ${n} line${n === 1 ? '' : 's'})`;
      } catch {
        return `${path} (new)`;
      }
    }
    return `${path} (${numstat.get(path) ?? line.slice(0, 2).trim()})`;
  });
}

/**
 * When the splitter writes nothing, split deterministically: first make the half-done work build
 * and commit it (reverting what cannot be fixed, so the step can always finish), then the rest.
 * @param {import('../board/store.js').Task} task
 * @param {string[]} dirty
 * @param {string} failures
 */
export function fallbackSteps(task, dirty, failures) {
  if (!dirty.length) return [];
  const first = [
    `Part of: ${task.title}. A builder ran out of room and left this work uncommitted: ${dirty.join(', ')}.`,
    'Make it build and pass the gate, then commit it. Fix or trim it; do not extend it.',
    'If a file cannot be fixed in a few small edits, revert it (git checkout -- <file>, or delete a new file) and say so in the commit message.',
    ...(failures ? ['Verification currently fails with:', failures] : []),
  ].join('\n');
  return [
    { title: 'Get the uncommitted work building and commit it', body: first },
    { title: truncate(`Finish: ${task.title}`, 120), body: task.body ?? '' },
  ];
}

/**
 * Replace a step its builder could not finish with smaller ones, in its place in the plan.
 * The facts the splitter needs (uncommitted files, verify failures) are gathered by tools, not by the agent.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} agent
 * @param {import('../board/store.js').Task} task
 * @param {string} why  what happened to the builder, e.g. "ran out of context (stuck in a compaction loop)"
 * @returns {Promise<string[]>} titles of the new steps; empty when the splitter produced none
 */
export async function splitTask(ctx, agent, task, why) {
  const { config, root } = ctx;
  const window = config.autopilot.contextWindow;
  const verify = await runVerify(ctx, { record: false });
  const failures = clip(verify.results.filter((r) => !r.ok).map((r) => `[${r.name}]\n${r.output}`).join('\n'), failureBudget(window));
  const dirty = dirtyWork(root);
  const step = { goal: truncate(task.goal ?? task.group, 400), title: task.title, body: task.body, why, dirty, failures };
  const prompt = splitterPrompt(step, { window: windowLabel(window), maxSteps: MAX_STEPS, rules: contextRules(window), ...(window ? { size: stepSize(window) } : {}) });
  // Tool-free where the harness allows it: everything the splitter needs is in the prompt, and an
  // agent with tools on a small window goes exploring and runs out of room before it answers.
  const r = await runAgent(ctx, agentArgv(config, agent, prompt, { tools: false, root }), 'splitter', log);

  /** @type {{ title: string, body: string }[]} */
  let steps = (stepsFrom(r.stdout) ?? stepsFrom(r.raw) ?? [])
    .filter((/** @type {any} */ s) => typeof s?.title === 'string' && s.title.trim())
    .slice(0, MAX_STEPS)
    .map((/** @type {any} */ s) => ({ title: truncate(s.title.trim(), 120), body: typeof s.body === 'string' ? s.body : '' }));
  if (!steps.length) {
    steps = fallbackSteps(task, dirty, failures);
    if (!steps.length) return [];
    log(`the splitter wrote no steps; splitting "${task.title}" by its uncommitted work instead`);
  }

  const now = new Date().toISOString();
  const depth = (task.splitDepth ?? 0) + 1;
  const base = task.seq ?? 0;
  const ids = steps.map((/** @type {any} */ _s, /** @type {number} */ i) => `${task.id}-s${i + 1}`);
  steps.forEach((/** @type {{ title: string, body: string }} */ s, /** @type {number} */ i) => {
    // Fractions keep the new steps between this one and the next, at any depth (at most 9 per split).
    const seq = base + (i + 1) * 10 ** -depth;
    writeTask(root, { id: ids[i], title: s.title, group: task.group, body: s.body, status: 'todo', queue: [], notes: [`${now} split from ${task.id}`], seq, goal: task.goal, splitDepth: depth, deps: i ? [ids[i - 1]] : task.deps, touches: task.touches, created: now, updated: now });
  });
  unlock(root, task.id);
  writeTask(root, { ...task, status: 'done', agent: undefined, splitInto: ids, notes: [...task.notes, `${now} split into: ${steps.map((s) => s.title).join('; ')}`], updated: now });
  count(root, 'split');
  log(`split "${task.title}" into ${steps.length} step(s): ${steps.map((s) => s.title).join('; ')}`);
  return steps.map((s) => s.title);
}
