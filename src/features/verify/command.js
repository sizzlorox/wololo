import { sh } from '../../core/exec.js';
import { recordEvent } from '../../core/state.js';
import { tail } from '../../core/text.js';

/**
 * @typedef {{ name: string, ok: boolean, code: number, ms: number, output: string, timedOut: boolean }} StepResult
 */

/**
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {{ fast?: boolean, steps?: string[], bail?: boolean, record?: boolean }} opts
 */
export async function runVerify(ctx, opts) {
  const { config, root } = ctx;
  let steps = config.verify.steps;
  if (opts.fast) steps = steps.filter((s) => s.fast);
  if (opts.steps?.length) steps = steps.filter((s) => opts.steps?.includes(s.name));
  /** @type {StepResult[]} */
  const results = [];
  for (const step of steps) {
    const r = await sh(step.run, { cwd: root, timeoutMs: (step.timeoutSec ?? config.verify.timeoutSec) * 1000, env: { CI: '1', FORCE_COLOR: '0' } });
    const ok = r.code === 0 && !r.timedOut;
    results.push({ name: step.name, ok, code: r.code, ms: r.ms, timedOut: r.timedOut, output: ok ? '' : tail(`${r.stdout}\n${r.stderr}`, 60) });
    if (!ok && opts.bail) break;
  }
  const configured = config.verify.steps.length > 0;
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

/** @param {string} s */
function indent(s) {
  return s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}
