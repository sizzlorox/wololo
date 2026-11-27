import { existsSync } from 'node:fs';
import { recordEvent, wololoPath } from '../../core/state.js';
import { formatViolation, runCheck } from '../check/engine.js';
import { runScore } from '../score/command.js';
import { runSync } from '../sync/command.js';
import { allSteps, runVerify } from '../verify/command.js';
import { ratchet } from '../guard/lock.js';
import { uncovered } from '../guard/coverage.js';

/**
 * The merge gate: the single answer to "can this agent merge its own code?"
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {{ judge?: Record<string, number>, base?: string, visual?: boolean }} [opts]  base: where this task started (a parallel worker's ratchet compares against it); visual: the step changes what people see
 */
export async function runGate(ctx, opts = {}) {
  /** @type {{ name: string, ok: boolean, detail: string[] }[]} */
  const parts = [];

  const sync = runSync(ctx, { check: true });
  parts.push({ name: 'adapters', ok: sync.ok, detail: [...sync.drift, ...sync.conflicts, ...sync.errors].map((d) => `drift: ${d}`) });

  const check = runCheck(ctx, { record: false });
  parts.push({ name: 'constraints', ok: check.ok, detail: [...check.ruleErrors, ...check.violations.filter((v) => v.severity === 'error').map(formatViolation)] });

  const verify = await runVerify(ctx, { record: false });
  parts.push({
    name: 'verify',
    ok: verify.ok,
    detail: verify.configured ? verify.results.filter((r) => !r.ok).map((r) => `FAIL ${r.name}\n${r.output}`) : ['no verify steps configured'],
  });

  if (existsSync(wololoPath(ctx.root, 'rubric.json'))) {
    const score = await runScore(ctx, { verified: verify, judge: opts.judge, record: false });
    const pendingBlocks = ctx.config.gate.requireJudgment && score.pending.length > 0;
    const ok = !score.empty && score.total >= ctx.config.gate.minScore && !pendingBlocks;
    parts.push({
      name: 'rubric',
      ok,
      detail: ok ? [] : [`score ${score.total} < ${ctx.config.gate.minScore}${pendingBlocks ? ` or pending judgment: ${score.pending.join(', ')}` : ''}${score.weakest ? ` (weakest: ${score.weakest.id})` : ''}`],
    });
  }

  // the project's own checks must be in the gate: a gate that skips the test suite proves nothing
  // (a parallel worker's branch may predate them; the main process adopts them on the merged result)
  if (!process.env.WOLOLO_WORKER) {
    const missing = uncovered(ctx.root, ctx.config.verify.steps);
    parts.push({ name: 'coverage', ok: !missing.length, detail: missing.length ? [...missing.map((s) => `the project has ${s.name} (${s.run ?? JSON.stringify(s.app)}) but the gate does not run it`), 'Add them: wololo verify adopt (autopilot adopts them on its own).'] : [] });
  }

  // a step that changes what people see is not verified until something opens the app and looks
  if (opts.visual && !allSteps(ctx).some((s) => s.app)) parts.push({ name: 'looked', ok: false, detail: ['This step changes what people see, but no verify step opens the app to look at it. Add one: wololo verify adopt (when the app can be detected), or a step like {"name": "app", "app": {"start": "<run the app>", "url": "<page>"}} ({"window": "<title>"} for a desktop app or game; neither for a CLI).'] });

  // checks may grow with the project; a weaker gate passes nothing until a human accepts it
  const r = ratchet(ctx, { base: opts.base });
  parts.push({ name: 'ratchet', ok: r.ok, detail: r.ok ? [] : [...r.weakened, 'Verification only grows. If this weakening is intended, a human accepts it: wololo verify approve (or the TUI: Health → a). Otherwise put the checks back.'] });

  const ok = parts.every((p) => p.ok);
  recordEvent(ctx.root, { type: 'gate', ok, failed: parts.filter((p) => !p.ok).map((p) => p.name) });
  return { ok, parts };
}

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'gate',
    summary: 'Merge gate: adapters in sync + constraints + verify + rubric. Exit 0 means the agent may merge.',
    options: { judge: { type: 'string[]', description: 'Judgment scores for rubric criteria, e.g. --judge ux=0.8' } },
    async run(input, ctx) {
      /** @type {Record<string, number>} */
      const judge = Object.fromEntries((input.judge ?? []).map((/** @type {string} */ p) => [p.split('=')[0], Number(p.split('=')[1])]));
      const r = await runGate(ctx, { judge });
      return {
        ok: r.ok,
        summary: r.ok ? 'gate: PASS, safe to merge' : `gate: BLOCKED by ${r.parts.filter((p) => !p.ok).map((p) => p.name).join(', ')}`,
        details: r.parts.flatMap((p) => [`${p.ok ? 'PASS' : 'FAIL'} ${p.name}`, ...p.detail.map((d) => `    ${d.replace(/\n/g, '\n    ')}`)]),
        data: r,
      };
    },
  },
];
