import { existsSync } from 'node:fs';
import { writeJson } from '../../core/files.js';
import { slugify } from '../../core/text.js';
import { wololoPath } from '../../core/state.js';
import { loadRules, testRule, validateRule } from '../check/rules.js';

/**
 * Turn a glob into a plausible concrete path so examples can be written without one.
 * @param {string} glob
 */
export function exampleFor(glob) {
  return glob
    .replace(/\*\*\//g, 'src/')
    .replace(/\{([^,}]+)[^}]*\}/g, '$1')
    .replace(/\*\*/g, 'example')
    .replace(/\*/g, 'example');
}

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'rule add',
    summary: 'Turn a repeated agent mistake into an enforced rule. Refuses rules whose examples do not hold.',
    args: [{ name: 'id', description: 'Rule id, e.g. no-direct-fetch', required: true }],
    options: {
      kind: { type: 'string', description: 'forbid | require | max-lines | forbid-path | require-sibling | tautological-tests', default: 'forbid' },
      files: { type: 'string[]', description: 'Globs the rule applies to', default: ['**/*'] },
      exclude: { type: 'string[]', description: 'Globs to exclude' },
      pattern: { type: 'string', description: 'Regex (forbid/require)' },
      flags: { type: 'string', description: 'Regex flags' },
      max: { type: 'number', description: 'Line budget (max-lines)' },
      sibling: { type: 'string', description: 'Companion template (require-sibling), e.g. {dir}/{name}.test{ext}' },
      why: { type: 'string', description: 'The mistake that keeps happening' },
      fix: { type: 'string', description: 'What to do instead (shown to the agent on violation)' },
      severity: { type: 'string', description: 'error | warn', default: 'error' },
      bad: { type: 'string', description: 'Example content that MUST be flagged' },
      good: { type: 'string', description: 'Example content that must NOT be flagged' },
      examplePath: { type: 'string', description: 'Path used for the examples (default derived from --files)' },
      force: { type: 'boolean', description: 'Overwrite an existing rule' },
    },
    async run(input, ctx) {
      const id = slugify(input.id);
      const path = wololoPath(ctx.root, 'rules', `${id}.json`);
      if (existsSync(path) && !input.force) return { ok: false, summary: `rule ${id} exists (use --force to replace)` };
      if (!input.why || !input.fix) return { ok: false, summary: 'a rule needs --why (the mistake) and --fix (what to do instead)' };
      const examplePath = input.examplePath ?? exampleFor(input.files[0]);
      /** @type {Record<string, any>} */
      const rule = {
        $schema: '../../node_modules/wololo/schema/rule.schema.json',
        id,
        kind: input.kind,
        severity: input.severity,
        files: input.files,
        exclude: input.exclude,
        pattern: input.pattern,
        flags: input.flags,
        max: input.max,
        sibling: input.sibling,
        why: input.why,
        fix: input.fix,
      };
      if (input.bad !== undefined || input.good !== undefined) {
        rule.examples = {
          bad: input.bad !== undefined ? [{ path: examplePath, content: input.bad }] : undefined,
          good: input.good !== undefined ? [{ path: examplePath, content: input.good }] : undefined,
        };
      }
      const clean = JSON.parse(JSON.stringify(rule));
      const problems = [...validateRule(clean), ...(problemsOrEmpty(clean))];
      if (problems.length) return { ok: false, summary: `rule ${id} rejected`, details: problems };
      writeJson(path, clean);
      return {
        ok: true,
        summary: `rule ${id} written to .wololo/rules/${id}.json${clean.examples ? ' (examples verified)' : ' (add --bad to prove it catches the mistake)'}`,
        data: clean,
      };
    },
  },
  {
    name: 'rule list',
    summary: 'List enforced rules and why each exists.',
    async run(_input, ctx) {
      const { rules, errors } = loadRules(ctx.root);
      return {
        ok: errors.length === 0,
        summary: `${rules.length} rules${errors.length ? `, ${errors.length} broken` : ''}`,
        details: [...rules.map((r) => `${r.id} (${r.kind}, ${r.severity ?? 'error'}) ${r.files.join(' ')}\n    why: ${r.why}`), ...errors],
        data: { rules, errors },
      };
    },
  },
  {
    name: 'rule test',
    summary: 'Prove every rule still catches its bad examples and spares its good ones.',
    async run(_input, ctx) {
      const { rules, errors } = loadRules(ctx.root);
      const failures = rules.flatMap((r) => testRule(r).map((f) => `${r.id}: ${f}`));
      const untested = rules.filter((r) => !r.examples?.bad?.length).map((r) => r.id);
      const ok = failures.length === 0 && errors.length === 0;
      return {
        ok,
        summary: ok ? `${rules.length} rules pass their examples${untested.length ? ` (${untested.length} without bad examples)` : ''}` : `${failures.length + errors.length} rule problems`,
        details: [...errors, ...failures, ...(untested.length ? [`untested: ${untested.join(', ')}`] : [])],
        data: { failures, untested, errors },
      };
    },
  },
];

/** @param {any} rule */
function problemsOrEmpty(rule) {
  return rule.examples ? testRule(rule) : [];
}
