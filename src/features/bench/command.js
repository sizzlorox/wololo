import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { appendJsonl, ensureDir, readJson, readJsonl, writeJson, writeText } from '../../core/files.js';
import { statePath } from '../../core/state.js';
import { formatReport, summarize } from './stats.js';
import { loadSuite } from './suite.js';
import { ARMS, runTrial, validateTask } from './trial.js';

/** @param {string} msg */
const log = (msg) => process.stderr.write(`[bench] ${msg}\n`);

const STARTER = fileURLToPath(new URL('../../../bench', import.meta.url));

/** The given suite, else the project's bench/, else the starter suite that ships with wololo. @param {string} cwd @param {string} [suite] */
const suiteDir = (cwd, suite) => (suite ? resolve(cwd, suite) : existsSync(resolve(cwd, 'bench')) ? resolve(cwd, 'bench') : STARTER);

/** @param {string} root */
const runsDir = (root) => statePath(root, 'bench');

/** @param {string} root */
function latestRun(root) {
  const dir = runsDir(root);
  return existsSync(dir) ? readdirSync(dir).sort().at(-1) : undefined;
}

/**
 * @template T, R
 * @param {T[]} items @param {number} limit @param {(item: T) => Promise<R>} fn
 */
async function pool(items, limit, fn) {
  /** @type {R[]} */
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** @param {any} ctx @param {Record<string, any>} input */
function trialOpts(ctx, input) {
  const agent = input.agent ?? ctx.config.autopilot.agent;
  return { config: ctx.config, agent, harness: input.harness ?? agent, timeoutMs: (input.timeout ?? 20) * 60_000, keep: input.keep };
}

/** @param {string} root @param {string} id */
function report(root, id) {
  const meta = readJson(join(runsDir(root), id, 'meta.json'), /** @type {any} */ ({}));
  const results = readJsonl(join(runsDir(root), id, 'results.jsonl'));
  const s = summarize(results, meta.arms ?? [...new Set(results.map((r) => r.arm))]);
  return { meta, results, ...s, lines: formatReport(s) };
}

const SUITE = { name: 'suite', description: "Bench suite folder (default: ./bench, else wololo's starter suite)" };

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'bench run',
    summary: 'Measure what the harness changes: run the same tasks with the same agent with and without wololo, scored by hidden tests.',
    mcp: false,
    args: [SUITE],
    options: {
      arms: { type: 'string[]', description: `Arms to compare; the first is the baseline (${ARMS.join(', ')}; default bare,wololo)` },
      trials: { type: 'number', description: 'Runs per task per arm (agents are noisy: use 3+ for a real answer)' },
      task: { type: 'string[]', description: 'Only these task ids' },
      agent: { type: 'string', description: 'Harness to drive headlessly (default autopilot.agent; autopilot.command overrides the argv)' },
      harness: { type: 'string', description: 'Adapter that wololo init wires in the workspace (default: the agent)' },
      parallel: { type: 'number', description: 'Trials to run at once' },
      timeout: { type: 'number', description: 'Minutes per agent run (default 20)' },
      keep: { type: 'boolean', description: 'Keep workspaces for inspection' },
      dryRun: { type: 'boolean', description: 'List the trials without running agents' },
    },
    async run(input, ctx) {
      const arms = input.arms?.length ? input.arms : ['bare', 'wololo'];
      const unknown = arms.filter((/** @type {string} */ a) => !(/** @type {readonly string[]} */ (ARMS)).includes(a));
      if (unknown.length) return { ok: false, summary: `unknown arm(s): ${unknown.join(', ')} (choose from ${ARMS.join(', ')})`, exitCode: 2 };
      const { tasks, errors } = loadSuite(suiteDir(ctx.cwd, input.suite), input.task);
      if (errors.length || !tasks.length) return { ok: false, summary: 'bench suite has problems', details: errors.length ? errors : ['no tasks'] };
      const trials = Math.max(1, input.trials ?? 1);
      const plan = tasks.flatMap((task) => Array.from({ length: trials }, (_, t) => arms.map((/** @type {string} */ arm) => ({ task, arm, trial: t + 1 }))).flat());
      const opts = trialOpts(ctx, input);
      if (input.dryRun) return { ok: true, summary: `dry run: ${plan.length} trial(s) with ${opts.agent}`, details: plan.map((p) => `${p.task.id} ${p.arm} #${p.trial}`) };

      const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${Math.random().toString(36).slice(2, 6)}`;
      const dir = join(runsDir(ctx.root), id);
      ensureDir(dir);
      writeJson(join(dir, 'meta.json'), { suite: suiteDir(ctx.cwd, input.suite), arms, trials, agent: opts.agent, started: new Date().toISOString() });
      writeText(join(dir, 'results.jsonl'), '');
      await pool(plan, input.parallel ?? 1, async ({ task, arm, trial }) => {
        log(`${task.id} · ${arm} #${trial}: running ${opts.agent}`);
        const r = await runTrial(task, arm, trial, opts);
        log(`${task.id} · ${arm} #${trial}: ${r.pass ? 'PASS' : 'fail'} (hidden ${r.hidden.toFixed(2)}, ${r.violations} violation(s), ${Math.round(r.ms / 1000)}s)`);
        appendJsonl(join(dir, 'results.jsonl'), r);
      });
      const rep = report(ctx.root, id);
      return { ok: true, summary: `bench ${id}: ${plan.length} trial(s)`, details: rep.lines, data: { id, arms: rep.arms, tasks: rep.tasks, results: rep.results } };
    },
  },
  {
    name: 'bench report',
    summary: 'Pass rate per arm with 95% CIs and the delta vs the baseline, plus quality signals (rule violations, tests, diff size, time, cost).',
    args: [{ name: 'id', description: 'Run id (default: latest)' }],
    async run(input, ctx) {
      const id = input.id ?? latestRun(ctx.root);
      if (!id || !existsSync(join(runsDir(ctx.root), id))) return { ok: false, summary: 'no bench runs yet: wololo bench run' };
      const rep = report(ctx.root, id);
      return { ok: true, summary: `bench ${id}: ${rep.results.length} trial(s), agent ${rep.meta.agent}`, details: rep.lines, data: { id, arms: rep.arms, tasks: rep.tasks } };
    },
  },
  {
    name: 'bench validate',
    summary: 'Prove every task can measure something: its hidden check fails on the starting code and passes with the reference solution.',
    args: [SUITE],
    options: { task: { type: 'string[]', description: 'Only these task ids' } },
    async run(input, ctx) {
      const { tasks, errors } = loadSuite(suiteDir(ctx.cwd, input.suite), input.task);
      const opts = trialOpts(ctx, { timeout: 10 });
      const details = [...errors];
      let valid = 0;
      for (const task of tasks) {
        const problems = await validateTask(task, opts);
        details.push(problems.length ? `${task.id}: ${problems.join('; ')}` : `${task.id}: ok`);
        if (!problems.length) valid++;
      }
      const total = tasks.length + errors.length;
      return { ok: total > 0 && valid === total, summary: `${valid}/${total} task(s) valid`, details };
    },
  },
  {
    name: 'bench new',
    summary: 'Scaffold a bench task: task.json, repo/ (starting code), hidden/ (acceptance tests), solution/ (reference).',
    args: [{ name: 'name', description: 'Task id', required: true }, SUITE],
    async run(input, ctx) {
      const dir = resolve(ctx.cwd, input.suite ?? 'bench', input.name);
      if (existsSync(dir)) return { ok: false, summary: `${dir} already exists` };
      writeJson(join(dir, 'task.json'), { prompt: 'TODO: the feature request, written the way you would ask an agent', check: 'node --test hidden/*.test.js', timeoutMin: 20 });
      writeText(join(dir, 'repo', 'README.md'), '# TODO: starting code the agent works on\n');
      writeText(join(dir, 'hidden', 'README.md'), '# TODO: acceptance tests, copied to hidden/ in the workspace after the agent stops\n');
      writeText(join(dir, 'solution', 'README.md'), '# TODO: reference solution files, overlaid on repo/ by bench validate\n');
      return { ok: true, summary: `created ${dir}`, details: ['fill in task.json, repo/, hidden/ and solution/, then run: bench validate'] };
    },
  },
];
