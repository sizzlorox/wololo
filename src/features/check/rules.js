import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from '../../core/files.js';
import { matchAny } from '../../core/glob.js';
import { loadSchema, validate } from '../../core/schema.js';
import { wololoPath } from '../../core/state.js';
import { findTautologies } from './tautology.js';

/**
 * @typedef {{ path: string, content: string, repeat?: number }} ExampleFile
 * @typedef {object} Rule
 * @property {string} id
 * @property {'forbid' | 'require' | 'max-lines' | 'forbid-path' | 'require-sibling' | 'tautological-tests'} kind
 * @property {'error' | 'warn'} [severity]
 * @property {string[]} files
 * @property {string[]} [exclude]
 * @property {string} [pattern]
 * @property {string} [flags]
 * @property {number} [max]
 * @property {string} [sibling]
 * @property {string} why
 * @property {string} fix
 * @property {{ bad?: ExampleFile[], good?: ExampleFile[] }} [examples]
 *
 * @typedef {object} Violation
 * @property {string} rule
 * @property {'error' | 'warn'} severity
 * @property {string} file
 * @property {number} [line]
 * @property {string} message
 * @property {string} fix
 */

/**
 * @param {string} root
 * @returns {{ rules: Rule[], errors: string[] }}
 */
export function loadRules(root) {
  const dir = wololoPath(root, 'rules');
  /** @type {Rule[]} */
  const rules = [];
  /** @type {string[]} */
  const errors = [];
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return { rules, errors };
  }
  for (const name of names) {
    try {
      const rule = JSON.parse(readText(join(dir, name)) ?? '');
      const problems = validateRule(rule);
      if (problems.length) errors.push(`${name}: ${problems.join('; ')}`);
      else rules.push(rule);
    } catch (e) {
      errors.push(`${name}: ${/** @type {Error} */ (e).message}`);
    }
  }
  return { rules, errors };
}

/** @param {any} rule */
export function validateRule(rule) {
  const errors = validate(loadSchema('rule'), rule);
  if (errors.length) return errors;
  if ((rule.kind === 'forbid' || rule.kind === 'require') && !rule.pattern) errors.push(`kind ${rule.kind} needs "pattern"`);
  if (rule.kind === 'max-lines' && !rule.max) errors.push('kind max-lines needs "max"');
  if (rule.kind === 'require-sibling' && !rule.sibling) errors.push('kind require-sibling needs "sibling"');
  if (rule.pattern) {
    try {
      new RegExp(rule.pattern, rule.flags);
    } catch (e) {
      errors.push(`bad pattern: ${/** @type {Error} */ (e).message}`);
    }
  }
  return errors;
}

/**
 * @param {Rule} rule
 * @param {string} file
 */
export function applies(rule, file) {
  return matchAny(file, rule.files) && !matchAny(file, rule.exclude);
}

/**
 * @param {string} tmpl
 * @param {string} file
 */
export function siblingPath(tmpl, file) {
  const slash = file.lastIndexOf('/');
  const dir = slash === -1 ? '.' : file.slice(0, slash);
  const base = file.slice(slash + 1);
  const dot = base.indexOf('.');
  const name = dot <= 0 ? base : base.slice(0, dot);
  const ext = dot <= 0 ? '' : base.slice(dot);
  return tmpl.replace(/\{dir\}/g, dir).replace(/\{name\}/g, name).replace(/\{ext\}/g, ext).replace(/^\.\//, '');
}

/**
 * Evaluate one rule against one file. Pure: the caller supplies content and an existence probe.
 * @param {Rule} rule
 * @param {string} file
 * @param {() => string} content
 * @param {(path: string) => boolean} exists
 * @returns {Violation[]}
 */
export function evaluate(rule, file, content, exists) {
  const severity = rule.severity ?? 'error';
  /** @param {string} message @param {number} [line] @returns {Violation} */
  const v = (message, line) => ({ rule: rule.id, severity, file, line, message, fix: rule.fix });
  /** @type {Violation[]} */
  let out = [];
  switch (rule.kind) {
    case 'forbid-path':
      out = [v('this path is not allowed here')];
      break;
    case 'require-sibling': {
      const want = siblingPath(/** @type {string} */ (rule.sibling), file);
      if (!exists(want)) out = [v(`missing companion file ${want}`)];
      break;
    }
    case 'max-lines': {
      const n = content().split('\n').length;
      if (n > /** @type {number} */ (rule.max)) out = [v(`${n} lines exceeds budget of ${rule.max}`)];
      break;
    }
    case 'require': {
      if (!new RegExp(/** @type {string} */ (rule.pattern), rule.flags).test(content())) out = [v(`must match /${rule.pattern}/`)];
      break;
    }
    case 'forbid': {
      const text = content();
      const re = new RegExp(/** @type {string} */ (rule.pattern), `${(rule.flags ?? '').replace('g', '')}g`);
      for (const m of text.matchAll(re)) {
        out.push(v(`forbidden: "${m[0].trim().slice(0, 60)}"`, lineOf(text, m.index ?? 0)));
        if (out.length >= 20) break;
      }
      break;
    }
    case 'tautological-tests':
      out = findTautologies(content()).map((t) => v(t.reason, t.line));
      break;
  }
  return out.filter((x) => !suppressed(rule.id, content, x.line));
}

/**
 * `wololo-ignore <rule>: reason` on the line or the line above; `wololo-ignore-file <rule>: reason` anywhere.
 * A reason is mandatory so suppressions stay reviewable.
 * @param {string} id
 * @param {() => string} content
 * @param {number} [line]
 */
function suppressed(id, content, line) {
  let text;
  try {
    text = content();
  } catch {
    return false;
  }
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`wololo-ignore-file ${esc}:\\s*\\S`).test(text)) return true;
  if (!line) return false;
  const lines = text.split('\n');
  const re = new RegExp(`wololo-ignore ${esc}:\\s*\\S`);
  return re.test(lines[line - 1] ?? '') || re.test(lines[line - 2] ?? '');
}

/**
 * @param {string} text
 * @param {number} index
 */
function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** @param {ExampleFile} ex */
const exampleText = (ex) => ex.content.repeat(Math.max(1, ex.repeat ?? 1));

/**
 * Run a rule's own examples: bad ones must violate, good ones must not. Rules are code; they get tests too.
 * @param {Rule} rule
 * @returns {string[]}
 */
export function testRule(rule) {
  const failures = [];
  const bad = rule.examples?.bad ?? [];
  const good = rule.examples?.good ?? [];
  const all = [...bad, ...good];
  /** @param {string} p */
  const exists = (p) => all.some((f) => f.path === p);
  for (const ex of bad) {
    if (!applies(rule, ex.path)) failures.push(`bad example ${ex.path} is not matched by files ${JSON.stringify(rule.files)}`);
    else if (evaluate(rule, ex.path, () => exampleText(ex), exists).length === 0) failures.push(`bad example ${ex.path} was not caught`);
  }
  for (const ex of good) {
    if (applies(rule, ex.path) && evaluate(rule, ex.path, () => exampleText(ex), exists).length > 0)
      failures.push(`good example ${ex.path} was flagged`);
  }
  return failures;
}
