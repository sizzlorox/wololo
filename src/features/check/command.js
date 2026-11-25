import { formatViolation, runCheck } from './engine.js';

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'check',
    summary: 'Enforce .wololo/rules on the repo (or given files). Violations explain the fix.',
    args: [{ name: 'files', description: 'Files to check (default: whole repo)', variadic: true }],
    options: {
      changed: { type: 'boolean', description: 'Only files changed in the working tree' },
      rule: { type: 'string[]', description: 'Only these rule ids' },
    },
    async run(input, ctx) {
      const r = runCheck(ctx, { files: input.files, changed: input.changed, only: input.rule });
      const errors = r.violations.filter((v) => v.severity === 'error').length;
      const warns = r.violations.length - errors;
      return {
        ok: r.ok,
        summary: r.ok
          ? `check passed: ${r.scanned} files, ${r.rules} rules${warns ? `, ${warns} warnings` : ''}`
          : `check failed: ${errors} errors, ${warns} warnings${r.ruleErrors.length ? `, ${r.ruleErrors.length} broken rules` : ''}`,
        details: [...r.ruleErrors.map((e) => `broken rule ${e}`), ...r.violations.map(formatViolation)],
        data: r,
      };
    },
  },
];
