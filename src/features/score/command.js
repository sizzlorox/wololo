import { join } from 'node:path';
import { sh } from '../../core/exec.js';
import { readJson } from '../../core/files.js';
import { loadSchema, validate } from '../../core/schema.js';
import { readEvents, recordEvent, wololoPath } from '../../core/state.js';
import { runCheck } from '../check/engine.js';
import { runVerify } from '../verify/command.js';

/**
 * @typedef {{ id: string, type: 'verify' | 'check' | 'command' | 'metric' | 'judgment', weight?: number, step?: string, run?: string, min?: number, max?: number, question?: string }} Criterion
 * @typedef {{ id: string, type: string, weight: number, score: number | null, note: string, question?: string }} Scored
 */

/** @param {string} root @returns {{ criteria: Criterion[] }} */
export function loadRubric(root) {
  const rubric = readJson(wololoPath(root, 'rubric.json'), { criteria: [] });
  const errors = validate(loadSchema('rubric'), rubric);
  if (errors.length) throw new Error(`Invalid .wololo/rubric.json:\n  ${errors.join('\n  ')}`);
  return rubric;
}

/**
 * Deterministic criteria are computed here. Judgment criteria come from the agent via `judge`;
 * the script never pretends to have taste.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {{ judge?: Record<string, number>, verified?: Awaited<ReturnType<typeof runVerify>>, record?: boolean }} opts
 */
export async function runScore(ctx, opts) {
  const { criteria } = loadRubric(ctx.root);
  /** @type {Awaited<ReturnType<typeof runVerify>> | undefined} */
  let verified = opts.verified;
  /** @type {Scored[]} */
  const scored = [];
  for (const c of criteria) {
    const weight = c.weight ?? 1;
    /** @param {number | null} score @param {string} note */
    const push = (score, note) => scored.push({ id: c.id, type: c.type, weight, score, note, question: c.question });
    if (c.type === 'verify') {
      verified ??= await runVerify(ctx, { record: false });
      const steps = c.step ? verified.results.filter((r) => r.name === c.step) : verified.results;
      const passed = steps.filter((r) => r.ok).length;
      push(steps.length ? passed / steps.length : 0, `${passed}/${steps.length} steps green`);
    } else if (c.type === 'check') {
      const r = runCheck(ctx, { record: false });
      const errs = r.violations.filter((v) => v.severity === 'error').length;
      push(errs === 0 ? 1 : 0, `${errs} rule errors`);
    } else if (c.type === 'command') {
      const r = await sh(/** @type {string} */ (c.run), { cwd: ctx.root, timeoutMs: 600_000 });
      push(r.code === 0 ? 1 : 0, `exit ${r.code}`);
    } else if (c.type === 'metric') {
      const r = await sh(/** @type {string} */ (c.run), { cwd: ctx.root, timeoutMs: 600_000 });
      const nums = `${r.stdout}`.match(/-?\d+(?:\.\d+)?/g);
      const value = nums ? Number(nums[nums.length - 1]) : NaN;
      const lo = c.min ?? 0;
      const hi = c.max ?? 1;
      push(Number.isNaN(value) ? 0 : clamp((value - lo) / (hi - lo)), `value ${value}`);
    } else {
      const j = opts.judge?.[c.id];
      push(j === undefined ? null : clamp(j), j === undefined ? 'pending judgment' : 'judged');
    }
  }
  const known = scored.filter((s) => s.score !== null);
  const totalWeight = known.reduce((a, s) => a + s.weight, 0);
  const total = totalWeight ? known.reduce((a, s) => a + s.weight * /** @type {number} */ (s.score), 0) / totalWeight : 0;
  const pending = scored.filter((s) => s.score === null).map((s) => s.id);
  const weakest = [...known].sort((a, b) => /** @type {number} */ (a.score) - /** @type {number} */ (b.score) || b.weight - a.weight)[0];
  const history = readEvents(ctx.root, 'score').slice(-5).map((e) => e.total);
  if (opts.record !== false) recordEvent(ctx.root, { type: 'score', ok: true, total, pending, criteria: Object.fromEntries(scored.map((s) => [s.id, s.score])) });
  return { total: round(total), scored, pending, weakest: weakest && /** @type {number} */ (weakest.score) < 1 ? weakest : undefined, history, empty: criteria.length === 0 };
}

/** @param {number} x */
const clamp = (x) => Math.max(0, Math.min(1, x));
/** @param {number} x */
const round = (x) => Math.round(x * 1000) / 1000;

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'score',
    summary: 'Score the current state against .wololo/rubric.json. Pass judgments as --judge id=0.8. Use it to hill-climb.',
    options: { judge: { type: 'string[]', description: 'Judgment scores, e.g. --judge ux=0.7' } },
    async run(input, ctx) {
      /** @type {Record<string, number>} */
      const judge = {};
      for (const pair of input.judge ?? []) {
        const [k, v] = String(pair).split('=');
        judge[k] = Number(v);
      }
      const r = await runScore(ctx, { judge });
      if (r.empty) return { ok: false, summary: `no rubric: create ${join('.wololo', 'rubric.json')}`, data: r };
      return {
        ok: true,
        summary: `score ${r.total}${r.pending.length ? ` (pending judgment: ${r.pending.join(', ')})` : ''}${r.weakest ? ` — weakest: ${r.weakest.id}` : ''}`,
        details: [
          ...r.scored.map((s) => `${s.score === null ? '  ?  ' : s.score.toFixed(2)} ${s.id} ×${s.weight} — ${s.note}${s.question && s.score === null ? `\n      judge: ${s.question}` : ''}`),
          r.history.length ? `trend: ${r.history.map((h) => h?.toFixed?.(2)).join(' → ')} → ${r.total.toFixed(2)}` : '',
        ].filter(Boolean),
        data: r,
      };
    },
  },
];
