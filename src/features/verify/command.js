import { join } from 'node:path';
import { sh } from '../../core/exec.js';
import { readJson } from '../../core/files.js';
import { isWorkspace, listRepos, repoDir } from '../../core/repos.js';
import { CONFIG_FILE, recordEvent } from '../../core/state.js';
import { tail } from '../../core/text.js';
import { compare, contractOf } from '../guard/contract.js';
import { runAppCheck } from './app/index.js';
import { notHuman, readLock, writeLock } from '../guard/lock.js';
import { adoptMissing } from '../guard/coverage.js';

/**
 * @typedef {{ name: string, ok: boolean, code: number, ms: number, output: string, timedOut: boolean, screenshot?: string }} StepResult  screenshot: what an app step saw, kept for the judge and a human
 */

/**
 * Every verify step to run, with where to run it: the workspace's own steps at the root, and in a
 * workspace each repo's steps inside that repo (autopilot.repos[repo].verify, else the repo's own
 * wololo.config.json), named "repo: step" so a failure says which repo.
 * @param {import('../../core/types.js').Ctx} ctx
 * @returns {(import('../../core/config.js').VerifyStep & { cwd: string })[]}
 */
export function allSteps(ctx) {
  const { config, root } = ctx;
  const own = config.verify.steps.map((s) => ({ ...s, cwd: root }));
  if (!isWorkspace(root)) return own;
  return [
    ...own,
    ...listRepos(root).flatMap((repo) => {
      const dir = repoDir(root, repo);
      /** @type {import('../../core/config.js').VerifyStep[]} */
      const steps = config.autopilot.repos?.[repo]?.verify ?? readJson(join(dir, CONFIG_FILE), /** @type {any} */ ({}))?.verify?.steps ?? [];
      return steps.map((s) => ({ ...s, name: `${repo}: ${s.name}`, cwd: dir }));
    }),
  ];
}

/**
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {{ fast?: boolean, steps?: string[], bail?: boolean, record?: boolean }} opts
 */
export async function runVerify(ctx, opts) {
  const { config, root } = ctx;
  const every = allSteps(ctx);
  let steps = every;
  if (opts.fast) steps = steps.filter((s) => s.fast);
  if (opts.steps?.length) steps = steps.filter((s) => opts.steps?.includes(s.name));
  /** @type {StepResult[]} */
  const results = [];
  for (const step of steps) {
    const started = Date.now();
    if (step.app) {
      const w = await runAppCheck(step.app, { cwd: step.cwd, root, name: step.name });
      results.push({ name: step.name, ok: w.ok, code: w.ok ? 0 : 1, ms: Date.now() - started, timedOut: false, output: w.ok ? '' : w.problems.join('\n'), screenshot: w.screenshot });
    } else if (!step.run) results.push({ name: step.name, ok: false, code: 1, ms: 0, timedOut: false, output: 'this step has neither run (a command) nor app (something to open and look at)' });
    else {
      const r = await sh(step.run, { cwd: step.cwd, timeoutMs: (step.timeoutSec ?? config.verify.timeoutSec) * 1000, env: { CI: '1', FORCE_COLOR: '0' } });
      const ok = r.code === 0 && !r.timedOut;
      results.push({ name: step.name, ok, code: r.code, ms: r.ms, timedOut: r.timedOut, output: ok ? '' : tail(`${r.stdout}\n${r.stderr}`, 60) });
    }
    if (!results.at(-1)?.ok && opts.bail) break;
  }
  const configured = every.length > 0;
  const ok = configured && steps.length > 0 && results.every((r) => r.ok);
  if (opts.record !== false) recordEvent(root, { type: 'verify', ok, fast: !!opts.fast, failed: results.filter((r) => !r.ok).map((r) => r.name) });
  return { ok, configured, results };
}

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'verify',
    summary: "Run the project's verification steps (lint, types, tests, e2e). Never claim done without green.",
    options: {
      fast: { type: 'boolean', description: 'Only steps marked fast' },
      step: { type: 'string[]', description: 'Only these steps' },
      bail: { type: 'boolean', description: 'Stop at the first failing step' },
    },
    async run(input, ctx) {
      const r = await runVerify(ctx, { fast: input.fast, steps: input.step, bail: input.bail });
      if (!r.configured)
        return {
          ok: false,
          summary: 'no verify steps configured: an agent without verification is guessing',
          details: ['Add steps to wololo.config.json → verify.steps, e.g. {"name":"test","run":"npm test","fast":false}'],
          data: r,
        };
      const failed = r.results.filter((s) => !s.ok);
      return {
        ok: r.ok,
        summary: r.ok ? `verify passed (${r.results.map((s) => s.name).join(', ')})` : `verify failed: ${failed.map((s) => s.name).join(', ')}`,
        details: r.results.map((s) => `${s.ok ? 'PASS' : 'FAIL'} ${s.name} (${s.ms}ms)${s.timedOut ? ' TIMEOUT' : ''}${s.output ? `\n${indent(s.output)}` : ''}`),
        data: r,
      };
    },
  },
];

commands.push({
  name: 'verify adopt',
  summary: "Add the project's own checks the gate does not run yet (a test suite, typecheck, build, an app to open). Verification grows with the project; adding never needs a human.",
  options: {},
  async run(_input, ctx) {
    const added = adoptMissing(ctx.root);
    return { ok: true, summary: added.length ? `the gate now also runs: ${added.map((s) => s.name).join(', ')}` : 'the gate already runs every check the project has', details: added.map((s) => `${s.name}: ${s.run ?? JSON.stringify(s.app)}`), data: added };
  },
});

commands.push({
  name: 'verify approve',
  summary: 'Accept the current verification as the new bar, after a change that weakened it (a step removed or changed, a gate script edited, tests deleted or thinned). Humans only.',
  options: {},
  async run(_input, ctx) {
    const no = notHuman();
    if (no) return { ok: false, summary: no, exitCode: 2 };
    const now = contractOf(ctx);
    const lock = readLock(ctx.root);
    const { weakened, added } = lock ? compare(lock.contract, now) : { weakened: [], added: [] };
    writeLock(ctx.root, now, 'human');
    return {
      ok: true,
      summary: weakened.length ? `approved ${weakened.length} weakening(s); this is the bar now` : 'nothing was weakened; the lock is the current verification',
      details: [...weakened.map((w) => `accepted: ${w}`), ...added.map((a) => `locked in: ${a}`)],
      data: { weakened, added },
    };
  },
});

/** @param {string} s */
function indent(s) {
  return s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}
