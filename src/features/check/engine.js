import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { changedFiles, listFiles, readText, toPosix } from '../../core/files.js';
import { recordEvent } from '../../core/state.js';
import { generatedPaths } from '../sync/manifest.js';
import { applies, evaluate, loadRules } from './rules.js';

/** @typedef {import('./rules.js').Violation} Violation */

/**
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {{ files?: string[], changed?: boolean, only?: string[], record?: boolean }} opts
 */
export function runCheck(ctx, opts) {
  const { root, config } = ctx;
  const { rules: allRules, errors } = loadRules(root);
  const rules = opts.only?.length ? allRules.filter((r) => opts.only?.includes(r.id)) : allRules;
  const generated = new Set(generatedPaths(root));
  const repoFiles = listFiles(root, config.ignore);
  const known = new Set(repoFiles);
  /** @param {string} p */
  const exists = (p) => known.has(p) || existsSync(join(root, p));

  let targets = repoFiles;
  if (opts.files?.length) targets = opts.files.map((f) => normalize(ctx, f)).filter((f) => existsSync(join(root, f)));
  else if (opts.changed) targets = changedFiles(root);
  targets = targets.filter((f) => !generated.has(f));

  /** @type {Violation[]} */
  const violations = [];
  for (const file of targets) {
    /** @type {string | undefined} */
    let cached;
    const content = () => (cached ??= readText(join(root, file)) ?? '');
    for (const rule of rules) if (applies(rule, file)) violations.push(...evaluate(rule, file, content, exists));
  }
  const errorCount = violations.filter((v) => v.severity === 'error').length;
  const ok = errorCount === 0 && errors.length === 0;
  if (opts.record !== false) {
    /** @type {Record<string, number>} */
    const byRule = {};
    for (const v of violations) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
    recordEvent(root, { type: 'check', ok, byRule, files: targets.length });
  }
  return { ok, violations, ruleErrors: errors, scanned: targets.length, rules: rules.length };
}

/**
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {string} f
 */
export function normalize(ctx, f) {
  const abs = isAbsolute(f) ? f : join(ctx.cwd, f);
  return toPosix(relative(ctx.root, abs));
}

/** @param {Violation} v */
export function formatViolation(v) {
  return `${v.file}${v.line ? `:${v.line}` : ''} [${v.rule}] ${v.message}\n    fix: ${v.fix}`;
}
