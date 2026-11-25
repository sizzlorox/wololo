import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJson, readText } from '../../core/files.js';

/**
 * A bench task is a folder:
 *   task.json   { "prompt"?: string, "check": string, "setup"?: string, "timeoutMin"?: number }
 *   prompt.md   the feature request (if not inline in task.json)
 *   repo/       the starting code the agent works on
 *   hidden/     acceptance tests copied in only after the agent stops (the agent never sees them)
 *   solution/   optional reference files overlaid on repo/ by `bench validate`
 *
 * @typedef {object} BenchTask
 * @property {string} id
 * @property {string} dir
 * @property {string} prompt
 * @property {string} check
 * @property {string} [setup]
 * @property {number} [timeoutMin]
 */

/**
 * @param {string} suiteDir
 * @param {string[]} [only]
 * @returns {{ tasks: BenchTask[], errors: string[] }}
 */
export function loadSuite(suiteDir, only) {
  const dir = resolve(suiteDir);
  /** @type {BenchTask[]} */
  const tasks = [];
  /** @type {string[]} */
  const errors = [];
  if (!existsSync(dir)) return { tasks, errors: [`no bench suite at ${suiteDir} (create one with: bench new <task>)`] };
  for (const id of readdirSync(dir).sort()) {
    const taskDir = join(dir, id);
    if (!statSync(taskDir).isDirectory() || !existsSync(join(taskDir, 'task.json'))) continue;
    if (only?.length && !only.includes(id)) continue;
    const meta = readJson(join(taskDir, 'task.json'), /** @type {any} */ ({}));
    const prompt = meta.prompt ?? readText(join(taskDir, 'prompt.md'))?.trim();
    const problems = [
      !prompt && 'no prompt (task.json "prompt" or prompt.md)',
      typeof meta.check !== 'string' && 'task.json needs "check": the command that runs the hidden tests',
      !existsSync(join(taskDir, 'repo')) && 'no repo/ folder with the starting code',
    ].filter(Boolean);
    if (problems.length) errors.push(`${id}: ${problems.join('; ')}`);
    else tasks.push({ id, dir: taskDir, prompt, check: meta.check, setup: meta.setup, timeoutMin: meta.timeoutMin });
  }
  if (only?.length) for (const id of only) if (!tasks.some((t) => t.id === id) && !errors.some((e) => e.startsWith(`${id}:`))) errors.push(`${id}: no such task`);
  return { tasks, errors };
}
